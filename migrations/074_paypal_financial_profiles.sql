-- Provider-aware issuance preserves Stripe capabilities and does not fabricate PayPal merchant capabilities.
CREATE FUNCTION paypal_payment_options(config jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('profile','PAYPAL_ORDERS_V2','accountRef',config->>'expectedMerchantId','currencies','["AUD","BRL","CAD","CHF","CNY","CZK","DKK","EUR","GBP","HKD","HUF","ILS","JPY","MXN","MYR","NOK","NZD","PHP","PLN","RUB","SEK","SGD","THB","TWD","USD"]'::jsonb,'beneficiaryVerification','CONFIGURED_EXPECTATION')
$$;
CREATE FUNCTION payment_issuance_current(c integration_connection,v integer,account text,options jsonb,currency text) RETURNS boolean LANGUAGE sql AS $$
  SELECT COALESCE(c.version=v AND c.kind='PAYMENT' AND c.status IN ('CONNECTED','WARNING') AND c.capabilities->>'authenticationVerified'='true' AND
    CASE c.provider WHEN 'STRIPE' THEN c.capabilities->>'paymentOptionsVersion'=v::text AND c.capabilities->'paymentOptions'=options
      AND options->>'accountRef'=account AND options->>'chargesEnabled'='true' AND options->'currencies' ? currency
    WHEN 'PAYPAL' THEN c.config->>'expectedMerchantId'=account AND account ~ '^[2-9A-HJ-NP-Z]{13}$'
      AND options=paypal_payment_options(c.config) AND options->'currencies' ? currency ELSE false END,false)
$$;
DO $$ DECLARE n text; BEGIN
  SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid='payment_link_intent'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%config_snapshot = jsonb_build_object%';
  EXECUTE format('ALTER TABLE payment_link_intent DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE payment_link_intent ADD CONSTRAINT payment_intent_provider_config CHECK(COALESCE(
  (provider='STRIPE' AND config_snapshot=jsonb_build_object('mode',mode)) OR
  (provider='PAYPAL' AND account_ref ~ '^[2-9A-HJ-NP-Z]{13}$' AND config_snapshot=jsonb_build_object('mode',mode,'expectedMerchantId',account_ref)
    AND options_snapshot=paypal_payment_options(config_snapshot)),false));
ALTER TABLE payment_checkout_ack ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE payment_checkout_ack ADD CONSTRAINT payment_checkout_expiry_profile CHECK(
  (provider='STRIPE' AND expires_at IS NOT NULL AND session_id ~ '^cs_(test|live)_[A-Za-z0-9]{6,180}$') OR
  (provider='PAYPAL' AND expires_at IS NULL AND session_id ~ '^[A-Z0-9]{1,36}$'));
CREATE OR REPLACE FUNCTION guard_payment_link_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR c.config IS DISTINCT FROM NEW.config_snapshot
    OR NOT payment_issuance_current(c,NEW.connection_version,NEW.account_ref,NEW.options_snapshot,NEW.currency)
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
CREATE OR REPLACE FUNCTION payment_dispatch_authorized(intent uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM payment_link_intent i JOIN integration_connection c ON c.id=i.connection_id
    JOIN branch b ON b.id=i.branch_id JOIN payment_method m ON m.id=i.method_id JOIN payment_webhook w ON w.id=i.webhook_id
    JOIN lead l ON l.id=i.lead_id JOIN user_account u ON u.id=i.requester_id JOIN user_session s ON s.id=i.requester_session_id AND s.user_id=u.id
    WHERE i.id=intent AND b.active AND m.active AND m.version=i.method_version AND m.connection_id=i.connection_id
      AND m.branch_id=i.branch_id AND m.currencies ? i.currency AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
      AND c.kind='PAYMENT' AND c.organization_id=i.organization_id AND (c.branch_id IS NULL OR c.branch_id=i.branch_id)
      AND c.provider=i.provider AND c.version=i.connection_version AND c.config->>'mode'=i.mode AND c.status IN ('CONNECTED','WARNING')
      AND c.config=i.config_snapshot AND payment_issuance_current(c,i.connection_version,i.account_ref,i.options_snapshot,i.currency)
      AND w.state='CONFIGURED' AND w.version=i.webhook_version AND w.connection_version=i.connection_version AND w.last_signed_at IS NOT NULL
      AND (SELECT state FROM payment_webhook_probe WHERE webhook_id=w.id ORDER BY probe_number DESC LIMIT 1)='VERIFIED'
      AND (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS NOT DISTINCT FROM (i.organization_id,i.branch_id,i.campaign_id,i.assigned_agent_id)
      AND u.active AND u.organization_id=i.organization_id AND u.role=i.requester_role AND u.branch_id IS NOT DISTINCT FROM i.requester_branch_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR
        (u.role='AGENT' AND u.branch_id=l.branch_id AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
$$;
ALTER TABLE payment_confirmation ADD COLUMN provider_evidence jsonb;
ALTER TABLE payment_confirmation ADD CONSTRAINT payment_confirmation_provider_evidence CHECK(COALESCE(
  (provider='STRIPE' AND provider_evidence IS NULL) OR (provider='PAYPAL' AND jsonb_typeof(provider_evidence)='object'
    AND provider_evidence ?& ARRAY['schemaVersion','source','orderId','captureId','intentId','merchantId','mode','currency','minor','captureStatus','paymentStatus']
    AND provider_evidence-'schemaVersion'-'source'-'orderId'-'captureId'-'intentId'-'merchantId'-'mode'-'currency'-'minor'-'captureStatus'-'paymentStatus'='{}'::jsonb
    AND provider_evidence->'schemaVersion'='1'::jsonb AND provider_evidence->>'source'='INDEPENDENT_ORDER_CAPTURE_READ'
    AND provider_evidence->>'orderId'=session_id AND session_id ~ '^[A-Z0-9]{1,36}$'
    AND provider_evidence->>'captureId' ~ '^[A-Z0-9]{1,36}$' AND provider_evidence->>'intentId'=intent_id::text
    AND provider_evidence->>'merchantId'=account_ref AND provider_evidence->>'mode'=mode
    AND provider_evidence->>'currency'=currency AND provider_evidence->>'minor'=minor AND provider_evidence->>'paymentStatus'=payment_status
    AND session_status='COMPLETE' AND provider_evidence->>'captureStatus' IN ('COMPLETED','PENDING','DECLINED','FAILED','REFUNDED','PARTIALLY_REFUNDED')
    AND (payment_status='PAID')=(provider_evidence->>'captureStatus'='COMPLETED')
    AND (payment_status<>'PAID' OR payment_ref=provider_evidence->>'captureId')),false));
CREATE OR REPLACE FUNCTION guard_payment_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_CONFIRMATION_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_webhook_event e ON e.connection_id=i.connection_id AND e.mode=i.mode
    JOIN payment_receipt_attempt a ON a.event_id=e.id WHERE i.id=NEW.intent_id AND e.id=NEW.event_id AND a.id=NEW.attempt_id AND a.state='RUNNING'
    AND ((i.provider='STRIPE' AND e.object_id=NEW.session_id AND e.object_type='checkout.session') OR
      (i.provider='PAYPAL' AND e.object_type='capture' AND e.event_type IN ('PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DECLINED')
        AND e.object_id=NEW.provider_evidence->>'captureId'))
    AND (i.provider,i.account_ref,i.mode,i.minor,i.currency)=(NEW.provider,NEW.account_ref,NEW.mode,NEW.minor,NEW.currency)
    AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM payment_checkout_ack k WHERE k.intent_id=i.id AND k.session_id<>NEW.session_id))
    THEN RAISE EXCEPTION 'PAYMENT_CONFIRMATION_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION fence_payment_record_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_confirmation; event_type text;
BEGIN
  SELECT * INTO p FROM payment_confirmation WHERE event_id=NEW.confirmation_event_id AND intent_id=NEW.intent_id;
  SELECT e.event_type INTO event_type FROM payment_webhook_event e WHERE e.id=NEW.confirmation_event_id;
  IF (TG_OP='UPDATE' AND OLD.state IN ('FAILED','EXPIRED') AND NEW.state<>'CONFIRMED')
    OR (NEW.state<>'CONFIRMED' AND p.payment_status='PAID')
    OR (NEW.state='EXPIRED' AND p.session_status<>'EXPIRED')
    OR (NEW.state='FAILED' AND (p.session_status<>'COMPLETE' OR p.payment_status<>'UNPAID' OR NOT ((p.provider='STRIPE' AND event_type='checkout.session.async_payment_failed') OR
      (p.provider='PAYPAL' AND event_type='PAYMENT.CAPTURE.DECLINED' AND p.provider_evidence->>'captureStatus' IN ('DECLINED','FAILED')))))
    THEN RAISE EXCEPTION 'PAYMENT_STATE_PROOF_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_payment_receipt_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CREDENTIAL_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_webhook_event e JOIN payment_receipt_job j ON j.event_id=e.id
    JOIN payment_link_intent i ON i.id=NEW.intent_id JOIN integration_connection c ON c.id=NEW.connection_id
    JOIN user_account u ON u.id=NEW.actor_user_id JOIN user_session s ON s.id=NEW.actor_session_id AND s.user_id=u.id
    WHERE e.id=NEW.event_id AND j.state='NEEDS_ATTENTION' AND j.attempts=NEW.attempt_before
      AND e.connection_id=c.id AND i.connection_id=c.id AND e.mode=i.mode
      AND (i.provider,i.account_ref,i.mode)=(NEW.provider,NEW.account_ref,NEW.mode)
      AND c.kind='PAYMENT' AND c.organization_id=i.organization_id AND c.provider=NEW.provider AND c.version=NEW.connection_version
      AND c.status IN ('CONNECTED','WARNING') AND c.config->>'mode'=NEW.mode
      AND c.capabilities->>'authenticationVerified'='true' AND
        ((c.provider='STRIPE' AND c.capabilities->>'paymentOptionsVersion'=NEW.connection_version::text AND c.capabilities->'paymentOptions'->>'accountRef'=NEW.account_ref)
          OR (c.provider='PAYPAL' AND c.config->>'expectedMerchantId'=NEW.account_ref))
      AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id)
      AND u.active AND u.organization_id=c.organization_id AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CREDENTIAL_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
