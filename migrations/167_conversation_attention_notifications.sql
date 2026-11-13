-- Capture under the existing Conversation row lock. Publication takes parent locks later.
CREATE FUNCTION conversation_attention_code(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN value IS NULL THEN NULL
  WHEN value IN ('SEND_OUTCOME_UNKNOWN','DELIVERY_FAILED','PARTICIPANT_CHANGED','CONNECTION_SENDER_MISMATCH','AMBIGUOUS_ACTIVE_CONVERSATIONS','NO_HUMAN_CONTROLLER') THEN value
  WHEN value LIKE 'PINNED\_%' ESCAPE '\' THEN 'PINNED_SENDER_REVIEW_REQUIRED'
  WHEN value LIKE 'TEMPLATE\_%' ESCAPE '\' THEN 'TEMPLATE_REVIEW_REQUIRED'
  ELSE 'REVIEW_REQUIRED' END
$$;
CREATE TABLE conversation_attention_transition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 conversation_id uuid NOT NULL REFERENCES conversation(id),lead_id uuid NOT NULL,organization_id uuid NOT NULL,branch_id uuid NOT NULL,campaign_id uuid NOT NULL,
 reason_hash text,reason_code text,created_at timestamptz NOT NULL,
 CHECK((reason_hash IS NULL)=(reason_code IS NULL)),CHECK(reason_hash IS NULL OR reason_hash ~ '^[a-f0-9]{64}$')
);
-- Parent IDs are historical snapshots derived from the real Conversation/Lead. Adding parent FKs here
-- would acquire Lead KEY SHARE after the writer owns Conversation, inverting assignment's Lead->Conversation locks.
-- The existing Conversation->Lead FK proves the relationship; publication verifies the complete current scope.
CREATE INDEX conversation_attention_latest ON conversation_attention_transition(conversation_id,ordinal DESC);
CREATE INDEX conversation_attention_page ON conversation_attention_transition(conversation_id,created_at DESC,id DESC);
CREATE FUNCTION guard_conversation_attention_transition() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c conversation;l lead;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_HISTORY_IMMUTABLE';END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_FRESH_TRANSITION_REQUIRED';END IF;
 SELECT * INTO c FROM conversation WHERE id=NEW.conversation_id AND ai_row_inserted_here(xmin);
 IF c IS NULL OR NEW.reason_hash IS DISTINCT FROM encode(sha256(convert_to(c.needs_attention_reason,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_CURRENT_TRANSITION_REQUIRED';END IF;
 SELECT * INTO l FROM lead WHERE id=c.lead_id;
 NEW.lead_id=l.id;NEW.organization_id=l.organization_id;NEW.branch_id=l.branch_id;NEW.campaign_id=l.campaign_id;
 NEW.reason_code=conversation_attention_code(c.needs_attention_reason);NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON conversation_attention_transition FOR EACH ROW EXECUTE FUNCTION guard_conversation_attention_transition();
CREATE FUNCTION observe_conversation_attention_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' AND NEW.needs_attention_reason IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND NEW.needs_attention_reason IS NOT DISTINCT FROM OLD.needs_attention_reason THEN RETURN NEW;END IF;
 INSERT INTO conversation_attention_transition(conversation_id,reason_hash) VALUES(NEW.id,encode(sha256(convert_to(NEW.needs_attention_reason,'UTF8')),'hex'));
 RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_observer AFTER INSERT OR UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION observe_conversation_attention_transition();
CREATE FUNCTION conversation_attention_scope(sid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM conversation_attention_transition s JOIN conversation cv ON cv.id=s.conversation_id AND cv.lead_id=s.lead_id
  JOIN lead l ON l.id=s.lead_id AND (l.organization_id,l.branch_id,l.campaign_id)=(s.organization_id,s.branch_id,s.campaign_id)
  JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id WHERE s.id=sid)
$$;
CREATE TABLE conversation_attention_queue (
 source_id uuid PRIMARY KEY REFERENCES conversation_attention_transition(id),version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('QUEUED','RECORDED','STALE_SCOPE','DEAD_LETTER')),failure_count integer NOT NULL CHECK(failure_count BETWEEN 0 AND 5),
 next_run_at timestamptz NOT NULL,last_failure_at timestamptz,operation text NOT NULL CHECK(operation IN ('ADMIT','PUBLISH','FAILURE','RETRY')),
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),updated_at timestamptz NOT NULL
);
CREATE INDEX conversation_attention_ready ON conversation_attention_queue(next_run_at,source_id) WHERE state='QUEUED';
CREATE FUNCTION guard_conversation_attention_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s conversation_attention_transition;u user_account;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_QUEUE_RETAINED';END IF;
 SELECT * INTO s FROM conversation_attention_transition WHERE id=NEW.source_id;
 IF s IS NULL OR s.reason_hash IS NULL THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_SOURCE_REQUIRED';END IF;
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM conversation_attention_transition WHERE id=s.id AND ai_row_inserted_here(xmin)) OR NEW.operation<>'ADMIT' OR NEW.version<>1
   THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_FRESH_SOURCE_REQUIRED';END IF;
  NEW.state='QUEUED';NEW.failure_count=0;NEW.next_run_at=clock_timestamp();NEW.last_failure_at=NULL;
 ELSE
  IF NEW.source_id<>OLD.source_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_VERSION_REQUIRED';END IF;
  IF NEW.operation IN ('PUBLISH','FAILURE') THEN
   IF OLD.state<>'QUEUED' OR OLD.next_run_at>clock_timestamp() THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_NOT_READY';END IF;
   IF NEW.operation='PUBLISH' THEN
    NEW.state=CASE WHEN conversation_attention_scope(s.id) THEN 'RECORDED' ELSE 'STALE_SCOPE' END;
    NEW.failure_count=OLD.failure_count;NEW.last_failure_at=OLD.last_failure_at;NEW.next_run_at='infinity';
   ELSE
    NEW.failure_count=OLD.failure_count+1;NEW.last_failure_at=clock_timestamp();NEW.state=CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'QUEUED' END;
    NEW.next_run_at=CASE WHEN NEW.state='DEAD_LETTER' THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>power(2,NEW.failure_count-1)::integer) END;
   END IF;
  ELSIF NEW.operation='RETRY' THEN
   IF OLD.state<>'DEAD_LETTER' OR NOT notification_session(NEW.actor_id,NEW.session_id) OR NOT conversation_attention_scope(s.id) THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_RETRY_DENIED';END IF;
   SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
   IF u IS NULL OR u.organization_id<>s.organization_id OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=s.branch_id) THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_RETRY_DENIED';END IF;
   NEW.state='QUEUED';NEW.failure_count=0;NEW.last_failure_at=NULL;NEW.next_run_at=clock_timestamp();
  ELSE RAISE EXCEPTION 'CONVERSATION_ATTENTION_OPERATION_INVALID';END IF;
 END IF;
 IF NEW.operation<>'RETRY' THEN NEW.actor_id=NULL;NEW.session_id=NULL;END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON conversation_attention_queue FOR EACH ROW EXECUTE FUNCTION guard_conversation_attention_queue();
CREATE FUNCTION admit_conversation_attention_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.reason_hash IS NOT NULL THEN INSERT INTO conversation_attention_queue(source_id,version,operation) VALUES(NEW.id,1,'ADMIT');END IF;RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_admit AFTER INSERT ON conversation_attention_transition FOR EACH ROW EXECUTE FUNCTION admit_conversation_attention_notification();
CREATE TABLE conversation_attention_queue_history (
 source_id uuid NOT NULL REFERENCES conversation_attention_transition(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(source_id,version)
);
CREATE FUNCTION guard_conversation_attention_queue_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_HISTORY_IMMUTABLE';END IF;
 SELECT to_jsonb(cq) AS snapshot,cq.updated_at INTO q FROM conversation_attention_queue cq WHERE source_id=NEW.source_id AND version=NEW.version AND ai_row_inserted_here(cq.xmin);
 IF q IS NULL OR NEW.snapshot IS DISTINCT FROM q.snapshot THEN RAISE EXCEPTION 'CONVERSATION_ATTENTION_FRESH_QUEUE_REQUIRED';END IF;
 NEW.created_at=q.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_queue_history_guard BEFORE INSERT OR UPDATE OR DELETE ON conversation_attention_queue_history FOR EACH ROW EXECUTE FUNCTION guard_conversation_attention_queue_history();
CREATE FUNCTION record_conversation_attention_queue_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO conversation_attention_queue_history(source_id,version,snapshot,created_at) VALUES(NEW.source_id,NEW.version,to_jsonb(NEW),NEW.updated_at);RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_queue_history AFTER INSERT OR UPDATE ON conversation_attention_queue FOR EACH ROW EXECUTE FUNCTION record_conversation_attention_queue_history();

ALTER TABLE notification_event DROP CONSTRAINT notification_event_event_type_check;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_event_type_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION'));
ALTER TABLE notification_template DROP CONSTRAINT notification_template_event_type_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION'));
ALTER TABLE notification_event ADD COLUMN conversation_attention_id uuid REFERENCES conversation_attention_transition(id);
ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK(
 (conversation_attention_id IS NULL AND (
  (payment_id IS NULL AND enrollment_id IS NULL AND (
   (event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED') AND conversation_id IS NOT NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
   OR (event_type='LEAD_CREATED' AND conversation_id IS NULL AND intake_receipt_id IS NOT NULL AND assignment_history_id IS NULL AND source_id=intake_receipt_id AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
   OR (event_type IN ('LEAD_ASSIGNED','LEAD_REASSIGNED') AND conversation_id IS NULL AND assignment_history_id IS NOT NULL AND intake_receipt_id IS NULL AND source_id=md5('LEAD_ASSIGNMENT:'||assignment_history_id::text)::uuid AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
   OR (event_type='FOLLOW_UP_DUE' AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NOT NULL AND follow_up_due_id IS NOT NULL AND source_id=follow_up_due_id)))
  OR (event_type IN ('PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED') AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL
   AND payment_id IS NOT NULL AND (event_type='PAYMENT_CONFIRMED' AND enrollment_id IS NULL AND source_id=payment_id OR event_type='ENROLLMENT_CONFIRMED' AND enrollment_id IS NOT NULL AND source_id=enrollment_id))))
 OR (event_type='CONVERSATION_NEEDS_ATTENTION' AND conversation_attention_id IS NOT NULL AND source_id=conversation_attention_id AND conversation_id IS NOT NULL
  AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL AND payment_id IS NULL AND enrollment_id IS NULL)
);
CREATE FUNCTION guard_conversation_attention_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s conversation_attention_transition;BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_OPERATION_REQUIRED';END IF;
 SELECT * INTO s FROM conversation_attention_transition WHERE id=NEW.conversation_attention_id AND reason_hash IS NOT NULL;
 IF s IS NULL OR NOT EXISTS(SELECT 1 FROM conversation_attention_queue WHERE source_id=s.id AND state='RECORDED' AND operation='PUBLISH' AND ai_row_inserted_here(xmin))
  OR NOT conversation_attention_scope(s.id) THEN RAISE EXCEPTION 'NOTIFICATION_CURRENT_ATTENTION_PUBLICATION_REQUIRED';END IF;
 NEW.source_id=s.id;NEW.organization_id=s.organization_id;NEW.branch_id=s.branch_id;NEW.campaign_id=s.campaign_id;NEW.lead_id=s.lead_id;NEW.conversation_id=s.conversation_id;
 NEW.intake_receipt_id=NULL;NEW.assignment_history_id=NULL;NEW.follow_up_id=NULL;NEW.follow_up_due_id=NULL;NEW.payment_id=NULL;NEW.enrollment_id=NULL;NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER notification_conversation_attention_guard BEFORE INSERT ON notification_event FOR EACH ROW WHEN(NEW.event_type='CONVERSATION_NEEDS_ATTENTION') EXECUTE FUNCTION guard_conversation_attention_notification();
CREATE FUNCTION publish_conversation_attention_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s conversation_attention_transition;n notification_event;BEGIN
 IF NEW.operation='ADMIT' THEN RETURN NEW;END IF;
 SELECT * INTO s FROM conversation_attention_transition WHERE id=NEW.source_id;
 IF NEW.state='RECORDED' THEN
  INSERT INTO notification_event(event_type,conversation_attention_id) VALUES('CONVERSATION_NEEDS_ATTENTION',s.id) RETURNING * INTO n;
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
   VALUES(s.organization_id,s.branch_id,'IN_APP_NOTIFICATION_RECORDED','CONVERSATION',s.conversation_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
 ELSE
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(s.organization_id,s.branch_id,NEW.actor_id,'CONVERSATION_NOTIFICATION_'||NEW.operation,'CONVERSATION',s.conversation_id,jsonb_build_object('sourceId',s.id,'version',NEW.version,'state',NEW.state,'failureCount',NEW.failure_count));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER conversation_attention_publication AFTER UPDATE ON conversation_attention_queue FOR EACH ROW EXECUTE FUNCTION publish_conversation_attention_notification();
