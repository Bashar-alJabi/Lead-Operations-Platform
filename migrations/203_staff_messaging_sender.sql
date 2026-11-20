CREATE TABLE staff_messaging_sender (
 sender_id uuid PRIMARY KEY REFERENCES messaging_sender(id),
 connection_id uuid NOT NULL REFERENCES integration_connection(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL,
 external_sender_id text NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 sender_version integer NOT NULL CHECK(sender_version>0),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 created_at timestamptz NOT NULL,
 FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id)
);
CREATE INDEX messaging_sender_external_id_idx ON messaging_sender(external_sender_id);

CREATE TABLE staff_messaging_webhook_receipt (
 sender_id uuid NOT NULL REFERENCES staff_messaging_sender(sender_id),
 provider_event_id text NOT NULL CHECK(provider_event_id ~ '^[a-f0-9]{64}$'),
 event_kind text NOT NULL CHECK(event_kind IN ('INBOUND_MESSAGE','DELIVERY_STATUS')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sender_id,provider_event_id)
);
CREATE FUNCTION retain_staff_messaging_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'STAFF_MESSAGING_RECEIPT_IMMUTABLE';
END $$;
CREATE TRIGGER retain_staff_messaging_receipt BEFORE UPDATE OR DELETE ON staff_messaging_webhook_receipt
 FOR EACH ROW EXECUTE FUNCTION retain_staff_messaging_receipt();

CREATE FUNCTION guard_staff_messaging_sender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender messaging_sender; connection integration_connection;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STAFF_SENDER_RESERVATION_IMMUTABLE'; END IF;
 SELECT * INTO connection FROM integration_connection WHERE id=NEW.connection_id AND kind='MESSAGING'
  AND branch_id IS NOT NULL AND status<>'DISABLED' FOR NO KEY UPDATE;
 IF connection.id IS NULL THEN RAISE EXCEPTION 'STAFF_SENDER_UNAVAILABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM branch WHERE id=connection.branch_id AND organization_id=connection.organization_id AND active FOR SHARE)
  THEN RAISE EXCEPTION 'STAFF_SENDER_UNAVAILABLE'; END IF;
 SELECT * INTO sender FROM messaging_sender WHERE id=NEW.sender_id AND connection_id=connection.id
  AND organization_id=connection.organization_id AND active AND capabilities->'template'='true'::jsonb FOR UPDATE;
 IF sender.id IS NULL THEN RAISE EXCEPTION 'STAFF_SENDER_UNAVAILABLE'; END IF;
 IF sender.version<>NEW.sender_version THEN RAISE EXCEPTION 'SENDER_VERSION_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
    WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=connection.organization_id
      AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=connection.branch_id)
      AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
  THEN RAISE EXCEPTION 'STAFF_SENDER_ACCESS_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-sender:'||sender.external_sender_id,0));
 IF EXISTS(SELECT 1 FROM messaging_sender WHERE external_sender_id=sender.external_sender_id AND id<>sender.id)
  THEN RAISE EXCEPTION 'STAFF_SENDER_EXTERNAL_ID_SHARED'; END IF;
 IF EXISTS(SELECT 1 FROM sender_branch_binding WHERE sender_id=sender.id)
  OR EXISTS(SELECT 1 FROM branch WHERE default_sender_id=sender.id)
  OR EXISTS(SELECT 1 FROM campaign WHERE sender_override_id=sender.id)
  OR EXISTS(SELECT 1 FROM conversation WHERE connection_id=connection.id AND sender_id=sender.id)
  OR EXISTS(SELECT 1 FROM integration_event WHERE connection_id=connection.id AND event_kind='INBOUND_MESSAGE'
      AND (sender_id=sender.id OR payload->>'senderExternalId'=sender.external_sender_id))
  THEN RAISE EXCEPTION 'STAFF_SENDER_CUSTOMER_USE'; END IF;
 NEW.external_sender_id=sender.external_sender_id; NEW.organization_id=connection.organization_id;
 NEW.branch_id=connection.branch_id; NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_sender_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_sender
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_sender();

CREATE FUNCTION record_staff_messaging_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE messaging_sender SET operator_enabled=false,version=version+1 WHERE id=NEW.sender_id;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'STAFF_MESSAGING_SENDER_RESERVED','SENDER',NEW.sender_id,
  jsonb_build_object('connectionId',NEW.connection_id,'reason',NEW.reason,'version',NEW.sender_version+1));
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_sender_record AFTER INSERT ON staff_messaging_sender
 FOR EACH ROW EXECUTE FUNCTION record_staff_messaging_sender();

CREATE FUNCTION guard_reserved_sender_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved staff_messaging_sender;
BEGIN
 IF TG_OP='INSERT' OR NEW.external_sender_id IS DISTINCT FROM OLD.external_sender_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-sender:'||NEW.external_sender_id,0));
  SELECT * INTO reserved FROM staff_messaging_sender WHERE external_sender_id=NEW.external_sender_id;
  -- Discovery can upsert the same canonical row. An independent connection cannot claim it.
  IF FOUND AND reserved.connection_id<>NEW.connection_id THEN RAISE EXCEPTION 'STAFF_SENDER_EXTERNAL_ID_RESERVED'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM staff_messaging_sender WHERE sender_id=OLD.id) AND
   (NEW.operator_enabled OR (NEW.external_sender_id,NEW.connection_id,NEW.organization_id)
    IS DISTINCT FROM (OLD.external_sender_id,OLD.connection_id,OLD.organization_id))
  THEN RAISE EXCEPTION 'STAFF_SENDER_CUSTOMER_USE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reserved_sender_identity_guard BEFORE INSERT OR UPDATE OF external_sender_id,connection_id,organization_id,operator_enabled
 ON messaging_sender FOR EACH ROW EXECUTE FUNCTION guard_reserved_sender_identity();

CREATE FUNCTION exclude_staff_sender_from_customer_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen uuid;
BEGIN
 chosen=(to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF chosen IS NOT NULL THEN
  PERFORM 1 FROM messaging_sender WHERE id=chosen FOR SHARE;
  IF EXISTS(SELECT 1 FROM staff_messaging_sender WHERE sender_id=chosen) THEN RAISE EXCEPTION 'STAFF_SENDER_CUSTOMER_USE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER exclude_staff_sender_branch BEFORE INSERT OR UPDATE OF default_sender_id ON branch
 FOR EACH ROW EXECUTE FUNCTION exclude_staff_sender_from_customer_use('default_sender_id');
CREATE TRIGGER exclude_staff_sender_campaign BEFORE INSERT OR UPDATE OF sender_override_id ON campaign
 FOR EACH ROW EXECUTE FUNCTION exclude_staff_sender_from_customer_use('sender_override_id');
CREATE TRIGGER exclude_staff_sender_shared BEFORE INSERT OR UPDATE OF sender_id ON sender_branch_binding
 FOR EACH ROW EXECUTE FUNCTION exclude_staff_sender_from_customer_use('sender_id');
CREATE TRIGGER exclude_staff_sender_conversation BEFORE INSERT OR UPDATE OF sender_id ON conversation
 FOR EACH ROW EXECUTE FUNCTION exclude_staff_sender_from_customer_use('sender_id');
CREATE TRIGGER exclude_staff_sender_message BEFORE INSERT OR UPDATE OF sender_id ON conversation_message
 FOR EACH ROW EXECUTE FUNCTION exclude_staff_sender_from_customer_use('sender_id');
