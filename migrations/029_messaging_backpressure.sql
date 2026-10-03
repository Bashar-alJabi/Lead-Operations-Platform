ALTER TABLE integration_connection ADD COLUMN cooldown_until timestamptz;
ALTER TABLE messaging_sender ADD COLUMN cooldown_until timestamptz;
ALTER TABLE messaging_sender ADD COLUMN last_provider_error_code text;

CREATE INDEX background_job_messaging_due_idx ON background_job (run_after, id)
  WHERE queue = 'messaging' AND kind = 'SEND_MESSAGE' AND status = 'QUEUED';
