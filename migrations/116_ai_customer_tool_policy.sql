-- Explicit versioned approval never grants unrestricted model/database/provider authority.
CREATE FUNCTION ai_customer_tool_catalog() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['createFollowUp','getCampaignKnowledge','getLeadContext','requestHumanHandoff','sendConversationMessage','updateQualificationField']::text[]
$$;
CREATE FUNCTION ai_tool_policy_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>1 OR NOT d ? 'allowedTools' THEN RETURN false;END IF;
 IF d->'allowedTools'='null'::jsonb THEN RETURN true;END IF;
 IF jsonb_typeof(d->'allowedTools') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'allowedTools')>cardinality(ai_customer_tool_catalog()) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'allowedTools') v WHERE jsonb_typeof(v)<>'string' OR NOT (v#>>'{}'=ANY(ai_customer_tool_catalog())))
   OR (SELECT count(*) FROM jsonb_array_elements(d->'allowedTools'))<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(d->'allowedTools') v) THEN RETURN false;END IF;
 RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_tool_policy (
 scope text NOT NULL CHECK(scope IN ('BRANCH','CAMPAIGN')),resource_id uuid NOT NULL,branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid REFERENCES campaign(id),
 version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_tool_policy_valid(definition)),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id),
 CHECK(scope='BRANCH' AND campaign_id IS NULL AND resource_id=branch_id OR scope='CAMPAIGN' AND campaign_id IS NOT NULL AND resource_id=campaign_id)
);
CREATE INDEX ai_tool_policy_branch_scope ON ai_tool_policy(branch_id,scope,resource_id);
CREATE TABLE ai_tool_policy_history (
 scope text NOT NULL,resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id,version),
 FOREIGN KEY(scope,resource_id) REFERENCES ai_tool_policy(scope,resource_id)
);
CREATE FUNCTION guard_ai_tool_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_TOOL_POLICY_HISTORY_RETAINED';END IF;
 PERFORM 1 FROM branch WHERE id=NEW.branch_id AND active FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'AI_TOOL_POLICY_CURRENT_ACCESS_REQUIRED';END IF;
 IF NEW.campaign_id IS NOT NULL THEN PERFORM 1 FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.id=NEW.campaign_id AND c.branch_id=NEW.branch_id AND c.organization_id=b.organization_id FOR SHARE OF c;
   IF NOT FOUND THEN RAISE EXCEPTION 'AI_TOOL_POLICY_CURRENT_ACCESS_REQUIRED';END IF;END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.scope,NEW.resource_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.branch_id,OLD.campaign_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'AI_TOOL_POLICY_VERSION_REQUIRED';END IF;
 PERFORM 1 FROM user_account u JOIN user_session s ON s.user_id=u.id JOIN branch b ON b.id=NEW.branch_id
   WHERE u.id=NEW.actor_id AND s.id=NEW.session_id AND u.organization_id=b.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_TOOL_POLICY_CURRENT_ACCESS_REQUIRED';END IF;
 IF NOT ai_tool_policy_valid(NEW.definition) THEN RAISE EXCEPTION 'AI_TOOL_POLICY_INVALID';END IF;
 NEW.definition=jsonb_build_object('allowedTools',CASE WHEN NEW.definition->'allowedTools'='null'::jsonb THEN 'null'::jsonb ELSE (SELECT COALESCE(jsonb_agg(v ORDER BY (v#>>'{}') COLLATE "C"),'[]') FROM jsonb_array_elements(NEW.definition->'allowedTools') v) END);
 NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_tool_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_tool_policy FOR EACH ROW EXECUTE FUNCTION guard_ai_tool_policy();
CREATE FUNCTION guard_ai_tool_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_tool_policy c WHERE c.scope=NEW.scope AND c.resource_id=NEW.resource_id AND c.version=NEW.version AND to_jsonb(c)=NEW.snapshot) THEN RAISE EXCEPTION 'AI_TOOL_POLICY_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_tool_policy_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_tool_policy_history FOR EACH ROW EXECUTE FUNCTION guard_ai_tool_policy_history();
CREATE FUNCTION record_ai_tool_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_tool_policy_history(scope,resource_id,version,snapshot) VALUES(NEW.scope,NEW.resource_id,NEW.version,to_jsonb(NEW));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT b.organization_id,b.id,NEW.actor_id,'AI_TOOL_POLICY_CONFIGURED',NEW.scope,NEW.resource_id,
   jsonb_build_object('catalogVersion',1,'version',NEW.version,'scope',NEW.scope,'allowedTools',NEW.definition->'allowedTools','reason',NEW.reason) FROM branch b WHERE b.id=NEW.branch_id;RETURN NEW;END $$;
CREATE TRIGGER ai_tool_policy_record AFTER INSERT OR UPDATE ON ai_tool_policy FOR EACH ROW EXECUTE FUNCTION record_ai_tool_policy();
CREATE FUNCTION ai_effective_tool_policy(bid uuid,cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalogVersion',1,'branchVersion',COALESCE(bp.version,0),'campaignVersion',COALESCE(cp.version,0),
   'branchDefinition',COALESCE(bp.definition,'{"allowedTools":null}'),'campaignDefinition',COALESCE(cp.definition,'{"allowedTools":null}'),
   'allowedTools',COALESCE(NULLIF(cp.definition->'allowedTools','null'),NULLIF(bp.definition->'allowedTools','null'),'[]'),
   'source',CASE WHEN cp.definition->'allowedTools'<>'null' THEN 'CAMPAIGN' WHEN bp.definition->'allowedTools'<>'null' THEN 'BRANCH' ELSE 'UNCONFIGURED' END)
 FROM branch b JOIN campaign c ON c.branch_id=b.id AND c.organization_id=b.organization_id
 LEFT JOIN ai_tool_policy bp ON bp.scope='BRANCH' AND bp.resource_id=b.id
 LEFT JOIN ai_tool_policy cp ON cp.scope='CAMPAIGN' AND cp.resource_id=c.id WHERE b.id=bid AND c.id=cid
$$;
CREATE FUNCTION ai_tool_context_current(ctx jsonb,bid uuid,cid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(ctx->'toolPolicy'=p AND ctx->'allowedTools'=p->'allowedTools',false) FROM (SELECT ai_effective_tool_policy(bid,cid) AS p) policy
$$;

CREATE OR REPLACE FUNCTION ai_customer_proposal_context(eid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH source AS (SELECT ai_customer_inbound_context(eid) AS ctx)
 SELECT ctx || jsonb_build_object('kind','CUSTOMER_PROPOSAL','protocolVersion',1,'toolPolicy',ai_effective_tool_policy(l.branch_id,c.id),
   'knowledgeData',jsonb_build_object('content',kp.content,'assets',COALESCE((SELECT jsonb_agg(pa.snapshot ORDER BY pa.asset_id) FROM ai_knowledge_publication_asset pa WHERE pa.campaign_id=c.id AND pa.version=kp.version),'[]')),
   'references',ai_simulation_references(jsonb_build_object('content',kp.content,'assets',COALESCE((SELECT jsonb_agg(pa.snapshot ORDER BY pa.asset_id) FROM ai_knowledge_publication_asset pa WHERE pa.campaign_id=c.id AND pa.version=kp.version),'[]'))),
   'messages',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'speaker',m.author_type,'text',left(m.body,2000)) ORDER BY m.created_at,m.id)
     FROM (SELECT cm.id,cm.author_type,cm.body,cm.created_at FROM conversation_message cm WHERE cm.conversation_id=cv.id AND cm.message_kind='TEXT' AND length(trim(cm.body))>0 ORDER BY cm.created_at DESC,cm.id DESC LIMIT 20) m),'[]'),
   'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','required',q->'required','field_type',fd.field_type,'options',fd.options,'validation',fd.validation) ORDER BY n)
     FROM ai_qualification_config qc CROSS JOIN LATERAL jsonb_array_elements(qc.definition->'questions') WITH ORDINALITY qs(q,n)
     LEFT JOIN field_definition fd ON fd.id=(q->>'fieldId')::uuid
     WHERE qc.campaign_id=c.id AND qc.definition->>'enabled'='true'),'[]'),
   'operationalData',jsonb_build_object('language',COALESCE(NULLIF(cc.definition->'language','null'),bc.definition->'language','null'),
     'tone',COALESCE(NULLIF(cc.definition->'tone','null'),bc.definition->'tone','null')),
   'consent',jsonb_build_object('status',COALESCE(co.status,'UNKNOWN'),'doNotContact',COALESCE(co.do_not_contact,false),'versionTime',co.updated_at))
 FROM source JOIN lead l ON l.id=(ctx->'scope'->>'leadId')::uuid
 JOIN campaign c ON c.id=l.campaign_id JOIN conversation cv ON cv.id=(ctx->'scope'->>'conversationId')::uuid
 JOIN conversation_message sm ON sm.id=(ctx->'source'->>'messageId')::uuid JOIN integration_event ev ON ev.id=eid
 JOIN ai_knowledge_publication kp ON kp.campaign_id=c.id AND kp.version=(ctx->'knowledge'->>'version')::integer
 LEFT JOIN ai_operational_config bc ON bc.scope='BRANCH' AND bc.resource_id=l.branch_id
 LEFT JOIN ai_operational_config cc ON cc.scope='CAMPAIGN' AND cc.resource_id=c.id
 LEFT JOIN messaging_consent co ON co.contact_id=l.contact_id AND co.channel=cv.channel
 WHERE ctx IS NOT NULL AND ctx->'branch'->>'active'='true' AND ctx->'campaign'->>'status'='ACTIVE' AND ctx->'campaign'->>'aiEnabled'='true'
   AND ctx->'lead'->>'lifecycle'='OPEN' AND ctx->'conversation'->>'controller'='AI'
   AND (cv.state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') OR cv.state='AI_HANDOFF_REQUIRED' AND cv.needs_attention_reason='AI_PROCESSING_NOT_READY')
   AND ctx->'conversation'->>'latestMessageId'=sm.id::text AND sm.message_kind='TEXT'
   AND sm.body IS NOT DISTINCT FROM CASE ev.payload->'message'->>'type' WHEN 'text' THEN ev.payload->'message'->'text'->>'body' WHEN 'button' THEN ev.payload->'message'->'button'->>'text' ELSE NULL END
   AND ctx->'profile'->>'usable'='true' AND ctx->'sender'->>'active'='true' AND ctx->'sender'->>'operatorEnabled'='true'
   AND ctx->'sender'->>'inScope'='true' AND ctx->'sender'->>'connectionStatus'='CONNECTED' AND ctx->'sender'->>'health' IN ('HEALTHY','DEGRADED')
   AND NOT COALESCE(co.do_not_contact,false) AND COALESCE(co.status,'UNKNOWN')<>'REVOKED'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'knowledge'->'assets') a WHERE a->>'state' IS DISTINCT FROM 'REVIEW' OR a->>'approval' IS DISTINCT FROM 'APPROVED')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(ctx->'qualification'->'fields','[]')) f WHERE f->>'active'<>'true' OR f->>'usableByAI'<>'true' OR f->>'inScope'<>'true' OR f->>'mode'<>'MANUAL')
   AND NOT EXISTS(SELECT 1 FROM ai_qualification_config qc CROSS JOIN LATERAL jsonb_array_elements(qc.definition->'questions') q
     WHERE qc.campaign_id=c.id AND qc.definition->>'enabled'='true' AND q->>'fieldId' IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=c.id AND fd.id=(q->>'fieldId')::uuid
       AND cf.active AND cf.usable_by_ai AND fd.active AND fd.value_mode='MANUAL' AND fd.organization_id=l.organization_id
       AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id)))
$$;

-- Parent-first dependency fences. No locks or transactions span provider HTTP.

CREATE OR REPLACE FUNCTION ai_simulation_current(s ai_campaign_simulation) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE b record;c record;p record;cfg jsonb;selected uuid;k jsonb;v integer;g integer;item record;BEGIN
  IF s.kind='COPILOT_SUMMARY' THEN RETURN ai_copilot_current(s);END IF;
  SELECT * INTO b FROM branch WHERE id=s.branch_id AND organization_id=s.organization_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO c FROM campaign WHERE id=s.campaign_id AND branch_id=b.id AND organization_id=s.organization_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  PERFORM 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=s.actor_id AND ss.id=s.session_id AND u.organization_id=s.organization_id AND u.active
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp() FOR SHARE OF u,ss;IF NOT FOUND THEN RETURN false;END IF;
  IF s.context->>'organizationId' IS DISTINCT FROM s.organization_id::text OR s.context->>'branchId' IS DISTINCT FROM b.id::text OR s.context->>'campaignId' IS DISTINCT FROM c.id::text
    OR (s.context->>'campaignVersion')::integer IS DISTINCT FROM c.version OR (s.context->'messaging'->>'branchPolicyVersion')::integer IS DISTINCT FROM b.messaging_policy_version
    OR s.context->'globalGuardrails'->>'version' IS DISTINCT FROM '1' OR EXISTS(SELECT 1 FROM jsonb_each(s.context->'globalGuardrails') e WHERE key<>'version' AND value<>'true'::jsonb) THEN RETURN false;END IF;
  FOR item IN SELECT scope,resource_id,version,definition FROM ai_operational_config WHERE branch_id=b.id AND (campaign_id IS NULL OR campaign_id=c.id) FOR SHARE LOOP
    cfg=CASE WHEN item.scope='BRANCH' THEN s.context->'branchDefaults' ELSE s.context->'campaignOverrides' END;
    IF (cfg->>'version')::integer IS DISTINCT FROM item.version OR cfg->'definition' IS DISTINCT FROM item.definition THEN RETURN false;END IF;
  END LOOP;
  IF (s.context->'branchDefaults'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id),0)
    OR (s.context->'campaignOverrides'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),0) THEN RETURN false;END IF;
  selected=COALESCE((SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),
    (SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id));
  IF selected IS NULL OR s.context->'profiles'->'CONVERSATION'->>'id' IS DISTINCT FROM selected::text OR NOT ai_operational_profile_usable(b.id,selected,'CONVERSATION') THEN RETURN false;END IF;
  SELECT pr.*,ic.version AS cv,ic.provider,ic.id AS cid INTO p FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=selected FOR SHARE OF pr,ic;
  cfg=s.context->'profiles'->'CONVERSATION';
  g=CASE WHEN p.branch_id IS NULL THEN (SELECT version FROM ai_connection_branch_use WHERE connection_id=p.cid AND branch_id=b.id AND active FOR SHARE) ELSE NULL END;
  IF cfg->>'model_id' IS DISTINCT FROM p.model_id OR (cfg->>'max_output_tokens')::integer IS DISTINCT FROM p.max_output_tokens OR (cfg->>'profile_version')::integer IS DISTINCT FROM p.version
    OR cfg->>'connection_id' IS DISTINCT FROM p.cid::text OR cfg->>'provider' IS DISTINCT FROM p.provider OR (cfg->>'connection_version')::integer IS DISTINCT FROM p.cv OR (cfg->>'grant_version')::integer IS DISTINCT FROM g THEN RETURN false;END IF;
  SELECT jsonb_build_object('version',version,'content',content,'assets',(SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=kp.campaign_id AND m.version=kp.version)) INTO k
    FROM ai_knowledge_publication kp WHERE campaign_id=c.id ORDER BY version DESC LIMIT 1;
  IF k IS NULL OR s.context->'knowledge' IS DISTINCT FROM k OR s.references_json IS DISTINCT FROM ai_simulation_references(k) THEN RETURN false;END IF;
  IF (s.context->'qualification'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_qualification_config WHERE campaign_id=c.id FOR SHARE),0)
    OR (s.context->'followup'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_followup_policy WHERE campaign_id=c.id FOR SHARE),0)
    OR (s.context->'behavior'->>'branchVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='BRANCH' AND resource_id=b.id FOR SHARE),0)
    OR (s.context->'behavior'->>'campaignVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='CAMPAIGN' AND resource_id=c.id FOR SHARE),0) THEN RETURN false;END IF;
  IF NOT ai_tool_context_current(s.context,b.id,c.id) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;

-- Copilot remains a distinct read-only operation. Current Published/configuration provenance cannot be forged or replayed.
CREATE OR REPLACE FUNCTION ai_copilot_current(s ai_campaign_simulation) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b record;c record;l record;cv record;u record;p record;selected uuid;cfg jsonb;profile jsonb;k jsonb;g integer;item record;
BEGIN
  SELECT * INTO b FROM branch WHERE id=s.branch_id AND organization_id=s.organization_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO c FROM campaign WHERE id=s.campaign_id AND branch_id=b.id AND organization_id=s.organization_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO l FROM lead WHERE id=s.lead_id AND branch_id=b.id AND organization_id=s.organization_id AND campaign_id=c.id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO cv FROM conversation WHERE id=s.conversation_id AND lead_id=l.id AND controller_type='HUMAN' AND state='HUMAN_ACTIVE' FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT a.* INTO u FROM user_account a JOIN user_session ss ON ss.user_id=a.id WHERE a.id=s.actor_id AND ss.id=s.session_id AND a.active AND a.organization_id=s.organization_id AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
    AND (a.role='SUPER_ADMIN' OR a.branch_id=b.id AND (a.role='MANAGER' OR a.role='AGENT' AND a.id=l.assigned_agent_id)) FOR SHARE OF a,ss;IF NOT FOUND THEN RETURN false;END IF;
  IF s.context->>'kind' IS DISTINCT FROM 'COPILOT_SUMMARY' OR s.context->'invoker'->>'id' IS DISTINCT FROM u.id::text OR s.context->'invoker'->>'role' IS DISTINCT FROM u.role::text
    OR s.context->'invoker'->>'branchId' IS DISTINCT FROM u.branch_id::text OR s.context->'summaryContext' IS DISTINCT FROM ai_copilot_summary_context(cv.id)
    OR s.references_json IS DISTINCT FROM s.context->'summaryContext'->'references' THEN RETURN false;END IF;
  cfg=s.context->'campaignContext';
  IF cfg->>'organizationId' IS DISTINCT FROM s.organization_id::text OR cfg->>'branchId' IS DISTINCT FROM b.id::text OR cfg->>'campaignId' IS DISTINCT FROM c.id::text
    OR (cfg->>'campaignVersion')::integer IS DISTINCT FROM c.version OR (cfg->'messaging'->>'branchPolicyVersion')::integer IS DISTINCT FROM b.messaging_policy_version
    OR cfg->'globalGuardrails'->>'version' IS DISTINCT FROM '1' OR EXISTS(SELECT 1 FROM jsonb_each(cfg->'globalGuardrails') e WHERE key<>'version' AND value<>'true'::jsonb) THEN RETURN false;END IF;
  FOR item IN SELECT scope,resource_id,version,definition FROM ai_operational_config WHERE branch_id=b.id AND (campaign_id IS NULL OR campaign_id=c.id) FOR SHARE LOOP
    profile=CASE WHEN item.scope='BRANCH' THEN cfg->'branchDefaults' ELSE cfg->'campaignOverrides' END;
    IF (profile->>'version')::integer IS DISTINCT FROM item.version OR profile->'definition' IS DISTINCT FROM item.definition THEN RETURN false;END IF;
  END LOOP;
  IF (cfg->'branchDefaults'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id),0)
    OR (cfg->'campaignOverrides'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),0) THEN RETURN false;END IF;
  selected=COALESCE((SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),
    (SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id));
  IF selected IS NULL OR NOT ai_operational_profile_usable(b.id,selected,'SUMMARIZATION') OR cfg->'profiles'->'SUMMARIZATION'->>'id' IS DISTINCT FROM selected::text THEN RETURN false;END IF;
  SELECT pr.*,ic.version AS cv,ic.provider,ic.id AS cid INTO p FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=selected FOR SHARE OF pr,ic;
  profile=cfg->'profiles'->'SUMMARIZATION';g=CASE WHEN p.branch_id IS NULL THEN (SELECT version FROM ai_connection_branch_use WHERE connection_id=p.cid AND branch_id=b.id AND active FOR SHARE) ELSE NULL END;
  IF profile->>'model_id' IS DISTINCT FROM p.model_id OR (profile->>'profile_version')::integer IS DISTINCT FROM p.version OR (profile->>'max_output_tokens')::integer IS DISTINCT FROM p.max_output_tokens
    OR (profile->>'connection_version')::integer IS DISTINCT FROM p.cv OR profile->>'connection_id' IS DISTINCT FROM p.cid::text OR profile->>'provider' IS DISTINCT FROM p.provider OR (profile->>'grant_version')::integer IS DISTINCT FROM g THEN RETURN false;END IF;
  SELECT jsonb_build_object('version',version,'content',content,'assets',(SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=kp.campaign_id AND m.version=kp.version)) INTO k
    FROM ai_knowledge_publication kp WHERE campaign_id=c.id ORDER BY version DESC LIMIT 1;
  IF cfg->'knowledge' IS DISTINCT FROM COALESCE(k,'null'::jsonb)
    OR (cfg->'qualification'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_qualification_config WHERE campaign_id=c.id FOR SHARE),0)
    OR (cfg->'followup'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_followup_policy WHERE campaign_id=c.id FOR SHARE),0)
    OR (cfg->'behavior'->>'branchVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='BRANCH' AND resource_id=b.id FOR SHARE),0)
    OR (cfg->'behavior'->>'campaignVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='CAMPAIGN' AND resource_id=c.id FOR SHARE),0) THEN RETURN false;END IF;
  IF NOT ai_tool_context_current(cfg,b.id,c.id) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
