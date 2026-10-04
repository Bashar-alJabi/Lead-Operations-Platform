CREATE TABLE source_retrieval_job (
  event_id uuid PRIMARY KEY REFERENCES source_webhook_event(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures>=0),
  recoveries integer NOT NULL DEFAULT 0 CHECK (recoveries>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  submission_id uuid UNIQUE REFERENCES source_submission(id),
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,100}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='RUNNING' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'RUNNING' AND lease_id IS NULL AND lease_until IS NULL)),
  CHECK ((state='SUCCEEDED' AND submission_id IS NOT NULL AND error_code IS NULL) OR (state<>'SUCCEEDED' AND submission_id IS NULL)),
  CHECK (state NOT IN ('FAILED','BLOCKED') OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX source_retrieval_running_idx ON source_retrieval_job (connection_id) WHERE state='RUNNING';
CREATE INDEX source_retrieval_queue_idx ON source_retrieval_job (connection_id,state,available_at,event_id);
CREATE TABLE source_retrieval_attempt (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES source_retrieval_job(event_id),
  attempt_number integer NOT NULL CHECK (attempt_number>0),
  connection_version integer NOT NULL CHECK (connection_version>0),
  page_version integer NOT NULL CHECK (page_version>0),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','SUPERSEDED')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (event_id,attempt_number),
  CHECK ((state='RUNNING' AND finished_at IS NULL AND error_code IS NULL) OR
    (state='SUCCEEDED' AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (state IN ('FAILED','SUPERSEDED') AND finished_at IS NOT NULL AND error_code IS NOT NULL))
);
CREATE FUNCTION guard_source_retrieval_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_HISTORY_IMMUTABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM source_webhook_event WHERE id=NEW.event_id AND connection_id=NEW.connection_id)
    THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_SCOPE_INVALID'; END IF;
  IF TG_OP='UPDATE' AND (OLD.state='SUCCEEDED' OR (NEW.event_id,NEW.connection_id) IS DISTINCT FROM (OLD.event_id,OLD.connection_id)
    OR NEW.version<>OLD.version+1 OR NEW.attempts<OLD.attempts OR NEW.recoveries<OLD.recoveries
    OR (NEW.failures<OLD.failures AND NOT (OLD.state IN ('FAILED','BLOCKED') AND NEW.state='PENDING' AND NEW.recoveries=OLD.recoveries+1)))
    THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_HISTORY_IMMUTABLE'; END IF;
  IF NEW.submission_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_submission s JOIN source_webhook_event e ON e.id=NEW.event_id
    WHERE s.id=NEW.submission_id AND s.connection_id=NEW.connection_id AND s.external_event_id=e.external_lead_id AND s.source_kind='META')
    THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_SUBMISSION_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_retrieval_job_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_retrieval_job FOR EACH ROW EXECUTE FUNCTION guard_source_retrieval_job();
CREATE FUNCTION preserve_source_retrieval_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_HISTORY_IMMUTABLE'; END IF;
  IF OLD.state<>'RUNNING' OR (NEW.id,NEW.event_id,NEW.attempt_number,NEW.connection_version,NEW.page_version,NEW.started_at)
    IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.attempt_number,OLD.connection_version,OLD.page_version,OLD.started_at)
    THEN RAISE EXCEPTION 'SOURCE_RETRIEVAL_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_retrieval_attempt_integrity BEFORE UPDATE OR DELETE ON source_retrieval_attempt FOR EACH ROW EXECUTE FUNCTION preserve_source_retrieval_attempt();
CREATE FUNCTION enqueue_source_retrieval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_retrieval_job (event_id,connection_id) VALUES (NEW.id,NEW.connection_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_webhook_enqueue AFTER INSERT ON source_webhook_event FOR EACH ROW EXECUTE FUNCTION enqueue_source_retrieval();
INSERT INTO source_retrieval_job (event_id,connection_id) SELECT id,connection_id FROM source_webhook_event;
CREATE FUNCTION preserve_meta_source_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.source_kind='META' THEN RAISE EXCEPTION 'SOURCE_SUBMISSION_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND (OLD.source_kind='META' OR NEW.source_kind='META') AND
    (NEW.id,NEW.organization_id,NEW.source_kind,NEW.connection_id,NEW.external_event_id,NEW.raw_payload,NEW.source_timestamp,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.source_kind,OLD.connection_id,OLD.external_event_id,OLD.raw_payload,OLD.source_timestamp,OLD.created_at)
    THEN RAISE EXCEPTION 'SOURCE_SUBMISSION_IMMUTABLE'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER meta_source_submission_integrity BEFORE UPDATE OR DELETE ON source_submission FOR EACH ROW EXECUTE FUNCTION preserve_meta_source_submission();
