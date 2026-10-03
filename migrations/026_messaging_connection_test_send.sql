CREATE TABLE messaging_connection_test_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL,
  sender_id uuid NOT NULL REFERENCES messaging_sender(id),
  template_id uuid NOT NULL REFERENCES provider_message_template(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  recipient_last4 text NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','REJECTED','UNKNOWN')),
  provider_message_id text,
  error_code text,
  created_by uuid NOT NULL REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, idempotency_key)
);
CREATE INDEX messaging_connection_test_send_list_idx
  ON messaging_connection_test_send (connection_id, created_at DESC, id DESC);
