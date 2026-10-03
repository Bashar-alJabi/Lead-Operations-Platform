ALTER TABLE conversation_message DROP CONSTRAINT conversation_message_delivery_state_check;
ALTER TABLE conversation_message ADD CONSTRAINT conversation_message_delivery_state_check
  CHECK (delivery_state IN ('QUEUED','SENT','DELIVERED','READ','FAILED','RECEIVED','UNKNOWN'));

CREATE TABLE sender_outbound_lease (
  sender_id uuid PRIMARY KEY REFERENCES messaging_sender(id),
  job_id uuid NOT NULL REFERENCES background_job(id),
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbound_send_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES conversation_message(id),
  job_id uuid NOT NULL REFERENCES background_job(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('PREPARED','ACKNOWLEDGED','REJECTED','UNKNOWN')),
  provider_message_id text,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_id, attempt_number)
);
CREATE INDEX outbound_send_attempt_message_idx ON outbound_send_attempt (message_id, started_at DESC);
CREATE INDEX background_job_expired_messaging_idx ON background_job (locked_until, id)
  WHERE queue = 'messaging' AND status = 'RUNNING';
