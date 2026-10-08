-- Independent provider reads have their own provenance. Unsigned notifications never become signed receipts.
CREATE TABLE payment_independent_read_job (
  notification_id uuid PRIMARY KEY REFERENCES payment_untrusted_notification(id),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','RETRY','PROCESSED','NEEDS_ATTENTION')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(error_code IS NULL OR error_code ~ '^PAYMENT_[A-Z_]{1,100}$')
);
CREATE INDEX payment_independent_read_due_idx ON payment_independent_read_job(run_after,notification_id) WHERE state IN ('QUEUED','RETRY');
CREATE INDEX payment_independent_read_lease_idx ON payment_independent_read_job(lease_until,notification_id) WHERE state='RUNNING';
CREATE TABLE payment_independent_read_attempt (
  id uuid PRIMARY KEY,notification_id uuid NOT NULL REFERENCES payment_independent_read_job(notification_id),
  number integer NOT NULL CHECK(number BETWEEN 1 AND 5),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','RETRYABLE','REJECTED','INTERRUPTED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,error_code text,
  UNIQUE(notification_id,number),CHECK((state='RUNNING')=(finished_at IS NULL)),
  CHECK(error_code IS NULL OR error_code ~ '^PAYMENT_[A-Z_]{1,100}$')
);
CREATE UNIQUE INDEX payment_independent_read_running_idx ON payment_independent_read_attempt(notification_id) WHERE state='RUNNING';
CREATE TABLE payment_independent_read_confirmation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),intent_id uuid NOT NULL REFERENCES payment_link_intent(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES payment_independent_read_attempt(id),
  provider text NOT NULL CHECK(provider='ALMA'),account_ref text NOT NULL,mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  session_id text NOT NULL CHECK(session_id ~ '^payment_[A-Za-z0-9]{1,120}$'),minor text NOT NULL,currency text NOT NULL CHECK(currency='EUR'),
  session_status text NOT NULL CHECK(session_status IN ('OPEN','COMPLETE','EXPIRED')),payment_status text NOT NULL CHECK(payment_status IN ('PAID','UNPAID')),
  payment_ref text,provider_evidence jsonb NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,intent_id),
  CHECK(COALESCE(jsonb_typeof(provider_evidence)='object'
    AND provider_evidence ?& ARRAY['schemaVersion','source','captureMode','paymentId','intentId','merchantId','mode','currency','minor','installments','deferredMonths','deferredDays','processingStatus','refundMinor','refundState','paymentStatus']
    AND provider_evidence-ARRAY['schemaVersion','source','captureMode','paymentId','intentId','merchantId','mode','currency','minor','installments','deferredMonths','deferredDays','processingStatus','refundMinor','refundState','paymentStatus']='{}'::jsonb
    AND provider_evidence->'schemaVersion'='1'::jsonb AND provider_evidence->>'source'='INDEPENDENT_ALMA_PAYMENT_READ'
    AND provider_evidence->>'captureMode'='AUTOMATIC'
    AND jsonb_typeof(provider_evidence->'source')='string' AND jsonb_typeof(provider_evidence->'captureMode')='string'
    AND jsonb_typeof(provider_evidence->'paymentId')='string' AND jsonb_typeof(provider_evidence->'intentId')='string'
    AND jsonb_typeof(provider_evidence->'merchantId')='string' AND jsonb_typeof(provider_evidence->'mode')='string'
    AND jsonb_typeof(provider_evidence->'currency')='string' AND jsonb_typeof(provider_evidence->'minor')='string'
    AND jsonb_typeof(provider_evidence->'processingStatus')='string' AND jsonb_typeof(provider_evidence->'refundState')='string' AND jsonb_typeof(provider_evidence->'paymentStatus')='string'
    AND provider_evidence->>'paymentId'=session_id AND provider_evidence->>'intentId'=intent_id::text
    AND provider_evidence->>'merchantId'=account_ref AND provider_evidence->>'mode'=mode
    AND provider_evidence->>'currency'=currency AND provider_evidence->>'minor'=minor AND minor ~ '^[1-9][0-9]{0,9}$' AND minor::numeric<=2147483647
    AND jsonb_typeof(provider_evidence->'installments')='number' AND provider_evidence->>'installments' ~ '^[1-9][0-9]{0,4}$'
    AND (provider_evidence->>'installments')::numeric<=65535
    AND jsonb_typeof(provider_evidence->'deferredMonths')='number' AND provider_evidence->>'deferredMonths' ~ '^(0|[1-9][0-9]{0,4})$'
    AND (provider_evidence->>'deferredMonths')::numeric<=65535
    AND jsonb_typeof(provider_evidence->'deferredDays')='number' AND provider_evidence->>'deferredDays' ~ '^(0|[1-9][0-9]{0,4})$'
    AND (provider_evidence->>'deferredDays')::numeric<=65535
    AND jsonb_typeof(provider_evidence->'refundMinor')='string' AND provider_evidence->>'refundMinor' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (provider_evidence->>'refundMinor')::numeric<=minor::numeric
    AND provider_evidence->>'refundState'=CASE WHEN provider_evidence->>'refundMinor'='0' THEN 'NONE'
      WHEN provider_evidence->>'refundMinor'=minor THEN 'FULL' ELSE 'PARTIAL' END
    AND provider_evidence->>'processingStatus' IN ('awaiting_authorization','authorized','captured','canceled')
    AND session_status=CASE provider_evidence->>'processingStatus' WHEN 'captured' THEN 'COMPLETE' WHEN 'canceled' THEN 'EXPIRED' ELSE 'OPEN' END
    AND provider_evidence->>'paymentStatus'=payment_status
    AND (payment_status='PAID')=(provider_evidence->>'processingStatus'='captured' AND provider_evidence->>'refundMinor'='0')
    AND ((payment_status='PAID' AND payment_ref=session_id) OR (payment_status='UNPAID' AND payment_ref IS NULL)),false))
);
CREATE INDEX payment_independent_read_confirmation_intent_idx ON payment_independent_read_confirmation(intent_id,verified_at,id);
CREATE FUNCTION enqueue_independent_payment_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO payment_independent_read_job(notification_id) VALUES(NEW.id);RETURN NEW;END $$;
CREATE TRIGGER payment_independent_read_enqueue AFTER INSERT ON payment_untrusted_notification FOR EACH ROW EXECUTE FUNCTION enqueue_independent_payment_read();
INSERT INTO payment_independent_read_job(notification_id) SELECT id FROM payment_untrusted_notification;
CREATE FUNCTION guard_payment_independent_read_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'QUEUED' OR NEW.attempts<>0) THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_INITIAL_INVALID'; END IF;
  IF TG_OP='UPDATE' AND (NEW.notification_id<>OLD.notification_id OR OLD.state IN ('PROCESSED','NEEDS_ATTENTION')
    OR NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','NEEDS_ATTENTION'))
      OR (OLD.state='RUNNING' AND NEW.state IN ('RETRY','PROCESSED','NEEDS_ATTENTION')))
    OR (NEW.state='RUNNING' AND NEW.attempts<>OLD.attempts+1) OR (NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts))
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_TRANSITION_INVALID'; END IF;
  IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation p
    JOIN payment_independent_read_attempt a ON a.id=p.attempt_id WHERE a.notification_id=NEW.notification_id AND a.id=OLD.lease_token)
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_PROOF_REQUIRED'; END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_independent_read_job_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_independent_read_job FOR EACH ROW EXECUTE FUNCTION guard_payment_independent_read_job();
CREATE FUNCTION guard_payment_independent_read_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING'
    OR (NEW.id,NEW.notification_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.notification_id,OLD.number,OLD.started_at)))
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_ATTEMPT_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'RUNNING' OR NOT EXISTS(SELECT 1 FROM payment_independent_read_job j WHERE j.notification_id=NEW.notification_id
    AND j.state='RUNNING' AND j.lease_token=NEW.id AND j.attempts=NEW.number AND j.lease_until>clock_timestamp())
    OR NEW.number<>(SELECT count(*)+1 FROM payment_independent_read_attempt WHERE notification_id=NEW.notification_id))
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_CLAIM_REQUIRED'; END IF;
  IF NEW.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation WHERE attempt_id=NEW.id)
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_PROOF_REQUIRED'; END IF;
  IF TG_OP='INSERT' THEN NEW.started_at:=clock_timestamp();ELSE NEW.finished_at:=clock_timestamp();END IF;RETURN NEW;
END $$;
CREATE TRIGGER payment_independent_read_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_independent_read_attempt FOR EACH ROW EXECUTE FUNCTION guard_payment_independent_read_attempt();
CREATE FUNCTION guard_payment_independent_read_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_PROOF_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_independent_read_attempt a
    JOIN payment_independent_read_job j ON j.notification_id=a.notification_id
    JOIN payment_untrusted_notification n ON n.id=j.notification_id
    JOIN payment_notification_endpoint endpoint ON endpoint.id=n.endpoint_id
    JOIN payment_link_intent i ON i.connection_id=n.connection_id AND i.mode=n.mode
    JOIN payment_write_admission admission ON admission.intent_id=i.id
    WHERE a.id=NEW.attempt_id AND a.state='RUNNING' AND j.state='RUNNING' AND j.lease_token=a.id AND j.lease_until>clock_timestamp()
      AND i.id=NEW.intent_id AND i.provider='ALMA' AND endpoint.account_ref=i.account_ref AND endpoint.mode=i.mode
      AND n.resource_id=NEW.session_id AND (i.provider,i.account_ref,i.mode,i.minor,i.currency)=(NEW.provider,NEW.account_ref,NEW.mode,NEW.minor,NEW.currency)
      AND i.selected_plan=jsonb_build_object('installments',NEW.provider_evidence->'installments','deferredMonths',NEW.provider_evidence->'deferredMonths','deferredDays',NEW.provider_evidence->'deferredDays')
      AND NOT EXISTS(SELECT 1 FROM payment_checkout_ack k WHERE k.intent_id=i.id AND k.session_id<>NEW.session_id)
      AND NOT EXISTS(SELECT 1 FROM payment_record p WHERE p.intent_id=i.id AND p.session_id<>NEW.session_id))
    THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_ORIGINAL_CONTEXT_REQUIRED'; END IF;
  NEW.verified_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_independent_read_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_independent_read_confirmation FOR EACH ROW EXECUTE FUNCTION guard_payment_independent_read_confirmation();
CREATE FUNCTION audit_payment_independent_read_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT organization_id,branch_id,NULL,'PAYMENT_INDEPENDENT_READ_VERIFIED','PAYMENT_LINK',id,
      jsonb_build_object('proofId',NEW.id,'attemptId',NEW.attempt_id,'source','INDEPENDENT_ALMA_PAYMENT_READ','paymentStatus',NEW.payment_status)
    FROM payment_link_intent WHERE id=NEW.intent_id;RETURN NEW;
END $$;
CREATE TRIGGER payment_independent_read_confirmation_audit AFTER INSERT ON payment_independent_read_confirmation FOR EACH ROW EXECUTE FUNCTION audit_payment_independent_read_confirmation();

-- Shared Payment and Enrollment domain records accept one of two disjoint trusted proof sources.
ALTER TABLE payment_record ALTER COLUMN confirmation_event_id DROP NOT NULL;
ALTER TABLE payment_record ADD COLUMN independent_confirmation_id uuid;
ALTER TABLE payment_record ADD FOREIGN KEY(independent_confirmation_id,intent_id) REFERENCES payment_independent_read_confirmation(id,intent_id);
ALTER TABLE payment_record ADD CONSTRAINT payment_record_confirmation_source CHECK(COALESCE(
  CASE WHEN provider='ALMA' THEN independent_confirmation_id IS NOT NULL AND confirmation_event_id IS NULL
  ELSE independent_confirmation_id IS NULL AND confirmation_event_id IS NOT NULL END,false));
CREATE OR REPLACE FUNCTION guard_payment_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.intent_id,NEW.provider,NEW.account_ref,NEW.mode,NEW.session_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.intent_id,OLD.provider,OLD.account_ref,OLD.mode,OLD.session_id,OLD.created_at)
    OR OLD.state='CONFIRMED' OR (NEW.state='PENDING' AND OLD.state<>'PENDING')) THEN RAISE EXCEPTION 'PAYMENT_STATE_MONOTONIC'; END IF;
  IF NEW.provider='ALMA' THEN
    SELECT provider,account_ref,mode,session_id,payment_status,payment_ref,verified_at INTO p FROM payment_independent_read_confirmation
      WHERE id=NEW.independent_confirmation_id AND intent_id=NEW.intent_id;
  ELSE
    SELECT provider,account_ref,mode,session_id,payment_status,payment_ref,verified_at INTO p FROM payment_confirmation
      WHERE event_id=NEW.confirmation_event_id AND intent_id=NEW.intent_id;
  END IF;
  IF p IS NULL OR (p.provider,p.account_ref,p.mode,p.session_id) IS DISTINCT FROM (NEW.provider,NEW.account_ref,NEW.mode,NEW.session_id)
    OR (NEW.state='CONFIRMED' AND (p.payment_status<>'PAID' OR p.payment_ref IS DISTINCT FROM NEW.payment_ref OR NEW.confirmed_at IS DISTINCT FROM p.verified_at))
    THEN RAISE EXCEPTION 'PAYMENT_TRUSTED_PROOF_REQUIRED'; END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fence_payment_record_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_confirmation; read_proof payment_independent_read_confirmation; event_type text;
BEGIN
  IF NEW.provider='ALMA' THEN
    SELECT * INTO read_proof FROM payment_independent_read_confirmation WHERE id=NEW.independent_confirmation_id AND intent_id=NEW.intent_id;
    IF read_proof IS NULL OR NEW.state='FAILED' OR (NEW.state<>'CONFIRMED' AND read_proof.payment_status='PAID')
      OR (NEW.state='EXPIRED' AND read_proof.session_status<>'EXPIRED')
      OR (NEW.state='PENDING' AND read_proof.session_status='EXPIRED')
      OR (TG_OP='UPDATE' AND OLD.state IN ('FAILED','EXPIRED') AND NEW.state<>'CONFIRMED') THEN RAISE EXCEPTION 'PAYMENT_STATE_PROOF_INVALID'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM payment_confirmation WHERE event_id=NEW.confirmation_event_id AND intent_id=NEW.intent_id;
  SELECT e.event_type INTO event_type FROM payment_webhook_event e WHERE e.id=NEW.confirmation_event_id;
  IF (TG_OP='UPDATE' AND OLD.state IN ('FAILED','EXPIRED') AND NEW.state<>'CONFIRMED')
    OR (NEW.state<>'CONFIRMED' AND p.payment_status='PAID')
    OR (NEW.state='EXPIRED' AND p.session_status<>'EXPIRED')
    OR (NEW.state='FAILED' AND (p.session_status<>'COMPLETE' OR p.payment_status<>'UNPAID' OR NOT ((p.provider='STRIPE' AND event_type='checkout.session.async_payment_failed') OR
      (p.provider='PAYPAL' AND event_type='PAYMENT.CAPTURE.DECLINED' AND p.provider_evidence->>'captureStatus' IN ('DECLINED','FAILED')))))
    THEN RAISE EXCEPTION 'PAYMENT_STATE_PROOF_INVALID'; END IF;RETURN NEW;
END $$;
