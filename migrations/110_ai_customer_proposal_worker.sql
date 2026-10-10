-- Autonomous customer proposals use authenticated inbound, never a publishing employee's session.
-- A proposal is not a tool/action authorization. Old terminal BLOCKED journals remain immutable.
CREATE FUNCTION ai_customer_proposal_context(eid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH source AS (SELECT ai_customer_inbound_context(eid) AS ctx)
 SELECT ctx || jsonb_build_object('kind','CUSTOMER_PROPOSAL','protocolVersion',1,
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
CREATE FUNCTION ai_customer_proposal_locked_context(eid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s record;selected uuid;BEGIN
 SELECT l.id AS lid,l.branch_id AS bid,l.campaign_id AS cid,l.contact_id AS contact,cv.id AS cvid,cv.sender_id,cv.connection_id
 INTO s FROM integration_event e JOIN conversation cv ON cv.id=e.conversation_id JOIN lead l ON l.id=cv.lead_id WHERE e.id=eid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=s.bid FOR SHARE;
 -- Missing Branch defaults need a parent fence against the first INSERT (which takes Branch SHARE).
 IF NOT EXISTS(SELECT 1 FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=s.bid) THEN PERFORM 1 FROM branch WHERE id=s.bid FOR UPDATE;END IF;
 PERFORM 1 FROM campaign WHERE id=s.cid FOR SHARE;
 PERFORM 1 FROM lead WHERE id=s.lid AND branch_id=s.bid AND campaign_id=s.cid FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM conversation WHERE id=s.cvid AND lead_id=s.lid AND sender_id=s.sender_id AND connection_id=s.connection_id FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM messaging_sender WHERE id=s.sender_id FOR SHARE;
 PERFORM 1 FROM integration_connection WHERE id=s.connection_id FOR SHARE;
 PERFORM 1 FROM sender_branch_binding WHERE sender_id=s.sender_id AND branch_id=s.bid FOR SHARE;
 PERFORM 1 FROM messaging_consent WHERE contact_id=s.contact AND channel='WHATSAPP' FOR SHARE;
 PERFORM 1 FROM ai_operational_config WHERE branch_id=s.bid AND (campaign_id IS NULL OR campaign_id=s.cid) ORDER BY scope FOR SHARE;
 PERFORM 1 FROM ai_behavior_policy WHERE branch_id=s.bid AND (campaign_id IS NULL OR campaign_id=s.cid) ORDER BY scope FOR SHARE;
 PERFORM 1 FROM ai_followup_policy WHERE campaign_id=s.cid FOR SHARE;
 PERFORM 1 FROM ai_qualification_config WHERE campaign_id=s.cid FOR SHARE;
 PERFORM 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=s.cid ORDER BY fd.id FOR SHARE OF cf,fd;
 PERFORM 1 FROM lead_field_value WHERE lead_id=s.lid ORDER BY field_id FOR SHARE;
 PERFORM 1 FROM lead_qualification_answer WHERE lead_id=s.lid ORDER BY question_id FOR SHARE;
 SELECT COALESCE((SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=s.cid),
   (SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=s.bid)) INTO selected;
 IF selected IS NULL OR NOT ai_operational_profile_usable(s.bid,selected,'CONVERSATION') THEN RETURN NULL;END IF;
 PERFORM 1 FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id LEFT JOIN ai_knowledge_asset_approval ap ON ap.asset_id=ka.id
   WHERE pa.campaign_id=s.cid AND pa.version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid) ORDER BY ka.id FOR SHARE OF ka;
 PERFORM 1 FROM ai_knowledge_asset_approval WHERE asset_id IN (SELECT asset_id FROM ai_knowledge_publication_asset WHERE campaign_id=s.cid AND version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid)) ORDER BY asset_id FOR SHARE;
 RETURN ai_customer_proposal_context(eid);
END $$;

CREATE TABLE ai_customer_proposal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),message_id uuid NOT NULL UNIQUE REFERENCES conversation_message(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),context_hash text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','PROPOSED','FAILED','BLOCKED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,completed_lease_token uuid,
 result jsonb,error_code text CHECK(error_code ~ '^[A-Z_]{1,100}$'),provider_invoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state='RUNNING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL OR state<>'RUNNING' AND lease_token IS NULL AND lease_until IS NULL),
 CHECK((state='PROPOSED')=(result IS NOT NULL)),CHECK(state NOT IN ('FAILED','BLOCKED') OR error_code IS NOT NULL)
);
CREATE INDEX ai_customer_proposal_queue ON ai_customer_proposal(available_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX ai_customer_proposal_history_page ON ai_customer_proposal(conversation_id,created_at DESC,id DESC);
CREATE TABLE ai_customer_proposal_history (
 proposal_id uuid NOT NULL REFERENCES ai_customer_proposal(id),version integer NOT NULL,state text NOT NULL,attempt_count integer NOT NULL,error_code text,provider_invoked boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(proposal_id,version)
);
CREATE FUNCTION ai_customer_proposal_result_valid(r jsonb,ctx jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE q jsonb;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>10 OR NOT r ?& ARRAY['decision','referenceIds','questionId','answerValue','sourceQuote','handoffReason','protocolVersion','toolsExecuted','sendAllowed','mutationsAllowed']
   OR r->'protocolVersion'<>'1' OR r->'toolsExecuted'<>'[]' OR r->'sendAllowed'<>'false' OR r->'mutationsAllowed'<>'false'
   OR jsonb_typeof(r->'referenceIds')<>'array' OR jsonb_array_length(r->'referenceIds')>8 THEN RETURN false;END IF;
 IF (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(r->'referenceIds') id)<>jsonb_array_length(r->'referenceIds')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'referenceIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'references') ref WHERE ref->>'id'=id)) THEN RETURN false;END IF;
 IF r->>'decision'='HANDOFF' THEN RETURN jsonb_array_length(r->'referenceIds')=0 AND r->'questionId'='null' AND r->'answerValue'='null' AND r->'sourceQuote'='null'
   AND r->>'handoffReason' IN ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE');END IF;
 IF r->>'decision'='ANSWER' THEN RETURN jsonb_array_length(r->'referenceIds')>0 AND r->'questionId'='null' AND r->'answerValue'='null' AND r->'sourceQuote'='null' AND r->'handoffReason'='null';END IF;
 IF r->>'decision' NOT IN ('QUESTION','QUALIFICATION') OR jsonb_array_length(r->'referenceIds')<>0 OR r->'handoffReason'<>'null' THEN RETURN false;END IF;
 SELECT item INTO q FROM jsonb_array_elements(ctx->'questions') item WHERE item->>'id'=r->>'questionId';IF q IS NULL THEN RETURN false;END IF;
 IF r->>'decision'='QUESTION' THEN RETURN r->'answerValue'='null' AND r->'sourceQuote'='null';END IF;
 RETURN r->'answerValue'<>'null' AND jsonb_typeof(r->'answerValue') IN ('string','boolean','number','array') AND length(trim(r->>'sourceQuote')) BETWEEN 1 AND 500
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'messages') m WHERE m->>'id'=ctx->'source'->>'messageId' AND m->>'speaker'='CUSTOMER' AND strpos(m->>'text',r->>'sourceQuote')>0);
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION guard_ai_customer_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   ctx=ai_customer_proposal_context(NEW.event_id);
   IF ctx IS NULL OR ctx IS DISTINCT FROM NEW.context OR ctx->'scope'<>jsonb_build_object('organizationId',NEW.organization_id,'branchId',NEW.branch_id,'campaignId',NEW.campaign_id,'leadId',NEW.lead_id,'conversationId',NEW.conversation_id)
     OR ctx->'source'->>'messageId' IS DISTINCT FROM NEW.message_id::text OR NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
     OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NEW.provider_invoked THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_SOURCE_REQUIRED';END IF;
   NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.created_at=clock_timestamp();
 ELSE
   IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.event_id,NEW.message_id,NEW.context,NEW.context_hash,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id,OLD.event_id,OLD.message_id,OLD.context,OLD.context_hash,OLD.created_at) OR NEW.version<>OLD.version+1 OR OLD.provider_invoked AND NOT NEW.provider_invoked
     THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_IMMUTABLE_CONTEXT';END IF;
   IF OLD.state IN ('PROPOSED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_TERMINAL';END IF;
   IF NEW.state='RUNNING' THEN
     IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1
       OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.completed_lease_token IS NOT NULL OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds'
       OR NEW.error_code IS NOT NULL OR NEW.provider_invoked IS DISTINCT FROM OLD.provider_invoked THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_LEASE_REQUIRED';END IF;
   ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
     IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_LEASE_REQUIRED';END IF;
   ELSE
     IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_LEASE_REQUIRED';END IF;
     IF NEW.state='PROPOSED' THEN
       ctx=ai_customer_proposal_locked_context(NEW.event_id);
       IF NOT NEW.provider_invoked OR NEW.error_code IS NOT NULL OR ctx IS DISTINCT FROM NEW.context OR NOT ai_customer_proposal_result_valid(NEW.result,ctx) THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_RESULT_REQUIRED';END IF;
     END IF;
     IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_RETRY_REQUIRED';END IF;
     IF NEW.state NOT IN ('QUEUED','PROPOSED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_TRANSITION_INVALID';END IF;
   END IF;
 END IF;NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_customer_proposal_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_proposal();
CREATE FUNCTION guard_ai_customer_proposal_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_customer_proposal p WHERE p.id=NEW.proposal_id AND (p.version,p.state,p.attempt_count,p.error_code,p.provider_invoked) IS NOT DISTINCT FROM (NEW.version,NEW.state,NEW.attempt_count,NEW.error_code,NEW.provider_invoked)) THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_customer_proposal_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_proposal_history FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_proposal_history();
CREATE FUNCTION record_ai_customer_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_customer_proposal_history(proposal_id,version,state,attempt_count,error_code,provider_invoked) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code,NEW.provider_invoked);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NULL,'AI_CUSTOMER_PROPOSAL_'||NEW.state,'AI_EXECUTION',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','leadId',NEW.lead_id,'conversationId',NEW.conversation_id,'campaignId',NEW.campaign_id,'eventId',NEW.event_id,'messageId',NEW.message_id,'version',NEW.version,'attempt',NEW.attempt_count,'errorCode',NEW.error_code,'providerInvoked',NEW.provider_invoked,'contextHash',NEW.context_hash,'knowledgeVersion',NEW.context->'knowledge'->'version'));
 RETURN NEW;END $$;
CREATE TRIGGER ai_customer_proposal_record AFTER INSERT OR UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION record_ai_customer_proposal();
