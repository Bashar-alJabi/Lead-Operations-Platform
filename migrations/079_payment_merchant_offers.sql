-- Merchant offers are read-only metadata, not customer eligibility or financial proof.
ALTER TABLE payment_connection_probe DROP CONSTRAINT payment_connection_probe_purpose_check;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_connection_probe_purpose_check CHECK(purpose IN ('AUTH','OPTIONS','OFFERS'));
ALTER TABLE payment_connection_probe ADD COLUMN offers_snapshot jsonb;
ALTER TABLE payment_connection_probe DROP CONSTRAINT payment_authentication_snapshot_valid;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_authentication_snapshot_valid CHECK(
  authentication_snapshot IS NULL OR COALESCE(
    purpose IN ('AUTH','OFFERS') AND state='VERIFIED' AND jsonb_typeof(authentication_snapshot)='object'
    AND authentication_snapshot-ARRAY['schemaVersion','profile','accountRef','mode']='{}'::jsonb
    AND authentication_snapshot->'schemaVersion'='1'::jsonb AND authentication_snapshot->>'profile'='ALMA_ME_V1'
    AND jsonb_typeof(authentication_snapshot->'accountRef')='string'
    AND authentication_snapshot->>'accountRef' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    AND jsonb_typeof(authentication_snapshot->'mode')='string' AND authentication_snapshot->>'mode' IN ('TEST','LIVE'),false)
);
CREATE FUNCTION valid_payment_merchant_offers(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb;prior_key integer[];current_key integer[];
BEGIN
  IF NOT COALESCE(jsonb_typeof(value)='object' AND value-ARRAY['schemaVersion','profile','accountRef','mode','plans']='{}'::jsonb
    AND value->'schemaVersion'='1'::jsonb AND value->>'profile'='ALMA_FEE_PLANS_V1'
    AND jsonb_typeof(value->'accountRef')='string' AND value->>'accountRef' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    AND jsonb_typeof(value->'mode')='string' AND value->>'mode' IN ('TEST','LIVE') AND jsonb_typeof(value->'plans')='array',false) THEN RETURN false; END IF;
  IF jsonb_array_length(value->'plans')>256 THEN RETURN false; END IF;
  FOR p IN SELECT * FROM jsonb_array_elements(value->'plans') LOOP
    IF NOT COALESCE(jsonb_typeof(p)='object' AND p-ARRAY['installments','deferredMonths','deferredDays','allowed','minMinor','maxMinor']='{}'::jsonb
      AND jsonb_typeof(p->'installments')='number' AND p->>'installments' ~ '^[0-9]{1,5}$'
      AND jsonb_typeof(p->'deferredMonths')='number' AND p->>'deferredMonths' ~ '^[0-9]{1,5}$'
      AND jsonb_typeof(p->'deferredDays')='number' AND p->>'deferredDays' ~ '^[0-9]{1,5}$'
      AND jsonb_typeof(p->'allowed')='boolean' AND jsonb_typeof(p->'minMinor')='string' AND jsonb_typeof(p->'maxMinor')='string'
      AND p->>'minMinor' ~ '^(0|[1-9][0-9]{0,15})$' AND p->>'maxMinor' ~ '^(0|[1-9][0-9]{0,15})$',false) THEN RETURN false; END IF;
    current_key=ARRAY[(p->>'installments')::integer,(p->>'deferredMonths')::integer,(p->>'deferredDays')::integer];
    IF current_key[1]<1 OR current_key[1]>65535 OR current_key[2]>65535 OR current_key[3]>65535
      OR (prior_key IS NOT NULL AND current_key<=prior_key)
      OR (p->>'minMinor')::numeric>(p->>'maxMinor')::numeric OR (p->>'maxMinor')::numeric>9007199254740991 THEN RETURN false; END IF;
    prior_key=current_key;
  END LOOP;
  RETURN true;
END;
$$;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_merchant_offers_valid CHECK(
  (purpose<>'OFFERS' OR state<>'VERIFIED' OR offers_snapshot IS NOT NULL)
  AND (offers_snapshot IS NULL OR COALESCE(purpose='OFFERS' AND state='VERIFIED'
    AND valid_payment_merchant_offers(offers_snapshot) AND authentication_snapshot IS NOT NULL
    AND offers_snapshot->>'accountRef'=authentication_snapshot->>'accountRef'
    AND offers_snapshot->>'mode'=authentication_snapshot->>'mode',false))
);
CREATE OR REPLACE FUNCTION guard_payment_authentication_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF TG_OP='UPDATE' AND NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.authentication_snapshot IS NOT NULL OR NEW.offers_snapshot IS NOT NULL)
    THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_CLAIM_INVALID'; END IF;
  IF c.provider IS DISTINCT FROM 'ALMA' THEN
    IF NEW.authentication_snapshot IS NOT NULL OR NEW.actor_session_id IS NOT NULL OR NEW.offers_snapshot IS NOT NULL
      THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_PROFILE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.actor_session_id IS NULL THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_REQUIRED'; END IF;
  IF NEW.state='VERIFIED' AND (NEW.purpose NOT IN ('AUTH','OFFERS') OR NEW.authentication_snapshot IS NULL
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
