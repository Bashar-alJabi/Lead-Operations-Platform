-- Explicit current authorization for capture is independent of the historical link requester.
CREATE TABLE payment_capture_authorization (
  id uuid PRIMARY KEY,intent_id uuid NOT NULL REFERENCES payment_link_intent(id),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),actor_session_id uuid NOT NULL REFERENCES user_session(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER','AGENT')),actor_branch_id uuid REFERENCES branch(id),
  assigned_agent_id uuid REFERENCES user_account(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_capture_authorization_intent_idx ON payment_capture_authorization(intent_id,created_at DESC,id DESC);
CREATE FUNCTION payment_capture_authorized(intent uuid,grant_id uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM payment_capture_authorization a JOIN payment_link_intent i ON i.id=a.intent_id
    JOIN payment_checkout_ack k ON k.intent_id=i.id JOIN payment_dispatch d ON d.intent_id=i.id
    JOIN integration_connection c ON c.id=i.connection_id JOIN branch b ON b.id=i.branch_id
    JOIN payment_method m ON m.id=i.method_id JOIN payment_webhook w ON w.id=i.webhook_id
    JOIN lead l ON l.id=i.lead_id JOIN user_account u ON u.id=a.actor_user_id
    JOIN user_session s ON s.id=a.actor_session_id AND s.user_id=u.id
    WHERE a.id=grant_id AND i.id=intent AND i.provider='PAYPAL' AND d.state='ACCEPTED' AND b.active
      AND m.active AND m.version=i.method_version AND m.connection_id=i.connection_id AND m.branch_id=i.branch_id
      AND m.currencies ? i.currency AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
      AND c.organization_id=i.organization_id AND (c.branch_id IS NULL OR c.branch_id=i.branch_id) AND c.provider=i.provider
      AND c.config=i.config_snapshot AND payment_issuance_current(c,i.connection_version,i.account_ref,i.options_snapshot,i.currency)
      AND w.state='CONFIGURED' AND w.version=i.webhook_version AND w.connection_version=i.connection_version AND w.last_signed_at IS NOT NULL
      AND (SELECT state FROM payment_webhook_probe WHERE webhook_id=w.id ORDER BY probe_number DESC LIMIT 1)='VERIFIED'
      AND (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS NOT DISTINCT FROM (i.organization_id,i.branch_id,i.campaign_id,a.assigned_agent_id)
      AND u.active AND u.organization_id=i.organization_id AND u.role=a.actor_role AND u.branch_id IS NOT DISTINCT FROM a.actor_branch_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR
        (u.role='AGENT' AND u.branch_id=l.branch_id AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
$$;
CREATE FUNCTION guard_payment_capture_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_AUTHORIZATION_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_checkout_ack k ON k.intent_id=i.id
    JOIN lead l ON l.id=i.lead_id JOIN user_account u ON u.id=NEW.actor_user_id
    JOIN user_session s ON s.id=NEW.actor_session_id AND s.user_id=u.id
    WHERE i.id=NEW.intent_id AND i.provider='PAYPAL' AND u.active AND u.organization_id=i.organization_id AND u.role=NEW.actor_role
      AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id AND l.assigned_agent_id IS NOT DISTINCT FROM NEW.assigned_agent_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR (u.role='AGENT' AND u.branch_id=l.branch_id AND l.assigned_agent_id=u.id)))
    THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_AUTHORIZATION_SCOPE_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_capture_authorization_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_capture_authorization FOR EACH ROW EXECUTE FUNCTION guard_payment_capture_authorization();
CREATE TABLE payment_capture_job (
  intent_id uuid PRIMARY KEY REFERENCES payment_checkout_ack(intent_id),
  authorization_id uuid NOT NULL REFERENCES payment_capture_authorization(id),order_id text NOT NULL CHECK(order_id ~ '^[A-Z0-9]{1,36}$'),
  request_key text NOT NULL UNIQUE CHECK(request_key ~ '^lop-capture:[0-9a-f-]{36}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','RETRY','ACCEPTED','FAILED','BLOCKED','NEEDS_ATTENTION')),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,
  first_dispatch_ms bigint,policy jsonb,error_code text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((first_dispatch_ms IS NULL)=(policy IS NULL) AND (policy IS NULL OR (first_dispatch_ms BETWEEN 0 AND 9007199254740991
    AND valid_payment_dispatch_policy(policy) AND first_dispatch_ms::numeric+(policy->>'retentionMs')::numeric<=9007199254740991)))
);
CREATE INDEX payment_capture_due_idx ON payment_capture_job(run_after,intent_id) WHERE state IN ('QUEUED','RETRY');
CREATE INDEX payment_capture_lease_idx ON payment_capture_job(lease_until,intent_id) WHERE state='RUNNING';
CREATE TABLE payment_capture_attempt (
  id uuid PRIMARY KEY,intent_id uuid NOT NULL REFERENCES payment_capture_job(intent_id),
  authorization_id uuid NOT NULL REFERENCES payment_capture_authorization(id),number integer NOT NULL CHECK(number>0),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','ACKNOWLEDGED','REJECTED','RETRYABLE','UNKNOWN','INTERRUPTED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,error_code text,
  CHECK((state='RUNNING')=(finished_at IS NULL)),UNIQUE(intent_id,number)
);
CREATE UNIQUE INDEX payment_capture_running_idx ON payment_capture_attempt(intent_id) WHERE state='RUNNING';
CREATE TABLE payment_capture_ack (
  intent_id uuid PRIMARY KEY REFERENCES payment_capture_job(intent_id),attempt_id uuid NOT NULL REFERENCES payment_capture_attempt(id),
  order_id text NOT NULL,capture_id text NOT NULL CHECK(capture_id ~ '^[A-Z0-9]{1,36}$'),
  capture_status text NOT NULL CHECK(capture_status IN ('COMPLETED','PENDING','DECLINED','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  write_performed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_payment_capture_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'QUEUED' OR NEW.first_dispatch_ms IS NOT NULL OR NEW.policy IS NOT NULL OR NEW.error_code IS NOT NULL
      OR NEW.request_key<>'lop-capture:'||NEW.intent_id::text OR NOT payment_capture_authorized(NEW.intent_id,NEW.authorization_id)
      OR NOT EXISTS(SELECT 1 FROM payment_checkout_ack k WHERE k.intent_id=NEW.intent_id AND k.session_id=NEW.order_id)
      THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_REQUEST_INVALID'; END IF;
  ELSE
    IF (NEW.intent_id,NEW.order_id,NEW.request_key) IS DISTINCT FROM (OLD.intent_id,OLD.order_id,OLD.request_key)
      OR (OLD.first_dispatch_ms IS NOT NULL AND (NEW.first_dispatch_ms,NEW.policy) IS DISTINCT FROM (OLD.first_dispatch_ms,OLD.policy))
      THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_POLICY_IMMUTABLE'; END IF;
    IF NEW.authorization_id<>OLD.authorization_id AND NOT (OLD.state='BLOCKED' AND NEW.state='RETRY'
      AND payment_capture_authorized(NEW.intent_id,NEW.authorization_id)) THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_EXPLICIT_AUTHORIZATION_REQUIRED'; END IF;
    IF NOT ((OLD.state IN ('QUEUED','RETRY') AND NEW.state IN ('RUNNING','FAILED','BLOCKED','NEEDS_ATTENTION'))
      OR (OLD.state='RUNNING' AND NEW.state IN ('ACCEPTED','RETRY','FAILED','BLOCKED','NEEDS_ATTENTION'))
      OR (OLD.state='BLOCKED' AND NEW.state='RETRY' AND NEW.authorization_id<>OLD.authorization_id))
      THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_TRANSITION_INVALID'; END IF;
    IF NEW.state='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM payment_capture_ack k WHERE k.intent_id=NEW.intent_id)
      THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_ACK_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_capture_job_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_capture_job FOR EACH ROW EXECUTE FUNCTION guard_payment_capture_job();
CREATE FUNCTION guard_payment_capture_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j payment_capture_job;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING' OR
    (NEW.id,NEW.intent_id,NEW.authorization_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.intent_id,OLD.authorization_id,OLD.number,OLD.started_at)))
    THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_ATTEMPT_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO j FROM payment_capture_job WHERE intent_id=NEW.intent_id;
    IF NEW.state<>'RUNNING' OR j.state<>'RUNNING' OR j.lease_token<>NEW.id OR j.lease_until<=clock_timestamp()
      OR NEW.authorization_id<>j.authorization_id OR NOT payment_capture_authorized(NEW.intent_id,NEW.authorization_id)
      OR j.policy IS NULL OR j.first_dispatch_ms IS NULL OR NEW.number<>(SELECT count(*)+1 FROM payment_capture_attempt WHERE intent_id=NEW.intent_id)
      OR NEW.number>(j.policy->>'maxAttempts')::integer
      OR floor(extract(epoch FROM clock_timestamp())*1000)+(j.policy->>'dispatchBudgetMs')::bigint>=j.first_dispatch_ms+(j.policy->>'retentionMs')::bigint
      THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_CURRENT_FENCE_REQUIRED'; END IF;
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER payment_capture_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_capture_attempt FOR EACH ROW EXECUTE FUNCTION guard_payment_capture_attempt();
CREATE FUNCTION guard_payment_capture_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_ACK_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_capture_job j JOIN payment_capture_attempt a ON a.intent_id=j.intent_id
    WHERE j.intent_id=NEW.intent_id AND a.id=NEW.attempt_id AND a.state='RUNNING' AND j.state='RUNNING'
      AND j.lease_token=a.id AND j.order_id=NEW.order_id) THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_ACK_SCOPE_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_capture_ack_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_capture_ack FOR EACH ROW EXECUTE FUNCTION guard_payment_capture_ack();
