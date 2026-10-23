-- A fresh typed Qualification write may continue with the next approved question.
-- Original inbound/proposal/admissions stay immutable. Completion/Handoff never invents a reply.
CREATE FUNCTION ai_next_qualification_question(lid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE q jsonb;v jsonb;d jsonb;BEGIN
 SELECT qc.definition INTO d FROM ai_qualification_config qc JOIN lead l ON l.campaign_id=qc.campaign_id WHERE l.id=lid;
 IF d->>'enabled' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 FOR q IN SELECT item FROM jsonb_array_elements(d->'questions') item LOOP
   v=NULL;
   IF q->>'fieldId' IS NOT NULL THEN SELECT value INTO v FROM lead_field_value WHERE lead_id=lid AND field_id=(q->>'fieldId')::uuid;
   ELSE SELECT value INTO v FROM lead_qualification_answer WHERE lead_id=lid AND question_id=(q->>'id')::uuid AND question_snapshot=q;END IF;
   IF NOT ai_qualification_answered(v) THEN RETURN q;END IF;
 END LOOP;RETURN NULL;
END $$;

CREATE TABLE ai_qualification_send_source (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_send_admission(proposal_id),
 qualification_action_id uuid NOT NULL UNIQUE REFERENCES ai_customer_action(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),
 outcome jsonb NOT NULL,question jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_qualification_send_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;p record;ctx jsonb;outcome jsonb;q jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_QUALIFICATION_SEND_SOURCE_IMMUTABLE';END IF;
 SELECT qa.*,qa.xmin AS inserted_xid INTO a FROM ai_customer_action qa WHERE qa.id=NEW.qualification_action_id;
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context AND adm.event_id=qp.event_id WHERE qp.id=NEW.proposal_id;
 IF a IS NULL OR p IS NULL OR a.proposal_id<>p.id OR a.state<>'APPLIED' OR NOT ai_row_inserted_here(a.inserted_xid)
   OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' OR a.context IS DISTINCT FROM p.context
   OR NOT EXISTS(SELECT 1 FROM lead_qualification_answer_history h WHERE h.lead_id=a.lead_id AND h.question_id=a.question_id AND h.version=a.answer_version
     AND h.snapshot->>'ai_action_id'=a.id::text AND h.snapshot->>'source'='AI' AND h.snapshot->'value'=a.value AND ai_row_inserted_here(h.xmin))
   OR NOT EXISTS(SELECT 1 FROM lead_qualification_answer qa WHERE qa.lead_id=a.lead_id AND qa.question_id=a.question_id AND qa.ai_action_id=a.id AND qa.source='AI'
     AND qa.value=a.value AND qa.version=a.answer_version AND qa.question_snapshot=a.question_snapshot)
   OR a.field_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lead_field_value fv JOIN field_value_history h ON h.ai_action_id=fv.ai_action_id
     WHERE fv.ai_action_id=a.id AND fv.lead_id=a.lead_id AND fv.field_id=a.field_id AND fv.source='AI' AND fv.value=a.value AND fv.version=a.previous_field_version+1
       AND h.lead_id=a.lead_id AND h.field_id=a.field_id AND h.new_value=a.value AND ai_row_inserted_here(h.xmin))
   THEN RAISE EXCEPTION 'AI_QUALIFICATION_SEND_FRESH_WRITE_REQUIRED';END IF;
 ctx=ai_customer_proposal_locked_context(p.event_id);outcome=ai_current_qualification_outcome(a.lead_id);q=ai_next_qualification_question(a.lead_id);
 IF NOT ai_send_admissible(ctx) OR ctx IS DISTINCT FROM ai_qualification_handoff_expected(a.id) OR ctx IS DISTINCT FROM NEW.context
   OR outcome IS NULL OR outcome->>'handoff' IS DISTINCT FROM 'false' OR outcome->>'complete' IS DISTINCT FROM 'false'
   OR outcome IS DISTINCT FROM NEW.outcome OR q IS NULL OR q IS DISTINCT FROM NEW.question
   OR EXISTS(SELECT 1 FROM ai_qualification_handoff_source WHERE proposal_id=p.id)
   THEN RAISE EXCEPTION 'AI_QUALIFICATION_SEND_EXACT_CONTEXT_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_send_source_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_qualification_send_source FOR EACH ROW EXECUTE FUNCTION guard_ai_qualification_send_source();
CREATE FUNCTION enqueue_ai_qualification_send_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;ctx jsonb;outcome jsonb;q jsonb;BEGIN
 IF NEW.snapshot->>'source'<>'AI' THEN RETURN NEW;END IF;
 SELECT qa.* INTO a FROM ai_customer_action qa JOIN ai_customer_send_admission adm ON adm.proposal_id=qa.proposal_id
   WHERE qa.id=(NEW.snapshot->>'ai_action_id')::uuid AND qa.state='APPLIED' AND ai_row_inserted_here(qa.xmin);
 IF a IS NULL THEN RETURN NEW;END IF;
 outcome=ai_current_qualification_outcome(a.lead_id);
 IF outcome IS NULL OR outcome->>'handoff' IS DISTINCT FROM 'false' OR outcome->>'complete' IS DISTINCT FROM 'false' THEN RETURN NEW;END IF;
 q=ai_next_qualification_question(a.lead_id);IF q IS NULL THEN RETURN NEW;END IF;
 ctx=ai_customer_proposal_locked_context((SELECT event_id FROM ai_customer_proposal WHERE id=a.proposal_id));
 INSERT INTO ai_qualification_send_source(proposal_id,qualification_action_id,context,outcome,question) VALUES(a.proposal_id,a.id,ctx,outcome,q);
 RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_send_source_enqueue AFTER INSERT ON lead_qualification_answer_history FOR EACH ROW EXECUTE FUNCTION enqueue_ai_qualification_send_source();

-- Historical source projection is not authority. The locked factory below separately proves current scope.
CREATE FUNCTION ai_customer_send_source_context(pid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p.result->>'decision'='QUALIFICATION' THEN s.context ELSE p.context END
 FROM ai_customer_proposal p LEFT JOIN ai_qualification_send_source s ON s.proposal_id=p.id WHERE p.id=pid
$$;
ALTER FUNCTION ai_customer_send_admission_context(uuid) RENAME TO ai_inbound_send_admission_context;
CREATE FUNCTION ai_customer_send_admission_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p record;s record;ctx jsonb;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p.result->>'decision' IS DISTINCT FROM 'QUALIFICATION' THEN RETURN ai_inbound_send_admission_context(pid);END IF;
 SELECT src.* INTO s FROM ai_qualification_send_source src JOIN ai_customer_send_admission adm ON adm.proposal_id=src.proposal_id AND adm.context=p.context AND adm.event_id=p.event_id
   JOIN ai_customer_action a ON a.id=src.qualification_action_id AND a.proposal_id=p.id AND a.state='APPLIED'
   WHERE src.proposal_id=pid AND src.context=ai_qualification_handoff_expected(a.id);
 IF s IS NULL OR p.state<>'PROPOSED' THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_send_admissible(ctx) OR ctx IS DISTINCT FROM s.context
   OR ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome
   OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;

ALTER FUNCTION ai_customer_send_content(uuid) RENAME TO ai_inbound_send_content;
CREATE FUNCTION ai_customer_send_content(pid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p record;s record;body text;disclosure jsonb;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid AND state='PROPOSED';
 IF p.result->>'decision' IS DISTINCT FROM 'QUALIFICATION' THEN RETURN ai_inbound_send_content(pid);END IF;
 SELECT * INTO s FROM ai_qualification_send_source WHERE proposal_id=pid;
 IF s IS NULL OR NOT ai_customer_proposal_result_valid(p.result,p.context) OR ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome
   OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question THEN RETURN NULL;END IF;
 body=s.question->>'prompt';
 SELECT COALESCE(NULLIF(cp.definition->'disclosure','null'),bp.definition->'disclosure','null') INTO disclosure
   FROM campaign c LEFT JOIN ai_behavior_policy cp ON cp.scope='CAMPAIGN' AND cp.resource_id=c.id
   LEFT JOIN ai_behavior_policy bp ON bp.scope='BRANCH' AND bp.resource_id=c.branch_id WHERE c.id=p.campaign_id;
 IF disclosure IS NOT NULL AND disclosure<>'null' AND (disclosure->>'mode'='EVERY_AI_MESSAGE' OR NOT EXISTS(
   SELECT 1 FROM conversation_message m WHERE m.conversation_id=p.conversation_id AND m.direction='OUTBOUND' AND m.author_type='AI' AND m.delivery_state IN ('SENT','DELIVERED','READ'))) THEN
   body=(disclosure->>'text')||E'\n\n'||body;
 ELSE disclosure='null';END IF;
 IF body IS NULL OR length(trim(body))=0 OR length(body)>20000 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('body',body,'decision','QUESTION','referenceIds','[]'::jsonb,'questionId',s.question->'id','disclosure',disclosure);
END $$;

CREATE OR REPLACE FUNCTION guard_ai_send_job() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;fresh boolean;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SEND_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   SELECT qp.*,qp.xmin AS written_xid INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission a ON a.proposal_id=qp.id WHERE qp.id=NEW.proposal_id;
   fresh=p.result->>'decision' IN ('ANSWER','QUESTION') AND ai_row_inserted_here(p.written_xid)
     OR p.result->>'decision'='QUALIFICATION' AND EXISTS(SELECT 1 FROM ai_qualification_send_source s WHERE s.proposal_id=p.id AND ai_row_inserted_here(s.xmin));
   IF p IS NULL OR p.state<>'PROPOSED' OR NOT COALESCE(fresh,false) OR ai_customer_send_admission_context(p.id) IS NULL
     OR NEW.state<>'QUEUED' OR EXISTS(SELECT 1 FROM ai_customer_send_action WHERE proposal_id=p.id) THEN RAISE EXCEPTION 'AI_SEND_FRESH_RESULT_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_send_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_SEND_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION enqueue_ai_qualification_send_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_customer_send_job(proposal_id) VALUES(NEW.proposal_id);RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_send_job_enqueue AFTER INSERT ON ai_qualification_send_source FOR EACH ROW EXECUTE FUNCTION enqueue_ai_qualification_send_job();

ALTER TABLE ai_customer_send_action ADD COLUMN qualification_action_id uuid UNIQUE REFERENCES ai_customer_action(id);
CREATE OR REPLACE FUNCTION guard_ai_send_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;expected jsonb;source_ctx jsonb;child uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_SEND_ACTION_IMMUTABLE';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;source_ctx=ai_customer_send_source_context(p.id);
 IF p.result->>'decision'='QUALIFICATION' THEN SELECT qualification_action_id INTO child FROM ai_qualification_send_source WHERE proposal_id=p.id;END IF;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION','QUALIFICATION') OR source_ctx IS NULL
   OR (NEW.lead_id,NEW.campaign_id,NEW.conversation_id,NEW.context) IS DISTINCT FROM (p.lead_id,p.campaign_id,p.conversation_id,source_ctx)
   OR NEW.qualification_action_id IS NOT NULL AND NEW.qualification_action_id IS DISTINCT FROM child
   OR NOT EXISTS(SELECT 1 FROM ai_customer_send_job WHERE proposal_id=p.id AND state='QUEUED' FOR UPDATE) THEN RAISE EXCEPTION 'AI_SEND_SOURCE_REQUIRED';END IF;
 ctx=ai_customer_send_admission_context(p.id);expected=ai_customer_send_content(p.id);
 IF NEW.state='APPLIED' AND (ctx IS NULL OR ctx->'consent'->>'status'<>'GRANTED' OR expected IS NULL OR NEW.content IS DISTINCT FROM expected OR NEW.message_id IS NULL)
   OR NEW.state='BLOCKED' AND (NEW.error_code IS NULL OR NEW.message_id IS NOT NULL OR NEW.content IS NOT NULL)
   THEN RAISE EXCEPTION 'AI_SEND_CURRENT_CONTENT_REQUIRED';END IF;
 NEW.qualification_action_id=child;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;

-- Dispatch permits precisely the original typed answer delta followed by this own Message.
CREATE OR REPLACE FUNCTION ai_customer_send_dispatch_context(aid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a record;p record;m record;s record;expected jsonb;current_base jsonb;expected_base jsonb;consent jsonb;BEGIN
 SELECT * INTO a FROM ai_customer_send_action WHERE id=aid AND state='APPLIED';IF a IS NULL THEN RETURN NULL;END IF;
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context AND adm.event_id=qp.event_id WHERE qp.id=a.proposal_id;
 expected=ai_customer_send_source_context(p.id);
 IF p IS NULL OR expected IS NULL OR expected IS DISTINCT FROM a.context OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION','QUALIFICATION') THEN RETURN NULL;END IF;
 IF p.result->>'decision'='QUALIFICATION' THEN
   SELECT * INTO s FROM ai_qualification_send_source WHERE proposal_id=p.id AND qualification_action_id=a.qualification_action_id;
   IF s IS NULL OR expected IS DISTINCT FROM ai_qualification_handoff_expected(s.qualification_action_id) THEN RETURN NULL;END IF;
 ELSIF a.qualification_action_id IS NOT NULL THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id AND branch_id=p.branch_id FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM lead WHERE id=p.lead_id AND organization_id=p.organization_id AND branch_id=p.branch_id AND campaign_id=p.campaign_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id AND lead_id=p.lead_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM ai_customer_proposal_locked_context(p.event_id);
 IF p.result->>'decision'='QUALIFICATION' AND (ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome
   OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question) THEN RETURN NULL;END IF;
 SELECT * INTO m FROM conversation_message WHERE id=a.message_id AND ai_send_action_id=a.id AND conversation_id=p.conversation_id;
 IF m IS NULL OR m.direction<>'OUTBOUND' OR m.author_type<>'AI' OR m.author_user_id IS NOT NULL OR m.body IS DISTINCT FROM a.content->>'body'
   OR m.sender_id IS DISTINCT FROM (expected->'conversation'->>'senderId')::uuid OR m.connection_id IS DISTINCT FROM (expected->'conversation'->>'connectionId')::uuid
   OR m.message_kind<>'TEXT' OR m.attachment_id IS NOT NULL OR m.template_id IS NOT NULL OR m.idempotency_key<>a.id::text
   OR EXISTS(SELECT 1 FROM conversation_message later,conversation_message source WHERE source.id=p.message_id AND later.conversation_id=p.conversation_id
     AND (later.created_at,later.id)>(source.created_at,source.id) AND later.id<>m.id) THEN RETURN NULL;END IF;
 current_base=ai_customer_inbound_context(p.event_id);
 IF current_base IS NULL OR current_base->'conversation'->>'latestMessageId' IS DISTINCT FROM m.id::text THEN RETURN NULL;END IF;
 expected_base=(expected-ARRAY['protocolVersion','toolPolicy','knowledgeData','references','messages','questions','operationalData','consent'])||jsonb_build_object('kind','CUSTOMER_INBOUND');
 IF jsonb_set(current_base,'{conversation,latestMessageId}',expected->'source'->'messageId') IS DISTINCT FROM expected_base
   OR ai_effective_tool_policy(p.branch_id,p.campaign_id) IS DISTINCT FROM expected->'toolPolicy' THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('status',COALESCE(co.status,'UNKNOWN'),'doNotContact',COALESCE(co.do_not_contact,false),'versionTime',co.updated_at) INTO consent
   FROM lead l LEFT JOIN messaging_consent co ON co.contact_id=l.contact_id AND co.channel='WHATSAPP' WHERE l.id=p.lead_id;
 IF consent IS DISTINCT FROM expected->'consent' OR consent->>'status'<>'GRANTED' OR consent->>'doNotContact'<>'false' THEN RETURN NULL;END IF;
 RETURN jsonb_set(expected,'{conversation,latestMessageId}',to_jsonb(m.id));
END $$;

CREATE OR REPLACE FUNCTION ai_local_action_context_current(pid uuid,k text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p record;ctx jsonb;expected jsonb;s record;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN false;END IF;
 ctx=ai_customer_proposal_context(p.event_id);IF ctx IS NULL THEN RETURN false;END IF;
 IF k='QUALIFICATION' THEN RETURN ai_qualification_admissible(ctx) AND ctx=p.context;
 ELSIF k='SEND' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT * INTO s FROM ai_qualification_send_source WHERE proposal_id=pid;
     IF s IS NULL OR s.context IS DISTINCT FROM ai_qualification_handoff_expected(s.qualification_action_id)
       OR ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question THEN RETURN false;END IF;
     expected=s.context;
   ELSIF p.result->>'decision' NOT IN ('ANSWER','QUESTION') THEN RETURN false;END IF;
   RETURN ai_send_admissible(ctx) AND ctx=expected AND EXISTS(SELECT 1 FROM ai_customer_send_admission WHERE proposal_id=pid);
 ELSIF k='HANDOFF' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT s.context INTO expected FROM ai_qualification_handoff_source s WHERE s.proposal_id=pid;
     IF expected IS NULL OR (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true' THEN RETURN false;END IF;
   ELSIF p.result->>'decision'<>'HANDOFF' THEN RETURN false;END IF;
   RETURN ai_handoff_admissible(ctx) AND ctx=expected;
 END IF;RETURN false;
END $$;

CREATE OR REPLACE FUNCTION record_ai_send_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_customer_send_job SET state='DONE' WHERE proposal_id=NEW.proposal_id AND state='QUEUED';
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,
   CASE NEW.state WHEN 'APPLIED' THEN 'AI_CUSTOMER_SEND_QUEUED' ELSE 'AI_CUSTOMER_SEND_BLOCKED' END,'AI_CUSTOMER_SEND',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','tool',NEW.tool,'leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,
     'proposalId',NEW.proposal_id,'qualificationActionId',NEW.qualification_action_id,'sourceMessageId',NEW.context->'source'->'messageId',
     'knowledgeVersion',NEW.context->'knowledge'->'version','profileId',NEW.context->'profile'->'id','messageId',NEW.message_id,'errorCode',NEW.error_code));
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(NEW.lead_id,CASE NEW.state WHEN 'APPLIED' THEN 'AI_CUSTOMER_SEND_QUEUED' ELSE 'AI_CUSTOMER_SEND_BLOCKED' END,
   jsonb_build_object('conversationId',NEW.conversation_id,'actionId',NEW.id,'qualificationActionId',NEW.qualification_action_id,'messageId',NEW.message_id,'errorCode',NEW.error_code));
 IF NEW.state='BLOCKED' THEN UPDATE conversation cv SET state='AI_HANDOFF_REQUIRED',needs_attention_reason='AI_CUSTOMER_SEND_BLOCKED'
   FROM lead l WHERE cv.id=NEW.conversation_id AND l.id=cv.lead_id AND l.id=NEW.lead_id AND l.campaign_id=NEW.campaign_id
     AND l.organization_id=(NEW.context->'scope'->>'organizationId')::uuid AND l.branch_id=(NEW.context->'scope'->>'branchId')::uuid
     AND cv.controller_type='AI' AND cv.state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND cv.needs_attention_reason IS NULL
     AND (SELECT id FROM conversation_message WHERE conversation_id=cv.id ORDER BY created_at DESC,id DESC LIMIT 1)=(NEW.context->'source'->>'messageId')::uuid;END IF;
 RETURN NEW;
END $$;
