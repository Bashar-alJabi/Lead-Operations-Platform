-- Read-only verification retries are bounded per approval. Explicit recovery never resets history.
ALTER TABLE payment_receipt_job DROP CONSTRAINT payment_receipt_job_attempts_check;
ALTER TABLE payment_receipt_job ADD CONSTRAINT payment_receipt_attempt_count CHECK(attempts>=0);
ALTER TABLE payment_receipt_job ADD COLUMN attempt_limit integer NOT NULL DEFAULT 5 CHECK(attempt_limit>=5 AND mod(attempt_limit,5)=0);
ALTER TABLE payment_receipt_job ADD CONSTRAINT payment_receipt_budget CHECK(attempts<=attempt_limit);
ALTER TABLE payment_receipt_attempt DROP CONSTRAINT payment_receipt_attempt_number_check;
ALTER TABLE payment_receipt_attempt ADD CONSTRAINT payment_receipt_positive_number CHECK(number>0);
ALTER TABLE payment_receipt_credential DROP CONSTRAINT payment_receipt_credential_attempt_before_check;
ALTER TABLE payment_receipt_credential ADD CONSTRAINT payment_receipt_credential_positive_attempt CHECK(attempt_before>=0);
CREATE OR REPLACE FUNCTION guard_payment_receipt_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CREDENTIAL_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_webhook_event e JOIN payment_receipt_job j ON j.event_id=e.id
    JOIN payment_link_intent i ON i.id=NEW.intent_id JOIN integration_connection c ON c.id=NEW.connection_id
    JOIN user_account u ON u.id=NEW.actor_user_id JOIN user_session s ON s.id=NEW.actor_session_id AND s.user_id=u.id
    WHERE e.id=NEW.event_id AND j.state='NEEDS_ATTENTION' AND j.attempts=NEW.attempt_before
      AND e.connection_id=c.id AND i.connection_id=c.id AND e.mode=i.mode
      AND (i.provider,i.account_ref,i.mode)=(NEW.provider,NEW.account_ref,NEW.mode)
      AND c.kind='PAYMENT' AND c.organization_id=i.organization_id AND c.provider=NEW.provider AND c.version=NEW.connection_version
      AND c.status IN ('CONNECTED','WARNING') AND c.config->>'mode'=NEW.mode
      AND c.capabilities->>'authenticationVerified'='true' AND c.capabilities->>'paymentOptionsVersion'=NEW.connection_version::text
      AND c.capabilities->'paymentOptions'->>'accountRef'=NEW.account_ref
      AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id)
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CREDENTIAL_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_payment_receipt_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_RETAINED'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'QUEUED' OR NEW.attempts<>0 OR NEW.attempt_limit<>5) THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_INITIAL_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.attempt_limit<>OLD.attempt_limit AND NOT (OLD.state='NEEDS_ATTENTION' AND NEW.state='RETRY'
      AND OLD.attempts=OLD.attempt_limit AND NEW.attempt_limit=OLD.attempt_limit+5
      AND EXISTS(SELECT 1 FROM payment_receipt_credential r WHERE r.event_id=OLD.event_id AND r.attempt_before=OLD.attempts))
      THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_EXPLICIT_RECOVERY_REQUIRED'; END IF;
    IF NEW.event_id<>OLD.event_id OR OLD.state IN ('PROCESSED','IGNORED') OR
      NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','IGNORED','NEEDS_ATTENTION')) OR
        (OLD.state='RUNNING' AND NEW.state IN ('RETRY','PROCESSED','NEEDS_ATTENTION')) OR
        (OLD.state='NEEDS_ATTENTION' AND NEW.state='RETRY' AND NEW.attempts<NEW.attempt_limit)) OR
      (NEW.state='RUNNING' AND NEW.attempts<>OLD.attempts+1) OR (NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts)
      THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_JOB_TRANSITION_INVALID'; END IF;
    IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM payment_confirmation p WHERE p.event_id=NEW.event_id)
      THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_PROOF_REQUIRED'; END IF;
  END IF;RETURN NEW;
END;
$$;
