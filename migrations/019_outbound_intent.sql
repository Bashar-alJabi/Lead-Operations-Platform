ALTER TABLE conversation
  ADD CONSTRAINT conversation_pinned_sender_identity UNIQUE (id, connection_id, sender_id);

ALTER TABLE conversation_message
  ADD CONSTRAINT message_pinned_sender_identity FOREIGN KEY (conversation_id, connection_id, sender_id)
    REFERENCES conversation (id, connection_id, sender_id);

ALTER TABLE conversation_message
  ADD CONSTRAINT message_direction_author CHECK (
    (direction = 'INBOUND' AND author_type = 'CUSTOMER' AND author_user_id IS NULL)
    OR (direction = 'OUTBOUND' AND author_type IN ('HUMAN','AI','AUTOMATION','FOLLOW_UP'))
  );

CREATE INDEX conversation_message_outbound_attempt_idx
  ON conversation_message (conversation_id, created_at DESC, id DESC)
  WHERE direction = 'OUTBOUND';

CREATE OR REPLACE FUNCTION preserve_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  IF ROW(NEW.conversation_id, NEW.connection_id, NEW.sender_id, NEW.direction,
      NEW.author_type, NEW.author_user_id, NEW.body, NEW.idempotency_key, NEW.created_at,
      NEW.received_at) IS DISTINCT FROM ROW(OLD.conversation_id, OLD.connection_id,
      OLD.sender_id, OLD.direction, OLD.author_type, OLD.author_user_id, OLD.body,
      OLD.idempotency_key, OLD.created_at, OLD.received_at) THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversation_message_preserve_update BEFORE UPDATE ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION preserve_customer_message();
CREATE TRIGGER conversation_message_preserve_delete BEFORE DELETE ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION preserve_customer_message();
