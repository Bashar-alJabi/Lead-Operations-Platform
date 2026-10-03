ALTER TABLE provider_message_template
  ADD COLUMN category text,
  ADD COLUMN components jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN last_synced_at timestamptz;
CREATE INDEX provider_message_template_list_idx
  ON provider_message_template (connection_id, name, language, id);

CREATE TABLE messaging_template_create_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  name text NOT NULL,
  language text NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','REJECTED','UNKNOWN')),
  template_id uuid REFERENCES provider_message_template(id),
  error_code text,
  created_by uuid NOT NULL REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, idempotency_key)
);
CREATE INDEX messaging_template_create_request_name_idx
  ON messaging_template_create_request (connection_id, name, language, created_at DESC);
