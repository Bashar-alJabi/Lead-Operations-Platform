-- Explicit managed approval extends only a bounded read window, never issuance or original financial context.
ALTER TABLE payment_independent_read_job DROP CONSTRAINT payment_independent_read_job_attempts_check;
ALTER TABLE payment_independent_read_job ADD CONSTRAINT independent_read_nonnegative_attempts CHECK(attempts>=0);
ALTER TABLE payment_independent_read_job ADD COLUMN attempt_limit integer NOT NULL DEFAULT 5 CHECK(attempt_limit>=5 AND mod(attempt_limit,5)=0);
ALTER TABLE payment_independent_read_job ADD CONSTRAINT independent_read_attempt_budget CHECK(attempts<=attempt_limit);
ALTER TABLE payment_independent_read_attempt DROP CONSTRAINT payment_independent_read_attempt_number_check;
ALTER TABLE payment_independent_read_attempt ADD CONSTRAINT independent_read_positive_number CHECK(number>0);
CREATE TABLE payment_independent_read_credential (
  id uuid PRIMARY KEY,notification_id uuid NOT NULL REFERENCES payment_untrusted_notification(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL CHECK(connection_version>0),
  provider text NOT NULL CHECK(provider='ALMA'),account_ref text NOT NULL,mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  attempt_before integer NOT NULL CHECK(attempt_before>=0),actor_user_id uuid NOT NULL REFERENCES user_account(id),actor_session_id uuid NOT NULL REFERENCES user_session(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),actor_branch_id uuid REFERENCES branch(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
  ciphertext bytea NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),key_version integer NOT NULL CHECK(key_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(notification_id,attempt_before)
);
CREATE INDEX independent_read_credential_latest_idx ON payment_independent_read_credential(notification_id,attempt_before DESC);
CREATE FUNCTION guard_independent_read_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_READ_CREDENTIAL_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_untrusted_notification n JOIN payment_notification_endpoint e ON e.id=n.endpoint_id
    JOIN payment_independent_read_job j ON j.notification_id=n.id JOIN integration_connection c ON c.id=n.connection_id
    JOIN user_account u ON u.id=NEW.actor_user_id JOIN user_session s ON s.user_id=u.id AND s.id=NEW.actor_session_id
    WHERE n.id=NEW.notification_id AND j.state='NEEDS_ATTENTION' AND j.attempts=NEW.attempt_before
      AND c.id=NEW.connection_id AND c.kind='PAYMENT' AND c.provider=NEW.provider AND c.version=NEW.connection_version
      AND c.status IN ('CONNECTED','WARNING') AND c.config->>'mode'=NEW.mode AND e.mode=NEW.mode AND e.account_ref=NEW.account_ref
      AND c.capabilities->'authenticationVerified'='true'::jsonb AND c.capabilities->'authenticationVersion'=to_jsonb(c.version)
      AND c.capabilities->'authentication'->>'accountRef'=NEW.account_ref AND c.capabilities->'authentication'->>'mode'=NEW.mode
      AND (c.branch_id IS NULL OR EXISTS(SELECT 1 FROM branch WHERE id=c.branch_id AND active))
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'PAYMENT_READ_CREDENTIAL_CURRENT_SCOPE_REQUIRED'; END IF;
  NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER independent_read_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_independent_read_credential FOR EACH ROW EXECUTE FUNCTION guard_independent_read_credential();
CREATE FUNCTION audit_independent_read_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT organization_id,branch_id,NEW.actor_user_id,'PAYMENT_READ_RECOVERY_APPROVED','PAYMENT_NOTIFICATION',NEW.notification_id,
      jsonb_build_object('recoveryId',NEW.id,'attemptBefore',NEW.attempt_before,'connectionVersion',NEW.connection_version,'reason',NEW.reason,'financialWrite',false)
    FROM integration_connection WHERE id=NEW.connection_id;RETURN NEW;
END $$;
CREATE TRIGGER independent_read_credential_audit AFTER INSERT ON payment_independent_read_credential FOR EACH ROW EXECUTE FUNCTION audit_independent_read_credential();
CREATE OR REPLACE FUNCTION guard_payment_independent_read_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'QUEUED' OR NEW.attempts<>0 OR NEW.attempt_limit<>5) THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_INITIAL_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.notification_id<>OLD.notification_id OR OLD.state='PROCESSED'
      OR NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','NEEDS_ATTENTION'))
        OR (OLD.state='RUNNING' AND NEW.state IN ('RETRY','PROCESSED','NEEDS_ATTENTION'))
        OR (OLD.state='NEEDS_ATTENTION' AND NEW.state='RETRY'))
      OR (NEW.state='RUNNING' AND NEW.attempts<>OLD.attempts+1) OR (NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts)
      THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_TRANSITION_INVALID'; END IF;
    IF OLD.state='NEEDS_ATTENTION' AND (NOT EXISTS(SELECT 1 FROM payment_independent_read_credential r WHERE r.notification_id=OLD.notification_id AND r.attempt_before=OLD.attempts)
      OR NEW.attempt_limit<>CASE WHEN OLD.attempts=OLD.attempt_limit THEN OLD.attempt_limit+5 ELSE OLD.attempt_limit END)
      THEN RAISE EXCEPTION 'PAYMENT_READ_RECOVERY_APPROVAL_REQUIRED'; END IF;
    IF OLD.state<>'NEEDS_ATTENTION' AND NEW.attempt_limit<>OLD.attempt_limit THEN RAISE EXCEPTION 'PAYMENT_READ_RECOVERY_APPROVAL_REQUIRED'; END IF;
    IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation p
      WHERE p.attempt_id=OLD.lease_token) THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_PROOF_REQUIRED'; END IF;
  END IF;NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
ALTER TABLE payment_independent_read_attempt ADD COLUMN credential_repair_id uuid REFERENCES payment_independent_read_credential(id);
CREATE FUNCTION fence_independent_read_attempt_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND NEW.credential_repair_id IS DISTINCT FROM OLD.credential_repair_id THEN RAISE EXCEPTION 'PAYMENT_READ_ATTEMPT_CREDENTIAL_IMMUTABLE'; END IF;
  IF NEW.credential_repair_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_independent_read_credential r
    WHERE r.id=NEW.credential_repair_id AND r.notification_id=NEW.notification_id AND r.attempt_before<NEW.number)
    THEN RAISE EXCEPTION 'PAYMENT_READ_ATTEMPT_CREDENTIAL_SCOPE_REQUIRED'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER independent_read_attempt_credential_fence BEFORE INSERT OR UPDATE ON payment_independent_read_attempt FOR EACH ROW EXECUTE FUNCTION fence_independent_read_attempt_credential();
