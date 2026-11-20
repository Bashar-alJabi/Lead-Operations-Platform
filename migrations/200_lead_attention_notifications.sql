-- Capture from the authoritative Lead row; publication runs outside routing transactions.
CREATE TABLE lead_attention_transition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  lead_id uuid NOT NULL REFERENCES lead(id),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  reason_code text CHECK(reason_code IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','LEAD_UNASSIGNED','REVIEW_REQUIRED')),
  created_at timestamptz NOT NULL
);
CREATE INDEX lead_attention_transition_latest ON lead_attention_transition(lead_id,ordinal DESC);

CREATE FUNCTION guard_lead_attention_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_lead lead;
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'LEAD_ATTENTION_TRANSITION_IMMUTABLE'; END IF;
  SELECT * INTO current_lead FROM lead WHERE id=NEW.lead_id AND ai_row_inserted_here(xmin);
  IF current_lead.id IS NULL THEN RAISE EXCEPTION 'LEAD_ATTENTION_TRANSITION_REQUIRED'; END IF;
  NEW.organization_id=current_lead.organization_id;
  NEW.branch_id=current_lead.branch_id;
  NEW.campaign_id=current_lead.campaign_id;
  NEW.reason_code=CASE
    WHEN current_lead.needs_attention_reason IS NULL THEN NULL
    WHEN current_lead.needs_attention_reason IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','LEAD_UNASSIGNED') THEN current_lead.needs_attention_reason
    ELSE 'REVIEW_REQUIRED'
  END;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER lead_attention_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_attention_transition
  FOR EACH ROW EXECUTE FUNCTION guard_lead_attention_transition();

CREATE TABLE lead_attention_queue (
  source_id uuid PRIMARY KEY REFERENCES lead_attention_transition(id),
  version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('WAITING','RECORDED','STALE_SCOPE','DEAD_LETTER')),
  operation text NOT NULL CHECK(operation IN ('ADMIT','PUBLISH','FAILURE','RETRY')),
  failures integer NOT NULL CHECK(failures BETWEEN 0 AND 5),
  run_at timestamptz NOT NULL,
  actor_id uuid REFERENCES user_account(id),
  session_id uuid REFERENCES user_session(id),
  changed_at timestamptz NOT NULL
);
CREATE INDEX lead_attention_queue_ready ON lead_attention_queue(run_at,source_id) WHERE state='WAITING';

CREATE FUNCTION capture_lead_attention_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence lead_attention_transition;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.needs_attention_reason IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.needs_attention_reason IS NOT DISTINCT FROM OLD.needs_attention_reason THEN
    RETURN NEW;
  END IF;
  INSERT INTO lead_attention_transition(lead_id) VALUES(NEW.id) RETURNING * INTO occurrence;
  IF occurrence.reason_code IS NOT NULL THEN
    INSERT INTO lead_attention_queue(source_id,operation) VALUES(occurrence.id,'ADMIT');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_attention_transition_capture AFTER INSERT OR UPDATE OF needs_attention_reason ON lead
  FOR EACH ROW EXECUTE FUNCTION capture_lead_attention_transition();

CREATE FUNCTION lead_attention_scope(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM lead_attention_transition s JOIN lead l ON l.id=s.lead_id
      AND (l.organization_id,l.branch_id,l.campaign_id)=(s.organization_id,s.branch_id,s.campaign_id)
    JOIN campaign c ON (c.id,c.branch_id,c.organization_id)=(l.campaign_id,l.branch_id,l.organization_id)
    WHERE s.id=source
  )
$$;

CREATE FUNCTION guard_lead_attention_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence lead_attention_transition;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LEAD_ATTENTION_QUEUE_RETAINED'; END IF;
  SELECT * INTO occurrence FROM lead_attention_transition WHERE id=NEW.source_id;
  IF occurrence.reason_code IS NULL THEN RAISE EXCEPTION 'LEAD_ATTENTION_SOURCE_REQUIRED'; END IF;
  NEW.changed_at=clock_timestamp();
  IF TG_OP='INSERT' THEN
    IF NEW.operation<>'ADMIT' OR pg_trigger_depth()<2 OR NOT EXISTS (
      SELECT 1 FROM lead_attention_transition WHERE id=occurrence.id AND ai_row_inserted_here(xmin)
    ) THEN RAISE EXCEPTION 'LEAD_ATTENTION_SOURCE_REQUIRED'; END IF;
    NEW.state='WAITING'; NEW.version=1; NEW.failures=0; NEW.run_at=NEW.changed_at;
  ELSE
    IF NEW.source_id<>OLD.source_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'LEAD_ATTENTION_VERSION_REQUIRED'; END IF;
    IF NEW.operation IN ('PUBLISH','FAILURE') AND OLD.state='WAITING' AND OLD.run_at<=NEW.changed_at THEN
      IF NEW.operation='PUBLISH' THEN
        NEW.state=CASE WHEN lead_attention_scope(NEW.source_id) THEN 'RECORDED' ELSE 'STALE_SCOPE' END;
        NEW.failures=OLD.failures; NEW.run_at='infinity';
      ELSE
        NEW.failures=OLD.failures+1;
        NEW.state=CASE WHEN NEW.failures=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
        NEW.run_at=NEW.changed_at+make_interval(secs=>power(2,NEW.failures-1));
      END IF;
    ELSIF NEW.operation='RETRY' AND OLD.state='DEAD_LETTER' AND lead_attention_scope(NEW.source_id) THEN
      IF NOT EXISTS (
        SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
        WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=occurrence.organization_id
          AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=occurrence.branch_id)
          AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s
      ) THEN RAISE EXCEPTION 'LEAD_ATTENTION_RETRY_DENIED'; END IF;
      NEW.state='WAITING'; NEW.failures=0; NEW.run_at=NEW.changed_at;
    ELSE RAISE EXCEPTION 'LEAD_ATTENTION_OPERATION_INVALID'; END IF;
  END IF;
  IF NEW.operation<>'RETRY' THEN NEW.actor_id=NULL; NEW.session_id=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_attention_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_attention_queue
  FOR EACH ROW EXECUTE FUNCTION guard_lead_attention_queue();

ALTER TABLE notification_event ADD COLUMN lead_attention_id uuid UNIQUE REFERENCES lead_attention_transition(id);
DO $$
DECLARE tab text; expr text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['notification_event','notification_preference','notification_template','notification_email_preference'] LOOP
    SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid=tab::regclass AND conname=tab||'_event_type_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',tab,tab||'_event_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR event_type=''LEAD_NEEDS_ATTENTION'')',tab,tab||'_event_type_check',expr);
  END LOOP;
  SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint
    WHERE conrelid='notification_event'::regclass AND conname='notification_event_source_shape';
  ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
  EXECUTE format('ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK (
    ((%s) AND lead_attention_id IS NULL) OR
    (event_type=''LEAD_NEEDS_ATTENTION'' AND lead_attention_id IS NOT NULL AND source_id=lead_attention_id
     AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL
     AND follow_up_id IS NULL AND follow_up_due_id IS NULL AND payment_id IS NULL AND enrollment_id IS NULL
     AND conversation_attention_id IS NULL AND automation_execution_id IS NULL))',expr);
END $$;

CREATE FUNCTION guard_lead_attention_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence lead_attention_transition;
BEGIN
  SELECT s.* INTO occurrence FROM lead_attention_transition s JOIN lead_attention_queue q ON q.source_id=s.id
    WHERE s.id=NEW.lead_attention_id AND q.state='RECORDED' AND q.operation='PUBLISH' AND ai_row_inserted_here(q.xmin);
  IF pg_trigger_depth()<2 OR occurrence.reason_code IS NULL OR NOT lead_attention_scope(occurrence.id)
    THEN RAISE EXCEPTION 'LEAD_ATTENTION_NOTIFICATION_PROOF_REQUIRED'; END IF;
  NEW.source_id=occurrence.id;
  NEW.lead_id=occurrence.lead_id;
  NEW.organization_id=occurrence.organization_id;
  NEW.branch_id=occurrence.branch_id;
  NEW.campaign_id=occurrence.campaign_id;
  NEW.created_at=occurrence.created_at;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_lead_attention_guard BEFORE INSERT ON notification_event
  FOR EACH ROW WHEN(NEW.event_type='LEAD_NEEDS_ATTENTION') EXECUTE FUNCTION guard_lead_attention_notification();

CREATE FUNCTION record_lead_attention_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence lead_attention_transition;
BEGIN
  SELECT * INTO occurrence FROM lead_attention_transition WHERE id=NEW.source_id;
  IF NEW.state='RECORDED' THEN
    INSERT INTO notification_event(event_type,lead_attention_id) VALUES('LEAD_NEEDS_ATTENTION',NEW.source_id);
  END IF;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(occurrence.organization_id,occurrence.branch_id,NEW.actor_id,'LEAD_ATTENTION_NOTIFICATION_CHANGED',
      'LEAD',occurrence.lead_id,jsonb_build_object('sourceId',NEW.source_id,'version',NEW.version,'state',NEW.state,'failures',NEW.failures,'operation',NEW.operation));
  RETURN NEW;
END $$;
CREATE TRIGGER lead_attention_queue_record AFTER UPDATE ON lead_attention_queue
  FOR EACH ROW EXECUTE FUNCTION record_lead_attention_queue();
