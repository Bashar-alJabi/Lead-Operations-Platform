-- Authentication is a read-only identity prerequisite, never financial proof.
ALTER TABLE integration_connection ADD CONSTRAINT alma_connection_config_valid CHECK(
  kind<>'PAYMENT' OR provider<>'ALMA' OR COALESCE(
    jsonb_typeof(config)='object' AND config-'mode'='{}'::jsonb
    AND jsonb_typeof(config->'mode')='string' AND config->>'mode' IN ('TEST','LIVE'),false)
);
ALTER TABLE payment_connection_probe ADD COLUMN authentication_snapshot jsonb;
ALTER TABLE payment_connection_probe ADD COLUMN actor_session_id uuid REFERENCES user_session(id);
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_authentication_snapshot_valid CHECK(
  authentication_snapshot IS NULL OR COALESCE(
    purpose='AUTH' AND state='VERIFIED' AND jsonb_typeof(authentication_snapshot)='object'
    AND authentication_snapshot-ARRAY['schemaVersion','profile','accountRef','mode']='{}'::jsonb
    AND authentication_snapshot->'schemaVersion'='1'::jsonb AND authentication_snapshot->>'profile'='ALMA_ME_V1'
    AND jsonb_typeof(authentication_snapshot->'accountRef')='string'
    AND authentication_snapshot->>'accountRef' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    AND jsonb_typeof(authentication_snapshot->'mode')='string' AND authentication_snapshot->>'mode' IN ('TEST','LIVE'),false)
);
CREATE FUNCTION guard_payment_authentication_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF TG_OP='UPDATE' AND NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND NEW.authentication_snapshot IS NOT NULL
    THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_CLAIM_INVALID'; END IF;
  IF c.provider IS DISTINCT FROM 'ALMA' THEN
    IF NEW.authentication_snapshot IS NOT NULL OR NEW.actor_session_id IS NOT NULL
      THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_PROFILE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.actor_session_id IS NULL THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_REQUIRED'; END IF;
  IF NEW.state='VERIFIED' AND (NEW.purpose<>'AUTH' OR NEW.authentication_snapshot IS NULL
    OR NEW.authentication_snapshot->>'mode' IS DISTINCT FROM c.config->>'mode')
    THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_PROFILE_INVALID'; END IF;
  IF TG_OP='INSERT' OR NEW.state='VERIFIED' THEN
    IF NOT EXISTS(SELECT 1 FROM user_session s JOIN user_account u ON u.id=s.user_id
      WHERE s.id=NEW.actor_session_id AND u.id=NEW.actor_user_id AND u.active
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND u.organization_id=c.organization_id AND u.role=NEW.actor_role
        AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
        AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)))
      OR c.kind<>'PAYMENT' OR c.status='DISABLED' OR c.version<>NEW.connection_version
      OR (c.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active))
      THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_SCOPE_INVALID'; END IF;
  END IF;
  IF NEW.state='VERIFIED' AND (NEW.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM payment_connection_probe p WHERE p.connection_id=NEW.connection_id AND p.probe_number>NEW.probe_number))
    THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_SUPERSEDED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_authentication_snapshot_guard BEFORE INSERT OR UPDATE ON payment_connection_probe
  FOR EACH ROW EXECUTE FUNCTION guard_payment_authentication_snapshot();
