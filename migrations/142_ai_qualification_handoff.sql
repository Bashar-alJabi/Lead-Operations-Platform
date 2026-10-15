-- Only the exact delta of one approved Qualification write can authorize its child Handoff.
-- The original proposal/context/admissions remain immutable. No general context omission.
CREATE FUNCTION ai_qualification_answered(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(v IS NOT NULL AND v<>'null'::jsonb AND v<>'""'::jsonb AND v<>'[]'::jsonb,false)
$$;
CREATE FUNCTION ai_qualification_conditions_match(conditions jsonb,mode text,answers jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_array_length(conditions)>0 AND CASE mode WHEN 'ALL' THEN bool_and(ok) WHEN 'ANY' THEN bool_or(ok) ELSE false END,false)
 FROM (SELECT ai_qualification_answered(answers->(c->>'questionId')) AND
   (c->>'operator'='ANSWERED' OR c->>'operator'='EQUALS' AND answers->(c->>'questionId')=c->'value') AS ok
   FROM jsonb_array_elements(conditions) c) s
$$;
CREATE FUNCTION ai_qualification_outcome(d jsonb,answers jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE missing jsonb;complete boolean;enabled boolean;BEGIN
 enabled=COALESCE(d->>'enabled'='true',false);
 SELECT COALESCE(jsonb_agg(q->'id' ORDER BY n),'[]') INTO missing
   FROM jsonb_array_elements(d->'questions') WITH ORDINALITY qs(q,n)
   WHERE q->>'required'='true' AND NOT ai_qualification_answered(answers->(q->>'id'));
 complete=enabled AND jsonb_array_length(missing)=0 AND CASE d->'completion'->>'mode'
   WHEN 'ALL_REQUIRED' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') q WHERE q->>'required'='true')
   WHEN 'CONDITIONS' THEN ai_qualification_conditions_match(d->'completion'->'conditions',d->'completion'->>'match',answers) ELSE false END;
 RETURN jsonb_build_object('enabled',enabled,'complete',complete,'missingQuestionIds',missing,'handoff',enabled AND
   (d->'handoff'->>'onCompletion'='true' AND complete OR ai_qualification_conditions_match(d->'handoff'->'conditions',d->'handoff'->>'match',answers)));
END $$;
CREATE FUNCTION ai_current_qualification_outcome(lid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE d jsonb;q jsonb;v jsonb;f field_definition;answers jsonb='{}';BEGIN
 SELECT qc.definition INTO d FROM ai_qualification_config qc JOIN lead l ON l.campaign_id=qc.campaign_id WHERE l.id=lid;
 IF d IS NULL OR d->>'enabled'<>'true' THEN RETURN NULL;END IF;
 FOR q IN SELECT item FROM jsonb_array_elements(d->'questions') item LOOP
   f=NULL;v=NULL;
   IF q->>'fieldId' IS NOT NULL THEN
     SELECT fd.* INTO f FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN lead l ON l.campaign_id=cf.campaign_id
       WHERE l.id=lid AND fd.id=(q->>'fieldId')::uuid AND fd.active AND cf.active AND cf.usable_by_ai AND fd.value_mode='MANUAL'
         AND fd.organization_id=l.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id);
     IF f.id IS NULL THEN RETURN NULL;END IF;
     SELECT fv.value INTO v FROM lead_field_value fv WHERE fv.lead_id=lid AND fv.field_id=f.id;
   ELSE
     SELECT qa.value INTO v FROM lead_qualification_answer qa WHERE qa.lead_id=lid AND qa.question_id=(q->>'id')::uuid AND qa.question_snapshot=q;
   END IF;
   IF v IS NOT NULL AND v<>'null'::jsonb AND NOT ai_qualification_value_valid(v,f) THEN RETURN NULL;END IF;
   answers=answers||jsonb_build_object(q->>'id',v);
 END LOOP;
 -- A changed Field definition cannot silently reinterpret an obsolete typed condition.
 FOR q IN SELECT item FROM jsonb_array_elements((d->'completion'->'conditions')||(d->'handoff'->'conditions')) item WHERE item->>'operator'='EQUALS' LOOP
   f=NULL;
   SELECT fd.* INTO f FROM jsonb_array_elements(d->'questions') question JOIN field_definition fd ON fd.id=(question->>'fieldId')::uuid
     WHERE question->>'id'=q->>'questionId';
   IF NOT ai_qualification_value_valid(q->'value',f) THEN RETURN NULL;END IF;
 END LOOP;
 RETURN ai_qualification_outcome(d,answers);
END $$;

CREATE TABLE ai_qualification_handoff_source (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_handoff_admission(proposal_id),
 qualification_action_id uuid NOT NULL UNIQUE REFERENCES ai_customer_action(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),
 outcome jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ai_qualification_handoff_expected(aid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE a record;expected jsonb;answers jsonb;fields jsonb;BEGIN
 SELECT qa.* INTO a FROM ai_customer_action qa WHERE qa.id=aid AND qa.state='APPLIED';
 IF a IS NULL THEN RETURN NULL;END IF;
 -- All keys except this answer version and, when mapped, this Field value version stay exact.
 SELECT jsonb_agg(item ORDER BY item->>'questionId') INTO answers FROM (
   SELECT item FROM jsonb_array_elements(a.context->'qualification'->'answers') item WHERE item->>'questionId'<>a.question_id::text
   UNION ALL SELECT jsonb_build_object('questionId',a.question_id,'version',a.answer_version)) s;
 SELECT COALESCE(jsonb_agg(CASE WHEN item->>'id'=a.field_id::text THEN jsonb_set(item,'{valueVersion}',to_jsonb(a.previous_field_version+1)) ELSE item END ORDER BY item->>'id'),'[]') INTO fields
   FROM jsonb_array_elements(a.context->'qualification'->'fields') item;
 expected=jsonb_set(a.context,'{qualification,answers}',answers);
 RETURN jsonb_set(expected,'{qualification,fields}',fields);
END $$;
CREATE FUNCTION guard_ai_qualification_handoff_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;p record;ctx jsonb;outcome jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_QUALIFICATION_HANDOFF_SOURCE_IMMUTABLE';END IF;
 SELECT qa.*,qa.xmin AS inserted_xid INTO a FROM ai_customer_action qa WHERE qa.id=NEW.qualification_action_id;
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context WHERE qp.id=NEW.proposal_id;
 IF a IS NULL OR p IS NULL OR a.proposal_id<>p.id OR a.state<>'APPLIED' OR NOT ai_row_inserted_here(a.inserted_xid)
   OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' OR a.context IS DISTINCT FROM p.context
   OR NOT EXISTS(SELECT 1 FROM lead_qualification_answer_history h WHERE h.lead_id=a.lead_id AND h.question_id=a.question_id AND h.version=a.answer_version
     AND h.snapshot->>'ai_action_id'=a.id::text AND h.snapshot->>'source'='AI' AND h.snapshot->'value'=a.value AND ai_row_inserted_here(h.xmin))
   OR NOT EXISTS(SELECT 1 FROM lead_qualification_answer qa WHERE qa.lead_id=a.lead_id AND qa.question_id=a.question_id AND qa.ai_action_id=a.id AND qa.source='AI'
     AND qa.value=a.value AND qa.version=a.answer_version AND qa.question_snapshot=a.question_snapshot)
   OR a.field_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lead_field_value fv JOIN field_value_history h ON h.ai_action_id=fv.ai_action_id
     WHERE fv.ai_action_id=a.id AND fv.lead_id=a.lead_id AND fv.field_id=a.field_id AND fv.source='AI' AND fv.value=a.value AND fv.version=a.previous_field_version+1
       AND h.lead_id=a.lead_id AND h.field_id=a.field_id AND h.new_value=a.value AND ai_row_inserted_here(h.xmin))
   THEN RAISE EXCEPTION 'AI_QUALIFICATION_HANDOFF_FRESH_WRITE_REQUIRED';END IF;
 -- The Qualification executor already owns Branch/Lead/Contact/Conversation and dependency fences.
 ctx=ai_customer_proposal_locked_context(p.event_id);
 outcome=ai_current_qualification_outcome(a.lead_id);
 IF NOT ai_handoff_admissible(ctx) OR ctx IS DISTINCT FROM ai_qualification_handoff_expected(a.id)
   OR ctx IS DISTINCT FROM NEW.context OR outcome IS NULL OR outcome->>'handoff'<>'true' OR outcome IS DISTINCT FROM NEW.outcome
   THEN RAISE EXCEPTION 'AI_QUALIFICATION_HANDOFF_EXACT_CONTEXT_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_handoff_source_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_qualification_handoff_source FOR EACH ROW EXECUTE FUNCTION guard_ai_qualification_handoff_source();

-- Answer history is created only after the answer and its mapped Field proof exist.
CREATE FUNCTION enqueue_ai_qualification_handoff_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;ctx jsonb;outcome jsonb;BEGIN
 IF NEW.snapshot->>'source'<>'AI' THEN RETURN NEW;END IF;
 SELECT qa.* INTO a FROM ai_customer_action qa JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qa.proposal_id
   WHERE qa.id=(NEW.snapshot->>'ai_action_id')::uuid AND qa.state='APPLIED' AND ai_row_inserted_here(qa.xmin);
 IF a IS NULL THEN RETURN NEW;END IF;
 outcome=ai_current_qualification_outcome(a.lead_id);
 IF outcome->>'handoff' IS DISTINCT FROM 'true' THEN RETURN NEW;END IF;
 ctx=ai_customer_proposal_locked_context((SELECT event_id FROM ai_customer_proposal WHERE id=a.proposal_id));
 INSERT INTO ai_qualification_handoff_source(proposal_id,qualification_action_id,context,outcome) VALUES(a.proposal_id,a.id,ctx,outcome);
 RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_handoff_source_enqueue AFTER INSERT ON lead_qualification_answer_history FOR EACH ROW EXECUTE FUNCTION enqueue_ai_qualification_handoff_source();

CREATE OR REPLACE FUNCTION guard_ai_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id
     WHERE qp.id=NEW.proposal_id AND qp.state='PROPOSED' AND (qp.result->>'decision'='HANDOFF' OR qp.result->>'decision'='QUALIFICATION'
       AND EXISTS(SELECT 1 FROM ai_qualification_handoff_source s WHERE s.proposal_id=qp.id AND ai_row_inserted_here(s.xmin))))
     OR EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_SOURCE_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION enqueue_ai_qualification_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_customer_handoff_job(proposal_id) VALUES(NEW.proposal_id);RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_handoff_job_enqueue AFTER INSERT ON ai_qualification_handoff_source FOR EACH ROW EXECUTE FUNCTION enqueue_ai_qualification_handoff_job();

CREATE OR REPLACE FUNCTION ai_customer_handoff_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p record;ctx jsonb;expected jsonb;BEGIN
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context WHERE qp.id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN NULL;END IF;
 IF p.result->>'decision'='HANDOFF' THEN expected=p.context;
 ELSIF p.result->>'decision'='QUALIFICATION' THEN
   SELECT s.context INTO expected FROM ai_qualification_handoff_source s JOIN ai_customer_action qa ON qa.id=s.qualification_action_id
     WHERE s.proposal_id=p.id AND qa.state='APPLIED' AND qa.proposal_id=p.id AND s.context=ai_qualification_handoff_expected(qa.id);
   IF expected IS NULL THEN RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_handoff_admissible(ctx) OR ctx IS DISTINCT FROM expected
   OR p.result->>'decision'='QUALIFICATION' AND (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true'
   THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;

ALTER TABLE ai_customer_handoff_action DROP CONSTRAINT ai_customer_handoff_action_handoff_reason_check;
ALTER TABLE ai_customer_handoff_action ADD CONSTRAINT ai_handoff_reason CHECK(handoff_reason IN
 ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE','QUALIFICATION'));
ALTER TABLE ai_customer_handoff_action ADD COLUMN qualification_action_id uuid UNIQUE REFERENCES ai_customer_action(id);
CREATE OR REPLACE FUNCTION guard_ai_handoff_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;ctx jsonb;expected jsonb;child uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_HANDOFF_ACTION_IMMUTABLE';END IF;
 SELECT qp.* INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 expected=p.context;
 IF p.result->>'decision'='QUALIFICATION' THEN
   SELECT s.context,s.qualification_action_id INTO expected,child FROM ai_qualification_handoff_source s WHERE s.proposal_id=p.id;
 END IF;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('HANDOFF','QUALIFICATION') OR expected IS NULL
   OR (NEW.lead_id,NEW.campaign_id,NEW.conversation_id,NEW.context) IS DISTINCT FROM (p.lead_id,p.campaign_id,p.conversation_id,expected)
   OR NEW.qualification_action_id IS NOT NULL AND NEW.qualification_action_id IS DISTINCT FROM child
   OR NOT EXISTS(SELECT 1 FROM ai_customer_handoff_job WHERE proposal_id=p.id AND state='QUEUED' FOR UPDATE)
   THEN RAISE EXCEPTION 'AI_HANDOFF_SOURCE_REQUIRED';END IF;
 ctx=ai_customer_handoff_context(p.id);
 IF NEW.state='APPLIED' AND ctx IS NULL OR NEW.state='BLOCKED' AND (ctx IS NOT NULL OR NEW.error_code IS DISTINCT FROM 'AI_HANDOFF_CONTEXT_CHANGED')
   THEN RAISE EXCEPTION 'AI_HANDOFF_CURRENT_ACTION_REQUIRED';END IF;
 NEW.qualification_action_id=child;NEW.handoff_reason=CASE WHEN child IS NULL THEN p.result->>'handoffReason' ELSE 'QUALIFICATION' END;
 NEW.previous_conversation_version=(expected->'conversation'->>'version')::integer;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION record_ai_handoff_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_customer_handoff_job SET state='DONE' WHERE proposal_id=NEW.proposal_id AND state='QUEUED';
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,
   CASE NEW.state WHEN 'APPLIED' THEN 'AI_HUMAN_HANDOFF_APPLIED' ELSE 'AI_HUMAN_HANDOFF_BLOCKED' END,'AI_CUSTOMER_HANDOFF',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','tool',NEW.tool,'leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,
     'proposalId',NEW.proposal_id,'qualificationActionId',NEW.qualification_action_id,'sourceMessageId',NEW.context->'source'->'messageId',
     'knowledgeVersion',NEW.context->'knowledge'->'version','profileId',NEW.context->'profile'->'id','reason',NEW.handoff_reason,'errorCode',NEW.error_code));
 IF NEW.state='APPLIED' THEN INSERT INTO lead_activity(lead_id,event_type,detail)
   VALUES(NEW.lead_id,'AI_HUMAN_HANDOFF_REQUESTED',jsonb_build_object('conversationId',NEW.conversation_id,'actionId',NEW.id,'reason',NEW.handoff_reason,'qualificationActionId',NEW.qualification_action_id));END IF;
 RETURN NEW;
END $$;
