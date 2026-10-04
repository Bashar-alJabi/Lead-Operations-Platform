ALTER TABLE integration_event
  ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  ADD COLUMN processing_failures integer NOT NULL DEFAULT 0 CHECK (processing_failures BETWEEN 0 AND 5),
  ADD COLUMN processing_version integer NOT NULL DEFAULT 1 CHECK (processing_version > 0),
  ADD COLUMN processing_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN processing_last_error text,
  ADD COLUMN last_processed_at timestamptz;
CREATE INDEX integration_event_received_due_idx ON integration_event (processing_available_at, received_at, id)
  WHERE event_kind = 'DELIVERY_STATUS' AND state = 'RECEIVED';
CREATE TABLE integration_event_processing_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES integration_event(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('PROCESSED','NEEDS_ATTENTION','RETRY','FAILED')),
  error_code text,
  finished_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, attempt_number)
);
CREATE INDEX integration_event_processing_history_idx ON integration_event_processing_attempt
  (event_id, finished_at DESC, id DESC);
