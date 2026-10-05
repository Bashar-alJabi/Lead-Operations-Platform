-- Callback identity is historical. Connection rotation never changes an existing endpoint or its secret.
CREATE TABLE payment_webhook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK(connection_version>0),
  mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  callback_url text NOT NULL CHECK(length(callback_url) BETWEEN 1 AND 2048),
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','CONFIGURED','DISABLED')),
  external_endpoint_id text CHECK(external_endpoint_id ~ '^we_[A-Za-z0-9]{6,100}$'),
  ciphertext bytea, nonce bytea, auth_tag bytea, key_version integer,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES user_account(id),
  updated_by uuid NOT NULL REFERENCES user_account(id),
  change_reason text NOT NULL CHECK(length(btrim(change_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_signed_at timestamptz,
  CHECK((external_endpoint_id IS NULL AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL)
    OR (external_endpoint_id IS NOT NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND key_version=1)),
  CHECK(state<>'CONFIGURED' OR external_endpoint_id IS NOT NULL),
  UNIQUE(id,connection_id,mode)
);
CREATE INDEX payment_webhook_history_idx ON payment_webhook(connection_id,created_at DESC,id DESC);
CREATE TABLE payment_webhook_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  webhook_id uuid NOT NULL REFERENCES payment_webhook(id),
  connection_version integer NOT NULL CHECK(connection_version>0),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),
  actor_branch_id uuid REFERENCES branch(id),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','FAILED','SUPERSEDED','BLOCKED')),
  error_code text,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  finished_at timestamptz,
  CHECK(expires_at>created_at),
  CHECK((state='RUNNING' AND finished_at IS NULL AND error_code IS NULL AND snapshot IS NULL) OR (state<>'RUNNING' AND finished_at IS NOT NULL)),
  CHECK((state='VERIFIED' AND snapshot IS NOT NULL AND jsonb_typeof(snapshot)='object' AND error_code IS NULL) OR (state<>'VERIFIED' AND snapshot IS NULL))
);
CREATE INDEX payment_webhook_probe_history_idx ON payment_webhook_probe(webhook_id,created_at DESC,id DESC);
CREATE INDEX payment_webhook_probe_latest_idx ON payment_webhook_probe(webhook_id,probe_number DESC);
CREATE TABLE payment_webhook_event (
  id uuid PRIMARY KEY,
  webhook_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  external_event_id text NOT NULL CHECK(external_event_id ~ '^evt_[A-Za-z0-9]{6,100}$'),
  event_type text NOT NULL CHECK(event_type ~ '^[a-z][a-z0-9_.]{1,127}$'),
  object_id text NOT NULL CHECK(object_id ~ '^[A-Za-z0-9_:-]{1,128}$'),
  object_type text NOT NULL CHECK(object_type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  provider_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  semantic_hash bytea NOT NULL CHECK(octet_length(semantic_hash)=32),
  ciphertext bytea NOT NULL, nonce bytea NOT NULL CHECK(octet_length(nonce)=12), auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), key_version integer NOT NULL CHECK(key_version=1),
  FOREIGN KEY(webhook_id,connection_id,mode) REFERENCES payment_webhook(id,connection_id,mode),
  UNIQUE(connection_id,mode,external_event_id)
);
CREATE INDEX payment_webhook_event_history_idx ON payment_webhook_event(connection_id,received_at DESC,id DESC);
CREATE INDEX payment_webhook_event_origin_idx ON payment_webhook_event(webhook_id,received_at DESC);
CREATE TABLE payment_webhook_delivery (
  webhook_id uuid NOT NULL REFERENCES payment_webhook(id),
  event_id uuid NOT NULL REFERENCES payment_webhook_event(id),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(webhook_id,event_id)
);
CREATE INDEX payment_webhook_delivery_history_idx ON payment_webhook_delivery(webhook_id,received_at DESC);
CREATE FUNCTION guard_payment_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_HISTORY_RETAINED'; END IF;
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF c.kind IS DISTINCT FROM 'PAYMENT' OR c.provider IS DISTINCT FROM 'STRIPE' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_SCOPE_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.connection_id,NEW.connection_version,NEW.mode,NEW.callback_url,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.mode,OLD.callback_url,OLD.created_by,OLD.created_at)
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_IMMUTABLE'; END IF;
    IF NEW.last_signed_at IS DISTINCT FROM OLD.last_signed_at THEN
      IF (to_jsonb(NEW)-'last_signed_at') IS DISTINCT FROM (to_jsonb(OLD)-'last_signed_at') OR NEW.last_signed_at IS NULL
        OR (OLD.last_signed_at IS NOT NULL AND NEW.last_signed_at<OLD.last_signed_at)
        OR NOT EXISTS(SELECT 1 FROM payment_webhook_delivery e WHERE e.webhook_id=NEW.id AND e.received_at=NEW.last_signed_at)
        THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_RECEIPT_PROOF_REQUIRED'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.version<>OLD.version+1 OR OLD.state='DISABLED' OR NOT ((OLD.state='DRAFT' AND NEW.state='CONFIGURED') OR NEW.state='DISABLED')
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_TRANSITION_INVALID'; END IF;
    IF NOT (OLD.state='DRAFT' AND NEW.state='CONFIGURED') AND (NEW.external_endpoint_id,NEW.ciphertext,NEW.nonce,NEW.auth_tag,NEW.key_version)
      IS DISTINCT FROM (OLD.external_endpoint_id,OLD.ciphertext,OLD.nonce,OLD.auth_tag,OLD.key_version)
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_SECRET_IMMUTABLE'; END IF;
  ELSIF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW.external_endpoint_id IS NOT NULL OR NEW.last_signed_at IS NOT NULL
    OR NEW.created_by<>NEW.updated_by THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_INITIAL_STATE_INVALID'; END IF;
  IF NEW.state<>'DISABLED' AND (c.status='DISABLED' OR c.version<>NEW.connection_version OR c.config->>'mode' IS DISTINCT FROM NEW.mode
    OR (c.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active)))
    THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_CONNECTION_STALE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account u WHERE u.id=NEW.updated_by AND u.active AND u.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))) THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_ACTOR_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_webhook_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_webhook FOR EACH ROW EXECUTE FUNCTION guard_payment_webhook();
CREATE FUNCTION guard_payment_webhook_probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_PROBE_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING'
    OR (NEW.id,NEW.probe_number,NEW.webhook_id,NEW.connection_version,NEW.actor_user_id,NEW.actor_role,NEW.actor_branch_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.probe_number,OLD.webhook_id,OLD.connection_version,OLD.actor_user_id,OLD.actor_role,OLD.actor_branch_id,OLD.created_at,OLD.expires_at))
    THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_PROBE_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'RUNNING' OR NOT EXISTS(SELECT 1 FROM payment_webhook w JOIN integration_connection c ON c.id=w.connection_id
    JOIN user_account u ON u.id=NEW.actor_user_id WHERE w.id=NEW.webhook_id AND w.state='CONFIGURED'
    AND w.connection_version=c.version AND c.version=NEW.connection_version AND c.status<>'DISABLED'
    AND (c.branch_id IS NULL OR EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active))
    AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
    AND (u.role='SUPER_ADMIN' OR u.branch_id=c.branch_id))) THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_PROBE_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_webhook_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_webhook_probe FOR EACH ROW EXECUTE FUNCTION guard_payment_webhook_probe();
CREATE FUNCTION guard_payment_webhook_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_webhook w WHERE w.id=NEW.webhook_id AND w.state='CONFIGURED') THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_NOT_CONFIGURED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_webhook_event_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_webhook_event FOR EACH ROW EXECUTE FUNCTION guard_payment_webhook_event();
CREATE FUNCTION guard_payment_webhook_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_DELIVERY_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_webhook w JOIN payment_webhook_event e ON e.connection_id=w.connection_id AND e.mode=w.mode
    WHERE w.id=NEW.webhook_id AND w.state='CONFIGURED' AND e.id=NEW.event_id) THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_DELIVERY_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_webhook_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_webhook_delivery FOR EACH ROW EXECUTE FUNCTION guard_payment_webhook_delivery();
