CREATE INDEX background_job_identity_recent_idx ON background_job (created_at DESC, id DESC)
  WHERE queue = 'identity_email';
