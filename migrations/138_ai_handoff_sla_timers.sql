-- System clock seam is replaced only by isolated test fixtures, never by request/configuration input.
CREATE FUNCTION ai_handoff_sla_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$;
CREATE FUNCTION ai_handoff_sla_clock(bid uuid,cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT ai_effective_handoff_clock(bid,cid,statement_timestamp())-'evaluatedAt'-'calendarOpenAtEvaluation'-'previewOnly'-'runtimeReady'
$$;
CREATE FUNCTION ai_handoff_sla_values(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('mode',c->'mode','timezone',c->'timezone','calendar',c->'calendar','targetMinutes',c->'targetMinutes')
$$;
CREATE TABLE ai_handoff_sla_timer (
 action_id uuid PRIMARY KEY REFERENCES ai_handoff_reception_event(action_id),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN ('WAITING','UNCONFIGURED','PAUSED','EXPIRED','CANCELLED')),
 reason_code text,started_at timestamptz NOT NULL,cursor_at timestamptz NOT NULL,elapsed_microseconds bigint NOT NULL CHECK(elapsed_microseconds>=0),
 clock jsonb NOT NULL,revision integer NOT NULL CHECK(revision>0),next_run_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 CHECK(cursor_at>=started_at)
);
CREATE INDEX ai_handoff_sla_conversation ON ai_handoff_sla_timer(conversation_id,started_at DESC,action_id);
CREATE INDEX ai_handoff_sla_unadmitted ON conversation(ai_handoff_action_id) WHERE state='WAITING_FOR_HUMAN' AND controller_type='NONE' AND ai_handoff_action_id IS NOT NULL;
CREATE TABLE ai_handoff_sla_history (
 action_id uuid NOT NULL REFERENCES ai_handoff_sla_timer(action_id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(action_id,version)
);
CREATE TABLE ai_handoff_sla_breach (
 action_id uuid PRIMARY KEY REFERENCES ai_handoff_sla_timer(action_id),timer_version integer NOT NULL,snapshot jsonb NOT NULL,observed_at timestamptz NOT NULL
);
CREATE TABLE ai_handoff_sla_queue (
 action_id uuid PRIMARY KEY REFERENCES ai_handoff_sla_timer(action_id),version integer NOT NULL CHECK(version>0),failure_count integer NOT NULL CHECK(failure_count BETWEEN 0 AND 5),
 next_run_at timestamptz NOT NULL,operation text NOT NULL CHECK(operation IN ('STEP','FAILURE','HUMAN_RETRY')),error_code text,
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),reason text,updated_at timestamptz NOT NULL
);
CREATE INDEX ai_handoff_sla_queue_due ON ai_handoff_sla_queue(next_run_at,action_id) WHERE failure_count<5;
CREATE TABLE ai_handoff_sla_queue_history (
 action_id uuid NOT NULL REFERENCES ai_handoff_sla_queue(action_id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(action_id,version)
);
-- Caller payload cannot choose scope, dates, totals or expiration. Every step is derived again under locks.
CREATE FUNCTION guard_ai_handoff_sla_timer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;r record;b record;c record;l record;cv record;current_clock jsonb;slice jsonb;at_time timestamptz;current_reason text;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_SLA_HISTORY_PRESERVED';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state IN ('EXPIRED','CANCELLED') THEN RAISE EXCEPTION 'HANDOFF_SLA_TERMINAL';END IF;
  IF NEW.version<>OLD.version+1 OR (NEW.action_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.started_at)
    IS DISTINCT FROM (OLD.action_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id,OLD.started_at) THEN RAISE EXCEPTION 'HANDOFF_SLA_IDENTITY_VERSION_REQUIRED';END IF;
 END IF;
 SELECT * INTO a FROM ai_customer_handoff_action WHERE id=NEW.action_id AND state='APPLIED';
 SELECT * INTO r FROM ai_handoff_reception_event WHERE action_id=NEW.action_id;
 IF a IS NULL OR r IS NULL THEN RAISE EXCEPTION 'HANDOFF_SLA_ACTUAL_SOURCE_REQUIRED';END IF;
 SELECT * INTO b FROM branch WHERE id=(a.context->'scope'->>'branchId')::uuid FOR UPDATE;
 SELECT * INTO c FROM campaign WHERE id=a.campaign_id FOR SHARE;
 SELECT * INTO l FROM lead WHERE id=a.lead_id FOR SHARE;
 SELECT * INTO cv FROM conversation WHERE id=a.conversation_id FOR SHARE;
 IF b IS NULL OR c IS NULL OR l IS NULL OR cv IS NULL OR b.organization_id<>(a.context->'scope'->>'organizationId')::uuid
  OR (l.organization_id,l.branch_id,l.campaign_id) IS DISTINCT FROM (b.organization_id,b.id,a.campaign_id)
  OR (c.organization_id,c.branch_id) IS DISTINCT FROM (b.organization_id,b.id) OR cv.lead_id<>l.id THEN current_reason='SOURCE_SCOPE_CHANGED';
 ELSIF cv.ai_handoff_action_id IS DISTINCT FROM a.id OR cv.state<>'WAITING_FOR_HUMAN' OR cv.controller_type<>'NONE' THEN current_reason='WAITING_SOURCE_ENDED';
 END IF;
 at_time=ai_handoff_sla_now();
 IF TG_OP='INSERT' THEN
  IF current_reason IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_WAITING_REQUIRED';END IF;
  NEW.organization_id=b.organization_id;NEW.branch_id=b.id;NEW.campaign_id=c.id;NEW.lead_id=l.id;NEW.conversation_id=cv.id;NEW.version=1;NEW.revision=1;
  NEW.started_at=r.created_at;NEW.cursor_at=r.created_at;NEW.elapsed_microseconds=0;NEW.clock=ai_handoff_sla_clock(b.id,c.id);
 ELSE NEW.clock=OLD.clock;NEW.revision=OLD.revision;NEW.cursor_at=OLD.cursor_at;NEW.elapsed_microseconds=OLD.elapsed_microseconds;END IF;
 NEW.updated_at=at_time;NEW.next_run_at=at_time+interval '60 seconds';NEW.reason_code=current_reason;
 IF current_reason IS NOT NULL THEN NEW.state='CANCELLED';RETURN NEW;END IF;
 current_clock=ai_handoff_sla_clock(b.id,c.id);
 IF ai_handoff_sla_values(current_clock) IS DISTINCT FROM ai_handoff_sla_values(NEW.clock) THEN
  NEW.cursor_at=NEW.started_at;NEW.elapsed_microseconds=0;NEW.revision=NEW.revision+1;
 END IF;
 NEW.clock=current_clock;
 IF NOT b.active OR l.lifecycle<>'OPEN' THEN NEW.state='PAUSED';NEW.reason_code=CASE WHEN NOT b.active THEN 'BRANCH_DISABLED' ELSE 'LEAD_NOT_OPEN' END;RETURN NEW;END IF;
 IF current_clock->>'targetMinutes' IS NULL THEN NEW.state='UNCONFIGURED';NEW.reason_code='TARGET_UNCONFIGURED';RETURN NEW;END IF;
 NEW.state='WAITING';
 IF at_time<NEW.cursor_at THEN NEW.reason_code='CLOCK_BEHIND_CURSOR';RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  slice=ai_handoff_clock_slice(current_clock->>'mode',current_clock->>'timezone',current_clock->'calendar',NEW.cursor_at,at_time);
  NEW.cursor_at=(slice->>'processedUntil')::timestamptz;NEW.elapsed_microseconds=NEW.elapsed_microseconds+(slice->>'accountedMicroseconds')::bigint;
  IF NEW.elapsed_microseconds>=(current_clock->>'targetMinutes')::bigint*60000000 THEN NEW.state='EXPIRED';
  ELSIF NOT (slice->>'complete')::boolean THEN NEW.next_run_at=at_time;
  ELSIF current_clock->>'mode'='ELAPSED' THEN NEW.next_run_at=at_time+make_interval(secs=>LEAST(60,((current_clock->>'targetMinutes')::bigint*60000000-NEW.elapsed_microseconds)::numeric/1000000)::double precision);END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_timer_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_sla_timer FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_sla_timer();
CREATE FUNCTION guard_ai_handoff_sla_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE row_data jsonb;x xid;ts timestamptz;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HANDOFF_SLA_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ai_handoff_sla_queue_history' THEN
  SELECT to_jsonb(q),q.xmin,q.updated_at INTO row_data,x,ts FROM ai_handoff_sla_queue q WHERE action_id=NEW.action_id AND version=NEW.version;
 ELSE
  SELECT to_jsonb(t),t.xmin,t.updated_at INTO row_data,x,ts FROM ai_handoff_sla_timer t WHERE action_id=NEW.action_id AND version=NEW.version;
 END IF;
 IF row_data IS NULL OR NOT ai_row_inserted_here(x) OR row_data IS DISTINCT FROM NEW.snapshot THEN RAISE EXCEPTION 'HANDOFF_SLA_FRESH_HISTORY_REQUIRED';END IF;
 NEW.created_at=ts;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_sla_history FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_sla_snapshot();
CREATE TRIGGER ai_handoff_sla_queue_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_sla_queue_history FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_sla_snapshot();
CREATE FUNCTION guard_ai_handoff_sla_breach() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HANDOFF_SLA_BREACH_IMMUTABLE';END IF;
 SELECT st.*,st.xmin AS inserted_xid INTO t FROM ai_handoff_sla_timer st WHERE action_id=NEW.action_id AND state='EXPIRED';
 IF t IS NULL OR NOT ai_row_inserted_here(t.inserted_xid) THEN RAISE EXCEPTION 'HANDOFF_SLA_FRESH_EXPIRY_REQUIRED';END IF;
 NEW.timer_version=t.version;NEW.snapshot=to_jsonb(t)-'inserted_xid';NEW.observed_at=t.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_breach_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_sla_breach FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_sla_breach();
CREATE FUNCTION guard_ai_handoff_sla_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;u record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_SLA_QUEUE_HISTORY_PRESERVED';END IF;
 SELECT st.*,st.xmin AS inserted_xid INTO t FROM ai_handoff_sla_timer st WHERE action_id=NEW.action_id;
 IF TG_OP='UPDATE' AND (NEW.action_id<>OLD.action_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'HANDOFF_SLA_QUEUE_VERSION_REQUIRED';END IF;
 IF TG_OP='INSERT' AND NEW.operation<>'STEP' THEN RAISE EXCEPTION 'HANDOFF_SLA_INITIAL_STEP_REQUIRED';END IF;
 NEW.updated_at=ai_handoff_sla_now();
 IF NEW.operation='STEP' THEN
  IF t IS NULL OR NOT ai_row_inserted_here(t.inserted_xid) THEN RAISE EXCEPTION 'HANDOFF_SLA_FRESH_STEP_REQUIRED';END IF;
  NEW.next_run_at=t.next_run_at;NEW.failure_count=0;NEW.error_code=NULL;NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;
 ELSIF NEW.operation='FAILURE' THEN
  IF t.state IN ('EXPIRED','CANCELLED') OR OLD.failure_count>=5 THEN RAISE EXCEPTION 'HANDOFF_SLA_TERMINAL';END IF;
  NEW.failure_count=OLD.failure_count+1;NEW.next_run_at=NEW.updated_at+make_interval(secs=>power(2,NEW.failure_count)::integer);NEW.error_code='SLA_STEP_FAILED';NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;
 ELSE
  PERFORM 1 FROM branch WHERE id=t.branch_id AND organization_id=t.organization_id FOR UPDATE;
  PERFORM 1 FROM lead WHERE id=t.lead_id AND branch_id=t.branch_id AND campaign_id=t.campaign_id AND organization_id=t.organization_id FOR SHARE;
  IF NOT FOUND OR NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_RECOVERY_REQUIRED';END IF;
  SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
  IF t.state IN ('EXPIRED','CANCELLED') OR u.organization_id<>t.organization_id OR NOT (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=t.branch_id)
   OR NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 3 AND 500 OR NEW.reason ~ '[\x00-\x1f\x7f]' THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_RECOVERY_REQUIRED';END IF;
  NEW.failure_count=0;NEW.next_run_at=NEW.updated_at;NEW.error_code=NULL;
 END IF;
 IF TG_OP='INSERT' THEN NEW.version=1;END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_sla_queue FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_sla_queue();
CREATE FUNCTION record_ai_handoff_sla_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;BEGIN
 INSERT INTO ai_handoff_sla_queue_history VALUES(NEW.action_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 IF NEW.operation='HUMAN_RETRY' OR NEW.failure_count=5 THEN
  SELECT * INTO t FROM ai_handoff_sla_timer WHERE action_id=NEW.action_id;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(t.organization_id,t.branch_id,NEW.actor_id,
   CASE WHEN NEW.operation='HUMAN_RETRY' THEN 'AI_HANDOFF_SLA_RECOVERY_REQUESTED' ELSE 'AI_HANDOFF_SLA_JOB_FAILED' END,'CONVERSATION',t.conversation_id,jsonb_build_object('actionId',t.action_id,'reason',NEW.reason));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_queue_record AFTER INSERT OR UPDATE ON ai_handoff_sla_queue FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_sla_queue();
CREATE FUNCTION record_ai_handoff_sla_timer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_handoff_sla_history VALUES(NEW.action_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 IF TG_OP='INSERT' OR NEW.state IN ('EXPIRED','CANCELLED') OR NEW.revision<>OLD.revision THEN
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,
   CASE WHEN NEW.state='EXPIRED' THEN 'AI_HANDOFF_SLA_EXCEEDED' WHEN NEW.state='CANCELLED' THEN 'AI_HANDOFF_SLA_CANCELLED' WHEN TG_OP='INSERT' THEN 'AI_HANDOFF_SLA_STARTED' ELSE 'AI_HANDOFF_SLA_CLOCK_CHANGED' END,
   'CONVERSATION',NEW.conversation_id,jsonb_build_object('actionId',NEW.action_id,'version',NEW.version,'revision',NEW.revision,'reason',NEW.reason_code));
 END IF;
 IF NEW.state='EXPIRED' THEN INSERT INTO ai_handoff_sla_breach(action_id) VALUES(NEW.action_id);END IF;
 INSERT INTO ai_handoff_sla_queue(action_id,version,operation) VALUES(NEW.action_id,1,'STEP') ON CONFLICT(action_id) DO UPDATE SET version=ai_handoff_sla_queue.version+1,operation='STEP';RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_timer_record AFTER INSERT OR UPDATE ON ai_handoff_sla_timer FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_sla_timer();
CREATE FUNCTION admit_ai_handoff_sla() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_handoff_sla_timer(action_id) VALUES(NEW.action_id) ON CONFLICT(action_id) DO NOTHING;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_admission AFTER INSERT ON ai_handoff_reception_event FOR EACH ROW EXECUTE FUNCTION admit_ai_handoff_sla();
CREATE FUNCTION check_ai_handoff_sla_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;BEGIN
 SELECT * INTO t FROM ai_handoff_sla_timer WHERE action_id=NEW.action_id;
 IF t.state='EXPIRED' AND (NOT EXISTS(SELECT 1 FROM ai_handoff_sla_breach WHERE action_id=t.action_id AND timer_version=t.version)
  OR ai_handoff_reception(t.action_id,clock_timestamp()) IS NULL OR NOT EXISTS(SELECT 1 FROM branch b JOIN lead l ON l.branch_id=b.id WHERE b.id=t.branch_id AND b.active AND l.id=t.lead_id AND l.lifecycle='OPEN')
  OR ai_handoff_sla_values(t.clock) IS DISTINCT FROM ai_handoff_sla_values(ai_handoff_sla_clock(t.branch_id,t.campaign_id))) THEN RAISE EXCEPTION 'HANDOFF_SLA_FINAL_EXPIRY_PROOF_REQUIRED';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ai_handoff_sla_final_expiry AFTER INSERT OR UPDATE ON ai_handoff_sla_timer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ai_handoff_sla_expiry();
