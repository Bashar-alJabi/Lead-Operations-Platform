ALTER TABLE conversation_message
  ADD COLUMN message_kind text NOT NULL DEFAULT 'TEXT'
    CHECK (message_kind IN ('TEXT','TEMPLATE')),
  ADD COLUMN template_id uuid REFERENCES provider_message_template(id),
  ADD COLUMN template_snapshot jsonb;
ALTER TABLE conversation_message ADD CONSTRAINT message_template_shape CHECK (
  (message_kind = 'TEXT' AND template_id IS NULL AND template_snapshot IS NULL)
  OR (message_kind = 'TEMPLATE' AND direction = 'OUTBOUND'
    AND template_id IS NOT NULL AND jsonb_typeof(template_snapshot) = 'object')
);

CREATE TABLE campaign_message_template_binding (
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  template_id uuid NOT NULL REFERENCES provider_message_template(id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES user_account(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, template_id)
);
CREATE INDEX campaign_message_template_active_idx ON campaign_message_template_binding (template_id, campaign_id)
  WHERE active;

CREATE OR REPLACE FUNCTION preserve_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  IF ROW(NEW.id, NEW.conversation_id, NEW.connection_id, NEW.sender_id,
      NEW.direction, NEW.author_type, NEW.author_user_id, NEW.body,
      NEW.idempotency_key, NEW.created_at, NEW.received_at,
      NEW.message_kind, NEW.template_id, NEW.template_snapshot)
    IS DISTINCT FROM ROW(OLD.id, OLD.conversation_id, OLD.connection_id,
      OLD.sender_id, OLD.direction, OLD.author_type, OLD.author_user_id,
      OLD.body, OLD.idempotency_key, OLD.created_at, OLD.received_at,
      OLD.message_kind, OLD.template_id, OLD.template_snapshot) THEN
    RAISE EXCEPTION 'CUSTOMER_MESSAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
