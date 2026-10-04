ALTER TABLE outbound_delivery_job
  ADD COLUMN recovery_version integer NOT NULL DEFAULT 1 CHECK (recovery_version > 0),
  ADD CONSTRAINT outbound_delivery_job_identity UNIQUE (job_id, message_id);

CREATE TABLE outbound_message_recovery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL,
  job_id uuid NOT NULL,
  recovery_version integer NOT NULL CHECK (recovery_version > 1),
  previous_error_code text,
  attempts_before integer NOT NULL CHECK (attempts_before >= 0),
  requested_by uuid NOT NULL REFERENCES user_account(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, message_id) REFERENCES outbound_delivery_job (job_id, message_id),
  UNIQUE (message_id, recovery_version)
);
CREATE INDEX outbound_message_recovery_history_idx ON outbound_message_recovery (message_id, id DESC);
CREATE INDEX outbound_send_attempt_history_idx ON outbound_send_attempt (message_id, id DESC);
CREATE INDEX message_delivery_event_history_idx ON message_delivery_event (message_id, id DESC);

CREATE FUNCTION preserve_outbound_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OUTBOUND_RECOVERY_IMMUTABLE';
END;
$$;
CREATE TRIGGER outbound_recovery_immutable BEFORE UPDATE OR DELETE ON outbound_message_recovery
  FOR EACH ROW EXECUTE FUNCTION preserve_outbound_recovery();

-- A later delivery failure is still an accepted customer send. It must never be requeued.
CREATE FUNCTION guard_customer_message_requeue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_state = 'QUEUED' AND OLD.delivery_state <> 'QUEUED' THEN
    IF OLD.delivery_state <> 'FAILED' OR OLD.direction <> 'OUTBOUND' OR OLD.author_type <> 'HUMAN'
      OR OLD.provider_message_id IS NOT NULL OR OLD.delivery_rank <> 0 OR OLD.sent_at IS NOT NULL
      OR OLD.delivery_provider_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM outbound_send_attempt WHERE message_id = OLD.id
        AND (state <> 'REJECTED' OR finished_at IS NULL OR provider_message_id IS NOT NULL))
      OR EXISTS (SELECT 1 FROM message_delivery_event WHERE message_id = OLD.id)
      OR NOT EXISTS (SELECT 1 FROM outbound_delivery_job link
        JOIN background_job j ON j.id = link.job_id
        JOIN outbound_message_recovery r ON r.message_id = link.message_id
          AND r.recovery_version = link.recovery_version
        WHERE link.message_id = OLD.id AND j.status = 'DEAD' AND j.locked_until IS NULL
          AND r.attempts_before = j.attempts) THEN
      RAISE EXCEPTION 'CUSTOMER_MESSAGE_REQUEUE_UNSAFE';
    END IF;
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'CUSTOMER_PROVIDER_ID_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_message_requeue_guard BEFORE UPDATE ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION guard_customer_message_requeue();
