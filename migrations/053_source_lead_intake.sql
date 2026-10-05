-- VALIDATED is durable conversion readiness; PROCESSED records an atomic domain intake.
ALTER TABLE source_processing DROP CONSTRAINT source_processing_state_check;
ALTER TABLE source_processing ADD CONSTRAINT source_processing_state_check CHECK (state IN ('PENDING','VALIDATED','NEEDS_ATTENTION','PROCESSED'));
ALTER TABLE source_processing_history DROP CONSTRAINT source_processing_history_state_check;
ALTER TABLE source_processing_history ADD CONSTRAINT source_processing_history_state_check CHECK (state IN ('PENDING','VALIDATED','NEEDS_ATTENTION','PROCESSED'));
ALTER TABLE source_processing ADD COLUMN intake_attempts integer NOT NULL DEFAULT 0 CHECK (intake_attempts>=0);
ALTER TABLE source_processing ADD CONSTRAINT source_processed_context CHECK (state<>'PROCESSED' OR
  (campaign_id IS NOT NULL AND branch_id IS NOT NULL AND binding_id IS NOT NULL AND mapping_version>0));
CREATE INDEX source_processing_intake_idx ON source_processing (connection_id,updated_at,submission_id) WHERE state='VALIDATED';

ALTER TABLE lead_field_value ADD COLUMN source_submission_id uuid REFERENCES source_submission(id);
ALTER TABLE lead_field_value ADD COLUMN source_binding_id uuid;
ALTER TABLE lead_field_value ADD COLUMN source_mapping_version integer;
ALTER TABLE lead_field_value ADD FOREIGN KEY (source_binding_id,source_mapping_version) REFERENCES source_mapping_revision(binding_id,version);
ALTER TABLE lead_field_value ADD CHECK (source_submission_id IS NULL OR (source='SOURCE' AND source_binding_id IS NOT NULL AND source_mapping_version>0));
ALTER TABLE field_value_history ADD COLUMN source_submission_id uuid REFERENCES source_submission(id);
ALTER TABLE field_value_history ADD COLUMN source_binding_id uuid;
ALTER TABLE field_value_history ADD COLUMN source_mapping_version integer;
ALTER TABLE field_value_history ADD FOREIGN KEY (source_binding_id,source_mapping_version) REFERENCES source_mapping_revision(binding_id,version);
ALTER TABLE field_value_history ADD CHECK (source_submission_id IS NULL OR (source='SOURCE' AND source_binding_id IS NOT NULL AND source_mapping_version>0));

CREATE FUNCTION guard_source_intake_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission source_submission;
BEGIN
  SELECT * INTO submission FROM source_submission WHERE id=NEW.submission_id;
  IF TG_OP='UPDATE' AND (OLD.state='PROCESSED' OR NEW.intake_attempts<OLD.intake_attempts)
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_RESULT_IMMUTABLE'; END IF;
  IF NEW.state='PROCESSED' AND (submission.state<>'PROCESSED' OR submission.lead_id IS NULL
    OR submission.campaign_id IS DISTINCT FROM NEW.campaign_id OR submission.branch_id IS DISTINCT FROM NEW.branch_id)
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_RESULT_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_intake_result_guard BEFORE INSERT OR UPDATE ON source_processing FOR EACH ROW EXECUTE FUNCTION guard_source_intake_result();
CREATE FUNCTION guard_meta_intake_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind<>'META' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.lead_id IS NOT NULL AND
    (NEW.lead_id,NEW.campaign_id,NEW.branch_id,NEW.resolution_contact_id,NEW.state,NEW.failure_code)
    IS DISTINCT FROM (OLD.lead_id,OLD.campaign_id,OLD.branch_id,OLD.resolution_contact_id,OLD.state,OLD.failure_code)
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_IMMUTABLE'; END IF;
  IF NEW.lead_id IS NOT NULL AND (NEW.state<>'PROCESSED' OR NEW.failure_code IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM lead l WHERE l.id=NEW.lead_id AND l.organization_id=NEW.organization_id AND l.branch_id=NEW.branch_id
      AND l.campaign_id=NEW.campaign_id AND l.source_kind='META' AND l.contact_id IS NOT DISTINCT FROM NEW.resolution_contact_id))
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_INVALID'; END IF;
  IF NEW.state='PROCESSED' AND NEW.lead_id IS NULL THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meta_intake_link_guard BEFORE INSERT OR UPDATE ON source_submission FOR EACH ROW EXECUTE FUNCTION guard_meta_intake_link();

CREATE OR REPLACE FUNCTION record_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_processing_history (submission_id,version,connection_id,campaign_id,branch_id,state,snapshot,actor_user_id,reason)
    VALUES (NEW.submission_id,NEW.version,NEW.connection_id,NEW.campaign_id,NEW.branch_id,NEW.state,
      jsonb_build_object('errorCode',NEW.error_code,'codes',NEW.codes,'bindingId',NEW.binding_id,'bindingVersion',NEW.binding_version,
        'mappingVersion',NEW.mapping_version,'connectionVersion',NEW.connection_version,'resourceVersion',NEW.resource_version,
        'mappedFields',NEW.mapped_fields,'mappedContactFields',NEW.mapped_contact_fields,'evaluations',NEW.evaluations,
        'intakeAttempts',NEW.intake_attempts,'leadId',(SELECT lead_id FROM source_submission WHERE id=NEW.submission_id)),NEW.actor_user_id,NEW.reason);
  RETURN NEW;
END;
$$;
