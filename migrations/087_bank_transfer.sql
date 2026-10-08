-- Bank requests and reconciliation are independent of hosted checkout and signed provider receipts.
CREATE TABLE bank_transfer_account (
  id uuid PRIMARY KEY REFERENCES integration_connection(id),
  organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),
  mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  beneficiary text NOT NULL CHECK(length(beneficiary) BETWEEN 1 AND 160),
  account_identifier text NOT NULL CHECK(length(account_identifier) BETWEEN 3 AND 200),
  bank_name text NOT NULL CHECK(length(bank_name) BETWEEN 1 AND 160),
  instructions text NOT NULL CHECK(length(instructions)<=1000),
  currencies jsonb NOT NULL CHECK(jsonb_typeof(currencies)='array' AND jsonb_array_length(currencies) BETWEEN 1 AND 32),
  active boolean NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,mode,account_identifier),FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id)
);
CREATE TABLE bank_transfer_account_history (
  account_id uuid NOT NULL REFERENCES bank_transfer_account(id),version integer NOT NULL,snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,version)
);
CREATE FUNCTION guard_bank_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BANK_ACCOUNT_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.organization_id,NEW.branch_id,NEW.mode,NEW.beneficiary,NEW.account_identifier,NEW.bank_name,NEW.currencies,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.mode,OLD.beneficiary,OLD.account_identifier,OLD.bank_name,OLD.currencies,OLD.created_at)
    OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'BANK_ACCOUNT_IDENTITY_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 THEN RAISE EXCEPTION 'BANK_ACCOUNT_VERSION_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_id
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id JOIN branch b ON b.id=NEW.branch_id
    WHERE c.id=NEW.id AND c.organization_id=NEW.organization_id AND c.branch_id=NEW.branch_id AND c.kind='PAYMENT' AND c.provider='BANK_TRANSFER'
    AND u.organization_id=NEW.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=NEW.branch_id))
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND (NOT NEW.active OR b.active)) THEN RAISE EXCEPTION 'BANK_ACCOUNT_ACCESS_INVALID'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER bank_account_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_transfer_account FOR EACH ROW EXECUTE FUNCTION guard_bank_account();
CREATE FUNCTION record_bank_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO bank_transfer_account_history(account_id,version,snapshot) VALUES(NEW.id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'BANK_ACCOUNT_CONFIGURED','BANK_ACCOUNT',NEW.id,jsonb_build_object('version',NEW.version,'reason',NEW.reason,'active',NEW.active));
  RETURN NEW; END $$;
CREATE TRIGGER bank_account_record AFTER INSERT OR UPDATE ON bank_transfer_account FOR EACH ROW EXECUTE FUNCTION record_bank_account();
CREATE FUNCTION guard_bank_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BANK_HISTORY_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_account_history_guard BEFORE UPDATE OR DELETE ON bank_transfer_account_history FOR EACH ROW EXECUTE FUNCTION guard_bank_history();

CREATE TABLE bank_transfer_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),
  lead_id uuid NOT NULL REFERENCES lead(id),method_id uuid NOT NULL REFERENCES payment_method(id),method_version integer NOT NULL,
  method_name text NOT NULL,account_id uuid NOT NULL REFERENCES bank_transfer_account(id),account_version integer NOT NULL,
  beneficiary text NOT NULL,account_identifier text NOT NULL,bank_name text NOT NULL,instructions text NOT NULL,mode text NOT NULL,
  request_id uuid NOT NULL,requester_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reference text NOT NULL UNIQUE CHECK(reference ~ '^BT-[A-F0-9]{32}$'),
  amount text NOT NULL CHECK(amount ~ '^[0-9]+(\.[0-9]+)?$'),minor text NOT NULL CHECK(minor ~ '^[1-9][0-9]*$'),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),scale integer NOT NULL CHECK(scale BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(lead_id,request_id)
);
CREATE INDEX bank_transfer_request_lead_idx ON bank_transfer_request(lead_id,created_at DESC,id DESC);
CREATE FUNCTION guard_bank_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BANK_REQUEST_IMMUTABLE'; END IF;
  IF NEW.minor::numeric>9007199254740991 OR NEW.amount::numeric*power(10::numeric,NEW.scale)<>NEW.minor::numeric THEN RAISE EXCEPTION 'BANK_MONEY_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM bank_transfer_account a JOIN integration_connection c ON c.id=a.id JOIN payment_method m ON m.connection_id=a.id
    JOIN lead l ON l.id=NEW.lead_id JOIN branch b ON b.id=l.branch_id JOIN user_account u ON u.id=NEW.requester_id
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id
    WHERE a.id=NEW.account_id AND m.id=NEW.method_id AND a.active AND c.status='CONNECTED' AND b.active AND m.active
    AND (a.organization_id,a.branch_id,a.version,a.mode,a.beneficiary,a.account_identifier,a.bank_name,a.instructions)
      =(NEW.organization_id,NEW.branch_id,NEW.account_version,NEW.mode,NEW.beneficiary,NEW.account_identifier,NEW.bank_name,NEW.instructions)
    AND (m.organization_id,m.branch_id,m.version,m.name)=(NEW.organization_id,NEW.branch_id,NEW.method_version,NEW.method_name)
    AND l.organization_id=NEW.organization_id AND l.branch_id=NEW.branch_id AND l.lifecycle='OPEN'
    AND a.currencies ? NEW.currency AND m.currencies ? NEW.currency
    AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
    AND (u.role<>'AGENT' OR m.agent_mode='ALL' OR m.agent_ids ? u.id::text)
    AND u.organization_id=NEW.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR (u.role='AGENT' AND l.assigned_agent_id=u.id))
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'BANK_REQUEST_CONTEXT_INVALID'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER bank_request_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_transfer_request FOR EACH ROW EXECUTE FUNCTION guard_bank_request();

CREATE TABLE bank_settlement_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES bank_transfer_account(id),
  description text NOT NULL CHECK(length(trim(description)) BETWEEN 3 AND 500),approved_by uuid NOT NULL REFERENCES user_account(id),
  session_id uuid NOT NULL REFERENCES user_session(id),active boolean NOT NULL DEFAULT true,
  ciphertext bytea NOT NULL,nonce bytea NOT NULL,auth_tag bytea NOT NULL,key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),disabled_at timestamptz,
  CHECK(active=(disabled_at IS NULL))
);
CREATE UNIQUE INDEX bank_settlement_source_active_idx ON bank_settlement_source(account_id) WHERE active;
CREATE FUNCTION guard_bank_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NOT OLD.active OR NEW.active OR
    (to_jsonb(NEW)-'active'-'disabled_at') IS DISTINCT FROM (to_jsonb(OLD)-'active'-'disabled_at'))) THEN RAISE EXCEPTION 'BANK_SOURCE_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM bank_transfer_account a JOIN user_account u ON u.id=NEW.approved_by
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE a.id=NEW.account_id AND a.active AND u.organization_id=a.organization_id AND u.active
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=a.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'BANK_SOURCE_APPROVAL_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER bank_source_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_settlement_source FOR EACH ROW EXECUTE FUNCTION guard_bank_source();
CREATE TABLE bank_settlement_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES bank_settlement_source(id),account_id uuid NOT NULL REFERENCES bank_transfer_account(id),
  event_id text NOT NULL,transaction_id text NOT NULL,mode text NOT NULL,account_identifier text NOT NULL,reference text NOT NULL,
  amount text NOT NULL,currency text NOT NULL,settled_at timestamptz NOT NULL,semantic_hash bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(account_id,event_id)
);
CREATE TRIGGER bank_event_immutable BEFORE UPDATE OR DELETE ON bank_settlement_event FOR EACH ROW EXECUTE FUNCTION guard_bank_history();
CREATE TABLE bank_settlement_job (
  event_id uuid PRIMARY KEY REFERENCES bank_settlement_event(id),state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','RETRY','PROCESSED','NEEDS_ATTENTION')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),lease_token uuid,lease_until timestamptz,
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),error_code text,version integer NOT NULL DEFAULT 1,
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX bank_settlement_job_due_idx ON bank_settlement_job(run_after,event_id) WHERE state IN ('QUEUED','RETRY');
CREATE TABLE bank_settlement_attempt (
  id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES bank_settlement_job(event_id),number integer NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('PROCESSED','RETRY','NEEDS_ATTENTION','INTERRUPTED')),error_code text,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(event_id,number)
);
CREATE TRIGGER bank_attempt_immutable BEFORE UPDATE OR DELETE ON bank_settlement_attempt FOR EACH ROW EXECUTE FUNCTION guard_bank_history();
CREATE TABLE bank_transfer_confirmation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL REFERENCES bank_transfer_request(id),
  source text NOT NULL CHECK(source IN ('AUTHORIZED_MANUAL','TRUSTED_FEED')),
  transaction_id text NOT NULL CHECK(length(trim(transaction_id)) BETWEEN 1 AND 200),
  account_id uuid NOT NULL REFERENCES bank_transfer_account(id),mode text NOT NULL,account_identifier text NOT NULL,reference text NOT NULL,
  amount text NOT NULL,minor text NOT NULL,currency text NOT NULL,settled_at timestamptz NOT NULL,
  actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),reason text,bank_verified boolean,
  event_id uuid REFERENCES bank_settlement_event(id),lease_token uuid,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,request_id),UNIQUE(request_id),UNIQUE(account_id,mode,transaction_id),
  CHECK((source='AUTHORIZED_MANUAL' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND bank_verified IS TRUE AND length(trim(reason)) BETWEEN 3 AND 500 AND event_id IS NULL AND lease_token IS NULL)
    OR (source='TRUSTED_FEED' AND actor_id IS NULL AND session_id IS NULL AND reason IS NULL AND bank_verified IS NULL AND event_id IS NOT NULL AND lease_token IS NOT NULL))
);
CREATE INDEX bank_confirmation_request_idx ON bank_transfer_confirmation(request_id,verified_at DESC,id DESC);
CREATE FUNCTION guard_bank_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BANK_CONFIRMATION_IMMUTABLE'; END IF;
  IF NEW.settled_at>clock_timestamp()+interval '1 minute' OR NOT EXISTS(SELECT 1 FROM bank_transfer_request r
    WHERE r.id=NEW.request_id AND (r.account_id,r.mode,r.account_identifier,r.reference,r.amount,r.minor,r.currency)
      =(NEW.account_id,NEW.mode,NEW.account_identifier,NEW.reference,NEW.amount,NEW.minor,NEW.currency)) THEN RAISE EXCEPTION 'BANK_CONFIRMATION_MISMATCH'; END IF;
  IF NEW.source='AUTHORIZED_MANUAL' THEN
    IF NOT EXISTS(SELECT 1 FROM bank_transfer_request r JOIN bank_transfer_account a ON a.id=r.account_id
      JOIN integration_connection c ON c.id=a.id JOIN lead l ON l.id=r.lead_id JOIN branch b ON b.id=l.branch_id JOIN user_account u ON u.id=NEW.actor_id
      JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE r.id=NEW.request_id AND a.active AND c.status='CONNECTED' AND b.active
      AND l.organization_id=r.organization_id AND l.branch_id=r.branch_id AND u.active AND u.organization_id=r.organization_id
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=r.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'BANK_MANUAL_APPROVAL_DENIED'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM bank_settlement_event e JOIN bank_settlement_job j ON j.event_id=e.id WHERE e.id=NEW.event_id
      AND j.state='RUNNING' AND j.lease_token=NEW.lease_token AND j.lease_until>clock_timestamp()
      AND (e.account_id,e.mode,e.account_identifier,e.reference,e.amount,e.currency,e.transaction_id,e.settled_at)
        =(NEW.account_id,NEW.mode,NEW.account_identifier,NEW.reference,NEW.amount,NEW.currency,NEW.transaction_id,NEW.settled_at)) THEN RAISE EXCEPTION 'BANK_TRUSTED_SOURCE_REQUIRED'; END IF;
  END IF;
  RETURN NEW; END $$;
CREATE TRIGGER bank_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_transfer_confirmation FOR EACH ROW EXECUTE FUNCTION guard_bank_confirmation();
CREATE FUNCTION audit_bank_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT r.organization_id,r.branch_id,NEW.actor_id,'BANK_TRANSFER_CONFIRMED','BANK_TRANSFER',r.id,
      jsonb_build_object('proofId',NEW.id,'source',NEW.source,'transactionId',NEW.transaction_id,'reason',NEW.reason,'eventId',NEW.event_id)
      FROM bank_transfer_request r WHERE r.id=NEW.request_id;
  RETURN NEW; END $$;
CREATE TRIGGER bank_confirmation_audit AFTER INSERT ON bank_transfer_confirmation FOR EACH ROW EXECUTE FUNCTION audit_bank_confirmation();
CREATE FUNCTION guard_bank_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM bank_settlement_source s JOIN bank_transfer_account a ON a.id=s.account_id
    JOIN integration_connection c ON c.id=a.id JOIN branch b ON b.id=a.branch_id
    WHERE s.id=NEW.source_id AND s.account_id=NEW.account_id AND s.active AND a.active AND b.active AND c.status='CONNECTED'
      AND a.mode=NEW.mode AND a.account_identifier=NEW.account_identifier)
    OR length(NEW.event_id) NOT BETWEEN 1 AND 200 OR length(NEW.transaction_id) NOT BETWEEN 1 AND 200
    OR NEW.reference !~ '^BT-[A-F0-9]{32}$' OR NEW.amount !~ '^[0-9]+(\.[0-9]+)?$' OR NEW.currency !~ '^[A-Z]{3}$'
    OR NEW.settled_at>clock_timestamp()+interval '1 minute' THEN RAISE EXCEPTION 'BANK_EVENT_CONTEXT_INVALID'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER bank_event_guard BEFORE INSERT ON bank_settlement_event FOR EACH ROW EXECUTE FUNCTION guard_bank_event();
CREATE FUNCTION guard_bank_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM bank_settlement_job j WHERE j.event_id=NEW.event_id AND j.state='RUNNING' AND j.lease_token=NEW.id AND j.attempts=NEW.number)
    THEN RAISE EXCEPTION 'BANK_ATTEMPT_CLAIM_REQUIRED'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_attempt_guard BEFORE INSERT ON bank_settlement_attempt FOR EACH ROW EXECUTE FUNCTION guard_bank_attempt();
CREATE FUNCTION guard_bank_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BANK_JOB_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'QUEUED' OR NEW.attempts<>0) THEN RAISE EXCEPTION 'BANK_JOB_INITIAL_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.event_id<>OLD.event_id OR NEW.version<>OLD.version+1 OR OLD.state='PROCESSED'
      OR NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state='RUNNING') OR (OLD.state='RUNNING' AND NEW.state IN ('PROCESSED','RETRY','NEEDS_ATTENTION'))
        OR (OLD.state='NEEDS_ATTENTION' AND NEW.state='RETRY' AND NEW.attempts<5))
      OR (NEW.state='RUNNING' AND NEW.attempts<>OLD.attempts+1) OR (NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts)
      THEN RAISE EXCEPTION 'BANK_JOB_TRANSITION_INVALID'; END IF;
    IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM bank_settlement_event e JOIN bank_transfer_confirmation p
      ON p.account_id=e.account_id AND p.mode=e.mode AND p.transaction_id=e.transaction_id
      JOIN bank_transfer_request r ON r.id=p.request_id WHERE e.id=NEW.event_id AND r.reference=e.reference AND r.amount=e.amount AND r.currency=e.currency)
      THEN RAISE EXCEPTION 'BANK_JOB_PROOF_REQUIRED'; END IF;
  END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_job_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_settlement_job FOR EACH ROW EXECUTE FUNCTION guard_bank_job();

ALTER TABLE payment_record ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE payment_record ADD COLUMN bank_request_id uuid UNIQUE REFERENCES bank_transfer_request(id);
ALTER TABLE payment_record ADD COLUMN bank_confirmation_id uuid;
ALTER TABLE payment_record ADD FOREIGN KEY(bank_confirmation_id,bank_request_id) REFERENCES bank_transfer_confirmation(id,request_id);
ALTER TABLE payment_record DROP CONSTRAINT payment_record_confirmation_source;
ALTER TABLE payment_record ADD CONSTRAINT payment_record_confirmation_source CHECK(COALESCE(
  CASE WHEN provider='BANK_TRANSFER' THEN intent_id IS NULL AND bank_request_id IS NOT NULL AND bank_confirmation_id IS NOT NULL AND confirmation_event_id IS NULL AND independent_confirmation_id IS NULL
    WHEN provider='ALMA' THEN intent_id IS NOT NULL AND bank_request_id IS NULL AND bank_confirmation_id IS NULL AND independent_confirmation_id IS NOT NULL AND confirmation_event_id IS NULL
    ELSE intent_id IS NOT NULL AND bank_request_id IS NULL AND bank_confirmation_id IS NULL AND independent_confirmation_id IS NULL AND confirmation_event_id IS NOT NULL END,false));
-- Preserve the already tested hosted guards; bank records have their own native proof checks.
DROP TRIGGER payment_record_guard ON payment_record;
CREATE TRIGGER payment_record_guard BEFORE INSERT OR UPDATE ON payment_record FOR EACH ROW WHEN(NEW.bank_request_id IS NULL) EXECUTE FUNCTION guard_payment_record();
CREATE TRIGGER payment_record_delete_guard BEFORE DELETE ON payment_record FOR EACH ROW EXECUTE FUNCTION guard_payment_record();
DROP TRIGGER payment_record_state_fence ON payment_record;
CREATE TRIGGER payment_record_state_fence BEFORE INSERT OR UPDATE ON payment_record FOR EACH ROW WHEN(NEW.bank_request_id IS NULL) EXECUTE FUNCTION fence_payment_record_state();
CREATE FUNCTION guard_bank_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (NEW.bank_request_id IS DISTINCT FROM OLD.bank_request_id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id)
    THEN RAISE EXCEPTION 'PAYMENT_SOURCE_IMMUTABLE'; END IF;
  IF NEW.bank_request_id IS NOT NULL THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BANK_PAYMENT_IMMUTABLE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM bank_transfer_confirmation f JOIN bank_transfer_request r ON r.id=f.request_id
      WHERE f.id=NEW.bank_confirmation_id AND r.id=NEW.bank_request_id AND NEW.state='CONFIRMED' AND NEW.provider='BANK_TRANSFER'
      AND NEW.account_ref=r.account_id::text AND NEW.mode=r.mode AND NEW.session_id=r.id::text
      AND NEW.payment_ref=f.transaction_id AND NEW.confirmed_at=f.verified_at) THEN RAISE EXCEPTION 'BANK_PAYMENT_PROOF_REQUIRED'; END IF;
  END IF; RETURN NEW; END $$;
CREATE TRIGGER payment_bank_guard BEFORE INSERT OR UPDATE ON payment_record FOR EACH ROW EXECUTE FUNCTION guard_bank_payment();
CREATE OR REPLACE FUNCTION guard_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ENROLLMENT_HISTORY_RETAINED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_record p LEFT JOIN payment_link_intent i ON i.id=p.intent_id LEFT JOIN bank_transfer_request b ON b.id=p.bank_request_id
    WHERE p.id=NEW.payment_id AND p.state='CONFIRMED' AND COALESCE(i.lead_id,b.lead_id)=NEW.lead_id) THEN RAISE EXCEPTION 'ENROLLMENT_TRUSTED_PAYMENT_REQUIRED'; END IF;
  RETURN NEW; END $$;
