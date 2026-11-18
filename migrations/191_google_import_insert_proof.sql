-- Read xmin from the actual fresh input row, not its composite PL/pgSQL value. Native190 is immutable.
CREATE OR REPLACE FUNCTION lead_import_data_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s lead_import_sheet;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMPORT_ROWS_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.file_id ELSE OLD.file_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN
  IF j.state NOT IN ('EXPIRED','CANCELLED','REJECTED','REVOKED') THEN RAISE EXCEPTION 'IMPORT_ROWS_RETAINED';END IF;RETURN OLD;
 END IF;
 IF j.input_kind='GOOGLE_SHEETS' THEN
  IF j.state<>'REVIEW' OR j.version<>1 OR NOT EXISTS(SELECT 1 FROM lead_import_file fresh WHERE fresh.id=j.id AND ai_row_inserted_here(fresh.xmin)) THEN RAISE EXCEPTION 'GOOGLE_IMPORT_INPUT_WRITE_PROOF';END IF;
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
