ALTER TABLE message_attachment ADD CONSTRAINT attachment_content_integrity CHECK (
  state <> 'READY' OR (content_sha256 IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$'
    AND storage_backend IN ('LOCAL','S3')
    AND storage_key ~ '^[0-9a-f-]{36}-[0-9a-f]{64}$'
    AND length(scanner_version) BETWEEN 1 AND 255)
);
ALTER TABLE message_attachment ADD CONSTRAINT attachment_lease_integrity CHECK (
  (state = 'RUNNING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  OR (state <> 'RUNNING' AND lease_token IS NULL AND lease_until IS NULL)
);
ALTER TABLE message_attachment ADD CONSTRAINT attachment_attempt_bounds
  CHECK (attempt_count >= 0 AND retry_count BETWEEN 0 AND 5);
CREATE INDEX attachment_expired_lease_idx ON message_attachment (lease_until, id) WHERE state = 'RUNNING';
