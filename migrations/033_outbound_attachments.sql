ALTER TABLE message_attachment ALTER COLUMN integration_event_id DROP NOT NULL;
ALTER TABLE message_attachment ALTER COLUMN provider_media_id DROP NOT NULL;
ALTER TABLE message_attachment ADD COLUMN upload_conversation_id uuid REFERENCES conversation(id);
ALTER TABLE message_attachment ADD COLUMN uploaded_by uuid REFERENCES user_account(id);
ALTER TABLE message_attachment ADD COLUMN upload_idempotency_key text;
ALTER TABLE message_attachment ADD CONSTRAINT attachment_origin CHECK (
  (integration_event_id IS NOT NULL AND provider_media_id IS NOT NULL
    AND upload_conversation_id IS NULL AND uploaded_by IS NULL AND upload_idempotency_key IS NULL)
  OR (integration_event_id IS NULL AND provider_media_id IS NULL AND upload_conversation_id IS NOT NULL
    AND uploaded_by IS NOT NULL AND upload_idempotency_key IS NOT NULL AND state = 'READY')
);
CREATE UNIQUE INDEX attachment_upload_replay_idx ON message_attachment
  (upload_conversation_id, uploaded_by, upload_idempotency_key) WHERE upload_conversation_id IS NOT NULL;
ALTER TABLE conversation_message DROP CONSTRAINT message_content_shape;
ALTER TABLE conversation_message ADD CONSTRAINT message_content_shape CHECK (
  (message_kind = 'TEXT' AND template_id IS NULL AND template_snapshot IS NULL AND attachment_id IS NULL)
  OR (message_kind = 'TEMPLATE' AND direction = 'OUTBOUND' AND template_id IS NOT NULL
    AND jsonb_typeof(template_snapshot) = 'object' AND attachment_id IS NULL)
  OR (message_kind = 'ATTACHMENT' AND attachment_id IS NOT NULL
    AND template_id IS NULL AND template_snapshot IS NULL)
);
CREATE OR REPLACE FUNCTION preserve_attachment_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.integration_event_id, NEW.media_kind, NEW.provider_media_id,
      NEW.declared_mime, NEW.expected_sha256, NEW.created_at,
      NEW.upload_conversation_id, NEW.uploaded_by, NEW.upload_idempotency_key)
    IS DISTINCT FROM ROW(OLD.id, OLD.integration_event_id, OLD.media_kind, OLD.provider_media_id,
      OLD.declared_mime, OLD.expected_sha256, OLD.created_at,
      OLD.upload_conversation_id, OLD.uploaded_by, OLD.upload_idempotency_key) OR
    (OLD.state = 'READY' AND ROW(NEW.state, NEW.mime_type, NEW.size_bytes, NEW.content_sha256,
      NEW.storage_key, NEW.storage_backend, NEW.scanner_version, NEW.scanned_at)
      IS DISTINCT FROM ROW(OLD.state, OLD.mime_type, OLD.size_bytes, OLD.content_sha256,
      OLD.storage_key, OLD.storage_backend, OLD.scanner_version, OLD.scanned_at)) THEN
    RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
UPDATE messaging_sender s SET capabilities = capabilities || '{"media":["image","document"]}'::jsonb
  WHERE EXISTS (SELECT 1 FROM integration_connection ic WHERE ic.id = s.connection_id AND ic.provider = 'META_WHATSAPP_CLOUD');
