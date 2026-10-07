-- Provider-independent historical identity fence. No provider is activated by this migration.
CREATE FUNCTION guard_payment_connection_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.kind,NEW.organization_id,NEW.branch_id,NEW.provider,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.id,OLD.kind,OLD.organization_id,OLD.branch_id,OLD.provider,OLD.created_at,OLD.created_by)
    THEN RAISE EXCEPTION 'PAYMENT_CONNECTION_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_connection_identity_guard BEFORE UPDATE ON integration_connection FOR EACH ROW
  WHEN (OLD.kind='PAYMENT' OR NEW.kind='PAYMENT') EXECUTE FUNCTION guard_payment_connection_identity();
