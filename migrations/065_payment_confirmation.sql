CREATE TABLE payment_receipt_job (
  event_id uuid PRIMARY KEY REFERENCES payment_webhook_event(id),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','RETRY','PROCESSED','IGNORED','NEEDS_ATTENTION')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,lease_until timestamptz,error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX payment_receipt_job_due_idx ON payment_receipt_job(run_after,event_id) WHERE state IN ('QUEUED','RETRY');
CREATE INDEX payment_receipt_job_lease_idx ON payment_receipt_job(lease_until,event_id) WHERE state='RUNNING';
CREATE TABLE payment_receipt_attempt (
  id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES payment_receipt_job(event_id),
  number integer NOT NULL CHECK(number BETWEEN 1 AND 5),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','RETRYABLE','REJECTED','INTERRUPTED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,error_code text,
  UNIQUE(event_id,number),CHECK((state='RUNNING')=(finished_at IS NULL))
);
CREATE TABLE payment_confirmation (
  event_id uuid PRIMARY KEY REFERENCES payment_webhook_event(id),
  intent_id uuid NOT NULL REFERENCES payment_link_intent(id),
  attempt_id uuid NOT NULL REFERENCES payment_receipt_attempt(id),
  session_id text NOT NULL,provider text NOT NULL,account_ref text NOT NULL,mode text NOT NULL,
  minor text NOT NULL,currency text NOT NULL,
  session_status text NOT NULL CHECK(session_status IN ('OPEN','COMPLETE','EXPIRED')),
  payment_status text NOT NULL CHECK(payment_status IN ('PAID','UNPAID')),
  payment_ref text,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(payment_status<>'PAID' OR (session_status='COMPLETE' AND payment_ref IS NOT NULL)),
  UNIQUE(event_id,intent_id)
);
CREATE INDEX payment_confirmation_intent_idx ON payment_confirmation(intent_id,verified_at,event_id);
CREATE TABLE payment_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL UNIQUE REFERENCES payment_link_intent(id),
  provider text NOT NULL,account_ref text NOT NULL,mode text NOT NULL,session_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('PENDING','FAILED','EXPIRED','CONFIRMED')),
  payment_ref text,confirmation_event_id uuid NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(confirmation_event_id,intent_id) REFERENCES payment_confirmation(event_id,intent_id),
  UNIQUE(provider,account_ref,mode,session_id),
  CHECK((state='CONFIRMED')=(confirmed_at IS NOT NULL AND payment_ref IS NOT NULL))
);
CREATE UNIQUE INDEX payment_record_ref_idx ON payment_record(provider,account_ref,mode,payment_ref) WHERE payment_ref IS NOT NULL;
CREATE TABLE enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES lead(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES payment_record(id),
  state text NOT NULL DEFAULT 'ENROLLED' CHECK(state='ENROLLED'),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,lead_id)
);
CREATE INDEX enrollment_lead_cursor_idx ON enrollment(lead_id,enrolled_at DESC,id DESC);
CREATE FUNCTION enqueue_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO payment_receipt_job(event_id) VALUES(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER payment_receipt_enqueue AFTER INSERT ON payment_webhook_event FOR EACH ROW EXECUTE FUNCTION enqueue_payment_receipt();
INSERT INTO payment_receipt_job(event_id) SELECT id FROM payment_webhook_event;
CREATE FUNCTION guard_payment_receipt_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_RETAINED'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'QUEUED' OR NEW.attempts<>0) THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_INITIAL_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.event_id<>OLD.event_id OR OLD.state IN ('PROCESSED','IGNORED') OR
      NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','IGNORED','NEEDS_ATTENTION')) OR
        (OLD.state='RUNNING' AND NEW.state IN ('RETRY','PROCESSED','NEEDS_ATTENTION')) OR
        (OLD.state='NEEDS_ATTENTION' AND NEW.state='RETRY' AND NEW.attempts<5)) OR
      (NEW.state='RUNNING' AND NEW.attempts<>OLD.attempts+1) OR (NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts)
      THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_TRANSITION_INVALID'; END IF;
    IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM payment_confirmation p WHERE p.event_id=NEW.event_id)
      THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_PROOF_REQUIRED'; END IF;
  END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER payment_receipt_job_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_receipt_job FOR EACH ROW EXECUTE FUNCTION guard_payment_receipt_job();
CREATE FUNCTION guard_payment_receipt_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING' OR
    (NEW.id,NEW.event_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.number,OLD.started_at)))
    THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_ATTEMPT_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'RUNNING' OR NOT EXISTS(SELECT 1 FROM payment_receipt_job j
    WHERE j.event_id=NEW.event_id AND j.state='RUNNING' AND j.lease_token=NEW.id AND j.attempts=NEW.number AND j.lease_until>clock_timestamp()))
    THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_ATTEMPT_CLAIM_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_receipt_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_receipt_attempt FOR EACH ROW EXECUTE FUNCTION guard_payment_receipt_attempt();
CREATE FUNCTION guard_payment_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_CONFIRMATION_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_webhook_event e ON e.connection_id=i.connection_id AND e.mode=i.mode
    JOIN payment_receipt_attempt a ON a.event_id=e.id WHERE i.id=NEW.intent_id AND e.id=NEW.event_id AND a.id=NEW.attempt_id AND a.state='RUNNING'
    AND e.object_id=NEW.session_id AND e.object_type='checkout.session'
    AND (i.provider,i.account_ref,i.mode,i.minor,i.currency)=(NEW.provider,NEW.account_ref,NEW.mode,NEW.minor,NEW.currency)
    AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM payment_checkout_ack k WHERE k.intent_id=i.id AND k.session_id<>NEW.session_id))
    THEN RAISE EXCEPTION 'PAYMENT_CONFIRMATION_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_confirmation FOR EACH ROW EXECUTE FUNCTION guard_payment_confirmation();
CREATE FUNCTION guard_payment_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_confirmation;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.intent_id,NEW.provider,NEW.account_ref,NEW.mode,NEW.session_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.intent_id,OLD.provider,OLD.account_ref,OLD.mode,OLD.session_id,OLD.created_at)
    OR OLD.state='CONFIRMED' OR (NEW.state='PENDING' AND OLD.state<>'PENDING')) THEN RAISE EXCEPTION 'PAYMENT_STATE_MONOTONIC'; END IF;
  SELECT * INTO p FROM payment_confirmation WHERE event_id=NEW.confirmation_event_id AND intent_id=NEW.intent_id;
  IF p IS NULL OR (p.provider,p.account_ref,p.mode,p.session_id) IS DISTINCT FROM (NEW.provider,NEW.account_ref,NEW.mode,NEW.session_id)
    OR (NEW.state='CONFIRMED' AND (p.payment_status<>'PAID' OR p.payment_ref IS DISTINCT FROM NEW.payment_ref OR NEW.confirmed_at<>p.verified_at))
    THEN RAISE EXCEPTION 'PAYMENT_TRUSTED_PROOF_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_record_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_record FOR EACH ROW EXECUTE FUNCTION guard_payment_record();
CREATE FUNCTION guard_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ENROLLMENT_HISTORY_RETAINED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_record p JOIN payment_link_intent i ON i.id=p.intent_id
    WHERE p.id=NEW.payment_id AND p.state='CONFIRMED' AND i.lead_id=NEW.lead_id) THEN RAISE EXCEPTION 'ENROLLMENT_TRUSTED_PAYMENT_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enrollment_guard BEFORE INSERT OR UPDATE OR DELETE ON enrollment FOR EACH ROW EXECUTE FUNCTION guard_enrollment();
