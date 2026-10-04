-- Provider capabilities, not a business frequency/capacity rule. Existing health and bindings remain unchanged.
UPDATE messaging_sender s SET capabilities = capabilities ||
  '{"media":["image","document","audio","video","sticker"],"mediaProfile":"meta-cloud-media-2026-10-04"}'::jsonb
  WHERE EXISTS (SELECT 1 FROM integration_connection ic WHERE ic.id = s.connection_id AND ic.provider = 'META_WHATSAPP_CLOUD');

CREATE FUNCTION enforce_outbound_media_caption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction = 'OUTBOUND' AND NEW.message_kind = 'ATTACHMENT' AND EXISTS (
    SELECT 1 FROM message_attachment a WHERE a.id = NEW.attachment_id AND
      ((a.media_kind IN ('audio','sticker') AND NEW.body <> '') OR char_length(NEW.body) > 1024)
  ) THEN RAISE EXCEPTION 'MEDIA_CAPTION_NOT_SUPPORTED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbound_media_caption_guard BEFORE INSERT OR UPDATE OF body, attachment_id, message_kind, direction
  ON conversation_message FOR EACH ROW EXECUTE FUNCTION enforce_outbound_media_caption();
