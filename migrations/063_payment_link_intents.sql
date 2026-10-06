-- Durable, immutable authorization and financial input. Dispatch/results live separately.
CREATE TABLE payment_link_intent (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES lead(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  assigned_agent_id uuid REFERENCES user_account(id),
  request_id uuid NOT NULL,
  method_id uuid NOT NULL,
  method_version integer NOT NULL CHECK(method_version>0),
  method_name text NOT NULL CHECK(length(method_name) BETWEEN 1 AND 100),
  connection_id uuid NOT NULL,
  connection_version integer NOT NULL CHECK(connection_version>0),
  provider text NOT NULL,
  config_snapshot jsonb NOT NULL CHECK(jsonb_typeof(config_snapshot)='object'),
  mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  account_ref text NOT NULL CHECK(length(account_ref) BETWEEN 1 AND 256),
  options_snapshot jsonb NOT NULL CHECK(jsonb_typeof(options_snapshot)='object'),
  webhook_id uuid NOT NULL,
  webhook_version integer NOT NULL CHECK(webhook_version>0),
  amount text NOT NULL CHECK(amount ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' AND length(amount)<=32),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  minor text NOT NULL CHECK(minor ~ '^[1-9][0-9]{0,15}$' AND minor::numeric<=9007199254740991),
  scale integer NOT NULL CHECK(scale BETWEEN 0 AND 4),
  quantum text NOT NULL CHECK(quantum ~ '^[1-9][0-9]{0,4}$'),
  success_url text NOT NULL CHECK(length(success_url) BETWEEN 1 AND 2048),
  cancel_url text NOT NULL CHECK(length(cancel_url) BETWEEN 1 AND 2048),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  key_version integer NOT NULL CHECK(key_version=1),
  requester_id uuid NOT NULL REFERENCES user_account(id),
  requester_session_id uuid NOT NULL REFERENCES user_session(id),
  requester_role text NOT NULL CHECK(requester_role IN ('SUPER_ADMIN','MANAGER','AGENT')),
  requester_branch_id uuid REFERENCES branch(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id),
  FOREIGN KEY(method_id,organization_id) REFERENCES payment_method(id,organization_id),
  FOREIGN KEY(connection_id,organization_id) REFERENCES integration_connection(id,organization_id),
  FOREIGN KEY(webhook_id,connection_id,mode) REFERENCES payment_webhook(id,connection_id,mode),
  UNIQUE(lead_id,request_id),
  UNIQUE(id,organization_id),
  CHECK(amount::numeric*power(10::numeric,scale)=minor::numeric AND mod(minor::numeric,quantum::numeric)=0),
  CHECK(config_snapshot=jsonb_build_object('mode',mode)),
  CHECK(options_snapshot->>'accountRef'=account_ref AND options_snapshot->'currencies' ? currency)
);
CREATE INDEX payment_link_intent_lead_cursor_idx ON payment_link_intent(lead_id,created_at DESC,id DESC);
CREATE INDEX payment_link_intent_connection_idx ON payment_link_intent(connection_id,created_at DESC,id DESC);
CREATE FUNCTION guard_payment_link_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m payment_method; c integration_connection; l lead; w payment_webhook;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_LINK_INTENT_IMMUTABLE'; END IF;
  SELECT * INTO m FROM payment_method WHERE id=NEW.method_id;
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  SELECT * INTO l FROM lead WHERE id=NEW.lead_id;
  SELECT * INTO w FROM payment_webhook WHERE id=NEW.webhook_id;
  IF (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS DISTINCT FROM
    (NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.assigned_agent_id)
    OR m.organization_id IS DISTINCT FROM NEW.organization_id OR m.branch_id IS DISTINCT FROM NEW.branch_id
    OR NOT m.active OR m.version<>NEW.method_version OR m.name<>NEW.method_name OR m.connection_id<>NEW.connection_id
    OR NOT m.currencies ? NEW.currency OR (m.campaign_mode='SELECTED' AND NOT m.campaign_ids ? l.campaign_id::text)
    OR NOT EXISTS(SELECT 1 FROM branch b WHERE b.id=NEW.branch_id AND b.active)
    THEN RAISE EXCEPTION 'PAYMENT_LINK_METHOD_SCOPE_INVALID'; END IF;
  IF c.kind IS DISTINCT FROM 'PAYMENT' OR c.organization_id IS DISTINCT FROM NEW.organization_id
    OR (c.branch_id IS NOT NULL AND c.branch_id<>NEW.branch_id) OR c.version<>NEW.connection_version OR c.provider<>NEW.provider
    OR c.config->>'mode' IS DISTINCT FROM NEW.mode OR c.status NOT IN ('CONNECTED','WARNING')
    OR c.capabilities->>'authenticationVerified' IS DISTINCT FROM 'true'
    OR c.capabilities->>'paymentOptionsVersion' IS DISTINCT FROM NEW.connection_version::text
    OR c.capabilities->'paymentOptions' IS DISTINCT FROM NEW.options_snapshot
    OR NEW.options_snapshot->>'chargesEnabled' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'PAYMENT_LINK_CONNECTION_NOT_READY'; END IF;
  IF w.state IS DISTINCT FROM 'CONFIGURED' OR w.connection_version<>NEW.connection_version OR w.version<>NEW.webhook_version
    OR w.last_signed_at IS NULL OR (SELECT p.state FROM payment_webhook_probe p WHERE p.webhook_id=w.id ORDER BY p.probe_number DESC LIMIT 1) IS DISTINCT FROM 'VERIFIED'
    THEN RAISE EXCEPTION 'PAYMENT_LINK_WEBHOOK_NOT_READY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=NEW.requester_id
    AND u.active AND u.organization_id=NEW.organization_id AND u.role=NEW.requester_role
    AND u.branch_id IS NOT DISTINCT FROM NEW.requester_branch_id AND s.id=NEW.requester_session_id
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=NEW.branch_id)
      OR (u.role='AGENT' AND u.branch_id=NEW.branch_id AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
    THEN RAISE EXCEPTION 'PAYMENT_LINK_ACTOR_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_link_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_link_intent FOR EACH ROW EXECUTE FUNCTION guard_payment_link_intent();
