-- A configured expectation is not provider verification or financial confirmation.
ALTER TABLE integration_connection ADD CONSTRAINT payment_expected_merchant_valid CHECK(
  NOT(config ? 'expectedMerchantId') OR COALESCE(
    kind='PAYMENT' AND provider='PAYPAL' AND jsonb_typeof(config->'expectedMerchantId')='string'
      AND (config->>'expectedMerchantId') ~ '^[2-9A-HJ-NP-Z]{13}$',false)
);
CREATE FUNCTION guard_payment_beneficiary_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.config->'mode',NEW.config->'expectedMerchantId') IS DISTINCT FROM (OLD.config->'mode',OLD.config->'expectedMerchantId')
    AND (NEW.version<>OLD.version+1 OR NEW.status<>'NOT_CONFIGURED' OR NEW.capabilities<>'{}'::jsonb OR NEW.last_error_code IS NOT NULL)
    THEN RAISE EXCEPTION 'PAYMENT_BENEFICIARY_RECONFIGURATION_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_beneficiary_change_guard BEFORE UPDATE ON integration_connection FOR EACH ROW
  WHEN (OLD.kind='PAYMENT' AND OLD.provider='PAYPAL') EXECUTE FUNCTION guard_payment_beneficiary_change();

CREATE TABLE payment_beneficiary_configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK(connection_version>0),
  mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  expected_merchant_id text CHECK(expected_merchant_id ~ '^[2-9A-HJ-NP-Z]{13}$'),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),
  actor_branch_id uuid REFERENCES branch(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connection_id,connection_version)
);
CREATE INDEX payment_beneficiary_history_idx ON payment_beneficiary_configuration(connection_id,created_at DESC,id DESC);
CREATE FUNCTION guard_payment_beneficiary_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_BENEFICIARY_HISTORY_RETAINED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_user_id
    WHERE c.id=NEW.connection_id AND c.kind='PAYMENT' AND c.provider='PAYPAL' AND c.version=NEW.connection_version AND c.status<>'DISABLED'
      AND c.config->>'mode'=NEW.mode AND (c.config->>'expectedMerchantId') IS NOT DISTINCT FROM NEW.expected_merchant_id
      AND (c.branch_id IS NULL OR EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active))
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role
      AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)))
    THEN RAISE EXCEPTION 'PAYMENT_BENEFICIARY_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_beneficiary_history_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_beneficiary_configuration
  FOR EACH ROW EXECUTE FUNCTION guard_payment_beneficiary_history();
