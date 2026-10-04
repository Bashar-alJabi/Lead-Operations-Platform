CREATE TABLE message_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),
  media_kind text NOT NULL CHECK (media_kind IN ('image','document','audio','video','sticker')),
  provider_media_id text NOT NULL,
  declared_mime text NOT NULL,
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','READY','REJECTED','FAILED')),
  mime_type text,
  size_bytes integer CHECK (size_bytes > 0),
  content_sha256 text,
  storage_key text,
  storage_backend text,
  scanner_version text,
  scanned_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'READY' OR (mime_type IS NOT NULL AND size_bytes IS NOT NULL
    AND content_sha256 = expected_sha256 AND storage_key IS NOT NULL
    AND storage_backend IS NOT NULL AND scanned_at IS NOT NULL AND scanner_version IS NOT NULL))
);
CREATE INDEX message_attachment_queue_idx ON message_attachment (available_at, id)
  WHERE state IN ('QUEUED','RUNNING');
CREATE TABLE attachment_processing_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attachment_id uuid NOT NULL REFERENCES message_attachment(id),
  lease_token uuid NOT NULL UNIQUE,
  attempt_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('STARTED','READY','REJECTED','RETRY','FAILED','LEASE_EXPIRED')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX attachment_attempt_history_idx ON attachment_processing_attempt (attachment_id, id DESC);
ALTER TABLE conversation_message DROP CONSTRAINT conversation_message_message_kind_check;
ALTER TABLE conversation_message DROP CONSTRAINT message_template_shape;
ALTER TABLE conversation_message ADD COLUMN attachment_id uuid UNIQUE REFERENCES message_attachment(id);
ALTER TABLE conversation_message ADD CONSTRAINT message_kind_check
  CHECK (message_kind IN ('TEXT','TEMPLATE','ATTACHMENT'));
ALTER TABLE conversation_message ADD CONSTRAINT message_content_shape CHECK (
  (message_kind = 'TEXT' AND template_id IS NULL AND template_snapshot IS NULL AND attachment_id IS NULL)
  OR (message_kind = 'TEMPLATE' AND direction = 'OUTBOUND' AND template_id IS NOT NULL
    AND jsonb_typeof(template_snapshot) = 'object' AND attachment_id IS NULL)
  OR (message_kind = 'ATTACHMENT' AND direction = 'INBOUND' AND attachment_id IS NOT NULL
    AND template_id IS NULL AND template_snapshot IS NULL)
);
CREATE OR REPLACE FUNCTION preserve_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.conversation_id, NEW.connection_id, NEW.sender_id,
      NEW.direction, NEW.author_type, NEW.author_user_id, NEW.body,
      NEW.idempotency_key, NEW.created_at, NEW.received_at,
      NEW.message_kind, NEW.template_id, NEW.template_snapshot, NEW.attachment_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.conversation_id, OLD.connection_id, OLD.sender_id,
      OLD.direction, OLD.author_type, OLD.author_user_id, OLD.body,
      OLD.idempotency_key, OLD.created_at, OLD.received_at,
      OLD.message_kind, OLD.template_id, OLD.template_snapshot, OLD.attachment_id) THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION preserve_attachment_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
    ROW(NEW.id, NEW.integration_event_id, NEW.media_kind, NEW.provider_media_id,
      NEW.declared_mime, NEW.expected_sha256, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.integration_event_id, OLD.media_kind, OLD.provider_media_id,
      OLD.declared_mime, OLD.expected_sha256, OLD.created_at) OR
    (OLD.state = 'READY' AND ROW(NEW.state, NEW.mime_type, NEW.size_bytes, NEW.content_sha256,
      NEW.storage_key, NEW.storage_backend, NEW.scanner_version, NEW.scanned_at)
      IS DISTINCT FROM ROW(OLD.state, OLD.mime_type, OLD.size_bytes, OLD.content_sha256,
      OLD.storage_key, OLD.storage_backend, OLD.scanner_version, OLD.scanned_at)) THEN
    RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachment_content_integrity BEFORE UPDATE OR DELETE ON message_attachment
  FOR EACH ROW EXECUTE FUNCTION preserve_attachment_content();
