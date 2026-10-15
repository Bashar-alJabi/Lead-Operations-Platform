-- Terminal rows leave the partial due index, rather than forcing every worker to scan historical jobs.
CREATE OR REPLACE FUNCTION guard_ai_handoff_sla_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;u record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_SLA_QUEUE_HISTORY_PRESERVED';END IF;
 SELECT st.*,st.xmin AS inserted_xid INTO t FROM ai_handoff_sla_timer st WHERE action_id=NEW.action_id;
 IF TG_OP='UPDATE' AND (NEW.action_id<>OLD.action_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'HANDOFF_SLA_QUEUE_VERSION_REQUIRED';END IF;
 IF TG_OP='INSERT' AND NEW.operation<>'STEP' THEN RAISE EXCEPTION 'HANDOFF_SLA_INITIAL_STEP_REQUIRED';END IF;
 NEW.updated_at=ai_handoff_sla_now();
 IF NEW.operation='STEP' THEN
  IF t IS NULL OR NOT ai_row_inserted_here(t.inserted_xid) AND t.state NOT IN ('EXPIRED','CANCELLED') THEN RAISE EXCEPTION 'HANDOFF_SLA_FRESH_STEP_REQUIRED';END IF;
  NEW.next_run_at=CASE WHEN t.state IN ('EXPIRED','CANCELLED') THEN 'infinity'::timestamptz ELSE t.next_run_at END;
  NEW.failure_count=0;NEW.error_code=NULL;NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;
 ELSIF NEW.operation='FAILURE' THEN
  IF t.state IN ('EXPIRED','CANCELLED') OR OLD.failure_count>=5 THEN RAISE EXCEPTION 'HANDOFF_SLA_TERMINAL';END IF;
  NEW.failure_count=OLD.failure_count+1;NEW.next_run_at=NEW.updated_at+make_interval(secs=>power(2,NEW.failure_count)::integer);NEW.error_code='SLA_STEP_FAILED';NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;
 ELSE
  PERFORM 1 FROM branch WHERE id=t.branch_id AND organization_id=t.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_RECOVERY_REQUIRED';END IF;
  PERFORM 1 FROM lead WHERE id=t.lead_id AND branch_id=t.branch_id AND campaign_id=t.campaign_id AND organization_id=t.organization_id FOR SHARE;
  IF NOT FOUND OR NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_RECOVERY_REQUIRED';END IF;
  SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
  IF t.state IN ('EXPIRED','CANCELLED') OR u.organization_id<>t.organization_id OR NOT (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=t.branch_id)
   OR NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 3 AND 500 OR NEW.reason ~ '[\x00-\x1f\x7f]' THEN RAISE EXCEPTION 'HANDOFF_SLA_CURRENT_RECOVERY_REQUIRED';END IF;
  NEW.failure_count=0;NEW.next_run_at=NEW.updated_at;NEW.error_code=NULL;
 END IF;
 IF TG_OP='INSERT' THEN NEW.version=1;END IF;RETURN NEW;
END $$;
UPDATE ai_handoff_sla_queue q SET version=q.version+1,operation='STEP' FROM ai_handoff_sla_timer t WHERE t.action_id=q.action_id AND t.state IN ('EXPIRED','CANCELLED') AND q.next_run_at<>'infinity';
DROP INDEX ai_handoff_sla_queue_due;
CREATE INDEX ai_handoff_sla_queue_due ON ai_handoff_sla_queue(next_run_at,action_id) WHERE failure_count<5 AND next_run_at<'infinity';
