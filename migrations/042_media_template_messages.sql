ALTER TABLE conversation_message DROP CONSTRAINT message_content_shape;
-- Approval handles are provider references, never plaintext catalog metadata.
UPDATE provider_message_template t SET components=(
  SELECT jsonb_agg(CASE WHEN upper(part->>'type')='HEADER' AND part->>'format' IS DISTINCT FROM 'TEXT'
    THEN part-'example' ELSE part END ORDER BY ordinal)
  FROM jsonb_array_elements(t.components) WITH ORDINALITY c(part,ordinal)
) WHERE jsonb_typeof(t.components)='array' AND jsonb_array_length(t.components)>0;
ALTER TABLE conversation_message ADD CONSTRAINT message_content_shape CHECK (
  (message_kind = 'TEXT' AND template_id IS NULL AND template_snapshot IS NULL AND attachment_id IS NULL)
  OR (message_kind = 'TEMPLATE' AND direction = 'OUTBOUND' AND template_id IS NOT NULL
    AND template_snapshot IS NOT NULL AND jsonb_typeof(template_snapshot) = 'object')
  OR (message_kind = 'ATTACHMENT' AND attachment_id IS NOT NULL AND template_id IS NULL AND template_snapshot IS NULL)
);
CREATE FUNCTION guard_media_template_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_media_header boolean;
BEGIN
  IF NEW.message_kind <> 'TEMPLATE' THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.template_snapshot->'components') part
    WHERE part->>'type' = 'HEADER' AND part->>'format' IN ('IMAGE','VIDEO','DOCUMENT')) INTO has_media_header;
  IF (NEW.attachment_id IS NULL AND (has_media_header OR NEW.template_snapshot ? 'mediaHeader'))
    OR (NEW.attachment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM message_attachment a
      WHERE a.id = NEW.attachment_id AND a.state = 'READY' AND a.upload_conversation_id = NEW.conversation_id
        AND a.media_kind IN ('image','video','document') AND has_media_header
        AND (NEW.template_snapshot #>> '{mediaHeader,attachmentId}') = a.id::text
        AND (NEW.template_snapshot #>> '{mediaHeader,kind}') = a.media_kind
        AND (NEW.template_snapshot #>> '{mediaHeader,mime}') = a.mime_type
        AND (NEW.template_snapshot #>> '{mediaHeader,sha256}') = a.content_sha256
        AND (NEW.template_snapshot #>> '{mediaHeader,sizeBytes}') = a.size_bytes::text
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.template_snapshot->'components') part
          WHERE part->>'type' = 'HEADER' AND lower(part->>'format') = a.media_kind)
    )) THEN RAISE EXCEPTION 'TEMPLATE_MEDIA_REFERENCE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_template_message_integrity BEFORE INSERT ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION guard_media_template_message();
