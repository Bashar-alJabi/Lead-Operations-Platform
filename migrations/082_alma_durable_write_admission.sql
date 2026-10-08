-- Alma unsigned notification context is distinct from a signed financial webhook.
ALTER TABLE payment_link_intent ALTER COLUMN webhook_id DROP NOT NULL;
ALTER TABLE payment_link_intent ALTER COLUMN webhook_version DROP NOT NULL;
ALTER TABLE payment_link_intent ADD COLUMN selected_plan jsonb;
ALTER TABLE payment_link_intent ADD COLUMN notification_endpoint_id uuid;
ALTER TABLE payment_link_intent ADD COLUMN notification_endpoint_version integer;
ALTER TABLE payment_link_intent ADD COLUMN notification_url text;
ALTER TABLE payment_link_intent ADD FOREIGN KEY(notification_endpoint_id,connection_id,mode)
  REFERENCES payment_notification_endpoint(id,connection_id,mode);
ALTER TABLE payment_link_intent ADD CONSTRAINT payment_intent_delivery_profile CHECK(COALESCE(
  CASE WHEN provider='ALMA' THEN webhook_id IS NULL AND webhook_version IS NULL
    AND notification_endpoint_id IS NOT NULL AND notification_endpoint_version>0 AND notification_url IS NOT NULL
    AND valid_alma_eligibility_request(jsonb_build_object('money',jsonb_build_object('amount',amount,'currency',currency,'minor',minor,'scale',scale,'quantum',quantum),'plan',selected_plan))
  ELSE webhook_id IS NOT NULL AND webhook_version>0 AND selected_plan IS NULL
    AND notification_endpoint_id IS NULL AND notification_endpoint_version IS NULL AND notification_url IS NULL END,false));
CREATE FUNCTION alma_payment_options(account text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('profile','ALMA_AUTOMATIC_PAYMENT_V1','accountRef',account,'currencies','["EUR"]'::jsonb,'beneficiaryVerification','AUTHENTICATED_MERCHANT')
$$;
ALTER TABLE payment_link_intent DROP CONSTRAINT payment_intent_provider_config;
ALTER TABLE payment_link_intent ADD CONSTRAINT payment_intent_provider_config CHECK(COALESCE(
  (provider='STRIPE' AND config_snapshot=jsonb_build_object('mode',mode)) OR
  (provider='PAYPAL' AND account_ref ~ '^[2-9A-HJ-NP-Z]{13}$' AND config_snapshot=jsonb_build_object('mode',mode,'expectedMerchantId',account_ref)
    AND options_snapshot=paypal_payment_options(config_snapshot)) OR
  (provider='ALMA' AND account_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND config_snapshot=jsonb_build_object('mode',mode)
    AND options_snapshot=alma_payment_options(account_ref)),false));

-- Keep the existing signed-provider guards; only the new source profile follows the Alma path.
ALTER FUNCTION payment_issuance_current(integration_connection,integer,text,jsonb,text) RENAME TO payment_signed_issuance_current;
CREATE FUNCTION payment_issuance_current(c integration_connection,v integer,account text,options jsonb,currency text) RETURNS boolean LANGUAGE sql AS $$
  SELECT CASE WHEN c.provider='ALMA' THEN COALESCE(c.version=v AND c.kind='PAYMENT' AND c.status IN ('CONNECTED','WARNING')
    AND c.capabilities->'authenticationVerified'='true'::jsonb AND c.capabilities->'authenticationVersion'=to_jsonb(v)
    AND c.capabilities->'authentication'->>'accountRef'=account AND c.capabilities->'authentication'->>'mode'=c.config->>'mode'
    AND options=alma_payment_options(account) AND currency='EUR',false)
  ELSE payment_signed_issuance_current(c,v,account,options,currency) END
$$;
ALTER FUNCTION payment_dispatch_authorized(uuid) RENAME TO payment_signed_dispatch_authorized;
CREATE FUNCTION payment_dispatch_authorized(intent uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT payment_signed_dispatch_authorized(intent) OR EXISTS(
    SELECT 1 FROM payment_link_intent i JOIN integration_connection c ON c.id=i.connection_id
    JOIN branch b ON b.id=i.branch_id JOIN payment_method m ON m.id=i.method_id
    JOIN payment_notification_endpoint n ON n.id=i.notification_endpoint_id
    JOIN lead l ON l.id=i.lead_id JOIN user_account u ON u.id=i.requester_id
    JOIN user_session s ON s.id=i.requester_session_id AND s.user_id=u.id
    WHERE i.id=intent AND i.provider='ALMA' AND b.active AND m.active AND m.version=i.method_version
      AND m.name=i.method_name AND m.organization_id=i.organization_id AND m.connection_id=i.connection_id
      AND m.branch_id=i.branch_id AND m.currencies ? i.currency AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
      AND c.organization_id=i.organization_id AND (c.branch_id IS NULL OR c.branch_id=i.branch_id) AND c.provider=i.provider
      AND c.config=i.config_snapshot AND payment_issuance_current(c,i.connection_version,i.account_ref,i.options_snapshot,i.currency)
      AND n.connection_id=i.connection_id AND n.connection_version=i.connection_version AND n.version=i.notification_endpoint_version
      AND n.state='ENABLED' AND n.account_ref=i.account_ref AND n.mode=i.mode AND n.callback_url=i.notification_url
      AND (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS NOT DISTINCT FROM (i.organization_id,i.branch_id,i.campaign_id,i.assigned_agent_id)
      AND u.active AND u.organization_id=i.organization_id AND u.role=i.requester_role AND u.branch_id IS NOT DISTINCT FROM i.requester_branch_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR
        (u.role='AGENT' AND u.branch_id=l.branch_id AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
$$;
-- INSERT-only legacy trigger plus a universal immutability fence prevents provider-changing updates.
DROP TRIGGER payment_link_intent_guard ON payment_link_intent;
CREATE TRIGGER payment_link_intent_guard BEFORE INSERT ON payment_link_intent
  FOR EACH ROW WHEN(NEW.provider<>'ALMA') EXECUTE FUNCTION guard_payment_link_intent();
CREATE FUNCTION retain_payment_link_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'PAYMENT_LINK_INTENT_IMMUTABLE'; END $$;
CREATE TRIGGER payment_link_intent_retain BEFORE UPDATE OR DELETE ON payment_link_intent FOR EACH ROW EXECUTE FUNCTION retain_payment_link_intent();
CREATE FUNCTION guard_alma_link_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection; m payment_method; l lead; n payment_notification_endpoint;
BEGIN
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR SHARE;
  PERFORM id FROM branch WHERE id=NEW.branch_id FOR SHARE;
  SELECT * INTO m FROM payment_method WHERE id=NEW.method_id FOR SHARE;
  SELECT * INTO n FROM payment_notification_endpoint WHERE id=NEW.notification_endpoint_id FOR SHARE;
  SELECT * INTO l FROM lead WHERE id=NEW.lead_id FOR SHARE;
  PERFORM id FROM user_account WHERE id=NEW.requester_id FOR SHARE;
  PERFORM id FROM user_session WHERE id=NEW.requester_session_id FOR SHARE;
  IF (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS DISTINCT FROM
    (NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.assigned_agent_id)
    OR m.organization_id IS DISTINCT FROM NEW.organization_id OR m.branch_id IS DISTINCT FROM NEW.branch_id
    OR m.active IS DISTINCT FROM true OR m.version IS DISTINCT FROM NEW.method_version OR m.name IS DISTINCT FROM NEW.method_name
    OR m.connection_id IS DISTINCT FROM NEW.connection_id OR NOT COALESCE(m.currencies ? NEW.currency,false)
    OR (m.campaign_mode='SELECTED' AND NOT m.campaign_ids ? l.campaign_id::text)
    OR NOT EXISTS(SELECT 1 FROM branch WHERE id=NEW.branch_id AND active) THEN RAISE EXCEPTION 'PAYMENT_LINK_METHOD_SCOPE_INVALID'; END IF;
  IF c.provider IS DISTINCT FROM 'ALMA' OR c.organization_id IS DISTINCT FROM NEW.organization_id
    OR (c.branch_id IS NOT NULL AND c.branch_id<>NEW.branch_id) OR c.config IS DISTINCT FROM NEW.config_snapshot
    OR NOT payment_issuance_current(c,NEW.connection_version,NEW.account_ref,NEW.options_snapshot,NEW.currency)
    THEN RAISE EXCEPTION 'PAYMENT_LINK_CONNECTION_NOT_READY'; END IF;
  IF n.connection_id IS DISTINCT FROM NEW.connection_id OR n.connection_version IS DISTINCT FROM NEW.connection_version
    OR n.version IS DISTINCT FROM NEW.notification_endpoint_version OR n.state IS DISTINCT FROM 'ENABLED'
    OR n.account_ref IS DISTINCT FROM NEW.account_ref OR n.mode IS DISTINCT FROM NEW.mode OR n.callback_url IS DISTINCT FROM NEW.notification_url
    THEN RAISE EXCEPTION 'PAYMENT_LINK_NOTIFICATION_NOT_READY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
    WHERE u.id=NEW.requester_id AND u.active AND u.organization_id=NEW.organization_id AND u.role=NEW.requester_role
      AND u.branch_id IS NOT DISTINCT FROM NEW.requester_branch_id AND s.id=NEW.requester_session_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND (u.role='SUPER_ADMIN'
        OR (u.role='MANAGER' AND u.branch_id=NEW.branch_id) OR (u.role='AGENT' AND u.branch_id=NEW.branch_id
          AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
    THEN RAISE EXCEPTION 'PAYMENT_LINK_ACTOR_INVALID'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER alma_link_intent_guard BEFORE INSERT ON payment_link_intent FOR EACH ROW WHEN(NEW.provider='ALMA') EXECUTE FUNCTION guard_alma_link_intent();

-- A null retention is valid ONLY for an explicit NEVER policy, never for provider-key replay.
ALTER FUNCTION valid_payment_dispatch_policy(jsonb) RENAME TO valid_payment_key_dispatch_policy;
CREATE FUNCTION valid_payment_dispatch_policy(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p->>'writeReplay'='NEVER' THEN COALESCE(
    p=jsonb_build_object('writeReplay','NEVER','maxAttempts',1,'retentionMs',NULL,'dispatchBudgetMs',30000,'retryBaseMs',2000,'retryMaxMs',60000),false)
  ELSE valid_payment_key_dispatch_policy(p) END
$$;
ALTER TABLE payment_dispatch DROP CONSTRAINT payment_dispatch_policy_shape;
ALTER TABLE payment_dispatch ADD CONSTRAINT payment_dispatch_policy_shape CHECK(
  (first_dispatch_ms IS NULL)=(policy IS NULL) AND (policy IS NULL OR
    (first_dispatch_ms BETWEEN 0 AND 9007199254740991 AND valid_payment_dispatch_policy(policy)
      AND (policy->>'writeReplay'='NEVER' OR first_dispatch_ms::numeric+(policy->>'retentionMs')::numeric<=9007199254740991))));
CREATE FUNCTION fence_alma_dispatch_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.policy IS NOT NULL AND
    (EXISTS(SELECT 1 FROM payment_link_intent WHERE id=NEW.intent_id AND provider='ALMA')) IS DISTINCT FROM (COALESCE(NEW.policy->>'writeReplay','PROVIDER_KEY')='NEVER')
    THEN RAISE EXCEPTION 'PAYMENT_WRITE_REPLAY_PROFILE_INVALID'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER alma_dispatch_policy_fence BEFORE INSERT OR UPDATE ON payment_dispatch FOR EACH ROW EXECUTE FUNCTION fence_alma_dispatch_policy();
CREATE OR REPLACE FUNCTION fence_payment_dispatch_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d payment_dispatch;
BEGIN
  SELECT * INTO d FROM payment_dispatch WHERE intent_id=NEW.intent_id;
  IF NOT payment_dispatch_authorized(NEW.intent_id) OR NOT valid_payment_dispatch_policy(d.policy)
    OR NEW.number>(d.policy->>'maxAttempts')::integer
    OR (d.policy->>'writeReplay' IS DISTINCT FROM 'NEVER' AND
      floor(extract(epoch FROM clock_timestamp())*1000)+(d.policy->>'dispatchBudgetMs')::bigint>=d.first_dispatch_ms+(d.policy->>'retentionMs')::bigint)
    THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_CURRENT_FENCE_REQUIRED'; END IF; RETURN NEW;
END $$;
CREATE TABLE payment_write_admission (
  intent_id uuid PRIMARY KEY REFERENCES payment_link_intent(id),attempt_id uuid NOT NULL UNIQUE REFERENCES payment_dispatch_attempt(id),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_payment_write_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i payment_link_intent; d payment_dispatch; now_ms bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_WRITE_ADMISSION_IMMUTABLE'; END IF;
  SELECT * INTO d FROM payment_dispatch WHERE intent_id=NEW.intent_id FOR UPDATE;
  SELECT * INTO i FROM payment_link_intent WHERE id=NEW.intent_id;
  PERFORM id FROM integration_connection WHERE id=i.connection_id FOR SHARE;
  PERFORM id FROM branch WHERE id=i.branch_id FOR SHARE;
  PERFORM id FROM payment_method WHERE id=i.method_id FOR SHARE;
  PERFORM id FROM payment_notification_endpoint WHERE id=i.notification_endpoint_id FOR SHARE;
  PERFORM id FROM lead WHERE id=i.lead_id FOR SHARE;
  PERFORM id FROM user_account WHERE id=i.requester_id FOR SHARE;
  PERFORM id FROM user_session WHERE id=i.requester_session_id FOR SHARE;
  PERFORM token FROM payment_merchant_lease WHERE provider=i.provider AND account_ref=i.account_ref AND mode=i.mode FOR SHARE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000);
  IF i.provider IS DISTINCT FROM 'ALMA' OR NOT payment_dispatch_authorized(i.id)
    OR d.state IS DISTINCT FROM 'RUNNING' OR d.lease_token IS DISTINCT FROM NEW.attempt_id OR d.lease_until<=clock_timestamp()
    OR d.policy->>'writeReplay' IS DISTINCT FROM 'NEVER' OR NOT valid_payment_dispatch_policy(d.policy)
    OR now_ms<d.first_dispatch_ms OR now_ms+8000>=d.first_dispatch_ms+(d.policy->>'dispatchBudgetMs')::bigint
    OR NOT EXISTS(SELECT 1 FROM payment_dispatch_attempt a WHERE a.id=NEW.attempt_id AND a.intent_id=i.id AND a.state='RUNNING' AND a.number=1)
    OR NOT EXISTS(SELECT 1 FROM payment_merchant_lease m WHERE m.provider=i.provider AND m.account_ref=i.account_ref AND m.mode=i.mode
      AND m.token=NEW.attempt_id AND m.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED'; END IF;
  NEW.admitted_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER payment_write_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_write_admission FOR EACH ROW EXECUTE FUNCTION guard_payment_write_admission();
CREATE FUNCTION audit_payment_write_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT organization_id,branch_id,NULL,'PAYMENT_WRITE_ADMITTED','PAYMENT_LINK',id,jsonb_build_object('attemptId',NEW.attempt_id,'writeReplay','NEVER')
    FROM payment_link_intent WHERE id=NEW.intent_id; RETURN NEW;
END $$;
CREATE TRIGGER payment_write_admission_audit AFTER INSERT ON payment_write_admission FOR EACH ROW EXECUTE FUNCTION audit_payment_write_admission();
ALTER TABLE payment_checkout_ack DROP CONSTRAINT payment_checkout_expiry_profile;
ALTER TABLE payment_checkout_ack ADD CONSTRAINT payment_checkout_expiry_profile CHECK(
  (provider='STRIPE' AND expires_at IS NOT NULL AND session_id ~ '^cs_(test|live)_[A-Za-z0-9]{6,180}$') OR
  (provider='PAYPAL' AND expires_at IS NULL AND session_id ~ '^[A-Z0-9]{1,36}$') OR
  (provider='ALMA' AND expires_at IS NULL AND session_id ~ '^payment_[A-Za-z0-9]{1,120}$'));
CREATE FUNCTION fence_alma_checkout_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.provider='ALMA' AND NOT EXISTS(SELECT 1 FROM payment_write_admission a WHERE a.intent_id=NEW.intent_id AND a.attempt_id=NEW.attempt_id)
    THEN RAISE EXCEPTION 'PAYMENT_WRITE_ADMISSION_REQUIRED'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER alma_checkout_ack_fence BEFORE INSERT ON payment_checkout_ack FOR EACH ROW EXECUTE FUNCTION fence_alma_checkout_ack();
