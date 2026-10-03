ALTER TABLE conversation_message
  ADD CONSTRAINT message_author_user_identity CHECK (
    (author_type = 'HUMAN' AND author_user_id IS NOT NULL)
    OR (author_type <> 'HUMAN' AND author_user_id IS NULL)
  );

CREATE TABLE outbound_delivery_job (
  message_id uuid PRIMARY KEY REFERENCES conversation_message(id),
  job_id uuid NOT NULL UNIQUE REFERENCES background_job(id)
);

CREATE OR REPLACE FUNCTION preserve_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  IF ROW(NEW.id, NEW.conversation_id, NEW.connection_id, NEW.sender_id,
      NEW.direction, NEW.author_type, NEW.author_user_id, NEW.body,
      NEW.idempotency_key, NEW.created_at, NEW.received_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.conversation_id, OLD.connection_id,
      OLD.sender_id, OLD.direction, OLD.author_type, OLD.author_user_id,
      OLD.body, OLD.idempotency_key, OLD.created_at, OLD.received_at) THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
