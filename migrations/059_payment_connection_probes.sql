CREATE INDEX payment_connection_cursor_idx ON integration_connection(organization_id,branch_id,created_at DESC,id DESC) WHERE kind='PAYMENT';
CREATE TABLE payment_connection_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK(connection_version>0),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),
  actor_branch_id uuid REFERENCES branch(id),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','FAILED','SUPERSEDED','BLOCKED')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  finished_at timestamptz,
  CHECK((state='RUNNING' AND finished_at IS NULL AND error_code IS NULL) OR (state<>'RUNNING' AND finished_at IS NOT NULL)),
  CHECK(state<>'VERIFIED' OR error_code IS NULL)
);
CREATE INDEX payment_connection_probe_history_idx ON payment_connection_probe(connection_id,created_at DESC,id DESC);
CREATE INDEX payment_connection_probe_latest_idx ON payment_connection_probe(connection_id,probe_number DESC);
CREATE FUNCTION guard_payment_probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_PROBE_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING'
    OR (NEW.id,NEW.probe_number,NEW.connection_id,NEW.connection_version,NEW.actor_user_id,NEW.actor_role,NEW.actor_branch_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.probe_number,OLD.connection_id,OLD.connection_version,OLD.actor_user_id,OLD.actor_role,OLD.actor_branch_id,OLD.created_at,OLD.expires_at))
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'RUNNING' OR NEW.expires_at<=NEW.created_at OR NOT EXISTS (SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_user_id
    WHERE c.id=NEW.connection_id AND c.kind='PAYMENT' AND c.version=NEW.connection_version AND c.status<>'DISABLED'
      AND (c.branch_id IS NULL OR EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active))
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role
      AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR u.branch_id=c.branch_id)))
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_connection_probe FOR EACH ROW EXECUTE FUNCTION guard_payment_probe();
