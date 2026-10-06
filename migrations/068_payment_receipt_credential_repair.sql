-- Explicit recovery grants a historical verification read, never a new payment creation.
CREATE TABLE payment_receipt_credential (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES payment_webhook_event(id),
  intent_id uuid NOT NULL REFERENCES payment_link_intent(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK(connection_version>0),
  provider text NOT NULL,account_ref text NOT NULL,mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  attempt_before integer NOT NULL CHECK(attempt_before BETWEEN 0 AND 4),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),actor_session_id uuid NOT NULL REFERENCES user_session(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),actor_branch_id uuid REFERENCES branch(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
  ciphertext bytea NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),key_version integer NOT NULL CHECK(key_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,attempt_before)
);
CREATE INDEX payment_receipt_credential_latest_idx ON payment_receipt_credential(event_id,attempt_before DESC);
ALTER TABLE payment_receipt_attempt ADD COLUMN credential_repair_id uuid REFERENCES payment_receipt_credential(id);
CREATE FUNCTION guard_payment_receipt_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CREDENTIAL_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_webhook_event e JOIN payment_receipt_job j ON j.event_id=e.id
    JOIN payment_link_intent i ON i.id=NEW.intent_id JOIN integration_connection c ON c.id=NEW.connection_id
    JOIN user_account u ON u.id=NEW.actor_user_id JOIN user_session s ON s.id=NEW.actor_session_id AND s.user_id=u.id
    WHERE e.id=NEW.event_id AND j.state='NEEDS_ATTENTION' AND j.attempts=NEW.attempt_before AND j.attempts<5
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
CREATE TRIGGER payment_receipt_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_receipt_credential FOR EACH ROW EXECUTE FUNCTION guard_payment_receipt_credential();
CREATE FUNCTION fence_payment_receipt_attempt_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.credential_repair_id IS DISTINCT FROM OLD.credential_repair_id THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_ATTEMPT_CREDENTIAL_IMMUTABLE'; END IF;
  IF NEW.credential_repair_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_receipt_credential r
    WHERE r.id=NEW.credential_repair_id AND r.event_id=NEW.event_id AND r.attempt_before<NEW.number)
    THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_ATTEMPT_CREDENTIAL_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_receipt_attempt_credential_fence BEFORE INSERT OR UPDATE ON payment_receipt_attempt FOR EACH ROW EXECUTE FUNCTION fence_payment_receipt_attempt_credential();
