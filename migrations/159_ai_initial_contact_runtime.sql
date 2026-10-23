CREATE TABLE ai_initial_job (
 admission_id uuid PRIMARY KEY REFERENCES ai_initial_admission(id),state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','DONE','DEAD_LETTER')),
 failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_initial_due ON ai_initial_job(available_at,admission_id) WHERE state='WAITING';
ALTER TABLE conversation ADD COLUMN ai_initial_admission_id uuid UNIQUE REFERENCES ai_initial_admission(id);
CREATE TABLE ai_initial_send_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),admission_id uuid NOT NULL UNIQUE REFERENCES ai_initial_job(admission_id),
 conversation_id uuid REFERENCES conversation(id),state text NOT NULL CHECK(state IN ('APPLIED','BLOCKED')),error_code text,
 message_id uuid UNIQUE REFERENCES conversation_message(id) DEFERRABLE INITIALLY DEFERRED,content jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='BLOCKED')=(error_code IS NOT NULL)),CHECK((state='APPLIED')=(message_id IS NOT NULL)),CHECK((state='APPLIED')=(content IS NOT NULL)),CHECK(state<>'APPLIED' OR conversation_id IS NOT NULL)
);
ALTER TABLE conversation_message ADD COLUMN ai_initial_action_id uuid UNIQUE REFERENCES ai_initial_send_action(id);
ALTER TABLE conversation_message ADD CONSTRAINT ai_message_single_proof CHECK(ai_initial_action_id IS NULL OR ai_send_action_id IS NULL);
CREATE FUNCTION guard_ai_initial_job() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a ai_initial_admission;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_INITIAL_JOB_HISTORY_RETAINED';END IF;
 SELECT * INTO a FROM ai_initial_admission WHERE id=NEW.admission_id;
 IF TG_OP='INSERT' THEN
  IF a IS NULL OR a.state<>'ADMITTED' OR NOT EXISTS(SELECT 1 FROM ai_initial_admission WHERE id=a.id AND ai_row_inserted_here(xmin)) OR a.context->'initialMessage'->>'ready' IS DISTINCT FROM 'true'
   OR NEW.state<>'WAITING' OR NEW.failure_count<>0 OR NEW.version<>1 THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_JOB_SOURCE_REQUIRED';END IF;
  NEW.available_at=clock_timestamp();NEW.error_code=NULL;
 ELSE
  IF NEW.admission_id<>OLD.admission_id OR OLD.state<>'WAITING' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_INITIAL_JOB_TRANSITION_REQUIRED';END IF;
  IF NEW.state='DONE' THEN
   IF NOT EXISTS(SELECT 1 FROM ai_initial_send_action WHERE admission_id=NEW.admission_id) THEN RAISE EXCEPTION 'AI_INITIAL_JOB_ACTION_REQUIRED';END IF;
  ELSE
   IF OLD.available_at>clock_timestamp() OR NEW.failure_count<>OLD.failure_count+1 OR NEW.state IS DISTINCT FROM (CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END)
    OR NEW.error_code IS DISTINCT FROM 'AI_INITIAL_LOCAL_ACTION_FAILED' THEN RAISE EXCEPTION 'AI_INITIAL_JOB_FAILURE_REQUIRED';END IF;
   NEW.available_at=clock_timestamp()+make_interval(secs=>power(2,NEW.failure_count)::integer);
  END IF;
 END IF;NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_job_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_job FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_job();
CREATE FUNCTION enqueue_ai_initial_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='ADMITTED' AND NEW.context->'initialMessage'->>'ready'='true' THEN INSERT INTO ai_initial_job(admission_id) VALUES(NEW.id);END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_initial_job_enqueue AFTER INSERT ON ai_initial_admission FOR EACH ROW EXECUTE FUNCTION enqueue_ai_initial_job();
CREATE FUNCTION ai_initial_execution_context(aid uuid,cvid uuid DEFAULT NULL,mid uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a ai_initial_admission;ctx jsonb;expected jsonb;cv conversation;BEGIN
 SELECT * INTO a FROM ai_initial_admission WHERE id=aid AND state='ADMITTED';IF a IS NULL THEN RETURN NULL;END IF;
 ctx=ai_initial_locked_context(a.receipt_id,a.created_at);expected=a.context;
 IF cvid IS NOT NULL THEN
  SELECT * INTO cv FROM conversation WHERE id=cvid AND ai_initial_admission_id=aid FOR UPDATE;
  IF cv IS NULL OR cv.lead_id::text IS DISTINCT FROM ctx->'scope'->>'leadId' OR cv.version<>1 OR cv.controller_type<>'AI' OR cv.controller_user_id IS NOT NULL
   OR cv.state NOT IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') OR cv.needs_attention_reason IS NOT NULL OR cv.channel<>'WHATSAPP'
   OR cv.sender_id::text IS DISTINCT FROM ctx->'sender'->>'senderId' OR cv.connection_id::text IS DISTINCT FROM ctx->'sender'->>'connectionId'
   OR NOT EXISTS(SELECT 1 FROM lead l JOIN contact ct ON ct.id=l.contact_id WHERE l.id=cv.lead_id AND ct.phone_normalized=cv.participant_ref)
   OR EXISTS(SELECT 1 FROM conversation_message WHERE conversation_id=cv.id AND id IS DISTINCT FROM mid) THEN RETURN NULL;END IF;
  expected=jsonb_set(expected,'{existingConversationIds}',jsonb_build_array(cvid));
 END IF;
 IF ctx IS DISTINCT FROM expected OR ctx->'initialMessage'->>'ready' IS DISTINCT FROM 'true'
   OR position(COALESCE(ctx->'effective'->'disclosure'->>'text','missing disclosure') IN COALESCE(ctx->'initialMessage'->>'body',''))=0 THEN RETURN NULL;END IF;
 -- Availability may change with the clock even though the historical policy snapshot has not changed.
 IF ai_initial_admission_blockers(ai_initial_intake_context(a.receipt_id,clock_timestamp()))- 'AI_INITIAL_EXISTING_CONVERSATION_REQUIRES_REVIEW'<>'[]' THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;
CREATE FUNCTION guard_ai_initial_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;BEGIN
 IF TG_OP='UPDATE' THEN IF NEW.ai_initial_admission_id IS DISTINCT FROM OLD.ai_initial_admission_id THEN RAISE EXCEPTION 'AI_INITIAL_CONVERSATION_PROOF_IMMUTABLE';END IF;RETURN NEW;END IF;
 IF NEW.ai_initial_admission_id IS NULL THEN RETURN NEW;END IF;
 ctx=ai_initial_execution_context(NEW.ai_initial_admission_id);
 IF ctx IS NULL OR NEW.lead_id::text IS DISTINCT FROM ctx->'scope'->>'leadId' OR NEW.sender_id::text IS DISTINCT FROM ctx->'sender'->>'senderId'
  OR NEW.connection_id::text IS DISTINCT FROM ctx->'sender'->>'connectionId' OR NEW.controller_type<>'AI' OR NEW.state<>'AI_ACTIVE' OR NEW.controller_user_id IS NOT NULL
  OR NEW.version<>1 OR NEW.channel<>'WHATSAPP' OR NEW.needs_attention_reason IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM lead l JOIN contact ct ON ct.id=l.contact_id WHERE l.id=NEW.lead_id AND ct.phone_normalized=NEW.participant_ref)
  OR NOT EXISTS(SELECT 1 FROM ai_initial_job WHERE admission_id=NEW.ai_initial_admission_id AND state='WAITING' AND available_at<=clock_timestamp() FOR UPDATE)
  THEN RAISE EXCEPTION 'AI_INITIAL_CURRENT_CONVERSATION_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_conversation_guard BEFORE INSERT OR UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_conversation();
CREATE FUNCTION ai_initial_template_snapshot(ctx jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT ((ctx->'initialMessage'->'approval'->'template')-'id')
  ||CASE WHEN jsonb_array_length(ctx->'initialMessage'->'definition'->'bodyParameters')>0 THEN jsonb_build_object('bodyParameters',ctx->'initialMessage'->'definition'->'bodyParameters') ELSE '{}' END
  ||CASE WHEN ctx->'initialMessage'->'definition'->>'headerParameter' IS NOT NULL THEN jsonb_build_object('headerParameter',ctx->'initialMessage'->'definition'->'headerParameter') ELSE '{}' END
  ||CASE WHEN ctx->'initialMessage'->'definition'->>'urlParameter' IS NOT NULL THEN jsonb_build_object('urlParameter',ctx->'initialMessage'->'definition'->'urlParameter') ELSE '{}' END
$$;
CREATE FUNCTION guard_ai_initial_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a ai_initial_admission;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_INITIAL_ACTION_IMMUTABLE';END IF;
 SELECT * INTO a FROM ai_initial_admission WHERE id=NEW.admission_id;
 IF a IS NULL OR NOT EXISTS(SELECT 1 FROM ai_initial_job WHERE admission_id=a.id AND state='WAITING' AND available_at<=clock_timestamp() FOR UPDATE)
  OR NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation WHERE id=NEW.conversation_id AND ai_initial_admission_id=a.id) THEN RAISE EXCEPTION 'AI_INITIAL_DUE_JOB_REQUIRED';END IF;
 IF NEW.state='APPLIED' THEN
  ctx=ai_initial_execution_context(a.id,NEW.conversation_id);
  IF ctx IS NULL OR ctx->'consent'->>'status'<>'GRANTED' OR ctx->'consent'->>'doNotContact'<>'false'
   OR NEW.content->>'body' IS DISTINCT FROM ctx->'initialMessage'->>'body' OR (NEW.content->'snapshot')-'quickReplyPayloads' IS DISTINCT FROM ai_initial_template_snapshot(ctx)
   THEN RAISE EXCEPTION 'AI_INITIAL_CURRENT_CONTENT_REQUIRED';END IF;
 END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_action_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_send_action FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_action();
DROP TRIGGER ai_send_message_guard ON conversation_message;
CREATE TRIGGER ai_send_message_guard BEFORE INSERT OR UPDATE ON conversation_message FOR EACH ROW WHEN(NEW.ai_initial_action_id IS NULL) EXECUTE FUNCTION guard_ai_send_message();
CREATE FUNCTION guard_ai_initial_message() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;adm ai_initial_admission;BEGIN
 IF TG_OP='UPDATE' THEN IF NEW.ai_initial_action_id IS DISTINCT FROM OLD.ai_initial_action_id THEN RAISE EXCEPTION 'AI_INITIAL_MESSAGE_PROOF_IMMUTABLE';END IF;RETURN NEW;END IF;
 IF NEW.ai_initial_action_id IS NULL THEN RETURN NEW;END IF;
 SELECT ac.*,ac.xmin AS row_xid INTO a FROM ai_initial_send_action ac WHERE ac.id=NEW.ai_initial_action_id;
 SELECT * INTO adm FROM ai_initial_admission WHERE id=a.admission_id;
 IF a IS NULL OR a.state<>'APPLIED' OR NOT ai_row_inserted_here(a.row_xid) OR NEW.id<>a.message_id OR NEW.conversation_id<>a.conversation_id
  OR NEW.sender_id::text IS DISTINCT FROM adm.context->'sender'->>'senderId' OR NEW.connection_id::text IS DISTINCT FROM adm.context->'sender'->>'connectionId'
  OR NEW.author_type<>'AI' OR NEW.direction<>'OUTBOUND' OR NEW.author_user_id IS NOT NULL OR NEW.message_kind<>'TEMPLATE'
  OR NEW.template_id::text IS DISTINCT FROM adm.context->'initialMessage'->'definition'->>'templateId' OR NEW.template_snapshot IS DISTINCT FROM a.content->'snapshot'
  OR NEW.body IS DISTINCT FROM a.content->>'body' OR NEW.idempotency_key IS DISTINCT FROM a.id::text OR NEW.delivery_state<>'QUEUED' OR NEW.attempt_count<>0
  OR NEW.attachment_id IS NOT NULL OR NEW.ai_send_action_id IS NOT NULL OR NEW.source_event_id IS NOT NULL OR NEW.provider_message_id IS NOT NULL OR NEW.sent_at IS NOT NULL
  OR NEW.received_at IS NOT NULL OR NEW.last_error_code IS NOT NULL OR NEW.reply_to_message_id IS NOT NULL OR NEW.reply_button_index IS NOT NULL OR NEW.source_reference IS NOT NULL
  THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_MESSAGE_PROOF_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_message_guard BEFORE INSERT OR UPDATE ON conversation_message FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_message();
CREATE FUNCTION ai_initial_dispatch_context(actid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE ac ai_initial_send_action;ctx jsonb;BEGIN
 SELECT * INTO ac FROM ai_initial_send_action WHERE id=actid AND state='APPLIED';IF ac IS NULL THEN RETURN NULL;END IF;
 ctx=ai_initial_execution_context(ac.admission_id,ac.conversation_id,ac.message_id);
 IF ctx IS NULL OR NOT EXISTS(SELECT 1 FROM conversation_message m WHERE m.id=ac.message_id AND m.ai_initial_action_id=ac.id AND m.body=ac.content->>'body' AND m.template_snapshot=ac.content->'snapshot') THEN RETURN NULL;END IF;
 RETURN ctx||jsonb_build_object('scope',ctx->'scope'||jsonb_build_object('conversationId',ac.conversation_id));
END $$;
CREATE FUNCTION record_ai_initial_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a ai_initial_admission;BEGIN
 SELECT * INTO a FROM ai_initial_admission WHERE id=NEW.admission_id;
 UPDATE ai_initial_job SET state='DONE',version=version+1 WHERE admission_id=a.id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES((a.context->'scope'->>'organizationId')::uuid,(a.context->'scope'->>'branchId')::uuid,'AI_INITIAL_CONTACT_'||NEW.state,'LEAD',(a.context->'scope'->>'leadId')::uuid,jsonb_build_object('actionId',NEW.id,'admissionId',a.id,'messageId',NEW.message_id,'errorCode',NEW.error_code));
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES((a.context->'scope'->>'leadId')::uuid,'AI_INITIAL_CONTACT_'||NEW.state,jsonb_build_object('actionId',NEW.id,'messageId',NEW.message_id,'errorCode',NEW.error_code));
 IF NEW.state='BLOCKED' AND NEW.conversation_id IS NOT NULL THEN UPDATE conversation SET state='AI_HANDOFF_REQUIRED',needs_attention_reason='AI_INITIAL_CONTACT_BLOCKED' WHERE id=NEW.conversation_id AND controller_type='AI';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_action_record AFTER INSERT ON ai_initial_send_action FOR EACH ROW EXECUTE FUNCTION record_ai_initial_action();
CREATE FUNCTION prove_ai_initial_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='APPLIED' AND (ai_initial_dispatch_context(NEW.id) IS NULL OR NOT EXISTS(SELECT 1 FROM conversation_message m JOIN outbound_delivery_job link ON link.message_id=m.id JOIN background_job j ON j.id=link.job_id
  WHERE m.id=NEW.message_id AND m.ai_initial_action_id=NEW.id AND ai_row_inserted_here(m.xmin) AND ai_row_inserted_here(j.xmin) AND j.queue='messaging' AND j.kind='SEND_MESSAGE' AND j.status='QUEUED'
  AND j.attempts=0 AND j.payload=jsonb_build_object('messageId',m.id) AND j.idempotency_key=m.id::text)) THEN RAISE EXCEPTION 'AI_INITIAL_ATOMIC_OUTBOX_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_initial_action_proof AFTER INSERT ON ai_initial_send_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_initial_action();
CREATE FUNCTION prove_ai_initial_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.ai_initial_admission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_initial_send_action WHERE admission_id=NEW.ai_initial_admission_id AND conversation_id=NEW.id AND ai_row_inserted_here(xmin)) THEN RAISE EXCEPTION 'AI_INITIAL_ATOMIC_CONVERSATION_REQUIRED';END IF;RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER ai_initial_conversation_proof AFTER INSERT ON conversation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_initial_conversation();
CREATE FUNCTION guard_ai_initial_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM conversation_message WHERE id=OLD.message_id AND ai_initial_action_id IS NOT NULL) THEN RAISE EXCEPTION 'AI_INITIAL_OUTBOX_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF EXISTS(SELECT 1 FROM conversation_message WHERE id=NEW.message_id AND ai_initial_action_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM conversation_message m JOIN ai_initial_send_action ac ON ac.id=m.ai_initial_action_id WHERE m.id=NEW.message_id AND ai_row_inserted_here(m.xmin) AND ai_row_inserted_here(ac.xmin)) THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_OUTBOX_REQUIRED';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_initial_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbound_delivery_job FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_outbox();
CREATE OR REPLACE FUNCTION guard_ai_send_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE m record;ctx jsonb;BEGIN
 SELECT * INTO m FROM conversation_message WHERE id=NEW.message_id;IF m.ai_send_action_id IS NULL AND m.ai_initial_action_id IS NULL THEN RETURN NEW;END IF;
 ctx=CASE WHEN m.ai_initial_action_id IS NOT NULL THEN ai_initial_dispatch_context(m.ai_initial_action_id) ELSE ai_customer_send_dispatch_context(m.ai_send_action_id) END;
 IF NEW.state<>'PREPARED' OR NEW.provider_message_id IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.finished_at IS NOT NULL OR m.delivery_state<>'QUEUED' OR ctx IS NULL THEN RAISE EXCEPTION 'AI_SEND_CURRENT_ATTEMPT_REQUIRED';END IF;
 PERFORM 1 FROM background_job j JOIN outbound_delivery_job link ON link.job_id=j.id JOIN sender_outbound_lease lease ON lease.job_id=j.id WHERE link.message_id=m.id AND j.id=NEW.job_id AND j.queue='messaging' AND j.kind='SEND_MESSAGE' AND j.status='RUNNING' AND j.attempts=NEW.attempt_number AND j.locked_until>clock_timestamp()+interval '15 seconds' AND lease.sender_id=m.sender_id AND lease.locked_until>clock_timestamp()+interval '15 seconds' FOR KEY SHARE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_SEND_CURRENT_DISPATCH_LEASE_REQUIRED';END IF;NEW.started_at=clock_timestamp();RETURN NEW;
END $$;
