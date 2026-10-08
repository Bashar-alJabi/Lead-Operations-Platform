-- Unsigned IPN is an untrusted read trigger, not signed delivery or financial evidence.
CREATE TABLE payment_notification_endpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK(connection_version>0),profile text NOT NULL CHECK(profile='ALMA_IPN_GET_V1'),
  account_ref text NOT NULL CHECK(account_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  authentication_probe_id uuid NOT NULL REFERENCES payment_connection_probe(id),callback_url text NOT NULL CHECK(length(callback_url)<=2048),
  state text NOT NULL DEFAULT 'ENABLED' CHECK(state IN ('ENABLED','DISABLED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),actor_session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connection_id,connection_version),UNIQUE(id,connection_id,mode)
);
CREATE INDEX payment_notification_endpoint_cursor_idx ON payment_notification_endpoint(connection_id,created_at DESC,id DESC);
CREATE FUNCTION guard_payment_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;actor user_account;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_HISTORY_RETAINED'; END IF;
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  SELECT u.* INTO actor FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=NEW.actor_user_id AND u.active
    AND s.id=NEW.actor_session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id));
  IF actor.id IS NULL OR c.kind IS DISTINCT FROM 'PAYMENT' OR c.provider IS DISTINCT FROM 'ALMA'
    OR (c.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM branch b WHERE b.id=c.branch_id AND b.active)) THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_SCOPE_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_connection_probe p WHERE p.id=NEW.authentication_probe_id AND p.connection_id=NEW.connection_id
    AND p.connection_version=NEW.connection_version AND p.state='VERIFIED' AND p.authentication_snapshot->>'accountRef'=NEW.account_ref
    AND p.authentication_snapshot->>'mode'=NEW.mode) THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_IDENTITY_INVALID'; END IF;
  IF (NEW.callback_url !~ ('^https://([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])/api/webhooks/payments/alma/'||NEW.id::text||'$')
    AND NEW.callback_url !~ ('^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/api/webhooks/payments/alma/'||NEW.id::text||'$'))
    OR NEW.callback_url ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_CALLBACK_INVALID'; END IF;
  IF TG_OP='INSERT' AND (NEW.version<>1 OR NEW.state<>'ENABLED') THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_INITIAL_STATE_INVALID'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.connection_id,NEW.connection_version,NEW.profile,NEW.account_ref,NEW.mode,NEW.authentication_probe_id,NEW.callback_url,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.profile,OLD.account_ref,OLD.mode,OLD.authentication_probe_id,OLD.callback_url,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR NEW.state=OLD.state) THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.state='ENABLED' AND (c.version<>NEW.connection_version OR c.config->>'mode' IS DISTINCT FROM NEW.mode OR c.status NOT IN ('CONNECTED','WARNING')
    OR c.capabilities->'authenticationVersion' IS DISTINCT FROM to_jsonb(NEW.connection_version) OR c.capabilities->'authenticationVerified' IS DISTINCT FROM 'true'::jsonb
    OR c.capabilities->'authentication'->>'accountRef' IS DISTINCT FROM NEW.account_ref
    OR c.capabilities->'authentication'->>'mode' IS DISTINCT FROM NEW.mode) THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_CURRENT_CONFIG_REQUIRED'; END IF;
  IF TG_OP='INSERT' THEN NEW.created_at:=clock_timestamp();END IF;NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_endpoint_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_notification_endpoint FOR EACH ROW EXECUTE FUNCTION guard_payment_notification_endpoint();
CREATE TABLE payment_notification_endpoint_history (
  endpoint_id uuid NOT NULL REFERENCES payment_notification_endpoint(id),version integer NOT NULL,actor_user_id uuid NOT NULL REFERENCES user_account(id),
  actor_session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(endpoint_id,version)
);
CREATE FUNCTION record_payment_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO payment_notification_endpoint_history(endpoint_id,version,actor_user_id,actor_session_id,reason,state)
    VALUES(NEW.id,NEW.version,NEW.actor_user_id,NEW.actor_session_id,NEW.reason,NEW.state);RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_endpoint_record AFTER INSERT OR UPDATE ON payment_notification_endpoint FOR EACH ROW EXECUTE FUNCTION record_payment_notification_endpoint();
CREATE FUNCTION guard_payment_notification_endpoint_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM payment_notification_endpoint e WHERE e.id=NEW.endpoint_id
    AND (e.version,e.actor_user_id,e.actor_session_id,e.reason,e.state)=(NEW.version,NEW.actor_user_id,NEW.actor_session_id,NEW.reason,NEW.state))
    THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_HISTORY_IMMUTABLE'; END IF;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_endpoint_history_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_notification_endpoint_history FOR EACH ROW EXECUTE FUNCTION guard_payment_notification_endpoint_history();
CREATE TABLE payment_untrusted_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
  endpoint_id uuid NOT NULL,resource_id text NOT NULL CHECK(resource_id ~ '^payment_[A-Za-z0-9]{1,120}$'),profile text NOT NULL CHECK(profile='ALMA_IPN_GET_V1'),
  trust text NOT NULL DEFAULT 'UNVERIFIED' CHECK(trust='UNVERIFIED'),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(endpoint_id,connection_id,mode) REFERENCES payment_notification_endpoint(id,connection_id,mode),UNIQUE(connection_id,mode,resource_id),UNIQUE(id,connection_id,mode)
);
CREATE INDEX payment_untrusted_notification_cursor_idx ON payment_untrusted_notification(connection_id,received_at DESC,id DESC);
CREATE FUNCTION guard_payment_untrusted_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_ORIGINAL_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_notification_endpoint e WHERE e.id=NEW.endpoint_id AND e.connection_id=NEW.connection_id
    AND e.mode=NEW.mode AND e.profile=NEW.profile AND e.state='ENABLED') THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_ENDPOINT_DISABLED'; END IF;NEW.received_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_untrusted_notification_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_untrusted_notification FOR EACH ROW EXECUTE FUNCTION guard_payment_untrusted_notification();
CREATE TABLE payment_notification_delivery (
  endpoint_id uuid NOT NULL,notification_id uuid NOT NULL,connection_id uuid NOT NULL,mode text NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(endpoint_id,notification_id),FOREIGN KEY(endpoint_id,connection_id,mode) REFERENCES payment_notification_endpoint(id,connection_id,mode),
  FOREIGN KEY(notification_id,connection_id,mode) REFERENCES payment_untrusted_notification(id,connection_id,mode)
);
CREATE FUNCTION guard_payment_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM payment_notification_endpoint e WHERE e.id=NEW.endpoint_id AND e.state='ENABLED')
    THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_DELIVERY_IMMUTABLE'; END IF;NEW.received_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_notification_delivery FOR EACH ROW EXECUTE FUNCTION guard_payment_notification_delivery();
