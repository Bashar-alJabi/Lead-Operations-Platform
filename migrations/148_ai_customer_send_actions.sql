-- Actual local send intent. External dispatch remains a separately gated operation.
CREATE FUNCTION ai_customer_send_content(pid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p record;body text;disclosure jsonb;question jsonb;value jsonb;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid AND state='PROPOSED' AND result->>'decision' IN ('ANSWER','QUESTION');
 IF p IS NULL OR NOT ai_customer_proposal_result_valid(p.result,p.context) THEN RETURN NULL;END IF;
 IF p.result->>'decision'='ANSWER' THEN
   SELECT string_agg(r->>'text',E'\n\n' ORDER BY ids.n) INTO body FROM jsonb_array_elements_text(p.result->'referenceIds') WITH ORDINALITY ids(id,n)
     JOIN LATERAL jsonb_array_elements(p.context->'references') r ON r->>'id'=ids.id;
 ELSE
   SELECT q INTO question FROM ai_qualification_config qc CROSS JOIN LATERAL jsonb_array_elements(qc.definition->'questions') q
     WHERE qc.campaign_id=p.campaign_id AND qc.definition->>'enabled'='true' AND q->>'id'=p.result->>'questionId';
   IF question IS NULL THEN RETURN NULL;END IF;
   IF question->>'fieldId' IS NOT NULL THEN SELECT fv.value INTO value FROM lead_field_value fv WHERE fv.lead_id=p.lead_id AND fv.field_id=(question->>'fieldId')::uuid;
   ELSE SELECT qa.value INTO value FROM lead_qualification_answer qa WHERE qa.lead_id=p.lead_id AND qa.question_id=(question->>'id')::uuid AND qa.question_snapshot=question;END IF;
   IF ai_qualification_answered(value) THEN RETURN NULL;END IF;
   body=question->>'prompt';
 END IF;
 SELECT COALESCE(NULLIF(cp.definition->'disclosure','null'),bp.definition->'disclosure','null') INTO disclosure
   FROM campaign c LEFT JOIN ai_behavior_policy cp ON cp.scope='CAMPAIGN' AND cp.resource_id=c.id
   LEFT JOIN ai_behavior_policy bp ON bp.scope='BRANCH' AND bp.resource_id=c.branch_id WHERE c.id=p.campaign_id;
 IF disclosure IS NOT NULL AND disclosure<>'null' AND (disclosure->>'mode'='EVERY_AI_MESSAGE' OR NOT EXISTS(
   SELECT 1 FROM conversation_message m WHERE m.conversation_id=p.conversation_id AND m.direction='OUTBOUND' AND m.author_type='AI' AND m.delivery_state IN ('SENT','DELIVERED','READ'))) THEN
   body=(disclosure->>'text')||E'\n\n'||body;
 ELSE disclosure='null';END IF;
 IF body IS NULL OR length(trim(body))=0 OR length(body)>20000 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('body',body,'decision',p.result->'decision','referenceIds',p.result->'referenceIds','questionId',p.result->'questionId','disclosure',disclosure);
END $$;

CREATE TABLE ai_customer_send_job (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_send_admission(proposal_id),state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','DONE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,CHECK((state='DONE')=(completed_at IS NOT NULL))
);
CREATE INDEX ai_send_pending ON ai_customer_send_job(created_at,proposal_id) WHERE state='QUEUED';
CREATE TABLE ai_customer_send_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_id uuid NOT NULL UNIQUE REFERENCES ai_customer_send_admission(proposal_id),
 lead_id uuid NOT NULL REFERENCES lead(id),campaign_id uuid NOT NULL REFERENCES campaign(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 tool text NOT NULL DEFAULT 'sendConversationMessage' CHECK(tool='sendConversationMessage'),state text NOT NULL CHECK(state IN ('APPLIED','BLOCKED')),
 error_code text CHECK(error_code ~ '^[A-Z_]{1,100}$'),message_id uuid UNIQUE REFERENCES conversation_message(id) DEFERRABLE INITIALLY DEFERRED,
 context jsonb NOT NULL,content jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='BLOCKED')=(error_code IS NOT NULL)),CHECK((state='APPLIED')=(message_id IS NOT NULL)),CHECK((state='APPLIED')=(content IS NOT NULL))
);
CREATE INDEX ai_send_conversation_history ON ai_customer_send_action(conversation_id,created_at DESC,id DESC);
ALTER TABLE conversation_message ADD COLUMN ai_send_action_id uuid UNIQUE REFERENCES ai_customer_send_action(id);
CREATE FUNCTION guard_ai_send_job() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SEND_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   SELECT qp.*,qp.xmin AS written_xid INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission a ON a.proposal_id=qp.id WHERE qp.id=NEW.proposal_id;
   IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION') OR NOT ai_row_inserted_here(p.written_xid)
     OR ai_customer_send_admission_context(p.id) IS NULL OR NEW.state<>'QUEUED' OR EXISTS(SELECT 1 FROM ai_customer_send_action WHERE proposal_id=p.id)
     THEN RAISE EXCEPTION 'AI_SEND_FRESH_RESULT_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_send_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_SEND_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_send_job_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_send_job FOR EACH ROW EXECUTE FUNCTION guard_ai_send_job();
CREATE FUNCTION enqueue_ai_send_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision' IN ('ANSWER','QUESTION') AND EXISTS(SELECT 1 FROM ai_customer_send_admission WHERE proposal_id=NEW.id)
   THEN INSERT INTO ai_customer_send_job(proposal_id) VALUES(NEW.id);END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_send_job_enqueue AFTER UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION enqueue_ai_send_job();
CREATE FUNCTION guard_ai_send_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;expected jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_SEND_ACTION_IMMUTABLE';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION')
   OR (NEW.lead_id,NEW.campaign_id,NEW.conversation_id,NEW.context) IS DISTINCT FROM (p.lead_id,p.campaign_id,p.conversation_id,p.context)
   OR NOT EXISTS(SELECT 1 FROM ai_customer_send_job WHERE proposal_id=p.id AND state='QUEUED' FOR UPDATE) THEN RAISE EXCEPTION 'AI_SEND_SOURCE_REQUIRED';END IF;
 ctx=ai_customer_send_admission_context(p.id);expected=ai_customer_send_content(p.id);
 IF NEW.state='APPLIED' AND (ctx IS NULL OR ctx->'consent'->>'status'<>'GRANTED' OR expected IS NULL OR NEW.content IS DISTINCT FROM expected OR NEW.message_id IS NULL)
   OR NEW.state='BLOCKED' AND (NEW.error_code IS NULL OR NEW.message_id IS NOT NULL OR NEW.content IS NOT NULL)
   THEN RAISE EXCEPTION 'AI_SEND_CURRENT_CONTENT_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_send_action_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_send_action FOR EACH ROW EXECUTE FUNCTION guard_ai_send_action();
CREATE FUNCTION guard_ai_send_message() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.ai_send_action_id IS DISTINCT FROM OLD.ai_send_action_id THEN RAISE EXCEPTION 'AI_SEND_MESSAGE_PROOF_IMMUTABLE';END IF;RETURN NEW;
 END IF;
 IF NEW.author_type='AI' OR NEW.ai_send_action_id IS NOT NULL THEN
   SELECT act.*,act.xmin AS written_xid INTO a FROM ai_customer_send_action act WHERE act.id=NEW.ai_send_action_id;
   IF a IS NULL OR a.state<>'APPLIED' OR NOT ai_row_inserted_here(a.written_xid) OR NEW.id<>a.message_id OR NEW.conversation_id<>a.conversation_id
     OR NEW.connection_id IS DISTINCT FROM (a.context->'conversation'->>'connectionId')::uuid OR NEW.sender_id IS DISTINCT FROM (a.context->'conversation'->>'senderId')::uuid
     OR NEW.direction<>'OUTBOUND' OR NEW.author_type<>'AI' OR NEW.author_user_id IS NOT NULL OR NEW.message_kind<>'TEXT' OR NEW.attachment_id IS NOT NULL
     OR NEW.template_id IS NOT NULL OR NEW.template_snapshot IS NOT NULL OR NEW.body IS DISTINCT FROM a.content->>'body' OR NEW.delivery_state<>'QUEUED'
     OR NEW.idempotency_key IS DISTINCT FROM a.id::text OR NEW.provider_message_id IS NOT NULL OR NEW.source_event_id IS NOT NULL
     OR NEW.received_at IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.last_error_code IS NOT NULL OR NEW.attempt_count<>0 OR NEW.delivery_rank<>0
     OR NEW.reply_to_message_id IS NOT NULL OR NEW.reply_button_index IS NOT NULL OR NEW.source_reference IS NOT NULL
     THEN RAISE EXCEPTION 'AI_SEND_FRESH_MESSAGE_PROOF_REQUIRED';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_send_message_guard BEFORE INSERT OR UPDATE ON conversation_message FOR EACH ROW EXECUTE FUNCTION guard_ai_send_message();

-- Exact own-message delta: every other original scope/version/config/source fact remains unchanged.
CREATE FUNCTION ai_customer_send_dispatch_context(aid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a record;p record;m record;current_base jsonb;expected_base jsonb;consent jsonb;BEGIN
 SELECT * INTO a FROM ai_customer_send_action WHERE id=aid AND state='APPLIED';IF a IS NULL THEN RETURN NULL;END IF;
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context WHERE qp.id=a.proposal_id;
 IF p IS NULL OR p.context IS DISTINCT FROM a.context OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION') THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id AND branch_id=p.branch_id FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM lead WHERE id=p.lead_id AND organization_id=p.organization_id AND branch_id=p.branch_id AND campaign_id=p.campaign_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id AND lead_id=p.lead_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM ai_customer_proposal_locked_context(p.event_id);
 SELECT * INTO m FROM conversation_message WHERE id=a.message_id AND ai_send_action_id=a.id AND conversation_id=p.conversation_id;
 IF m IS NULL OR m.direction<>'OUTBOUND' OR m.author_type<>'AI' OR m.author_user_id IS NOT NULL OR m.body IS DISTINCT FROM a.content->>'body'
   OR m.sender_id IS DISTINCT FROM (p.context->'conversation'->>'senderId')::uuid OR m.connection_id IS DISTINCT FROM (p.context->'conversation'->>'connectionId')::uuid
   OR m.message_kind<>'TEXT' OR m.attachment_id IS NOT NULL OR m.template_id IS NOT NULL OR m.idempotency_key<>a.id::text
   OR EXISTS(SELECT 1 FROM conversation_message later,conversation_message source WHERE source.id=p.message_id AND later.conversation_id=p.conversation_id
     AND (later.created_at,later.id)>(source.created_at,source.id) AND later.id<>m.id) THEN RETURN NULL;END IF;
 current_base=ai_customer_inbound_context(p.event_id);
 IF current_base IS NULL OR current_base->'conversation'->>'latestMessageId' IS DISTINCT FROM m.id::text THEN RETURN NULL;END IF;
 expected_base=(p.context-ARRAY['protocolVersion','toolPolicy','knowledgeData','references','messages','questions','operationalData','consent'])||jsonb_build_object('kind','CUSTOMER_INBOUND');
 IF jsonb_set(current_base,'{conversation,latestMessageId}',p.context->'source'->'messageId') IS DISTINCT FROM expected_base
   OR ai_effective_tool_policy(p.branch_id,p.campaign_id) IS DISTINCT FROM p.context->'toolPolicy' THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('status',COALESCE(co.status,'UNKNOWN'),'doNotContact',COALESCE(co.do_not_contact,false),'versionTime',co.updated_at) INTO consent
   FROM lead l LEFT JOIN messaging_consent co ON co.contact_id=l.contact_id AND co.channel='WHATSAPP' WHERE l.id=p.lead_id;
 IF consent IS DISTINCT FROM p.context->'consent' OR consent->>'status'<>'GRANTED' OR consent->>'doNotContact'<>'false' THEN RETURN NULL;END IF;
 RETURN jsonb_set(p.context,'{conversation,latestMessageId}',to_jsonb(m.id));
END $$;

CREATE FUNCTION record_ai_send_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_customer_send_job SET state='DONE' WHERE proposal_id=NEW.proposal_id AND state='QUEUED';
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,
   CASE NEW.state WHEN 'APPLIED' THEN 'AI_CUSTOMER_SEND_QUEUED' ELSE 'AI_CUSTOMER_SEND_BLOCKED' END,'AI_CUSTOMER_SEND',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','tool',NEW.tool,'leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,
     'proposalId',NEW.proposal_id,'sourceMessageId',NEW.context->'source'->'messageId','knowledgeVersion',NEW.context->'knowledge'->'version',
     'profileId',NEW.context->'profile'->'id','messageId',NEW.message_id,'errorCode',NEW.error_code));
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(NEW.lead_id,CASE NEW.state WHEN 'APPLIED' THEN 'AI_CUSTOMER_SEND_QUEUED' ELSE 'AI_CUSTOMER_SEND_BLOCKED' END,
   jsonb_build_object('conversationId',NEW.conversation_id,'actionId',NEW.id,'messageId',NEW.message_id,'errorCode',NEW.error_code));
 IF NEW.state='BLOCKED' THEN UPDATE conversation cv SET state='AI_HANDOFF_REQUIRED',needs_attention_reason='AI_CUSTOMER_SEND_BLOCKED'
   FROM lead l WHERE cv.id=NEW.conversation_id AND l.id=cv.lead_id AND l.id=NEW.lead_id AND l.campaign_id=NEW.campaign_id
     AND l.organization_id=(NEW.context->'scope'->>'organizationId')::uuid AND l.branch_id=(NEW.context->'scope'->>'branchId')::uuid
     AND cv.controller_type='AI' AND cv.state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND cv.needs_attention_reason IS NULL
     AND (SELECT id FROM conversation_message WHERE conversation_id=cv.id ORDER BY created_at DESC,id DESC LIMIT 1)=(NEW.context->'source'->>'messageId')::uuid;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_send_action_record AFTER INSERT ON ai_customer_send_action FOR EACH ROW EXECUTE FUNCTION record_ai_send_action();
CREATE FUNCTION prove_ai_send_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='APPLIED' AND (ai_customer_send_dispatch_context(NEW.id) IS NULL OR NOT EXISTS(
   SELECT 1 FROM conversation_message m JOIN outbound_delivery_job link ON link.message_id=m.id JOIN background_job j ON j.id=link.job_id
   WHERE m.id=NEW.message_id AND ai_row_inserted_here(m.xmin) AND ai_row_inserted_here(j.xmin) AND m.ai_send_action_id=NEW.id
     AND m.delivery_state='QUEUED' AND j.queue='messaging' AND j.kind='SEND_MESSAGE' AND j.status='QUEUED' AND j.attempts=0
     AND j.payload=jsonb_build_object('messageId',m.id) AND j.idempotency_key=m.id::text)) THEN RAISE EXCEPTION 'AI_SEND_ATOMIC_OUTBOX_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_send_action_proof AFTER INSERT ON ai_customer_send_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_send_action();
CREATE FUNCTION guard_ai_send_outbox_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE m record;BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM conversation_message WHERE id=OLD.message_id AND ai_send_action_id IS NOT NULL) THEN RAISE EXCEPTION 'AI_SEND_OUTBOX_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 SELECT cm.*,cm.xmin AS written_xid INTO m FROM conversation_message cm WHERE cm.id=NEW.message_id;
 IF m.ai_send_action_id IS NOT NULL AND (TG_OP<>'INSERT' OR NOT ai_row_inserted_here(m.written_xid)
   OR NOT EXISTS(SELECT 1 FROM ai_customer_send_action a WHERE a.id=m.ai_send_action_id AND a.message_id=m.id AND a.state='APPLIED' AND ai_row_inserted_here(a.xmin)))
   THEN RAISE EXCEPTION 'AI_SEND_FRESH_OUTBOX_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_send_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbound_delivery_job FOR EACH ROW EXECUTE FUNCTION guard_ai_send_outbox_link();

-- Extend the existing bounded local queue; never grant legacy send sources.
ALTER TABLE ai_local_action_queue DROP CONSTRAINT ai_local_action_queue_kind_check;
ALTER TABLE ai_local_action_queue ADD CONSTRAINT ai_local_action_queue_kind_check CHECK(kind IN ('QUALIFICATION','HANDOFF','SEND'));
CREATE OR REPLACE FUNCTION ai_local_action_context_current(pid uuid,k text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p record;ctx jsonb;expected jsonb;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN false;END IF;
 ctx=ai_customer_proposal_context(p.event_id);IF ctx IS NULL THEN RETURN false;END IF;
 IF k='QUALIFICATION' THEN RETURN ai_qualification_admissible(ctx) AND ctx=p.context;
 ELSIF k='SEND' THEN RETURN p.result->>'decision' IN ('ANSWER','QUESTION') AND ai_send_admissible(ctx) AND ctx=p.context AND EXISTS(SELECT 1 FROM ai_customer_send_admission WHERE proposal_id=pid);
 ELSIF k='HANDOFF' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT s.context INTO expected FROM ai_qualification_handoff_source s WHERE s.proposal_id=pid;
     IF expected IS NULL OR (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true' THEN RETURN false;END IF;
   ELSIF p.result->>'decision'<>'HANDOFF' THEN RETURN false;END IF;
   RETURN ai_handoff_admissible(ctx) AND ctx=expected;
 END IF;RETURN false;
END $$;
CREATE OR REPLACE FUNCTION guard_ai_local_action_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;jstate text;receipt_id uuid;receipt_xid xid;u record;ctx jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_HISTORY_RETAINED';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;
 IF NEW.kind='QUALIFICATION' THEN
   SELECT state INTO jstate FROM ai_customer_action_job WHERE proposal_id=NEW.proposal_id;
   SELECT a.id,a.xmin INTO receipt_id,receipt_xid FROM ai_customer_action a WHERE proposal_id=NEW.proposal_id;
 ELSIF NEW.kind='SEND' THEN
   SELECT state INTO jstate FROM ai_customer_send_job WHERE proposal_id=NEW.proposal_id;
   SELECT a.id,a.xmin INTO receipt_id,receipt_xid FROM ai_customer_send_action a WHERE proposal_id=NEW.proposal_id;
 ELSE
   SELECT state INTO jstate FROM ai_customer_handoff_job WHERE proposal_id=NEW.proposal_id;
   SELECT a.id,a.xmin INTO receipt_id,receipt_xid FROM ai_customer_handoff_action a WHERE proposal_id=NEW.proposal_id;
 END IF;
 IF p IS NULL OR jstate IS NULL THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_JOB_SOURCE_REQUIRED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.operation<>'ADMIT' OR NEW.version<>1 OR jstate<>'QUEUED' OR receipt_id IS NOT NULL
     OR NEW.organization_id IS NOT NULL AND NEW.organization_id<>p.organization_id OR NEW.branch_id IS NOT NULL AND NEW.branch_id<>p.branch_id
     OR NEW.campaign_id IS NOT NULL AND NEW.campaign_id<>p.campaign_id OR NEW.lead_id IS NOT NULL AND NEW.lead_id<>p.lead_id
     OR NEW.conversation_id IS NOT NULL AND NEW.conversation_id<>p.conversation_id THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_ADMISSION_REQUIRED';END IF;
   NEW.organization_id=p.organization_id;NEW.branch_id=p.branch_id;NEW.campaign_id=p.campaign_id;NEW.lead_id=p.lead_id;NEW.conversation_id=p.conversation_id;
 ELSE
   IF (NEW.id,NEW.proposal_id,NEW.kind,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id)
     IS DISTINCT FROM (OLD.id,OLD.proposal_id,OLD.kind,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id)
     OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_VERSION_REQUIRED';END IF;
   IF OLD.state='COMPLETED' OR NEW.operation='ADMIT' THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_TERMINAL';END IF;
 END IF;
 NEW.updated_at=ai_local_action_now();
 IF NEW.operation='ADMIT' THEN
   NEW.state='WAITING';NEW.failure_count=0;NEW.available_at=NEW.updated_at;NEW.error_code=NULL;
 ELSIF NEW.operation='COMPLETE' THEN
   IF jstate<>'DONE' OR receipt_id IS NULL OR NOT ai_row_inserted_here(receipt_xid) THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_FRESH_RECEIPT_REQUIRED';END IF;
   NEW.state='COMPLETED';NEW.failure_count=OLD.failure_count;NEW.available_at='infinity';NEW.error_code=NULL;
 ELSIF NEW.operation='FAILURE' THEN
   IF jstate<>'QUEUED' OR receipt_id IS NOT NULL OR OLD.state<>'WAITING' OR OLD.failure_count>=5 OR OLD.available_at>NEW.updated_at THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_DUE_JOB_REQUIRED';END IF;
   NEW.failure_count=OLD.failure_count+1;NEW.state=CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
   NEW.available_at=CASE WHEN NEW.failure_count=5 THEN 'infinity'::timestamptz ELSE NEW.updated_at+make_interval(secs=>power(2,NEW.failure_count)::integer) END;
   NEW.error_code='AI_LOCAL_ACTION_FAILED';
 ELSE
   -- Queue -> Branch -> real current User/Session -> Domain dependency locks, matching the worker.
   PERFORM 1 FROM branch WHERE id=p.branch_id AND organization_id=p.organization_id FOR UPDATE;
   IF NOT FOUND OR NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
   IF jstate<>'QUEUED' OR receipt_id IS NOT NULL OR OLD.failure_count=0 OR u.organization_id<>p.organization_id
     OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=p.branch_id)
     OR NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 3 AND 500 OR NEW.reason ~ '[\x00-\x1f\x7f]'
     THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   ctx=CASE NEW.kind WHEN 'QUALIFICATION' THEN ai_customer_action_context(p.id) WHEN 'SEND' THEN ai_customer_send_admission_context(p.id) ELSE ai_customer_handoff_context(p.id) END;
   IF ctx IS NULL THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   NEW.state='WAITING';NEW.failure_count=0;NEW.error_code=NULL;NEW.available_at=NEW.updated_at;NEW.reason=trim(NEW.reason);
 END IF;
 IF NEW.operation<>'HUMAN_RETRY' THEN NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION sync_ai_local_action_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;BEGIN
 k=CASE TG_TABLE_NAME WHEN 'ai_customer_action_job' THEN 'QUALIFICATION' WHEN 'ai_customer_send_job' THEN 'SEND' ELSE 'HANDOFF' END;
 IF TG_OP='INSERT' THEN INSERT INTO ai_local_action_queue(proposal_id,kind,operation) VALUES(NEW.proposal_id,k,'ADMIT');
 ELSIF NEW.state='DONE' THEN UPDATE ai_local_action_queue SET operation='COMPLETE',version=version+1 WHERE proposal_id=NEW.proposal_id AND kind=k;END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_ai_local_action_due() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;k text;BEGIN
 k=CASE TG_TABLE_NAME WHEN 'ai_customer_action' THEN 'QUALIFICATION' WHEN 'ai_customer_send_action' THEN 'SEND' ELSE 'HANDOFF' END;
 SELECT * INTO q FROM ai_local_action_queue WHERE proposal_id=NEW.proposal_id AND kind=k FOR UPDATE;
 IF q IS NULL OR q.state<>'WAITING' OR q.failure_count>=5 OR q.available_at>ai_local_action_now() THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_DUE_JOB_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_local_send_queue_sync AFTER INSERT OR UPDATE ON ai_customer_send_job FOR EACH ROW EXECUTE FUNCTION sync_ai_local_action_queue();
CREATE TRIGGER aa_ai_local_action_due BEFORE INSERT ON ai_customer_send_action FOR EACH ROW EXECUTE FUNCTION guard_ai_local_action_due();
