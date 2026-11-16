CREATE FUNCTION lead_import_cells_valid(v jsonb,headers boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(v)<>'array' THEN false ELSE jsonb_array_length(v) BETWEEN 1 AND 64
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE (jsonb_typeof(x)<>'string' AND (headers OR x<>'null'::jsonb))
   OR length(x#>>'{}')>CASE WHEN headers THEN 256 ELSE 8192 END) END
$$;
CREATE TABLE lead_import_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 actor_id uuid NOT NULL REFERENCES user_account(id),actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),branch_scope uuid REFERENCES branch(id),
 uploaded_session_id uuid NOT NULL REFERENCES user_session(id),request_key uuid NOT NULL,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200 AND label!~'[[:cntrl:]]'),
 format text NOT NULL CHECK(format IN ('CSV','XLSX','XLS')),delimiter text NOT NULL CHECK(delimiter IN (',',';',E'\t')),
 content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608),
 storage_key text NOT NULL UNIQUE,storage_backend text NOT NULL CHECK(storage_backend IN ('LOCAL','S3')),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','RUNNING','REVIEW','REJECTED','DEAD_LETTER','REVOKED','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
 lease_token uuid,lease_until timestamptz,next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),error_code text,
 scanner_version text,scanned_at timestamptz,row_count integer NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),purged_at timestamptz,
 UNIQUE(actor_id,request_key),CHECK(storage_key=id::text||'-'||content_sha256),CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state<>'REVIEW' OR scanner_version IS NOT NULL AND scanned_at IS NOT NULL AND row_count>0)
);
CREATE INDEX lead_import_work ON lead_import_file(next_run_at,id) WHERE state IN ('WAITING','RUNNING');
CREATE INDEX lead_import_expiry ON lead_import_file(expires_at,id) WHERE state NOT IN ('EXPIRED','CANCELLED');
CREATE INDEX lead_import_cleanup ON lead_import_file(id) WHERE purged_at IS NULL;
CREATE INDEX lead_import_actor ON lead_import_file(actor_id,id);
CREATE TABLE lead_import_sheet (
 file_id uuid NOT NULL REFERENCES lead_import_file(id),sheet_index integer NOT NULL CHECK(sheet_index BETWEEN 0 AND 9),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),headers jsonb NOT NULL CHECK(lead_import_cells_valid(headers,true)),
 header_row integer NOT NULL CHECK(header_row BETWEEN 1 AND 1048576),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),
 PRIMARY KEY(file_id,sheet_index)
);
CREATE TABLE lead_import_row (
 file_id uuid NOT NULL,sheet_index integer NOT NULL,row_number integer NOT NULL CHECK(row_number BETWEEN 2 AND 1048576),
 cells jsonb NOT NULL CHECK(lead_import_cells_valid(cells)),PRIMARY KEY(file_id,sheet_index,row_number),
 FOREIGN KEY(file_id,sheet_index) REFERENCES lead_import_sheet(file_id,sheet_index)
);
CREATE TABLE lead_import_file_history (
 file_id uuid NOT NULL REFERENCES lead_import_file(id),version integer NOT NULL,state text NOT NULL,attempt_count integer NOT NULL,
 row_count integer NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(file_id,version)
);
CREATE FUNCTION lead_import_authority(j lead_import_file) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u JOIN branch b ON b.id=j.branch_id JOIN campaign c ON c.id=j.campaign_id
  WHERE u.id=j.actor_id AND u.active AND u.role=j.actor_role AND u.organization_id=j.organization_id
   AND u.branch_id IS NOT DISTINCT FROM j.branch_scope AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id)
   AND b.active AND b.organization_id=u.organization_id AND c.organization_id=b.organization_id AND c.branch_id=b.id)
$$;
CREATE FUNCTION lead_import_fresh_audit(j lead_import_file,act text,human boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.branch_id=j.branch_id
  AND a.target_type='LEAD_IMPORT_FILE' AND a.target_id=j.id::text AND a.action=act AND ai_row_inserted_here(a.xmin)
  AND a.detail->>'version'=j.version::text
  AND CASE WHEN human THEN a.actor_user_id=j.actor_id AND EXISTS(SELECT 1 FROM user_session s
   WHERE s.id=(a.detail->>'sessionId')::uuid AND s.user_id=j.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
  ELSE a.actor_user_id IS NULL END)
$$;
CREATE FUNCTION lead_import_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMPORT_HISTORY_RETAINED';END IF;
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
  ELSIF NEW.state<>'REVOKED' THEN RAISE EXCEPTION 'IMPORT_TRANSITION_INVALID';END IF;
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
CREATE TRIGGER lead_import_file_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_file FOR EACH ROW EXECUTE FUNCTION lead_import_file_guard();
CREATE FUNCTION lead_import_data_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s lead_import_sheet;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMPORT_ROWS_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.file_id ELSE OLD.file_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN
  IF j.state NOT IN ('EXPIRED','CANCELLED','REJECTED','REVOKED') THEN RAISE EXCEPTION 'IMPORT_ROWS_RETAINED';END IF;RETURN OLD;
 END IF;
 IF j.state<>'RUNNING' OR j.lease_until<=clock_timestamp() OR NOT lead_import_authority(j)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_type='LEAD_IMPORT_FILE' AND a.target_id=j.id::text AND a.action='IMPORT_FILE_PARSED'
   AND a.organization_id=j.organization_id AND a.actor_user_id IS NULL AND a.detail->>'leaseToken'=j.lease_token::text AND ai_row_inserted_here(a.xmin))
  THEN RAISE EXCEPTION 'IMPORT_PARSED_WRITE_PROOF';END IF;
 IF TG_TABLE_NAME='lead_import_row' THEN
  SELECT * INTO s FROM lead_import_sheet WHERE file_id=NEW.file_id AND sheet_index=NEW.sheet_index;
  IF NEW.row_number<=s.header_row OR jsonb_array_length(NEW.cells)<>jsonb_array_length(s.headers) THEN RAISE EXCEPTION 'IMPORT_ROW_SHAPE';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_sheet_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_sheet FOR EACH ROW EXECUTE FUNCTION lead_import_data_guard();
CREATE TRIGGER lead_import_row_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_row FOR EACH ROW EXECUTE FUNCTION lead_import_data_guard();
CREATE FUNCTION lead_import_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM lead_import_file j WHERE j.id=NEW.file_id AND j.version=NEW.version
  AND j.state=NEW.state AND j.attempt_count=NEW.attempt_count AND j.row_count=NEW.row_count AND j.error_code IS NOT DISTINCT FROM NEW.error_code AND ai_row_inserted_here(j.xmin))
  THEN RAISE EXCEPTION 'IMPORT_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_history_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_file_history FOR EACH ROW EXECUTE FUNCTION lead_import_history_guard();
CREATE FUNCTION lead_import_history_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.version<>OLD.version THEN
  INSERT INTO lead_import_file_history(file_id,version,state,attempt_count,row_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.row_count,NEW.error_code);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_history_record AFTER INSERT OR UPDATE ON lead_import_file FOR EACH ROW EXECUTE FUNCTION lead_import_history_record();
