ALTER TABLE conversation_message
  ADD COLUMN reply_to_message_id uuid REFERENCES conversation_message(id),
  ADD COLUMN reply_button_index smallint;
ALTER TABLE conversation_message ADD CONSTRAINT template_reply_shape CHECK (
  (reply_to_message_id IS NULL AND reply_button_index IS NULL)
  OR (reply_to_message_id IS NOT NULL AND reply_button_index BETWEEN 0 AND 2
    AND direction = 'INBOUND' AND message_kind = 'TEXT' AND author_type = 'CUSTOMER')
);
CREATE INDEX conversation_message_reply_reference_idx ON conversation_message (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE FUNCTION guard_template_reply_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_message prior
      CROSS JOIN LATERAL jsonb_array_elements(prior.template_snapshot->'components') component
      CROSS JOIN LATERAL jsonb_array_elements(component->'buttons') WITH ORDINALITY button(value, position)
    WHERE prior.id = NEW.reply_to_message_id AND prior.direction = 'OUTBOUND' AND prior.message_kind = 'TEMPLATE'
      AND prior.provider_message_id IS NOT NULL
      AND prior.conversation_id = NEW.conversation_id AND prior.connection_id = NEW.connection_id AND prior.sender_id = NEW.sender_id
      AND component->>'type' = 'BUTTONS' AND button.value->>'type' = 'QUICK_REPLY'
      AND button.position = NEW.reply_button_index + 1 AND button.value->>'text' = NEW.body
  ) THEN RAISE EXCEPTION 'TEMPLATE_REPLY_REFERENCE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_reply_reference_integrity BEFORE INSERT ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION guard_template_reply_reference();

CREATE OR REPLACE FUNCTION preserve_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.conversation_id, NEW.connection_id, NEW.sender_id,
      NEW.direction, NEW.author_type, NEW.author_user_id, NEW.body,
      NEW.idempotency_key, NEW.created_at, NEW.received_at,
      NEW.message_kind, NEW.template_id, NEW.template_snapshot, NEW.attachment_id,
      NEW.reply_to_message_id, NEW.reply_button_index)
    IS DISTINCT FROM ROW(OLD.id, OLD.conversation_id, OLD.connection_id, OLD.sender_id,
      OLD.direction, OLD.author_type, OLD.author_user_id, OLD.body,
      OLD.idempotency_key, OLD.created_at, OLD.received_at,
      OLD.message_kind, OLD.template_id, OLD.template_snapshot, OLD.attachment_id,
      OLD.reply_to_message_id, OLD.reply_button_index) THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
