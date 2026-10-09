-- Reuse the durable read-only inference queue; Copilot has a separate current-user/Conversation proof.
ALTER TABLE ai_campaign_simulation ADD COLUMN kind text NOT NULL DEFAULT 'CAMPAIGN_SIMULATION' CHECK(kind IN ('CAMPAIGN_SIMULATION','COPILOT_SUMMARY')),
  ADD COLUMN lead_id uuid REFERENCES lead(id),ADD COLUMN conversation_id uuid REFERENCES conversation(id),
  ADD CHECK(kind='CAMPAIGN_SIMULATION' AND lead_id IS NULL AND conversation_id IS NULL OR kind='COPILOT_SUMMARY' AND lead_id IS NOT NULL AND conversation_id IS NOT NULL);
CREATE INDEX ai_copilot_history ON ai_campaign_simulation(conversation_id,created_at DESC,id DESC) WHERE kind='COPILOT_SUMMARY';
CREATE FUNCTION ai_copilot_summary_context(cvid uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('conversationId',cv.id,'leadId',l.id,'leadVersion',l.version,'conversationVersion',cv.version,'controller',cv.controller_type,'controllerUserId',cv.controller_user_id,
    'senderId',cv.sender_id,'connectionId',cv.connection_id,'leadOwnerId',l.assigned_agent_id,'lifecycle',l.lifecycle,
    'messageCount',(SELECT count(*) FROM conversation_message m WHERE m.conversation_id=cv.id),
    'confirmedPaymentCount',(SELECT count(*) FROM payment_record p JOIN payment_link_intent i ON i.id=p.intent_id WHERE i.lead_id=l.id AND p.state='CONFIRMED'),
    'enrollmentCount',(SELECT count(*) FROM enrollment e WHERE e.lead_id=l.id),
    'references',COALESCE((SELECT jsonb_agg(jsonb_build_object('id','message:'||m.id,'text',m.direction||' / '||m.author_type||' / '||m.delivery_state||': '||left(m.body,2000)) ORDER BY m.created_at,m.id)
      FROM (SELECT id,direction,author_type,delivery_state,body,created_at FROM conversation_message WHERE conversation_id=cv.id AND length(trim(body))>0 ORDER BY created_at DESC,id DESC LIMIT 20) m),'[]'),
    'truncated',(SELECT count(*)>20 OR COALESCE(bool_or(length(body)>2000),false) FROM conversation_message m WHERE m.conversation_id=cv.id AND length(trim(body))>0))
  FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=cvid
$$;
CREATE FUNCTION ai_copilot_current(s ai_campaign_simulation) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE b record;l record;cv record;u record;p record;selected uuid;cfg jsonb;g integer;BEGIN
  SELECT * INTO b FROM branch WHERE id=s.branch_id AND organization_id=s.organization_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO l FROM lead WHERE id=s.lead_id AND branch_id=b.id AND organization_id=s.organization_id AND campaign_id=s.campaign_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  PERFORM 1 FROM campaign WHERE id=s.campaign_id AND branch_id=b.id AND organization_id=s.organization_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO cv FROM conversation WHERE id=s.conversation_id AND lead_id=l.id AND controller_type='HUMAN' AND state='HUMAN_ACTIVE' FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT a.* INTO u FROM user_account a JOIN user_session ss ON ss.user_id=a.id WHERE a.id=s.actor_id AND ss.id=s.session_id AND a.active AND a.organization_id=s.organization_id AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
    AND (a.role='SUPER_ADMIN' OR a.branch_id=b.id AND (a.role='MANAGER' OR a.role='AGENT' AND a.id=l.assigned_agent_id)) FOR SHARE OF a,ss;IF NOT FOUND THEN RETURN false;END IF;
  IF s.context->>'kind' IS DISTINCT FROM 'COPILOT_SUMMARY' OR s.context->'invoker'->>'id' IS DISTINCT FROM u.id::text OR s.context->'invoker'->>'role' IS DISTINCT FROM u.role::text
    OR s.context->'invoker'->>'branchId' IS DISTINCT FROM u.branch_id::text OR s.context->'summaryContext' IS DISTINCT FROM ai_copilot_summary_context(cv.id) THEN RETURN false;END IF;
  cfg=s.context->'campaignContext';
  IF cfg->>'organizationId' IS DISTINCT FROM s.organization_id::text OR cfg->>'branchId' IS DISTINCT FROM b.id::text OR cfg->>'campaignId' IS DISTINCT FROM s.campaign_id::text
    OR (cfg->'branchDefaults'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id FOR SHARE),0)
    OR (cfg->'campaignOverrides'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=s.campaign_id FOR SHARE),0) THEN RETURN false;END IF;
  selected=COALESCE((SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=s.campaign_id),
    (SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id));
  IF selected IS NULL OR NOT ai_operational_profile_usable(b.id,selected,'SUMMARIZATION') OR cfg->'profiles'->'SUMMARIZATION'->>'id' IS DISTINCT FROM selected::text THEN RETURN false;END IF;
  SELECT pr.*,ic.version AS cv,ic.provider,ic.id AS cid INTO p FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=selected FOR SHARE OF pr,ic;
  cfg=cfg->'profiles'->'SUMMARIZATION';g=CASE WHEN p.branch_id IS NULL THEN (SELECT version FROM ai_connection_branch_use WHERE connection_id=p.cid AND branch_id=b.id AND active FOR SHARE) ELSE NULL END;
  IF cfg->>'model_id' IS DISTINCT FROM p.model_id OR (cfg->>'profile_version')::integer IS DISTINCT FROM p.version OR (cfg->>'max_output_tokens')::integer IS DISTINCT FROM p.max_output_tokens
    OR (cfg->>'connection_version')::integer IS DISTINCT FROM p.cv OR cfg->>'connection_id' IS DISTINCT FROM p.cid::text OR cfg->>'provider' IS DISTINCT FROM p.provider OR (cfg->>'grant_version')::integer IS DISTINCT FROM g
    OR s.references_json IS DISTINCT FROM s.context->'summaryContext'->'references' THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;

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
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
CREATE OR REPLACE FUNCTION guard_ai_campaign_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SIMULATION_HISTORY_RETAINED';END IF;
  IF TG_OP='INSERT' THEN
    NEW.references_json=CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN ai_copilot_summary_context(NEW.conversation_id)->'references' ELSE ai_simulation_references(NEW.context->'knowledge') END;NEW.context_hash=encode(sha256(convert_to(NEW.context::text,'UTF8')),'hex');
    IF NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NOT ai_simulation_current(NEW) THEN RAISE EXCEPTION 'AI_SIMULATION_CURRENT_CONTEXT_REQUIRED';END IF;
  ELSE
    IF (NEW.kind,NEW.lead_id,NEW.conversation_id,NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.actor_id,NEW.session_id,NEW.request_id,NEW.request_hash,NEW.question,NEW.context,NEW.context_hash,NEW.references_json,NEW.created_at)
      IS DISTINCT FROM (OLD.kind,OLD.lead_id,OLD.conversation_id,OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.actor_id,OLD.session_id,OLD.request_id,OLD.request_hash,OLD.question,OLD.context,OLD.context_hash,OLD.references_json,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_SIMULATION_IMMUTABLE_CONTEXT_VERSION';END IF;
    IF OLD.state IN ('COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_SIMULATION_TERMINAL';END IF;
    IF NEW.state='RUNNING' THEN
      IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.completed_lease_token IS NOT NULL
        OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds' OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
    ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
      IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
    ELSE
      IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
      IF NEW.state='COMPLETED' AND (NEW.error_code IS NOT NULL OR NOT ai_simulation_current(NEW) OR NOT ai_simulation_result_valid(NEW.result,NEW.references_json)) THEN RAISE EXCEPTION 'AI_SIMULATION_RESULT_PROOF_REQUIRED';END IF;
      IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_SIMULATION_RETRY_REQUIRED';END IF;
      IF NEW.state NOT IN ('QUEUED','COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_SIMULATION_TRANSITION_INVALID';END IF;
    END IF;
  END IF;
  NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION record_ai_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_simulation_history(simulation_id,version,state,attempt_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN 'AI_COPILOT_SUMMARY_' ELSE 'AI_SIMULATION_' END||NEW.state,CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN 'AI_COPILOT_SUMMARY' ELSE 'AI_SIMULATION' END,NEW.id,
    jsonb_build_object('campaignId',NEW.campaign_id,'version',NEW.version,'attempt',NEW.attempt_count,'errorCode',NEW.error_code,'contextHash',NEW.context_hash,
      'knowledgeVersion',CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN NEW.context->'campaignContext'->'knowledge'->'version' ELSE NEW.context->'knowledge'->'version' END,
      'profileId',CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN NEW.context->'campaignContext'->'profiles'->'SUMMARIZATION'->'id' ELSE NEW.context->'profiles'->'CONVERSATION'->'id' END));
  RETURN NEW;END $$;
