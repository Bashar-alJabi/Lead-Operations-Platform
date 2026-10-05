ALTER TABLE payment_connection_probe ADD COLUMN purpose text NOT NULL DEFAULT 'AUTH' CHECK(purpose IN ('AUTH','OPTIONS'));
ALTER TABLE payment_connection_probe ADD COLUMN options_snapshot jsonb;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_probe_options_valid CHECK(
  (purpose<>'AUTH' OR options_snapshot IS NULL)
  AND (purpose<>'OPTIONS' OR state<>'VERIFIED' OR options_snapshot IS NOT NULL)
  AND (options_snapshot IS NULL OR (purpose='OPTIONS' AND state='VERIFIED' AND jsonb_typeof(options_snapshot)='object'))
);
CREATE OR REPLACE FUNCTION guard_payment_probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_PROBE_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING'
    OR (NEW.id,NEW.probe_number,NEW.connection_id,NEW.connection_version,NEW.actor_user_id,NEW.actor_role,NEW.actor_branch_id,NEW.created_at,NEW.expires_at,NEW.purpose)
      IS DISTINCT FROM (OLD.id,OLD.probe_number,OLD.connection_id,OLD.connection_version,OLD.actor_user_id,OLD.actor_role,OLD.actor_branch_id,OLD.created_at,OLD.expires_at,OLD.purpose))
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'RUNNING' OR NEW.options_snapshot IS NOT NULL OR NEW.expires_at<=NEW.created_at OR NOT EXISTS (SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_user_id
    WHERE c.id=NEW.connection_id AND c.kind='PAYMENT' AND c.version=NEW.connection_version AND c.status<>'DISABLED'
      AND (c.branch_id IS NULL OR EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active))
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role
      AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR u.branch_id=c.branch_id)))
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
