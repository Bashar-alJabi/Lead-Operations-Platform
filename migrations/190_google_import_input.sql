-- The historical lead_import_file identifier now stores a typed import input.
-- Google inputs have genuine capture provenance and no invented binary/scanner metadata.
ALTER TABLE lead_import_file ADD COLUMN input_kind text NOT NULL DEFAULT 'FILE' CHECK(input_kind IN ('FILE','GOOGLE_SHEETS')),
 ADD COLUMN google_capture_id uuid UNIQUE REFERENCES google_capture_job(id),ADD COLUMN google_capture_version integer,
 ADD COLUMN google_manifest jsonb,ADD COLUMN input_reason text;
ALTER TABLE lead_import_file ADD CONSTRAINT google_import_capture_history FOREIGN KEY(google_capture_id,google_capture_version) REFERENCES google_capture_history(job_id,version);
ALTER TABLE lead_import_file ALTER COLUMN format DROP NOT NULL,ALTER COLUMN delimiter DROP NOT NULL,
 ALTER COLUMN content_sha256 DROP NOT NULL,ALTER COLUMN size_bytes DROP NOT NULL,ALTER COLUMN storage_key DROP NOT NULL,ALTER COLUMN storage_backend DROP NOT NULL;
DO $$ DECLARE c record;n integer=0;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='lead_import_file'::regclass AND contype='c' AND position('scanner_version' in pg_get_constraintdef(oid))>0 LOOP
  n=n+1;EXECUTE format('ALTER TABLE lead_import_file DROP CONSTRAINT %I',c.conname);
 END LOOP;IF n<>1 THEN RAISE EXCEPTION 'IMPORT_INPUT_CONSTRAINT_EXPECTATION';END IF;
END $$;
ALTER TABLE lead_import_file ADD CONSTRAINT import_input_shape CHECK(
 (input_kind='FILE' AND format IS NOT NULL AND delimiter IS NOT NULL AND content_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND storage_key IS NOT NULL AND storage_backend IS NOT NULL
  AND google_capture_id IS NULL AND google_capture_version IS NULL AND google_manifest IS NULL AND input_reason IS NULL
  AND (state<>'REVIEW' OR scanner_version IS NOT NULL AND scanned_at IS NOT NULL AND row_count>0)) OR
 (input_kind='GOOGLE_SHEETS' AND format IS NULL AND delimiter IS NULL AND content_sha256 IS NULL AND size_bytes IS NULL AND storage_key IS NULL AND storage_backend IS NULL
  AND scanner_version IS NULL AND scanned_at IS NULL AND google_capture_id IS NOT NULL AND google_capture_version>0 AND google_capture_version IS NOT NULL
  AND google_manifest IS NOT NULL AND jsonb_typeof(google_manifest)='object' AND octet_length(google_manifest::text)<=2097152
  AND input_reason IS NOT NULL AND length(trim(input_reason)) BETWEEN 3 AND 500 AND input_reason!~'[[:cntrl:]]'
  AND state IN ('REVIEW','REVOKED','CANCELLED','EXPIRED') AND row_count>0 AND attempt_count=0));
CREATE FUNCTION lead_import_source_kind(j lead_import_file) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN j.input_kind='GOOGLE_SHEETS' THEN 'IMPORT_GOOGLE_SHEETS' WHEN j.format='CSV' THEN 'IMPORT_CSV' ELSE 'IMPORT_EXCEL' END
$$;
CREATE FUNCTION google_import_headers(capture_arg uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_agg(COALESCE(NULLIF(btrim(v#>>'{}'),''),'Column '||ordinality::text) ORDER BY ordinality)
 FROM google_capture_job g JOIN google_capture_row r ON r.job_id=g.id AND r.row_number=g.start_row CROSS JOIN LATERAL jsonb_array_elements(r.cells) WITH ORDINALITY e(v,ordinality) WHERE g.id=capture_arg
$$;
CREATE FUNCTION google_import_manifest(capture_arg uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('captureId',g.id,'captureVersion',g.version,'resourceId',g.resource_id,'resourceVersion',g.resource_version,
  'connectionId',g.connection_id,'connectionVersion',g.connection_version,'accessVersion',g.access_version,'spreadsheetId',g.spreadsheet_id,
  'sheetId',g.sheet_id,'requestedSheetTitle',g.sheet_title,'row',g.start_row,'column',g.start_column,'rows',g.row_count,'columns',g.column_count,
  'verifiedMetadata',g.verified_metadata,'requestedAt',g.created_at,'finishedAt',h.created_at,'headerCells',r.cells)
 FROM google_capture_job g JOIN google_capture_history h ON h.job_id=g.id AND h.version=g.version AND h.state='READY'
 JOIN google_capture_row r ON r.job_id=g.id AND r.row_number=g.start_row WHERE g.id=capture_arg
$$;
CREATE FUNCTION google_import_source_current(j lead_import_file) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE g google_capture_job;cid uuid;
BEGIN
 IF j.input_kind='FILE' THEN RETURN true;END IF;
 SELECT connection_id INTO cid FROM google_capture_job WHERE id=j.google_capture_id;
 PERFORM id FROM integration_connection WHERE id=cid FOR SHARE;
 SELECT * INTO g FROM google_capture_job WHERE id=j.google_capture_id;
 RETURN g.id IS NOT NULL AND g.state='READY' AND g.version=j.google_capture_version AND g.expires_at>clock_timestamp()
  AND (g.organization_id,g.branch_id,g.campaign_id,g.actor_id,g.actor_role,g.actor_branch_id) IS NOT DISTINCT FROM (j.organization_id,j.branch_id,j.campaign_id,j.actor_id,j.actor_role,j.branch_scope)
  AND google_capture_allowed(g);
END $$;
DROP TRIGGER lead_import_file_guard ON lead_import_file;
CREATE TRIGGER lead_import_file_guard BEFORE INSERT OR UPDATE ON lead_import_file FOR EACH ROW WHEN(NEW.input_kind='FILE') EXECUTE FUNCTION lead_import_file_guard();
CREATE TRIGGER lead_import_delete_guard BEFORE DELETE ON lead_import_file FOR EACH ROW EXECUTE FUNCTION lead_import_file_guard();
CREATE FUNCTION guard_google_import_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g google_capture_job;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'REVIEW' OR NEW.version<>1 OR NEW.lease_token IS NOT NULL OR NEW.purged_at IS NOT NULL OR NEW.error_code IS NOT NULL
   OR NOT lead_import_authority(NEW) OR NOT google_import_source_current(NEW::lead_import_file)
   OR NOT lead_import_fresh_audit(NEW,'IMPORT_GOOGLE_INPUT_CAPTURED',true)
   OR NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=NEW.uploaded_session_id AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
   THEN RAISE EXCEPTION 'GOOGLE_IMPORT_CURRENT_APPROVAL_REQUIRED';END IF;
  SELECT * INTO g FROM google_capture_job WHERE id=NEW.google_capture_id;
  IF NEW.label<>g.label OR NEW.row_count<>g.row_count-1 OR NEW.expires_at<>g.expires_at OR NEW.google_manifest IS DISTINCT FROM google_import_manifest(g.id)
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_type='LEAD_IMPORT_FILE' AND a.target_id=NEW.id::text AND a.action='IMPORT_GOOGLE_INPUT_CAPTURED'
    AND a.actor_user_id=NEW.actor_id AND ai_row_inserted_here(a.xmin) AND a.detail->>'sessionId'=NEW.uploaded_session_id::text AND a.detail->>'requestId'=NEW.request_key::text
    AND a.detail->>'captureId'=g.id::text AND a.detail->>'captureVersion'=g.version::text AND a.detail->>'reason'=NEW.input_reason)
   THEN RAISE EXCEPTION 'GOOGLE_IMPORT_CAPTURE_PROOF';END IF;
  NEW.created_at=clock_timestamp();
 ELSE
  IF OLD.input_kind<>'GOOGLE_SHEETS' THEN RAISE EXCEPTION 'IMPORT_INPUT_KIND_IMMUTABLE';END IF;
  IF NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
   IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL OR OLD.state NOT IN ('EXPIRED','CANCELLED','REVOKED') OR (to_jsonb(NEW)-'purged_at') IS DISTINCT FROM (to_jsonb(OLD)-'purged_at')
    OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_PURGED',false) THEN RAISE EXCEPTION 'IMPORT_PURGE_PROOF';END IF;RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 OR OLD.state IN ('CANCELLED','EXPIRED') OR NEW.state NOT IN ('CANCELLED','EXPIRED','REVOKED')
   OR (to_jsonb(NEW)-ARRAY['state','version','error_code','updated_at','next_run_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','error_code','updated_at','next_run_at'])
   OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_STATE',false) OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_type='LEAD_IMPORT_FILE' AND a.target_id=NEW.id::text
    AND a.action='IMPORT_FILE_STATE' AND ai_row_inserted_here(a.xmin) AND a.detail->>'version'=NEW.version::text AND a.detail->>'state'=NEW.state)
   THEN RAISE EXCEPTION 'GOOGLE_IMPORT_INPUT_IMMUTABLE';END IF;
  IF NEW.state='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_NOT_EXPIRED';END IF;
  IF NEW.state='CANCELLED' AND (NOT lead_import_authority(NEW) OR NOT lead_import_fresh_audit(NEW,'IMPORT_FILE_CANCELLED',true)) THEN RAISE EXCEPTION 'IMPORT_CANCEL_SESSION';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER google_import_input_guard BEFORE INSERT OR UPDATE ON lead_import_file FOR EACH ROW WHEN(NEW.input_kind='GOOGLE_SHEETS') EXECUTE FUNCTION guard_google_import_input();
CREATE FUNCTION require_google_import_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT google_import_source_current(NEW::lead_import_file)
  OR (SELECT count(*) FROM lead_import_sheet WHERE file_id=NEW.id)<>1 OR (SELECT count(*) FROM lead_import_row WHERE file_id=NEW.id)<>NEW.row_count
  THEN RAISE EXCEPTION 'GOOGLE_IMPORT_COMPLETE_INPUT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_import_complete_input AFTER INSERT ON lead_import_file DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.input_kind='GOOGLE_SHEETS') EXECUTE FUNCTION require_google_import_input();
ALTER TABLE lead_import_dataset DROP CONSTRAINT lead_import_dataset_source_schema_check;
ALTER TABLE lead_import_dataset ADD CONSTRAINT lead_import_dataset_source_schema_check CHECK(source_schema IN (1,2,3));
CREATE OR REPLACE FUNCTION lead_import_dataset_schema_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_schema IS DISTINCT FROM (SELECT CASE WHEN input_kind='GOOGLE_SHEETS' THEN 3 ELSE 2 END FROM lead_import_file WHERE id=NEW.file_id) THEN RAISE EXCEPTION 'IMPORT_DATASET_SCHEMA_REQUIRED';END IF;RETURN NEW;
END $$;

-- Forward extensions of the verified shared Import contracts.
CREATE OR REPLACE FUNCTION lead_import_cells_valid(v jsonb,headers boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(v)<>'array' THEN false ELSE jsonb_array_length(v) BETWEEN 1 AND 64
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE (jsonb_typeof(x)<>'string' AND (headers OR x<>'null'::jsonb))
   OR length(x#>>'{}')>CASE WHEN headers THEN 256 ELSE 20000 END) END
$$;
CREATE OR REPLACE FUNCTION lead_import_data_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s lead_import_sheet;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMPORT_ROWS_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.file_id ELSE OLD.file_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN
  IF j.state NOT IN ('EXPIRED','CANCELLED','REJECTED','REVOKED') THEN RAISE EXCEPTION 'IMPORT_ROWS_RETAINED';END IF;RETURN OLD;
 END IF;
 IF j.input_kind='GOOGLE_SHEETS' THEN
  IF j.state<>'REVIEW' OR j.version<>1 OR NOT ai_row_inserted_here(j.xmin) THEN RAISE EXCEPTION 'GOOGLE_IMPORT_INPUT_WRITE_PROOF';END IF;
  IF TG_TABLE_NAME='lead_import_sheet' THEN
   IF NEW.sheet_index<>0 OR NEW.header_row<>1 OR NEW.row_count<>j.row_count OR NEW.name IS DISTINCT FROM j.google_manifest->'verifiedMetadata'->>'sheetTitle'
    OR NEW.headers IS DISTINCT FROM google_import_headers(j.google_capture_id) THEN RAISE EXCEPTION 'GOOGLE_IMPORT_SHEET_PROOF';END IF;
  ELSE
   IF NEW.sheet_index<>0 OR NEW.row_number<2 OR NEW.row_number>j.row_count+1 OR NOT EXISTS(SELECT 1 FROM google_capture_row cr
    WHERE cr.job_id=j.google_capture_id AND cr.row_number=(j.google_manifest->>'row')::integer+NEW.row_number-1 AND cr.cells=NEW.cells)
    THEN RAISE EXCEPTION 'GOOGLE_IMPORT_ROW_PROOF';END IF;
  END IF;RETURN NEW;
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
CREATE OR REPLACE FUNCTION lead_import_mapping_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s lead_import_sheet;e jsonb;kind text;column_index integer;field_id uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_MAPPING_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=NEW.file_id FOR UPDATE;
 IF j.id IS NULL OR j.state<>'REVIEW' OR j.expires_at<=clock_timestamp() OR j.purged_at IS NOT NULL OR NOT lead_import_authority(j)
  OR NOT google_import_source_current(j) OR NEW.configuration_hash IS DISTINCT FROM lead_import_mapping_config(j)
  OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
  OR NEW.version<>COALESCE((SELECT max(version)+1 FROM lead_import_mapping_revision WHERE file_id=j.id AND sheet_index=NEW.sheet_index),1)
  OR NOT EXISTS(SELECT 1 FROM user_session us WHERE us.id=NEW.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.branch_id=j.branch_id
   AND a.target_type='LEAD_IMPORT_FILE' AND a.target_id=j.id::text AND a.action='IMPORT_MAPPING_SAVED' AND a.actor_user_id=j.actor_id
   AND ai_row_inserted_here(a.xmin) AND a.detail->>'version'=NEW.version::text AND a.detail->>'sheet'=NEW.sheet_index::text
   AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text AND a.detail->>'configurationHash'=NEW.configuration_hash)
  THEN RAISE EXCEPTION 'IMPORT_MAPPING_CURRENT_PROOF';END IF;
 SELECT * INTO s FROM lead_import_sheet WHERE file_id=j.id AND sheet_index=NEW.sheet_index;
 IF s.file_id IS NULL THEN RAISE EXCEPTION 'IMPORT_MAPPING_SHEET';END IF;
 IF (SELECT count(DISTINCT x->>'column') FROM jsonb_array_elements(NEW.entries) x)<>jsonb_array_length(NEW.entries)
  OR (SELECT count(DISTINCT CASE WHEN x->>'kind'='LEAD_FIELD' THEN 'FIELD:'||(x->>'fieldId') ELSE x->>'kind' END)
      FROM jsonb_array_elements(NEW.entries) x)<>jsonb_array_length(NEW.entries) THEN RAISE EXCEPTION 'IMPORT_MAPPING_DUPLICATE';END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(NEW.entries) LOOP
  IF jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'column')<>'number' OR (e->>'column')!~'^[0-9]+$'
   OR jsonb_typeof(e->'kind')<>'string' OR e->>'kind' NOT IN ('CONTACT_NAME','CONTACT_PHONE','CONTACT_EMAIL','LEAD_FIELD')
   OR NOT(e ? 'column' AND e ? 'kind') OR (e-ARRAY['column','kind','fieldId'])<>'{}'::jsonb
   THEN RAISE EXCEPTION 'IMPORT_MAPPING_ENTRY';END IF;
  column_index=(e->>'column')::integer;kind=e->>'kind';
  IF column_index<0 OR column_index>=jsonb_array_length(s.headers) THEN RAISE EXCEPTION 'IMPORT_MAPPING_COLUMN';END IF;
  IF kind='LEAD_FIELD' THEN
   IF jsonb_typeof(e->'fieldId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;field_id=(e->>'fieldId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id
    WHERE cf.campaign_id=j.campaign_id AND fd.id=field_id AND fd.organization_id=j.organization_id
     AND (fd.branch_id IS NULL OR fd.branch_id=j.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=j.campaign_id)
     AND fd.active AND cf.active AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
     AND (j.actor_role='SUPER_ADMIN' OR cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))
    THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;
  ELSIF e ? 'fieldId' THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION lead_import_review_current(j lead_import_file,r lead_import_review) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT j.state='REVIEW' AND j.expires_at>clock_timestamp() AND j.purged_at IS NULL AND lead_import_authority(j) AND google_import_source_current(j)
  AND r.configuration_hash=lead_import_mapping_config(j)
  AND NOT EXISTS(SELECT 1 FROM lead_import_review newer WHERE newer.file_id=j.id AND newer.revision>r.revision)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.selection) s WHERE NOT EXISTS(
   SELECT 1 FROM lead_import_mapping_revision m JOIN lead_import_sheet sh ON sh.file_id=m.file_id AND sh.sheet_index=m.sheet_index
    WHERE m.file_id=j.id AND m.sheet_index=(s->>'sheet')::integer AND m.version=(s->>'version')::integer
     AND m.configuration_hash=r.configuration_hash AND NOT EXISTS(SELECT 1 FROM lead_import_mapping_revision n
      WHERE n.file_id=m.file_id AND n.sheet_index=m.sheet_index AND n.version>m.version)))
$$;
CREATE OR REPLACE FUNCTION lead_import_dataset_current(d lead_import_dataset) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT r.state='READY' AND r.version=d.review_version AND lead_import_review_current(j,r)
  AND r.configuration_hash=d.configuration_hash AND lead_import_authority(j)
  AND EXISTS(SELECT 1 FROM campaign c WHERE c.id=j.campaign_id AND c.status='ACTIVE')
  AND EXISTS(SELECT 1 FROM user_session us WHERE us.id=d.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
 FROM lead_import_review r JOIN lead_import_file j ON j.id=r.file_id WHERE r.id=d.review_id AND j.id=d.file_id
$$;
CREATE OR REPLACE FUNCTION lead_import_effect_allowed(subid uuid,lid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM lead_import_attempt a JOIN lead_import_dataset_row dr ON dr.submission_id=a.submission_id
  JOIN lead_import_file f ON f.id=dr.file_id JOIN lead_intake_birth bi ON bi.lead_id=a.lead_id JOIN lead l ON l.id=bi.lead_id
  WHERE a.submission_id=subid AND a.lead_id=lid AND ai_row_inserted_here(a.xmin) AND ai_row_inserted_here(bi.xmin)
   AND lead_import_execution_allowed(dr.dataset_id) AND a.configuration_hash=lead_import_mapping_config(f)
   AND (bi.organization_id,bi.branch_id,bi.campaign_id,bi.contact_id,bi.source_kind) IS NOT DISTINCT FROM
    (f.organization_id,f.branch_id,f.campaign_id,a.contact_id,lead_import_source_kind(f))
   AND (l.organization_id,l.branch_id,l.campaign_id,l.contact_id,l.source_kind) IS NOT DISTINCT FROM
    (bi.organization_id,bi.branch_id,bi.campaign_id,bi.contact_id,bi.source_kind))
$$;
CREATE OR REPLACE FUNCTION lead_import_source_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d lead_import_dataset;j lead_import_file;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_RETAINED';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.import_dataset_id IS NOT NULL THEN
  IF OLD.state<>'RECEIVED' OR NEW.state<>'PROCESSED' OR NEW.failure_code IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['state','lead_id','resolution_contact_id','failure_code']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','lead_id','resolution_contact_id','failure_code'])
   OR NOT COALESCE(lead_import_effect_allowed(OLD.id,NEW.lead_id),false)
   OR NEW.resolution_contact_id IS DISTINCT FROM (SELECT contact_id FROM lead WHERE id=NEW.lead_id)
   THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE';END IF;RETURN NEW;
 END IF;
 IF NEW.import_dataset_id IS NULL AND NEW.source_kind NOT IN ('IMPORT_CSV','IMPORT_EXCEL','IMPORT_GOOGLE_SHEETS') THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR NEW.import_dataset_id IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;
 SELECT ds.* INTO d FROM lead_import_dataset ds WHERE ds.id=NEW.import_dataset_id AND ai_row_inserted_here(ds.xmin);
 SELECT * INTO j FROM lead_import_file WHERE id=d.file_id;
 IF d.id IS NULL OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (j.organization_id,j.branch_id,j.campaign_id)
  OR NEW.source_kind IS DISTINCT FROM lead_import_source_kind(j)
  OR NEW.state<>'RECEIVED' OR NEW.lead_id IS NOT NULL OR NEW.resolution_contact_id IS NOT NULL OR NEW.failure_code IS NOT NULL
  OR NEW.connection_id IS NOT NULL OR NEW.external_event_id IS NOT NULL OR NEW.source_timestamp IS NOT NULL
  OR NEW.raw_payload IS DISTINCT FROM lead_import_source_payload(d.id,NEW.import_sheet_index,NEW.import_row_number)
  OR NEW.raw_payload IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION lead_import_source_payload(dataset_arg uuid,sheet_arg integer,row_arg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN d.source_schema=1 THEN lead_import_source_payload_v1(dataset_arg,sheet_arg,row_arg) WHEN d.source_schema=3 THEN
 jsonb_build_object('schema',3,'kind','GOOGLE_SHEETS_IMPORT','datasetId',d.id,'inputId',f.id,'captureId',f.google_capture_id,'captureVersion',f.google_capture_version,
  'sheetId',(f.google_manifest->>'sheetId')::integer,'sheetIndex',sh.sheet_index,'inputRow',raw.row_number,
  'row',jsonb_build_object('number',(f.google_manifest->>'row')::integer+raw.row_number-1,'column',(f.google_manifest->>'column')::integer,'cells',raw.cells),
  'mappingVersion',sh.mapping_version,'reviewId',d.review_id) ELSE
 jsonb_build_object('schema',2,'kind',CASE WHEN f.format='CSV' THEN 'CSV_IMPORT' ELSE 'EXCEL_IMPORT' END,
 'datasetId',d.id,'fileId',f.id,'sheetIndex',sh.sheet_index,'row',jsonb_build_object('number',raw.row_number,'cells',raw.cells),
 'mappingVersion',sh.mapping_version,'reviewId',d.review_id) END
 FROM lead_import_dataset d JOIN lead_import_file f ON f.id=d.file_id
 JOIN lead_import_dataset_sheet sh ON sh.dataset_id=d.id AND sh.sheet_index=sheet_arg
 JOIN lead_import_row raw ON raw.file_id=f.id AND raw.sheet_index=sh.sheet_index AND raw.row_number=row_arg WHERE d.id=dataset_arg
$$;
