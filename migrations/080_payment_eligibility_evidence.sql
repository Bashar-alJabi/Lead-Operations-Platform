-- Amount-specific eligibility is a read-only assessment, never financial confirmation.
ALTER TABLE payment_connection_probe DROP CONSTRAINT payment_connection_probe_purpose_check;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_connection_probe_purpose_check CHECK(purpose IN ('AUTH','OPTIONS','OFFERS','ELIGIBILITY'));
ALTER TABLE payment_connection_probe ADD COLUMN eligibility_request jsonb;
ALTER TABLE payment_connection_probe ADD COLUMN eligibility_snapshot jsonb;
CREATE FUNCTION valid_alma_eligibility_request(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE money jsonb;plan jsonb;
BEGIN
  IF NOT COALESCE(jsonb_typeof(value)='object' AND value-ARRAY['money','plan']='{}'::jsonb,false) THEN RETURN false; END IF;
  money=value->'money';plan=value->'plan';
  IF NOT COALESCE(jsonb_typeof(money)='object' AND money-ARRAY['amount','currency','minor','scale','quantum']='{}'::jsonb
    AND money->>'currency'='EUR' AND money->'scale'='2'::jsonb AND money->>'quantum'='1'
    AND jsonb_typeof(money->'quantum')='string' AND jsonb_typeof(money->'currency')='string'
    AND jsonb_typeof(money->'amount')='string' AND money->>'amount' ~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$'
    AND jsonb_typeof(money->'minor')='string' AND money->>'minor' ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof(plan)='object' AND plan-ARRAY['installments','deferredMonths','deferredDays']='{}'::jsonb
    AND jsonb_typeof(plan->'installments')='number' AND plan->>'installments' ~ '^[0-9]{1,5}$'
    AND jsonb_typeof(plan->'deferredMonths')='number' AND plan->>'deferredMonths' ~ '^[0-9]{1,5}$'
    AND jsonb_typeof(plan->'deferredDays')='number' AND plan->>'deferredDays' ~ '^[0-9]{1,5}$',false) THEN RETURN false; END IF;
  RETURN (money->>'amount')::numeric*100=(money->>'minor')::numeric AND (money->>'minor')::numeric<=2147483647
    AND (plan->>'installments')::integer BETWEEN 1 AND 65535
    AND (plan->>'deferredMonths')::integer BETWEEN 0 AND 65535 AND (plan->>'deferredDays')::integer BETWEEN 0 AND 65535;
END;
$$;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_eligibility_evidence_valid CHECK(
  (purpose='ELIGIBILITY' AND eligibility_request IS NOT NULL AND valid_alma_eligibility_request(eligibility_request)
    OR purpose<>'ELIGIBILITY' AND eligibility_request IS NULL)
  AND (purpose<>'ELIGIBILITY' OR state<>'VERIFIED' OR eligibility_snapshot IS NOT NULL)
  AND (eligibility_snapshot IS NULL OR COALESCE(purpose='ELIGIBILITY' AND state='VERIFIED' AND authentication_snapshot IS NOT NULL
    AND jsonb_typeof(eligibility_snapshot)='object'
    AND eligibility_snapshot-ARRAY['schemaVersion','profile','accountRef','mode','money','plan','eligible']='{}'::jsonb
    AND eligibility_snapshot->'schemaVersion'='1'::jsonb AND eligibility_snapshot->>'profile'='ALMA_ELIGIBILITY_V2'
    AND jsonb_typeof(eligibility_snapshot->'accountRef')='string' AND jsonb_typeof(eligibility_snapshot->'mode')='string'
    AND eligibility_snapshot->>'accountRef'=authentication_snapshot->>'accountRef'
    AND eligibility_snapshot->>'mode'=authentication_snapshot->>'mode'
    AND jsonb_typeof(eligibility_snapshot->'eligible')='boolean'
    AND eligibility_snapshot->'money'=eligibility_request->'money' AND eligibility_snapshot->'plan'=eligibility_request->'plan',false))
);
ALTER TABLE payment_connection_probe DROP CONSTRAINT payment_authentication_snapshot_valid;
ALTER TABLE payment_connection_probe ADD CONSTRAINT payment_authentication_snapshot_valid CHECK(
  authentication_snapshot IS NULL OR COALESCE(
    purpose IN ('AUTH','OFFERS','ELIGIBILITY') AND state='VERIFIED' AND jsonb_typeof(authentication_snapshot)='object'
    AND authentication_snapshot-ARRAY['schemaVersion','profile','accountRef','mode']='{}'::jsonb
    AND authentication_snapshot->'schemaVersion'='1'::jsonb AND authentication_snapshot->>'profile'='ALMA_ME_V1'
    AND jsonb_typeof(authentication_snapshot->'accountRef')='string'
    AND authentication_snapshot->>'accountRef' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    AND jsonb_typeof(authentication_snapshot->'mode')='string' AND authentication_snapshot->>'mode' IN ('TEST','LIVE'),false)
);
CREATE OR REPLACE FUNCTION guard_payment_authentication_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF TG_OP='UPDATE' AND NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND NEW.eligibility_request IS DISTINCT FROM OLD.eligibility_request
    THEN RAISE EXCEPTION 'PAYMENT_PROBE_INPUT_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND (NEW.authentication_snapshot IS NOT NULL OR NEW.offers_snapshot IS NOT NULL OR NEW.eligibility_snapshot IS NOT NULL)
    THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_CLAIM_INVALID'; END IF;
  IF c.provider IS DISTINCT FROM 'ALMA' THEN
    IF NEW.authentication_snapshot IS NOT NULL OR NEW.actor_session_id IS NOT NULL OR NEW.offers_snapshot IS NOT NULL OR NEW.eligibility_request IS NOT NULL OR NEW.eligibility_snapshot IS NOT NULL
      THEN RAISE EXCEPTION 'PAYMENT_AUTHENTICATION_PROFILE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.actor_session_id IS NULL THEN RAISE EXCEPTION 'PAYMENT_PROBE_SESSION_REQUIRED'; END IF;
  IF NEW.purpose='ELIGIBILITY' AND (TG_OP='INSERT' OR NEW.state='VERIFIED') AND (c.capabilities->'authenticationVersion' IS DISTINCT FROM to_jsonb(NEW.connection_version)
    OR c.capabilities->'authenticationVerified' IS DISTINCT FROM 'true'::jsonb
    OR c.capabilities->'authentication'->>'mode' IS DISTINCT FROM c.config->>'mode'
    OR NOT COALESCE(c.capabilities->'authentication'->>'accountRef' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$',false)
    OR (NEW.state='VERIFIED' AND NEW.eligibility_snapshot->>'accountRef' IS DISTINCT FROM c.capabilities->'authentication'->>'accountRef'))
    THEN RAISE EXCEPTION 'PAYMENT_ELIGIBILITY_IDENTITY_INVALID'; END IF;
  IF NEW.state='VERIFIED' AND (NEW.purpose NOT IN ('AUTH','OFFERS','ELIGIBILITY') OR NEW.authentication_snapshot IS NULL
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
