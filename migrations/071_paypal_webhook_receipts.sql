-- Add the PayPal signing profile without changing historical Stripe credentials or financial proof guards.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='payment_webhook'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%external_endpoint_id%'
  LOOP EXECUTE format('ALTER TABLE payment_webhook DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE payment_webhook ADD CONSTRAINT payment_webhook_endpoint_identity_check
  CHECK(external_endpoint_id IS NULL OR external_endpoint_id ~ '^we_[A-Za-z0-9]{6,100}$' OR external_endpoint_id ~ '^[A-Z0-9]{8,64}$');
ALTER TABLE payment_webhook ADD CONSTRAINT payment_webhook_secret_shape_check
  CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
    (external_endpoint_id IS NOT NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version=1 AND octet_length(nonce)=12 AND octet_length(auth_tag)=16));
ALTER TABLE payment_webhook ADD CONSTRAINT payment_webhook_configured_identity_check CHECK(state<>'CONFIGURED' OR external_endpoint_id IS NOT NULL);
CREATE OR REPLACE FUNCTION guard_payment_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_HISTORY_RETAINED'; END IF;
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF c.kind IS DISTINCT FROM 'PAYMENT' OR c.provider NOT IN ('STRIPE','PAYPAL') THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_SCOPE_INVALID'; END IF;
  IF NEW.external_endpoint_id IS NOT NULL AND
    ((c.provider='STRIPE' AND (NEW.external_endpoint_id !~ '^we_[A-Za-z0-9]{6,100}$' OR NEW.ciphertext IS NULL)) OR
     (c.provider='PAYPAL' AND (NEW.external_endpoint_id !~ '^[A-Z0-9]{8,64}$' OR NEW.ciphertext IS NOT NULL OR NEW.nonce IS NOT NULL OR NEW.auth_tag IS NOT NULL OR NEW.key_version IS NOT NULL)))
    THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_PROFILE_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.connection_id,NEW.connection_version,NEW.mode,NEW.callback_url,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.mode,OLD.callback_url,OLD.created_by,OLD.created_at)
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_IMMUTABLE'; END IF;
    IF NEW.last_signed_at IS DISTINCT FROM OLD.last_signed_at THEN
      IF (to_jsonb(NEW)-'last_signed_at') IS DISTINCT FROM (to_jsonb(OLD)-'last_signed_at') OR NEW.last_signed_at IS NULL
        OR (OLD.last_signed_at IS NOT NULL AND NEW.last_signed_at<OLD.last_signed_at)
        OR NOT EXISTS(SELECT 1 FROM payment_webhook_delivery e WHERE e.webhook_id=NEW.id AND e.received_at=NEW.last_signed_at)
        THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_RECEIPT_PROOF_REQUIRED'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.version<>OLD.version+1 OR OLD.state='DISABLED' OR NOT ((OLD.state='DRAFT' AND NEW.state='CONFIGURED') OR NEW.state='DISABLED')
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_TRANSITION_INVALID'; END IF;
    IF NOT (OLD.state='DRAFT' AND NEW.state='CONFIGURED') AND (NEW.external_endpoint_id,NEW.ciphertext,NEW.nonce,NEW.auth_tag,NEW.key_version)
      IS DISTINCT FROM (OLD.external_endpoint_id,OLD.ciphertext,OLD.nonce,OLD.auth_tag,OLD.key_version)
      THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_SECRET_IMMUTABLE'; END IF;
  ELSIF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW.external_endpoint_id IS NOT NULL OR NEW.last_signed_at IS NOT NULL
    OR NEW.created_by<>NEW.updated_by THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_INITIAL_STATE_INVALID'; END IF;
  IF NEW.state<>'DISABLED' AND (c.status='DISABLED' OR c.version<>NEW.connection_version OR c.config->>'mode' IS DISTINCT FROM NEW.mode
    OR (c.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active)))
    THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_CONNECTION_STALE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account u WHERE u.id=NEW.updated_by AND u.active AND u.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))) THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_ACTOR_INVALID'; END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE payment_webhook_event DROP CONSTRAINT payment_webhook_event_external_event_id_check;
ALTER TABLE payment_webhook_event DROP CONSTRAINT payment_webhook_event_event_type_check;
ALTER TABLE payment_webhook_event ADD CONSTRAINT payment_webhook_event_external_event_id_check
  CHECK(external_event_id ~ '^evt_[A-Za-z0-9]{6,100}$' OR external_event_id ~ '^WH-[A-Z0-9-]{5,180}$');
ALTER TABLE payment_webhook_event ADD CONSTRAINT payment_webhook_event_event_type_check
  CHECK(event_type ~ '^[a-z][a-z0-9_.]{1,127}$' OR event_type ~ '^[A-Z][A-Z0-9_.-]{1,127}$');
CREATE OR REPLACE FUNCTION guard_payment_webhook_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_IMMUTABLE'; END IF;
  SELECT c.provider INTO profile FROM payment_webhook w JOIN integration_connection c ON c.id=w.connection_id
    WHERE w.id=NEW.webhook_id AND w.connection_id=NEW.connection_id AND w.mode=NEW.mode AND w.state='CONFIGURED' AND c.kind='PAYMENT';
  IF profile IS NULL THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_NOT_CONFIGURED'; END IF;
  IF (profile='STRIPE' AND (NEW.external_event_id !~ '^evt_[A-Za-z0-9]{6,100}$' OR NEW.event_type !~ '^[a-z][a-z0-9_.]{1,127}$')) OR
     (profile='PAYPAL' AND (NEW.external_event_id !~ '^WH-[A-Z0-9-]{5,180}$' OR NEW.event_type !~ '^[A-Z][A-Z0-9_.-]{1,127}$')) OR
     profile NOT IN ('STRIPE','PAYPAL') THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_PROFILE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
