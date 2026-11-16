ALTER TABLE lead_import_file ADD COLUMN cleanup_attempt_count integer NOT NULL DEFAULT 0 CHECK(cleanup_attempt_count BETWEEN 0 AND 5);
ALTER TABLE lead_import_file ADD COLUMN cleanup_next_run_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE lead_import_file ADD COLUMN cleanup_error_code text CHECK(cleanup_error_code IS NULL OR cleanup_error_code='IMPORT_FILE_PURGE_FAILED');
CREATE INDEX lead_import_storage_quota ON lead_import_file(organization_id,actor_id) WHERE purged_at IS NULL;
CREATE INDEX lead_import_purge_due ON lead_import_file(cleanup_next_run_at,id) WHERE purged_at IS NULL AND state IN ('CANCELLED','EXPIRED','REJECTED','REVOKED');
CREATE INDEX lead_import_running_lease ON lead_import_file(lease_until,id) WHERE state='RUNNING';
CREATE FUNCTION lead_import_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.cleanup_attempt_count<>0 OR NEW.cleanup_error_code IS NOT NULL OR NEW.cleanup_next_run_at<transaction_timestamp() OR NEW.cleanup_next_run_at>clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_CLEANUP_INITIAL';END IF;
 ELSIF (NEW.cleanup_attempt_count,NEW.cleanup_next_run_at,NEW.cleanup_error_code) IS DISTINCT FROM (OLD.cleanup_attempt_count,OLD.cleanup_next_run_at,OLD.cleanup_error_code) THEN
  IF OLD.state NOT IN ('EXPIRED','CANCELLED','REJECTED','REVOKED') OR OLD.purged_at IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['cleanup_attempt_count','cleanup_next_run_at','cleanup_error_code']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['cleanup_attempt_count','cleanup_next_run_at','cleanup_error_code'])
   OR NEW.cleanup_attempt_count<>least(5,OLD.cleanup_attempt_count+1) OR NEW.cleanup_error_code IS DISTINCT FROM 'IMPORT_FILE_PURGE_FAILED'
   OR NEW.cleanup_next_run_at<clock_timestamp()+interval '1 second' OR NEW.cleanup_next_run_at>clock_timestamp()+interval '61 minutes'
   OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_PURGE_FAILED',false) THEN RAISE EXCEPTION 'IMPORT_CLEANUP_BACKOFF_PROOF';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER a_lead_import_cleanup_guard BEFORE INSERT OR UPDATE ON lead_import_file FOR EACH ROW EXECUTE FUNCTION lead_import_cleanup_guard();

CREATE OR REPLACE FUNCTION lead_import_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMPORT_HISTORY_RETAINED';END IF;
 IF TG_OP='UPDATE' AND (NEW.cleanup_attempt_count,NEW.cleanup_next_run_at,NEW.cleanup_error_code) IS DISTINCT FROM (OLD.cleanup_attempt_count,OLD.cleanup_next_run_at,OLD.cleanup_error_code) THEN
  -- a_lead_import_cleanup_guard قبل هذه البوابة يثبت الظهور في نفس المعاملة وbackoff وimmutability.
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
  IF OLD.purged_at IS NOT NULL OR OLD.state NOT IN ('CANCELLED','EXPIRED','REJECTED','REVOKED') OR NEW.purged_at IS NULL
   OR (to_jsonb(NEW)-'purged_at') IS DISTINCT FROM (to_jsonb(OLD)-'purged_at')
   OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_PURGED',false) THEN RAISE EXCEPTION 'IMPORT_PURGE_PROOF';END IF;RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.row_count<>0 OR NEW.lease_token IS NOT NULL
   OR NEW.scanned_at IS NOT NULL OR NEW.scanner_version IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.purged_at IS NOT NULL
   OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+interval '7 days'
   OR NOT lead_import_authority(NEW) OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_UPLOADED',true)
   OR NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=NEW.uploaded_session_id AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
   THEN RAISE EXCEPTION 'IMPORT_UPLOAD_AUTHORITY';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','attempt_count','lease_token','lease_until','next_run_at','error_code','scanner_version','scanned_at','row_count','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','attempt_count','lease_token','lease_until','next_run_at','error_code','scanner_version','scanned_at','row_count','updated_at'])
   OR NEW.version<>OLD.version+1 OR OLD.state IN ('CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'IMPORT_FILE_IMMUTABLE';END IF;
  IF NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_STATE',false) OR NOT EXISTS(SELECT 1 FROM audit_log a
   WHERE a.target_type='LEAD_IMPORT_FILE' AND a.target_id=NEW.id::text AND a.action='IMPORT_FILE_STATE' AND a.organization_id=NEW.organization_id
    AND ai_row_inserted_here(a.xmin) AND a.detail->>'version'=NEW.version::text AND a.detail->>'state'=NEW.state)
   THEN RAISE EXCEPTION 'IMPORT_STATE_AUDIT';END IF;
  IF NEW.state='EXPIRED' THEN
   IF clock_timestamp()<OLD.expires_at THEN RAISE EXCEPTION 'IMPORT_NOT_EXPIRED';END IF;
  ELSIF NEW.state<>'REVOKED' AND NOT lead_import_authority(NEW) THEN RAISE EXCEPTION 'IMPORT_AUTHORITY_REVOKED';END IF;
  IF NEW.state='CANCELLED' THEN
   IF NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_CANCELLED',true) THEN RAISE EXCEPTION 'IMPORT_CANCEL_SESSION';END IF;
  ELSIF NEW.state='WAITING' AND OLD.state IN ('DEAD_LETTER','REVOKED') THEN
   IF OLD.purged_at IS NOT NULL OR NEW.attempt_count<>0 OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_RETRIED',true) THEN RAISE EXCEPTION 'IMPORT_RECOVERY_SESSION';END IF;
  ELSIF NEW.state='RUNNING' THEN
   IF OLD.state NOT IN ('WAITING','RUNNING') OR OLD.state='RUNNING' AND OLD.lease_until>clock_timestamp()
    OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '245 seconds'
    OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN RAISE EXCEPTION 'IMPORT_LEASE_PROOF';END IF;
  ELSIF NEW.state IN ('WAITING','REVIEW','REJECTED') THEN
   IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.attempt_count<>OLD.attempt_count
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_id=NEW.id::text AND a.target_type='LEAD_IMPORT_FILE' AND a.action='IMPORT_FILE_STATE'
     AND ai_row_inserted_here(a.xmin) AND a.detail->>'leaseToken'=OLD.lease_token::text AND a.detail->>'version'=NEW.version::text)
    THEN RAISE EXCEPTION 'IMPORT_COMPLETION_LEASE';END IF;
  ELSIF NEW.state='DEAD_LETTER' THEN
   IF OLD.state NOT IN ('RUNNING','WAITING') OR NEW.attempt_count<>5 OR OLD.attempt_count<>5 THEN RAISE EXCEPTION 'IMPORT_RETRY_BOUND';END IF;
  ELSIF NEW.state NOT IN ('REVOKED','EXPIRED') THEN RAISE EXCEPTION 'IMPORT_TRANSITION_INVALID';END IF;
  IF NEW.state='REVIEW' THEN
   IF NEW.scanned_at<transaction_timestamp() OR NEW.scanned_at>clock_timestamp() OR length(NEW.scanner_version) NOT BETWEEN 1 AND 255
    OR NEW.row_count<>(SELECT count(*) FROM lead_import_row r WHERE r.file_id=NEW.id)
    OR NEW.row_count<>(SELECT sum(row_count) FROM lead_import_sheet s WHERE s.file_id=NEW.id)
    OR NOT EXISTS(SELECT 1 FROM lead_import_sheet s WHERE s.file_id=NEW.id)
    OR EXISTS(SELECT 1 FROM lead_import_sheet s WHERE s.file_id=NEW.id AND s.row_count<>(SELECT count(*) FROM lead_import_row r WHERE r.file_id=s.file_id AND r.sheet_index=s.sheet_index))
    THEN RAISE EXCEPTION 'IMPORT_PARSE_PROOF';END IF;
  ELSIF NEW.row_count<>OLD.row_count OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at OR NEW.scanner_version IS DISTINCT FROM OLD.scanner_version
   THEN RAISE EXCEPTION 'IMPORT_PARSE_IMMUTABLE';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
