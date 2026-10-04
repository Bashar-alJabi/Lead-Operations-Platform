CREATE TABLE messaging_template_sample (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK (connection_version > 0),
  uploaded_by uuid NOT NULL REFERENCES user_account(id),
  requested_by uuid NOT NULL REFERENCES user_account(id),
  upload_key text NOT NULL CHECK (upload_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('image','video','document')),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','video/mp4','application/pdf')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL,
  storage_backend text NOT NULL,
  scanner_version text NOT NULL,
  scanned_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','READY','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  handle_ciphertext bytea,
  handle_nonce bytea,
  handle_auth_tag bytea,
  handle_key_version integer,
  last_error_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, uploaded_by, upload_key),
  CHECK ((state = 'RUNNING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'RUNNING' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'READY' AND handle_ciphertext IS NOT NULL AND handle_nonce IS NOT NULL
      AND handle_auth_tag IS NOT NULL AND handle_key_version IS NOT NULL AND handle_key_version = 1)
    OR (state <> 'READY' AND handle_ciphertext IS NULL AND handle_nonce IS NULL
      AND handle_auth_tag IS NULL AND handle_key_version IS NULL)),
  CHECK ((media_kind = 'image' AND mime_type IN ('image/jpeg','image/png'))
    OR (media_kind = 'video' AND mime_type = 'video/mp4')
    OR (media_kind = 'document' AND mime_type = 'application/pdf'))
);
CREATE INDEX template_sample_queue_idx ON messaging_template_sample (available_at, id)
  WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX template_sample_catalog_idx ON messaging_template_sample (connection_id, id);
CREATE TABLE template_sample_processing_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sample_id uuid NOT NULL REFERENCES messaging_template_sample(id),
  lease_token uuid NOT NULL UNIQUE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  connection_version integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('STARTED','READY','RETRY','FAILED','LEASE_EXPIRED')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (sample_id, attempt_number)
);
CREATE INDEX template_sample_attempt_history_idx ON template_sample_processing_attempt (sample_id, id DESC);
CREATE FUNCTION preserve_template_sample() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id, NEW.connection_id, NEW.uploaded_by, NEW.upload_key,
      NEW.media_kind, NEW.mime_type, NEW.content_sha256, NEW.size_bytes, NEW.storage_key,
      NEW.storage_backend, NEW.scanner_version, NEW.scanned_at, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.connection_id, OLD.uploaded_by, OLD.upload_key,
      OLD.media_kind, OLD.mime_type, OLD.content_sha256, OLD.size_bytes, OLD.storage_key,
      OLD.storage_backend, OLD.scanner_version, OLD.scanned_at, OLD.created_at)
    OR (OLD.state = 'READY' AND ROW(NEW.state, NEW.connection_version, NEW.handle_ciphertext,
      NEW.handle_nonce, NEW.handle_auth_tag, NEW.handle_key_version)
    IS DISTINCT FROM ROW(OLD.state, OLD.connection_version, OLD.handle_ciphertext,
      OLD.handle_nonce, OLD.handle_auth_tag, OLD.handle_key_version)) THEN
    RAISE EXCEPTION 'TEMPLATE_SAMPLE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_sample_content_integrity BEFORE UPDATE OR DELETE ON messaging_template_sample
  FOR EACH ROW EXECUTE FUNCTION preserve_template_sample();
