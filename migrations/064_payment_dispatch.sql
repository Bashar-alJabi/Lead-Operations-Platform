-- Every request has one durable dispatch. Time and leases are supplied by PostgreSQL.
CREATE TABLE payment_dispatch (
  intent_id uuid PRIMARY KEY REFERENCES payment_link_intent(id),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','RETRY','ACCEPTED','FAILED','BLOCKED','NEEDS_ATTENTION')),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid, lease_until timestamptz,
  first_dispatch_ms bigint,
  policy jsonb,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((first_dispatch_ms IS NULL AND policy IS NULL) OR (first_dispatch_ms>=0 AND jsonb_typeof(policy)='object'))
);
CREATE INDEX payment_dispatch_due_idx ON payment_dispatch(run_after,intent_id) WHERE state IN ('QUEUED','RETRY');
CREATE INDEX payment_dispatch_lease_idx ON payment_dispatch(lease_until,intent_id) WHERE state='RUNNING';
CREATE TABLE payment_dispatch_attempt (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES payment_dispatch(intent_id),
  number integer NOT NULL CHECK(number>0),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','ACKNOWLEDGED','REJECTED','RETRYABLE','UNKNOWN','INTERRUPTED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error_code text,
  UNIQUE(intent_id,number),
  CHECK((state='RUNNING')=(finished_at IS NULL)),
  CHECK(error_code IS NULL OR error_code ~ '^PAYMENT_[A-Z_]{1,100}$')
);
CREATE UNIQUE INDEX payment_dispatch_running_idx ON payment_dispatch_attempt(intent_id) WHERE state='RUNNING';
CREATE TABLE payment_checkout_ack (
  intent_id uuid PRIMARY KEY REFERENCES payment_link_intent(id),
  attempt_id uuid NOT NULL REFERENCES payment_dispatch_attempt(id),
  provider text NOT NULL, account_ref text NOT NULL, mode text NOT NULL,
  session_id text NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  ciphertext bytea NOT NULL, nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), key_version integer NOT NULL CHECK(key_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(provider,account_ref,mode,session_id)
);
-- A lease is shared by Connections using the same merchant, including shared Branch Methods.
CREATE TABLE payment_merchant_lease (
  provider text NOT NULL, account_ref text NOT NULL, mode text NOT NULL,
  token uuid, expires_at timestamptz,
  PRIMARY KEY(provider,account_ref,mode),
  CHECK((token IS NULL)=(expires_at IS NULL))
);
CREATE FUNCTION enqueue_payment_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO payment_dispatch(intent_id) VALUES(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER payment_dispatch_enqueue AFTER INSERT ON payment_link_intent FOR EACH ROW EXECUTE FUNCTION enqueue_payment_dispatch();
INSERT INTO payment_dispatch(intent_id) SELECT id FROM payment_link_intent;
CREATE FUNCTION guard_payment_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'QUEUED' OR NEW.first_dispatch_ms IS NOT NULL OR NEW.policy IS NOT NULL OR NEW.error_code IS NOT NULL
      THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_INITIAL_INVALID'; END IF;
  ELSE
    IF NEW.intent_id<>OLD.intent_id OR (OLD.first_dispatch_ms IS NOT NULL AND
      (NEW.first_dispatch_ms,NEW.policy) IS DISTINCT FROM (OLD.first_dispatch_ms,OLD.policy))
      THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_POLICY_IMMUTABLE'; END IF;
    IF OLD.state IN ('ACCEPTED','FAILED','BLOCKED','NEEDS_ATTENTION') OR
      NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','FAILED','BLOCKED','NEEDS_ATTENTION')) OR
        (OLD.state='RUNNING' AND NEW.state IN ('RETRY','ACCEPTED','FAILED','BLOCKED','NEEDS_ATTENTION')))
      THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_TRANSITION_INVALID'; END IF;
    IF NEW.state='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM payment_checkout_ack a WHERE a.intent_id=NEW.intent_id)
      THEN RAISE EXCEPTION 'PAYMENT_CHECKOUT_PROOF_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_dispatch_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_dispatch FOR EACH ROW EXECUTE FUNCTION guard_payment_dispatch();
CREATE FUNCTION guard_payment_dispatch_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d payment_dispatch;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state<>'RUNNING' OR NEW.state='RUNNING' OR
      (NEW.id,NEW.intent_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.intent_id,OLD.number,OLD.started_at)
      THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_IMMUTABLE'; END IF;
  ELSE
    SELECT * INTO d FROM payment_dispatch WHERE intent_id=NEW.intent_id;
    IF NEW.state<>'RUNNING' OR d.state<>'RUNNING' OR d.lease_token<>NEW.id OR d.lease_until<=clock_timestamp()
      OR d.first_dispatch_ms IS NULL OR NEW.number<>(SELECT count(*)+1 FROM payment_dispatch_attempt WHERE intent_id=NEW.intent_id)
      THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_CLAIM_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_dispatch_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_dispatch_attempt FOR EACH ROW EXECUTE FUNCTION guard_payment_dispatch_attempt();
CREATE FUNCTION guard_payment_checkout_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_CHECKOUT_ACK_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_dispatch_attempt a ON a.intent_id=i.id
    WHERE i.id=NEW.intent_id AND a.id=NEW.attempt_id AND a.state='RUNNING'
      AND (i.provider,i.account_ref,i.mode)=(NEW.provider,NEW.account_ref,NEW.mode))
    THEN RAISE EXCEPTION 'PAYMENT_CHECKOUT_ACK_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_checkout_ack_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_checkout_ack FOR EACH ROW EXECUTE FUNCTION guard_payment_checkout_ack();
