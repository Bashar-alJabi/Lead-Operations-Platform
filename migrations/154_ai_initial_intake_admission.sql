-- Initial-contact admission is a non-inbound source. It does not authorize an outbound send.
CREATE FUNCTION ai_initial_sender_context(lid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE l lead;b branch;c campaign;s record;selected uuid;n integer;reason_code text;BEGIN
 SELECT * INTO l FROM lead WHERE id=lid;IF l IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO b FROM branch WHERE id=l.branch_id;SELECT * INTO c FROM campaign WHERE id=l.campaign_id;
 selected=COALESCE(c.sender_override_id,b.default_sender_id);
 IF selected IS NULL THEN
  SELECT count(*),min(ms.id::text)::uuid INTO n,selected FROM sender_branch_binding sb JOIN messaging_sender ms ON ms.id=sb.sender_id
   JOIN integration_connection ic ON ic.id=ms.connection_id WHERE sb.branch_id=b.id AND sb.allow_shared_fallback
   AND ic.branch_id IS NULL AND ic.kind='MESSAGING' AND ms.organization_id=l.organization_id;
  IF n<>1 THEN RETURN jsonb_build_object('senderId',NULL,'reason',CASE WHEN n=0 THEN 'NO_SENDER' ELSE 'SHARED_FALLBACK_AMBIGUOUS' END,'usable',false);END IF;
 END IF;
 SELECT ms.*,ic.branch_id AS connection_branch,ic.organization_id AS connection_org,ic.kind,ic.status AS connection_status,ic.version AS connection_version,ic.provider,
  sb.branch_id AS bound_branch,sb.allow_shared_fallback INTO s FROM messaging_sender ms JOIN integration_connection ic ON ic.id=ms.connection_id
  LEFT JOIN sender_branch_binding sb ON sb.sender_id=ms.id AND sb.branch_id=b.id WHERE ms.id=selected AND ms.organization_id=l.organization_id AND ic.kind='MESSAGING';
 IF s IS NULL THEN RETURN jsonb_build_object('senderId',selected,'reason','CONFIGURED_SENDER_MISSING','usable',false);END IF;
 IF s.connection_org<>l.organization_id OR NOT (s.connection_branch IS NOT DISTINCT FROM b.id OR s.bound_branch IS NOT DISTINCT FROM b.id) THEN reason_code='SENDER_OUT_OF_SCOPE';
 ELSIF NOT s.active OR NOT s.operator_enabled THEN reason_code='SENDER_DISABLED';
 ELSIF s.connection_status<>'CONNECTED' THEN reason_code='CONNECTION_NOT_READY';
 ELSIF s.health NOT IN ('HEALTHY','DEGRADED') THEN reason_code='SENDER_UNHEALTHY';
 ELSIF s.capabilities->>'text' IS DISTINCT FROM 'true' THEN reason_code='TEXT_NOT_SUPPORTED';
 ELSE reason_code=CASE WHEN c.sender_override_id IS NOT NULL THEN 'CAMPAIGN_OVERRIDE' WHEN b.default_sender_id IS NOT NULL THEN 'BRANCH_DEFAULT' ELSE 'SHARED_FALLBACK' END;END IF;
 RETURN jsonb_build_object('senderId',s.id,'connectionId',s.connection_id,'connectionVersion',s.connection_version,'connectionStatus',s.connection_status,'provider',s.provider,
  'active',s.active,'operatorEnabled',s.operator_enabled,'health',s.health,'capabilities',s.capabilities,'boundBranchId',s.bound_branch,'allowSharedFallback',s.allow_shared_fallback,
  'reason',reason_code,'usable',reason_code IN ('CAMPAIGN_OVERRIDE','BRANCH_DEFAULT','SHARED_FALLBACK'));
END $$;

CREATE FUNCTION ai_initial_intake_context(rid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('schema',1,'kind','LEAD_INTAKE_INITIAL','assistant','AI_LEAD_ASSISTANT','globalGuardrailsVersion',1,
  'scope',r.context->'scope','source',jsonb_build_object('receiptId',r.id,'originKind',r.origin_kind,'submissionId',r.submission_id,'routingHistoryId',r.routing_history_id),
  'lead',jsonb_build_object('version',l.version,'lifecycle',l.lifecycle,'ownerId',l.assigned_agent_id,'contactId',l.contact_id,'attentionReason',l.needs_attention_reason),
  'contact',jsonb_build_object('available',ct.id IS NOT NULL AND ct.organization_id=l.organization_id,'phoneAvailable',NULLIF(ct.phone_normalized,'') IS NOT NULL),
  'branch',jsonb_build_object('active',b.active,'timezone',b.timezone,'messagingPolicyVersion',b.messaging_policy_version,'messagingWindow',b.messaging_window,'businessHours',b.business_hours),
  'campaign',jsonb_build_object('version',c.version,'status',c.status,'aiEnabled',c.ai_config->'enabled','messagingEnabled',c.messaging_config->'enabled','messagingPolicy',c.messaging_policy),
  'configuration',COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',cfg.scope,'version',cfg.version,'definition',cfg.definition) ORDER BY cfg.scope)
    FROM ai_operational_config cfg WHERE cfg.branch_id=b.id AND (cfg.campaign_id IS NULL OR cfg.campaign_id=c.id)),'[]'),
  'behavior',COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',bp.scope,'version',bp.version,'definition',bp.definition) ORDER BY bp.scope)
    FROM ai_behavior_policy bp WHERE bp.branch_id=b.id AND (bp.campaign_id IS NULL OR bp.campaign_id=c.id)),'[]'),
  'effective',jsonb_build_object('language',COALESCE(NULLIF(cc.definition->'language','null'),bc.definition->'language','null'),
    'tone',COALESCE(NULLIF(cc.definition->'tone','null'),bc.definition->'tone','null'),
    'disclosure',COALESCE(NULLIF(cb.definition->'disclosure','null'),bb.definition->'disclosure','null'),
    'handoff',COALESCE(NULLIF(cb.definition->'handoff','null'),bb.definition->'handoff','null'),
    'returningContact',COALESCE(cb.definition->'returningContact','null')),
  'followup',(SELECT jsonb_build_object('version',f.version,'definition',f.definition) FROM ai_followup_policy f WHERE f.campaign_id=c.id),
  'qualification',(SELECT jsonb_build_object('version',q.version,'definition',q.definition,
    'fields',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',fd.id,'definitionVersion',fd.version,'bindingVersion',cf.version,'type',fd.field_type,'mode',fd.value_mode,
      'active',fd.active AND cf.active,'usableByAI',cf.usable_by_ai,'inScope',fd.organization_id=l.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id),
      'optionsSha256',encode(sha256(convert_to(fd.options::text,'UTF8')),'hex'),'validationSha256',encode(sha256(convert_to(fd.validation::text,'UTF8')),'hex'),'valueVersion',COALESCE(v.version,0)) ORDER BY fd.id)
      FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id LEFT JOIN lead_field_value v ON v.field_id=fd.id AND v.lead_id=l.id
      WHERE cf.campaign_id=c.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.definition->'questions') item WHERE item->>'fieldId'=fd.id::text)),'[]'),
    'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object('questionId',qa.question_id,'version',qa.version) ORDER BY qa.question_id) FROM lead_qualification_answer qa WHERE qa.lead_id=l.id),'[]'))
    FROM ai_qualification_config q WHERE q.campaign_id=c.id),
  'profile',(SELECT jsonb_build_object('id',p.id,'version',p.version,'task',p.task,'modelId',p.model_id,'maxOutputTokens',p.max_output_tokens,
    'connectionId',ic.id,'connectionVersion',ic.version,'provider',ic.provider,'catalogVersion',ic.capabilities->'catalogVersion',
    'grantVersion',(SELECT g.version FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=b.id AND g.active),
    'usable',p.active AND p.task='CONVERSATION' AND p.organization_id=l.organization_id AND ic.organization_id=l.organization_id AND ic.kind='AI' AND ic.status='CONNECTED'
      AND ic.capabilities->>'catalogVersion'=ic.version::text AND ic.capabilities->'models' ? p.model_id
      AND (p.branch_id=b.id AND ic.branch_id=b.id OR p.branch_id IS NULL AND ic.branch_id IS NULL AND EXISTS(SELECT 1 FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=b.id AND g.active)))
    FROM ai_model_profile p JOIN integration_connection ic ON ic.id=p.connection_id WHERE p.id=COALESCE((cc.definition->'profiles'->>'CONVERSATION')::uuid,(bc.definition->'profiles'->>'CONVERSATION')::uuid)),
  'knowledge',(SELECT jsonb_build_object('version',kp.version,'contentSha256',encode(sha256(convert_to(kp.content::text,'UTF8')),'hex'),
    'assets',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pa.asset_id,'manifestSha256',encode(sha256(convert_to(pa.snapshot::text,'UTF8')),'hex'),'state',ka.state,'approval',ap.decision) ORDER BY pa.asset_id)
      FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id LEFT JOIN ai_knowledge_asset_approval ap ON ap.asset_id=pa.asset_id WHERE pa.campaign_id=c.id AND pa.version=kp.version),'[]'))
    FROM ai_knowledge_publication kp WHERE kp.campaign_id=c.id ORDER BY kp.version DESC LIMIT 1),
  'toolPolicy',ai_effective_tool_policy(b.id,c.id),'sender',ai_initial_sender_context(l.id),
  'availability',jsonb_build_object('ownerId',l.assigned_agent_id,'ownerEligible',COALESCE(u.active AND u.role='AGENT' AND u.branch_id=b.id AND u.organization_id=l.organization_id AND ca.active,false),
    'ownerAvailable',COALESCE(u.active AND u.role='AGENT' AND u.branch_id=b.id AND u.organization_id=l.organization_id AND ca.active
      AND operational_hours_open(b.business_hours,b.timezone,at_time) AND operational_hours_open(u.working_hours,b.timezone,at_time),false),
    'ownerHours',u.working_hours,'branchHoursVersion',COALESCE((SELECT version FROM operational_hours_policy WHERE scope='BRANCH' AND resource_id=b.id),0),
    'ownerHoursVersion',COALESCE((SELECT version FROM operational_hours_policy WHERE scope='USER' AND resource_id=u.id),0),
    'fallback',jsonb_build_object('kind','BRANCH_MANAGER_ATTENTION','branchId',b.id)),
  'existingConversationIds',COALESCE((SELECT jsonb_agg(cv.id ORDER BY cv.id) FROM conversation cv WHERE cv.lead_id=l.id),'[]'),
  'consent',jsonb_build_object('status',COALESCE(co.status,'UNKNOWN'),'doNotContact',COALESCE(co.do_not_contact,false),'versionTime',co.updated_at),
  'liveTransferEnabled',false,'sendAuthorized',false)
 FROM lead_intake_receipt r JOIN lead l ON l.id=r.lead_id JOIN branch b ON b.id=l.branch_id AND b.organization_id=l.organization_id
 JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=b.id AND c.organization_id=l.organization_id LEFT JOIN contact ct ON ct.id=l.contact_id
 LEFT JOIN ai_operational_config bc ON bc.scope='BRANCH' AND bc.resource_id=b.id LEFT JOIN ai_operational_config cc ON cc.scope='CAMPAIGN' AND cc.resource_id=c.id
 LEFT JOIN ai_behavior_policy bb ON bb.scope='BRANCH' AND bb.resource_id=b.id LEFT JOIN ai_behavior_policy cb ON cb.scope='CAMPAIGN' AND cb.resource_id=c.id
 LEFT JOIN user_account u ON u.id=l.assigned_agent_id LEFT JOIN campaign_agent ca ON ca.agent_id=u.id AND ca.campaign_id=c.id
 LEFT JOIN messaging_consent co ON co.contact_id=ct.id AND co.channel='WHATSAPP' WHERE r.id=rid
$$;

CREATE FUNCTION ai_initial_admission_blockers(ctx jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$ DECLARE reasons text[]='{}';q jsonb;BEGIN
 IF ctx IS NULL THEN RETURN '["AI_INITIAL_SOURCE_UNAVAILABLE"]';END IF;
 IF ctx->'branch'->>'active' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'BRANCH_DISABLED');END IF;
 IF ctx->'campaign'->>'status' IS DISTINCT FROM 'ACTIVE' THEN reasons=array_append(reasons,'CAMPAIGN_NOT_ACTIVE');END IF;
 IF ctx->'campaign'->>'aiEnabled' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'AI_DISABLED');END IF;
 IF ctx->'campaign'->>'messagingEnabled' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'MESSAGING_DISABLED');END IF;
 IF ctx->'lead'->>'lifecycle' IS DISTINCT FROM 'OPEN' THEN reasons=array_append(reasons,'LEAD_NOT_OPEN');END IF;
 IF ctx->'contact'->>'available' IS DISTINCT FROM 'true' OR ctx->'contact'->>'phoneAvailable' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'AI_INITIAL_CONTACT_REQUIRED');END IF;
 IF ctx->'profile'->>'usable' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'AI_CONVERSATION_PROFILE_UNAVAILABLE');END IF;
 IF ctx->'knowledge'->>'version' IS NULL THEN reasons=array_append(reasons,'AI_PUBLISHED_KNOWLEDGE_REQUIRED');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(ctx->'knowledge'->'assets','null'),'[]')) a WHERE a->>'state' IS DISTINCT FROM 'REVIEW' OR a->>'approval' IS DISTINCT FROM 'APPROVED') THEN reasons=array_append(reasons,'AI_PUBLISHED_ASSET_UNAVAILABLE');END IF;
 IF ctx->'effective'->>'language' IS NULL THEN reasons=array_append(reasons,'AI_LANGUAGE_REQUIRED');END IF;
 IF ctx->'effective'->>'disclosure' IS NULL THEN reasons=array_append(reasons,'AI_DISCLOSURE_POLICY_REQUIRED');END IF;
 IF ctx->'effective'->>'handoff' IS NULL THEN reasons=array_append(reasons,'AI_HANDOFF_POLICY_REQUIRED');END IF;
 IF ctx->'availability'->>'ownerAvailable' IS DISTINCT FROM 'true' AND ctx->'effective'->'handoff'->>'initialContactWithoutAgent' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'AI_INITIAL_WITHOUT_AVAILABLE_AGENT_NOT_ALLOWED');END IF;
 IF NOT COALESCE(ctx->'toolPolicy'->'allowedTools' ? 'sendConversationMessage',false) THEN reasons=array_append(reasons,'AI_SEND_TOOL_NOT_APPROVED');END IF;
 IF ctx->'sender'->>'usable' IS DISTINCT FROM 'true' THEN reasons=array_append(reasons,'AI_MESSAGING_SENDER_UNAVAILABLE');END IF;
 IF jsonb_array_length(ctx->'existingConversationIds')>0 THEN reasons=array_append(reasons,'AI_INITIAL_EXISTING_CONVERSATION_REQUIRES_REVIEW');END IF;
 q=ctx->'qualification';
 IF q->'definition'->>'enabled'='true' AND (
   EXISTS(SELECT 1 FROM jsonb_array_elements(q->'fields') f WHERE f->>'active' IS DISTINCT FROM 'true' OR f->>'usableByAI' IS DISTINCT FROM 'true' OR f->>'inScope' IS DISTINCT FROM 'true' OR f->>'mode' IS DISTINCT FROM 'MANUAL')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'definition'->'questions') item WHERE item->>'fieldId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'fields') f WHERE f->>'id'=item->>'fieldId')))
 THEN reasons=array_append(reasons,'AI_QUALIFICATION_FIELD_UNAVAILABLE');END IF;
 -- Consent/template/window/rate checks belong to Central Messaging Policy before action and dispatch.
 RETURN to_jsonb(reasons);
END $$;

CREATE TABLE ai_initial_admission (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),receipt_id uuid NOT NULL UNIQUE REFERENCES lead_intake_receipt(id),
 state text NOT NULL DEFAULT 'BLOCKED' CHECK(state IN ('ADMITTED','BLOCKED')),blockers jsonb NOT NULL DEFAULT '[]',
 context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),context_hash text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ai_initial_locked_context(rid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE r record;pid uuid;BEGIN
 SELECT l.id,l.branch_id,l.campaign_id,l.contact_id,l.assigned_agent_id INTO r FROM lead_intake_receipt ir JOIN lead l ON l.id=ir.lead_id WHERE ir.id=rid;
 IF r IS NULL THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=r.branch_id FOR UPDATE;PERFORM 1 FROM campaign WHERE id=r.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=r.id AND branch_id=r.branch_id AND campaign_id=r.campaign_id AND contact_id IS NOT DISTINCT FROM r.contact_id AND assigned_agent_id IS NOT DISTINCT FROM r.assigned_agent_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM contact WHERE id=r.contact_id FOR SHARE;
 PERFORM 1 FROM ai_operational_config WHERE branch_id=r.branch_id AND (scope='BRANCH' OR campaign_id=r.campaign_id) ORDER BY scope,resource_id FOR SHARE;
 PERFORM 1 FROM ai_behavior_policy WHERE branch_id=r.branch_id AND (scope='BRANCH' OR campaign_id=r.campaign_id) ORDER BY scope,resource_id FOR SHARE;
 PERFORM 1 FROM ai_tool_policy WHERE branch_id=r.branch_id AND (scope='BRANCH' OR campaign_id=r.campaign_id) ORDER BY scope,resource_id FOR SHARE;
 PERFORM 1 FROM ai_followup_policy WHERE campaign_id=r.campaign_id FOR SHARE;PERFORM 1 FROM ai_qualification_config WHERE campaign_id=r.campaign_id FOR SHARE;
 PERFORM 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=r.campaign_id ORDER BY fd.id FOR SHARE OF cf,fd;
 PERFORM 1 FROM lead_field_value WHERE lead_id=r.id ORDER BY field_id FOR SHARE;PERFORM 1 FROM lead_qualification_answer WHERE lead_id=r.id ORDER BY question_id FOR SHARE;
 PERFORM 1 FROM user_account WHERE id=r.assigned_agent_id FOR SHARE;PERFORM 1 FROM campaign_agent WHERE campaign_id=r.campaign_id AND agent_id=r.assigned_agent_id FOR SHARE;
 SELECT COALESCE((SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=r.campaign_id),
   (SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=r.branch_id)) INTO pid;
 PERFORM 1 FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=pid FOR SHARE OF pr,ic;
 PERFORM 1 FROM ai_connection_branch_use g JOIN ai_model_profile pr ON pr.connection_id=g.connection_id WHERE pr.id=pid AND g.branch_id=r.branch_id FOR SHARE OF g;
 PERFORM 1 FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id WHERE pa.campaign_id=r.campaign_id AND pa.version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=r.campaign_id) ORDER BY ka.id FOR SHARE OF ka;
 PERFORM 1 FROM ai_knowledge_asset_approval WHERE asset_id IN (SELECT asset_id FROM ai_knowledge_publication_asset WHERE campaign_id=r.campaign_id AND version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=r.campaign_id)) ORDER BY asset_id FOR SHARE;
 PERFORM 1 FROM messaging_sender ms JOIN integration_connection ic ON ic.id=ms.connection_id WHERE ms.id=(ai_initial_sender_context(r.id)->>'senderId')::uuid FOR SHARE OF ms,ic;
 PERFORM 1 FROM sender_branch_binding WHERE branch_id=r.branch_id ORDER BY sender_id FOR SHARE;
 PERFORM 1 FROM messaging_consent WHERE contact_id=r.contact_id AND channel='WHATSAPP' FOR SHARE;
 RETURN ai_initial_intake_context(rid,at_time);
END $$;
CREATE FUNCTION guard_ai_initial_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_INITIAL_ADMISSION_IMMUTABLE';END IF;
 SELECT ir.*,ir.xmin AS row_xid INTO r FROM lead_intake_receipt ir JOIN lead_intake_birth bi ON bi.lead_id=ir.lead_id AND ai_row_inserted_here(bi.xmin) WHERE ir.id=NEW.receipt_id;
 IF r IS NULL OR NOT ai_row_inserted_here(r.row_xid) THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_INTAKE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();ctx=ai_initial_locked_context(NEW.receipt_id,NEW.created_at);
 IF ctx IS NULL OR ctx->'campaign'->>'aiEnabled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'AI_INITIAL_ENABLED_SOURCE_REQUIRED';END IF;
 NEW.context=ctx;NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.blockers=ai_initial_admission_blockers(ctx);
 NEW.state=CASE WHEN NEW.blockers='[]' THEN 'ADMITTED' ELSE 'BLOCKED' END;RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_admission FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_admission();
CREATE FUNCTION prove_ai_initial_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ai_initial_intake_context(NEW.receipt_id,NEW.created_at) IS DISTINCT FROM NEW.context THEN RAISE EXCEPTION 'AI_INITIAL_ATOMIC_CONTEXT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_initial_admission_proof AFTER INSERT ON ai_initial_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_initial_admission();
CREATE FUNCTION admit_initial_ai_intake() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a ai_initial_admission;BEGIN
 IF EXISTS(SELECT 1 FROM lead l JOIN campaign c ON c.id=l.campaign_id WHERE l.id=NEW.lead_id AND c.ai_config->>'enabled'='true') THEN
  INSERT INTO ai_initial_admission(receipt_id) VALUES(NEW.id) RETURNING * INTO a;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,NEW.actor_id,'AI_INITIAL_INTAKE_ASSESSED','LEAD',NEW.lead_id,
    jsonb_build_object('admissionId',a.id,'receiptId',NEW.id,'state',a.state,'blockers',a.blockers,'contextHash',a.context_hash,'knowledgeVersion',a.context->'knowledge'->'version'));
  INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(NEW.lead_id,NEW.actor_id,'AI_INITIAL_INTAKE_ASSESSED',jsonb_build_object('admissionId',a.id,'state',a.state,'blockers',a.blockers));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER initial_ai_intake_admit AFTER INSERT ON lead_intake_receipt FOR EACH ROW EXECUTE FUNCTION admit_initial_ai_intake();
CREATE FUNCTION ai_initial_admission_current(aid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE a ai_initial_admission;ctx jsonb;BEGIN
 SELECT * INTO a FROM ai_initial_admission WHERE id=aid AND state='ADMITTED';IF a IS NULL THEN RETURN NULL;END IF;
 ctx=ai_initial_locked_context(a.receipt_id,a.created_at);IF ctx IS DISTINCT FROM a.context THEN RETURN NULL;END IF;
 ctx=ai_initial_intake_context(a.receipt_id,clock_timestamp());IF ai_initial_admission_blockers(ctx)<>'[]' THEN RETURN NULL;END IF;RETURN ctx;
END $$;
-- No backfill, customer proposal/inbound, queued work, Conversation, message, or live transfer.
