-- Evaluation is a short database transaction: no provider I/O and no raw/PII copies in history.
CREATE TABLE source_processing (
  submission_id uuid PRIMARY KEY REFERENCES source_submission(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','VALIDATED','NEEDS_ATTENTION')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  evaluations integer NOT NULL DEFAULT 0 CHECK (evaluations>=0),
  campaign_id uuid REFERENCES campaign(id),
  branch_id uuid REFERENCES branch(id),
  resource_id uuid REFERENCES source_resource(id),
  binding_id uuid REFERENCES source_campaign_binding(id),
  binding_version integer,
  mapping_version integer,
  connection_version integer,
  resource_version integer,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$'),
  codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(codes)='array' AND jsonb_array_length(codes)<=200),
  mapped_fields integer NOT NULL DEFAULT 0 CHECK (mapped_fields>=0),
  mapped_contact_fields integer NOT NULL DEFAULT 0 CHECK (mapped_contact_fields BETWEEN 0 AND 3),
  actor_user_id uuid REFERENCES user_account(id),
  reason text NOT NULL DEFAULT 'SOURCE_RECEIVED' CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='NEEDS_ATTENTION')=(error_code IS NOT NULL)),
  CHECK (state<>'VALIDATED' OR (campaign_id IS NOT NULL AND branch_id IS NOT NULL AND binding_id IS NOT NULL AND mapping_version IS NOT NULL AND mapping_version>0))
);
CREATE INDEX source_processing_pending_idx ON source_processing (connection_id,updated_at,submission_id) WHERE state='PENDING';
CREATE INDEX source_processing_campaign_idx ON source_processing (campaign_id,updated_at DESC,submission_id DESC);
CREATE TABLE source_processing_history (
  submission_id uuid NOT NULL REFERENCES source_submission(id),
  version integer NOT NULL CHECK (version>0),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  campaign_id uuid REFERENCES campaign(id),
  branch_id uuid REFERENCES branch(id),
  state text NOT NULL CHECK (state IN ('PENDING','VALIDATED','NEEDS_ATTENTION')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_user_id uuid REFERENCES user_account(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id,version)
);
CREATE FUNCTION guard_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s source_submission; c integration_connection;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_HISTORY_REQUIRED'; END IF;
  SELECT * INTO s FROM source_submission WHERE id=NEW.submission_id;
  SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
  IF s.source_kind<>'META' OR s.connection_id IS DISTINCT FROM NEW.connection_id OR s.organization_id<>c.organization_id
    OR c.kind<>'META' OR c.provider<>'META_LEAD_ADS' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_SCOPE_INVALID'; END IF;
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_resource r WHERE r.id=NEW.resource_id AND r.connection_id=NEW.connection_id AND r.resource_kind='FORM')
    THEN RAISE EXCEPTION 'SOURCE_PROCESSING_RESOURCE_INVALID'; END IF;
  IF TG_OP='UPDATE' AND (NEW.submission_id<>OLD.submission_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.version<>OLD.version+1 OR NEW.evaluations<OLD.evaluations) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_VERSION_REQUIRED'; END IF;
  IF NEW.campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign c WHERE c.id=NEW.campaign_id
    AND c.organization_id=s.organization_id AND c.branch_id=NEW.branch_id) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_CAMPAIGN_INVALID'; END IF;
  IF NEW.binding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_campaign_binding b WHERE b.id=NEW.binding_id
    AND b.connection_id=NEW.connection_id AND b.campaign_id=NEW.campaign_id AND b.resource_id=NEW.resource_id) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_BINDING_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_processing_guard BEFORE INSERT OR UPDATE OR DELETE ON source_processing FOR EACH ROW EXECUTE FUNCTION guard_source_processing();
CREATE FUNCTION record_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_processing_history (submission_id,version,connection_id,campaign_id,branch_id,state,snapshot,actor_user_id,reason)
    VALUES (NEW.submission_id,NEW.version,NEW.connection_id,NEW.campaign_id,NEW.branch_id,NEW.state,
      jsonb_build_object('errorCode',NEW.error_code,'codes',NEW.codes,'bindingId',NEW.binding_id,'bindingVersion',NEW.binding_version,
        'mappingVersion',NEW.mapping_version,'connectionVersion',NEW.connection_version,'resourceVersion',NEW.resource_version,
        'mappedFields',NEW.mapped_fields,'mappedContactFields',NEW.mapped_contact_fields,'evaluations',NEW.evaluations),NEW.actor_user_id,NEW.reason);
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_processing_record AFTER INSERT OR UPDATE ON source_processing FOR EACH ROW EXECUTE FUNCTION record_source_processing();
CREATE FUNCTION preserve_source_processing_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_HISTORY_IMMUTABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM source_processing p WHERE p.submission_id=NEW.submission_id AND p.version=NEW.version
    AND p.connection_id=NEW.connection_id AND p.state=NEW.state AND p.campaign_id IS NOT DISTINCT FROM NEW.campaign_id
    AND p.branch_id IS NOT DISTINCT FROM NEW.branch_id AND p.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
    AND p.reason=NEW.reason) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_HISTORY_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_processing_history_guard BEFORE INSERT OR UPDATE OR DELETE ON source_processing_history
  FOR EACH ROW EXECUTE FUNCTION preserve_source_processing_history();
CREATE FUNCTION enqueue_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind='META' AND NEW.connection_id IS NOT NULL AND NEW.lead_id IS NULL THEN
    INSERT INTO source_processing (submission_id,connection_id) VALUES (NEW.id,NEW.connection_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enqueue_source_processing AFTER INSERT ON source_submission FOR EACH ROW EXECUTE FUNCTION enqueue_source_processing();
INSERT INTO source_processing (submission_id,connection_id) SELECT id,connection_id FROM source_submission
  WHERE source_kind='META' AND connection_id IS NOT NULL AND lead_id IS NULL ON CONFLICT DO NOTHING;
