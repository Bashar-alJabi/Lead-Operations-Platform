-- Authenticated inbound provenance is independent of employee-session authority.
-- These terminal blocked executions grant NO tool, send, or financial authority.
CREATE TABLE messaging_inbound_authentication (
  event_id uuid PRIMARY KEY REFERENCES integration_event(id),
  method text NOT NULL CHECK(method='META_HMAC_SHA256'),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  payload_sha256 text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_messaging_inbound_authentication() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE e record;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INBOUND_AUTHENTICATION_IMMUTABLE';END IF;
  SELECT e.payload,e.event_kind,c.provider INTO e FROM integration_event e JOIN integration_connection c ON c.id=e.connection_id WHERE e.id=NEW.event_id;
  IF NOT FOUND OR e.event_kind<>'INBOUND_MESSAGE' OR e.provider<>'META_WHATSAPP_CLOUD' THEN RAISE EXCEPTION 'INBOUND_AUTHENTICATION_SOURCE_REQUIRED';END IF;
  NEW.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex');
  NEW.verified_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER inbound_authentication_guard BEFORE INSERT OR UPDATE OR DELETE ON messaging_inbound_authentication FOR EACH ROW EXECUTE FUNCTION guard_messaging_inbound_authentication();

-- One statement produces a coherent historical source snapshot. This is NOT an action authorization function.
CREATE FUNCTION ai_customer_inbound_context(eid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
   'schema',1,'kind','CUSTOMER_INBOUND','assistant','AI_LEAD_ASSISTANT','globalGuardrailsVersion',1,
   'scope',jsonb_build_object('organizationId',l.organization_id,'branchId',l.branch_id,'campaignId',l.campaign_id,'leadId',l.id,'conversationId',cv.id),
   'source',jsonb_build_object('eventId',e.id,'messageId',m.id,'method',a.method,'requestSha256',a.request_sha256,'payloadSha256',a.payload_sha256,
     'messageSha256',encode(sha256(convert_to(m.body,'UTF8')),'hex'),'receivedAt',e.received_at),
   'lead',jsonb_build_object('version',l.version,'lifecycle',l.lifecycle,'ownerId',l.assigned_agent_id),
   'conversation',jsonb_build_object('version',cv.version,'controller',cv.controller_type,'state',cv.state,'attentionReason',cv.needs_attention_reason,
     'senderId',cv.sender_id,'connectionId',cv.connection_id,'latestMessageId',(SELECT cm.id FROM conversation_message cm WHERE cm.conversation_id=cv.id ORDER BY cm.created_at DESC,cm.id DESC LIMIT 1)),
   'branch',jsonb_build_object('active',b.active,'timezone',b.timezone,'messagingPolicyVersion',b.messaging_policy_version),
   'campaign',jsonb_build_object('version',c.version,'status',c.status,'aiEnabled',c.ai_config->'enabled'),
   'sender',jsonb_build_object('active',s.active,'operatorEnabled',s.operator_enabled,'health',s.health,'capabilities',s.capabilities,
     'connectionStatus',mc.status,'connectionVersion',mc.version,'inScope',mc.organization_id=l.organization_id AND (mc.branch_id=l.branch_id OR EXISTS(SELECT 1 FROM sender_branch_binding sb WHERE sb.sender_id=s.id AND sb.branch_id=l.branch_id))),
   'configuration',COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',cfg.scope,'version',cfg.version,'definitionSha256',encode(sha256(convert_to(cfg.definition::text,'UTF8')),'hex')) ORDER BY cfg.scope)
     FROM ai_operational_config cfg WHERE cfg.branch_id=b.id AND (cfg.campaign_id IS NULL OR cfg.campaign_id=c.id)),'[]'),
   'behavior',COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',bp.scope,'version',bp.version,'definitionSha256',encode(sha256(convert_to(bp.definition::text,'UTF8')),'hex')) ORDER BY bp.scope)
     FROM ai_behavior_policy bp WHERE bp.branch_id=b.id AND (bp.campaign_id IS NULL OR bp.campaign_id=c.id)),'[]'),
   'followup',(SELECT jsonb_build_object('version',f.version,'definitionSha256',encode(sha256(convert_to(f.definition::text,'UTF8')),'hex')) FROM ai_followup_policy f WHERE f.campaign_id=c.id),
   'qualification',(SELECT jsonb_build_object('version',q.version,'definitionSha256',encode(sha256(convert_to(q.definition::text,'UTF8')),'hex'),
     'fields',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',fd.id,'definitionVersion',fd.version,'bindingVersion',cf.version,'type',fd.field_type,
       'optionsSha256',encode(sha256(convert_to(fd.options::text,'UTF8')),'hex'),'validationSha256',encode(sha256(convert_to(fd.validation::text,'UTF8')),'hex'),'mode',fd.value_mode,'active',fd.active AND cf.active,'usableByAI',cf.usable_by_ai,
       'inScope',fd.organization_id=l.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id),
       'valueVersion',COALESCE(v.version,0)) ORDER BY fd.id)
       FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id LEFT JOIN lead_field_value v ON v.field_id=fd.id AND v.lead_id=l.id
       WHERE cf.campaign_id=c.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.definition->'questions') i WHERE i->>'fieldId'=fd.id::text)),'[]'),
     'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object('questionId',qa.question_id,'version',qa.version) ORDER BY qa.question_id) FROM lead_qualification_answer qa WHERE qa.lead_id=l.id),'[]'))
     FROM ai_qualification_config q WHERE q.campaign_id=c.id),
   'profile',(SELECT jsonb_build_object('id',p.id,'task',p.task,'modelId',p.model_id,'version',p.version,'maxOutputTokens',p.max_output_tokens,
     'connectionId',ic.id,'connectionVersion',ic.version,'provider',ic.provider,'catalogVersion',ic.capabilities->'catalogVersion',
     'grantVersion',(SELECT g.version FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=b.id AND g.active),
     'usable',b.active AND p.active AND p.task='CONVERSATION' AND p.organization_id=l.organization_id AND ic.organization_id=l.organization_id
       AND ic.kind='AI' AND ic.status='CONNECTED' AND ic.capabilities->>'catalogVersion'=ic.version::text AND ic.capabilities->'models' ? p.model_id
       AND (p.branch_id=b.id AND ic.branch_id=b.id OR p.branch_id IS NULL AND ic.branch_id IS NULL AND EXISTS(SELECT 1 FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=b.id AND g.active)))
     FROM ai_model_profile p JOIN integration_connection ic ON ic.id=p.connection_id WHERE p.id=COALESCE(
       (SELECT (cfg.definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config cfg WHERE cfg.scope='CAMPAIGN' AND cfg.resource_id=c.id),
       (SELECT (cfg.definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config cfg WHERE cfg.scope='BRANCH' AND cfg.resource_id=b.id))),
   'knowledge',(SELECT jsonb_build_object('version',kp.version,'contentSha256',encode(sha256(convert_to(kp.content::text,'UTF8')),'hex'),'assets',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pa.asset_id,'manifestSha256',encode(sha256(convert_to(pa.snapshot::text,'UTF8')),'hex'),'state',ka.state,'approval',ap.decision) ORDER BY pa.asset_id)
     FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id LEFT JOIN ai_knowledge_asset_approval ap ON ap.asset_id=pa.asset_id WHERE pa.campaign_id=c.id AND pa.version=kp.version),'[]'))
     FROM ai_knowledge_publication kp WHERE kp.campaign_id=c.id ORDER BY kp.version DESC LIMIT 1),
   'approvedTools','[]'::jsonb,'liveTransferEnabled',false)
 FROM integration_event e JOIN messaging_inbound_authentication a ON a.event_id=e.id
 JOIN conversation_message m ON m.source_event_id=e.id JOIN conversation cv ON cv.id=m.conversation_id
 JOIN lead l ON l.id=cv.lead_id JOIN campaign c ON c.id=l.campaign_id JOIN branch b ON b.id=l.branch_id
 JOIN messaging_sender s ON s.id=cv.sender_id JOIN integration_connection mc ON mc.id=cv.connection_id
 WHERE e.id=eid AND e.event_kind='INBOUND_MESSAGE' AND e.state='PROCESSED'
   AND e.lead_id=l.id AND e.conversation_id=cv.id AND e.connection_id=cv.connection_id AND e.sender_id=cv.sender_id
   AND m.connection_id=cv.connection_id AND m.sender_id=cv.sender_id AND m.direction='INBOUND' AND m.author_type='CUSTOMER'
   AND e.participant_ref=cv.participant_ref AND e.payload->'message'->>'id'=m.provider_message_id
   AND a.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex')
   AND c.organization_id=l.organization_id AND c.branch_id=l.branch_id AND b.organization_id=l.organization_id
   AND s.organization_id=l.organization_id AND mc.organization_id=l.organization_id AND s.connection_id=mc.id
$$;
CREATE TABLE ai_customer_inbound_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
  lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),message_id uuid NOT NULL UNIQUE REFERENCES conversation_message(id),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),context_hash text NOT NULL,
  state text NOT NULL DEFAULT 'BLOCKED' CHECK(state='BLOCKED'),error_code text NOT NULL DEFAULT 'AI_LIVE_DATA_TRANSFER_DISABLED' CHECK(error_code='AI_LIVE_DATA_TRANSFER_DISABLED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_customer_execution_conversation_history ON ai_customer_inbound_execution(conversation_id,created_at DESC,id DESC);
CREATE FUNCTION guard_ai_customer_inbound_execution() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_CUSTOMER_EXECUTION_IMMUTABLE';END IF;
  ctx=ai_customer_inbound_context(NEW.event_id);
  IF ctx IS NULL OR ctx->'conversation'->>'controller'<>'AI' OR NEW.context IS DISTINCT FROM ctx
    OR ctx->'scope'<>jsonb_build_object('organizationId',NEW.organization_id,'branchId',NEW.branch_id,'campaignId',NEW.campaign_id,'leadId',NEW.lead_id,'conversationId',NEW.conversation_id)
    OR ctx->'source'->>'messageId' IS DISTINCT FROM NEW.message_id::text THEN RAISE EXCEPTION 'AI_CUSTOMER_TRUSTED_SOURCE_REQUIRED';END IF;
  NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_inbound_execution FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_inbound_execution();
CREATE FUNCTION record_ai_customer_inbound_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(NEW.organization_id,NEW.branch_id,NULL,'AI_CUSTOMER_INBOUND_BLOCKED','AI_EXECUTION',NEW.id,
      jsonb_build_object('assistant','AI_LEAD_ASSISTANT','leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,'messageId',NEW.message_id,
        'eventId',NEW.event_id,'knowledgeVersion',NEW.context->'knowledge'->'version','profileId',NEW.context->'profile'->'id','contextHash',NEW.context_hash,'errorCode',NEW.error_code));
  RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_execution_record AFTER INSERT ON ai_customer_inbound_execution FOR EACH ROW EXECUTE FUNCTION record_ai_customer_inbound_execution();
