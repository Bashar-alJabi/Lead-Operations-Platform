-- Current task schedules survive process restarts; historical delivery is unique per task/due instant.
CREATE TABLE follow_up_notification_queue (
 follow_up_id uuid PRIMARY KEY REFERENCES follow_up(id),due_at timestamptz NOT NULL,
 version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN ('WAITING','RECORDED','CANCELLED','DEAD_LETTER')),
 failure_count integer NOT NULL CHECK(failure_count BETWEEN 0 AND 5),next_run_at timestamptz NOT NULL,last_failure_at timestamptz,
 operation text NOT NULL CHECK(operation IN ('SOURCE','RECORDED','FAILURE','RETRY')),
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),updated_at timestamptz NOT NULL
);
CREATE INDEX follow_up_notification_ready ON follow_up_notification_queue(next_run_at,follow_up_id) WHERE state='WAITING';
CREATE TABLE follow_up_due_observation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),follow_up_id uuid NOT NULL REFERENCES follow_up(id),due_at timestamptz NOT NULL,
 follow_up_version integer NOT NULL,owner_user_id uuid REFERENCES user_account(id),organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),lead_id uuid NOT NULL REFERENCES lead(id),created_at timestamptz NOT NULL,
 UNIQUE(follow_up_id,due_at)
);
CREATE INDEX follow_up_due_observation_history ON follow_up_due_observation(follow_up_id,created_at DESC,id DESC);
-- Admit existing OPEN tasks, not historical completed/cancelled tasks. No notification is backdated or fabricated.
INSERT INTO follow_up_notification_queue(follow_up_id,due_at,version,state,failure_count,next_run_at,operation,updated_at)
 SELECT id,due_at,1,'WAITING',0,due_at,'SOURCE',clock_timestamp() FROM follow_up WHERE status='OPEN';

CREATE FUNCTION guard_follow_up_notification_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f follow_up;l lead;u user_account;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.follow_up_id<>OLD.follow_up_id OR NEW.version<>OLD.version+1)
  THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_VERSION_REQUIRED';END IF;
 SELECT * INTO f FROM follow_up WHERE id=NEW.follow_up_id;
 IF f IS NULL THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_TASK_REQUIRED';END IF;
 IF NEW.operation='SOURCE' THEN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM follow_up WHERE id=f.id AND ai_row_inserted_here(xmin))
   THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_FRESH_TASK_REQUIRED';END IF;
  NEW.due_at=f.due_at;
  NEW.failure_count=CASE WHEN TG_OP='INSERT' OR OLD.due_at IS DISTINCT FROM f.due_at THEN 0 ELSE OLD.failure_count END;
  NEW.last_failure_at=CASE WHEN NEW.failure_count=0 THEN NULL ELSE OLD.last_failure_at END;
  NEW.state=CASE WHEN f.status<>'OPEN' THEN 'CANCELLED'
   WHEN EXISTS(SELECT 1 FROM follow_up_due_observation WHERE follow_up_id=f.id AND due_at=f.due_at) THEN 'RECORDED'
   WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
  NEW.next_run_at=CASE WHEN NEW.state='WAITING' THEN CASE WHEN TG_OP='UPDATE' AND OLD.due_at=f.due_at THEN OLD.next_run_at ELSE f.due_at END ELSE 'infinity'::timestamptz END;
 ELSIF TG_OP<>'UPDATE' OR NEW.due_at IS DISTINCT FROM OLD.due_at OR f.due_at IS DISTINCT FROM OLD.due_at OR f.status<>'OPEN' THEN
  RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_CURRENT_TASK_REQUIRED';
 ELSIF NEW.operation='RECORDED' THEN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM follow_up_due_observation WHERE follow_up_id=f.id AND due_at=f.due_at AND ai_row_inserted_here(xmin))
   THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_FRESH_OBSERVATION_REQUIRED';END IF;
  NEW.state='RECORDED';NEW.failure_count=OLD.failure_count;NEW.last_failure_at=OLD.last_failure_at;NEW.next_run_at='infinity';
 ELSIF NEW.operation='FAILURE' THEN
  IF OLD.state<>'WAITING' OR OLD.next_run_at>clock_timestamp() OR OLD.due_at>clock_timestamp()
   THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_RETRY_NOT_DUE';END IF;
  NEW.failure_count=OLD.failure_count+1;NEW.last_failure_at=clock_timestamp();
  NEW.state=CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
  NEW.next_run_at=CASE WHEN NEW.state='DEAD_LETTER' THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>power(2,NEW.failure_count-1)::integer) END;
 ELSIF NEW.operation='RETRY' THEN
  IF OLD.state<>'DEAD_LETTER' OR NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_RETRY_DENIED';END IF;
  SELECT * INTO l FROM lead WHERE id=f.lead_id;
  SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
  IF u IS NULL OR u.organization_id<>l.organization_id OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=l.branch_id)
   THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_RETRY_DENIED';END IF;
  NEW.state='WAITING';NEW.failure_count=0;NEW.last_failure_at=NULL;NEW.next_run_at=GREATEST(f.due_at,clock_timestamp());
 ELSE RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_OPERATION_INVALID';END IF;
 IF NEW.operation<>'RETRY' THEN NEW.actor_id=NULL;NEW.session_id=NULL;END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER follow_up_notification_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON follow_up_notification_queue FOR EACH ROW EXECUTE FUNCTION guard_follow_up_notification_queue();
CREATE FUNCTION schedule_follow_up_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO follow_up_notification_queue(follow_up_id,due_at,version,operation) VALUES(NEW.id,NEW.due_at,1,'SOURCE')
 ON CONFLICT(follow_up_id) DO UPDATE SET version=follow_up_notification_queue.version+1,operation='SOURCE';
 RETURN NEW;
END $$;
CREATE TRIGGER follow_up_notification_schedule AFTER INSERT OR UPDATE ON follow_up FOR EACH ROW EXECUTE FUNCTION schedule_follow_up_notification();

CREATE TABLE follow_up_notification_history (
 follow_up_id uuid NOT NULL REFERENCES follow_up(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(follow_up_id,version)
);
CREATE FUNCTION guard_follow_up_notification_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_HISTORY_IMMUTABLE';END IF;
 SELECT to_jsonb(fq) AS snapshot,fq.updated_at INTO q FROM follow_up_notification_queue fq
  WHERE follow_up_id=NEW.follow_up_id AND version=NEW.version AND ai_row_inserted_here(fq.xmin);
 IF q IS NULL OR NEW.snapshot IS DISTINCT FROM q.snapshot THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_CURRENT_PROOF_REQUIRED';END IF;
 NEW.created_at=q.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER follow_up_notification_history_guard BEFORE INSERT OR UPDATE OR DELETE ON follow_up_notification_history FOR EACH ROW EXECUTE FUNCTION guard_follow_up_notification_history();
CREATE FUNCTION record_follow_up_notification_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE l lead;BEGIN
 INSERT INTO follow_up_notification_history(follow_up_id,version,snapshot,created_at) VALUES(NEW.follow_up_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 IF NEW.operation IN ('FAILURE','RETRY') THEN
  SELECT ld.* INTO l FROM lead ld JOIN follow_up f ON f.lead_id=ld.id WHERE f.id=NEW.follow_up_id;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(l.organization_id,l.branch_id,NEW.actor_id,'FOLLOW_UP_NOTIFICATION_'||NEW.operation,'FOLLOW_UP',NEW.follow_up_id,
    jsonb_build_object('version',NEW.version,'state',NEW.state,'failureCount',NEW.failure_count));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER follow_up_notification_queue_history AFTER INSERT OR UPDATE ON follow_up_notification_queue FOR EACH ROW EXECUTE FUNCTION record_follow_up_notification_queue();

CREATE FUNCTION guard_follow_up_due_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f follow_up;l lead;q follow_up_notification_queue;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FOLLOW_UP_DUE_OBSERVATION_IMMUTABLE';END IF;
 -- Same parent order as the application worker; task writers already hold the Lead lock.
 SELECT ld.* INTO l FROM lead ld JOIN follow_up fu ON fu.lead_id=ld.id WHERE fu.id=NEW.follow_up_id;
 IF l IS NULL THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_TASK_REQUIRED';END IF;
 PERFORM 1 FROM branch WHERE id=l.branch_id FOR SHARE;
 SELECT * INTO l FROM lead WHERE id=l.id FOR SHARE;
 PERFORM 1 FROM campaign WHERE id=l.campaign_id AND organization_id=l.organization_id AND branch_id=l.branch_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_CURRENT_SCOPE_REQUIRED';END IF;
 SELECT * INTO f FROM follow_up WHERE id=NEW.follow_up_id AND lead_id=l.id FOR UPDATE;
 SELECT * INTO q FROM follow_up_notification_queue WHERE follow_up_id=f.id FOR UPDATE;
 IF f IS NULL OR q IS NULL OR f.status<>'OPEN' OR NOT isfinite(f.due_at) OR f.due_at>clock_timestamp()
  OR q.state<>'WAITING' OR q.due_at<>f.due_at OR q.next_run_at>clock_timestamp()
  THEN RAISE EXCEPTION 'FOLLOW_UP_NOTIFICATION_CURRENT_DUE_REQUIRED';END IF;
 NEW.due_at=f.due_at;NEW.follow_up_version=f.version;NEW.owner_user_id=f.owner_user_id;
 NEW.organization_id=l.organization_id;NEW.branch_id=l.branch_id;NEW.campaign_id=l.campaign_id;NEW.lead_id=l.id;NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER follow_up_due_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON follow_up_due_observation FOR EACH ROW EXECUTE FUNCTION guard_follow_up_due_observation();

ALTER TABLE notification_event DROP CONSTRAINT notification_event_event_type_check;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_event_type_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE'));
ALTER TABLE notification_template DROP CONSTRAINT notification_template_event_type_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE'));
ALTER TABLE notification_event ADD COLUMN follow_up_id uuid REFERENCES follow_up(id);
ALTER TABLE notification_event ADD COLUMN follow_up_due_id uuid REFERENCES follow_up_due_observation(id);
ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK(
 (event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED') AND conversation_id IS NOT NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
 OR (event_type='LEAD_CREATED' AND conversation_id IS NULL AND intake_receipt_id IS NOT NULL AND assignment_history_id IS NULL AND source_id=intake_receipt_id AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
 OR (event_type IN ('LEAD_ASSIGNED','LEAD_REASSIGNED') AND conversation_id IS NULL AND assignment_history_id IS NOT NULL AND intake_receipt_id IS NULL
  AND source_id=md5('LEAD_ASSIGNMENT:'||assignment_history_id::text)::uuid AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
 OR (event_type='FOLLOW_UP_DUE' AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NOT NULL AND follow_up_due_id IS NOT NULL AND source_id=follow_up_due_id)
);
CREATE FUNCTION guard_follow_up_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE o follow_up_due_observation;BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_OPERATION_REQUIRED';END IF;
 SELECT * INTO o FROM follow_up_due_observation WHERE id=NEW.follow_up_due_id AND ai_row_inserted_here(xmin);
 IF o IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_OBSERVATION_REQUIRED';END IF;
 NEW.source_id=o.id;NEW.follow_up_id=o.follow_up_id;NEW.organization_id=o.organization_id;NEW.branch_id=o.branch_id;
 NEW.campaign_id=o.campaign_id;NEW.lead_id=o.lead_id;NEW.created_at=o.created_at;NEW.conversation_id=NULL;NEW.intake_receipt_id=NULL;NEW.assignment_history_id=NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_follow_up_event_guard BEFORE INSERT ON notification_event FOR EACH ROW WHEN(NEW.event_type='FOLLOW_UP_DUE') EXECUTE FUNCTION guard_follow_up_notification_event();
CREATE FUNCTION record_follow_up_due_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n notification_event;BEGIN
 UPDATE follow_up_notification_queue SET version=version+1,operation='RECORDED' WHERE follow_up_id=NEW.follow_up_id;
 INSERT INTO notification_event(event_type,follow_up_due_id) VALUES('FOLLOW_UP_DUE',NEW.id) RETURNING * INTO n;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','FOLLOW_UP',NEW.follow_up_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
 RETURN NEW;
END $$;
CREATE TRIGGER follow_up_due_notification AFTER INSERT ON follow_up_due_observation FOR EACH ROW EXECUTE FUNCTION record_follow_up_due_notification();

CREATE OR REPLACE FUNCTION notification_access(eid uuid,uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM notification_event e JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
  JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id
  LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
  LEFT JOIN follow_up f ON f.id=e.follow_up_id AND f.lead_id=l.id
  JOIN user_account u ON u.id=uid AND u.active AND u.organization_id=e.organization_id
  WHERE e.id=eid AND (e.conversation_id IS NULL OR cv.id IS NOT NULL) AND (e.follow_up_id IS NULL OR f.id IS NOT NULL)
   AND (u.role='SUPER_ADMIN' OR u.branch_id=e.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id AND (e.follow_up_id IS NULL OR f.owner_user_id=u.id))))
$$;
