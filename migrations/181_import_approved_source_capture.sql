-- Durable source approval, not Lead intake authority. Raw quarantine may expire independently.
CREATE TABLE lead_import_dataset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid NOT NULL REFERENCES lead_import_file(id),review_id uuid NOT NULL UNIQUE REFERENCES lead_import_review(id),
 request_key uuid NOT NULL,review_version integer NOT NULL CHECK(review_version>0),session_id uuid NOT NULL REFERENCES user_session(id),
 unreviewed_policy text NOT NULL CHECK(unreviewed_policy='KEEP_VALID_UNIQUE'),configuration_hash text NOT NULL CHECK(configuration_hash~'^[a-f0-9]{64}$'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 10000),ready_count integer NOT NULL CHECK(ready_count>=0),skipped_count integer NOT NULL CHECK(skipped_count>=0),invalid_count integer NOT NULL CHECK(invalid_count>=0),
 duplicate_count integer NOT NULL CHECK(duplicate_count BETWEEN 0 AND total),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(file_id,request_key),UNIQUE(id,file_id),CHECK(ready_count+skipped_count+invalid_count=total)
);
ALTER TABLE source_submission ADD COLUMN import_dataset_id uuid REFERENCES lead_import_dataset(id);
ALTER TABLE source_submission ADD COLUMN import_sheet_index integer;
ALTER TABLE source_submission ADD COLUMN import_row_number integer;
ALTER TABLE source_submission ADD CONSTRAINT import_source_identity CHECK(
 (import_dataset_id IS NULL AND import_sheet_index IS NULL AND import_row_number IS NULL) OR
 (import_dataset_id IS NOT NULL AND import_sheet_index BETWEEN 0 AND 9 AND import_row_number BETWEEN 2 AND 1048576 AND import_sheet_index IS NOT NULL AND import_row_number IS NOT NULL));
CREATE UNIQUE INDEX import_source_row ON source_submission(import_dataset_id,import_sheet_index,import_row_number) WHERE import_dataset_id IS NOT NULL;
CREATE TABLE lead_import_dataset_row (
 dataset_id uuid NOT NULL,file_id uuid NOT NULL,sheet_index integer NOT NULL,row_number integer NOT NULL,submission_id uuid NOT NULL UNIQUE REFERENCES source_submission(id),
 mapping_version integer NOT NULL,decision_version integer NOT NULL CHECK(decision_version>=0),
 disposition text NOT NULL CHECK(disposition IN ('READY_FOR_INTAKE','SKIPPED','INVALID')),duplicate boolean NOT NULL,
 contact jsonb,fields jsonb NOT NULL,errors jsonb NOT NULL,
 PRIMARY KEY(dataset_id,sheet_index,row_number),UNIQUE(file_id,sheet_index,row_number),
 FOREIGN KEY(dataset_id,file_id) REFERENCES lead_import_dataset(id,file_id),
 FOREIGN KEY(file_id,sheet_index,mapping_version) REFERENCES lead_import_mapping_revision(file_id,sheet_index,version)
);
ALTER TABLE source_submission ADD CONSTRAINT import_source_capture_row FOREIGN KEY(import_dataset_id,import_sheet_index,import_row_number)
 REFERENCES lead_import_dataset_row(dataset_id,sheet_index,row_number) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION lead_import_review_duplicate(review_arg uuid,sheet_arg integer,row_arg integer) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM lead_import_review_row rw JOIN lead_import_review_row peer ON peer.review_id=rw.review_id
  AND (peer.sheet_index,peer.row_number)<>(rw.sheet_index,rw.row_number)
  AND ((rw.phone_normalized IS NOT NULL AND peer.phone_normalized=rw.phone_normalized) OR (rw.email_normalized IS NOT NULL AND peer.email_normalized=rw.email_normalized))
  WHERE rw.review_id=review_arg AND rw.sheet_index=sheet_arg AND rw.row_number=row_arg)
$$;
CREATE FUNCTION lead_import_review_disposition(review_arg uuid,sheet_arg integer,row_arg integer) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN d.action='SKIP' THEN 'SKIPPED' WHEN NOT rw.valid THEN 'INVALID'
  WHEN d.action='KEEP_AS_NEW_LEAD' OR NOT lead_import_review_duplicate(review_arg,sheet_arg,row_arg) THEN 'READY_FOR_INTAKE' ELSE NULL END
 FROM lead_import_review_row rw LEFT JOIN LATERAL(SELECT action FROM lead_import_review_decision
  WHERE review_id=rw.review_id AND sheet_index=rw.sheet_index AND row_number=rw.row_number ORDER BY version DESC LIMIT 1) d ON true
 WHERE rw.review_id=review_arg AND rw.sheet_index=sheet_arg AND rw.row_number=row_arg
$$;
CREATE FUNCTION lead_import_dataset_current(d lead_import_dataset) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT r.state='READY' AND r.version=d.review_version AND lead_import_review_current(j,r)
  AND r.configuration_hash=d.configuration_hash AND lead_import_authority(j)
  AND EXISTS(SELECT 1 FROM campaign c WHERE c.id=j.campaign_id AND c.status='ACTIVE')
  AND EXISTS(SELECT 1 FROM user_session us WHERE us.id=d.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
 FROM lead_import_review r JOIN lead_import_file j ON j.id=r.file_id WHERE r.id=d.review_id AND j.id=d.file_id
$$;
CREATE FUNCTION lead_import_dataset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_DATASET_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=NEW.file_id FOR UPDATE;
 IF NOT COALESCE(lead_import_dataset_current(NEW),false) OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
  OR NEW.total IS DISTINCT FROM (SELECT total FROM lead_import_review WHERE id=NEW.review_id)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.branch_id=j.branch_id AND a.actor_user_id=j.actor_id
   AND a.target_type='LEAD_IMPORT_DATASET' AND a.target_id=NEW.id::text AND a.action='IMPORT_DATASET_APPROVED' AND ai_row_inserted_here(a.xmin)
   AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text AND a.detail->>'reviewId'=NEW.review_id::text
   AND a.detail->>'reviewVersion'=NEW.review_version::text AND a.detail->>'configurationHash'=NEW.configuration_hash AND a.detail->>'unreviewedPolicy'=NEW.unreviewed_policy)
  THEN RAISE EXCEPTION 'IMPORT_DATASET_APPROVAL_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_dataset_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_dataset FOR EACH ROW EXECUTE FUNCTION lead_import_dataset_guard();
CREATE FUNCTION lead_import_source_payload(dataset_arg uuid,sheet_arg integer,row_arg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('schema',1,'kind',CASE WHEN f.format='CSV' THEN 'CSV_IMPORT' ELSE 'EXCEL_IMPORT' END,
  'file',jsonb_build_object('id',f.id,'sha256',f.content_sha256,'label',f.label,'format',f.format,'delimiter',f.delimiter),
  'sheet',jsonb_build_object('index',s.sheet_index,'name',s.name,'headers',s.headers,'headerRow',s.header_row),
  'row',jsonb_build_object('number',raw.row_number,'cells',raw.cells),'mapping',jsonb_build_object('version',m.version,'entries',m.entries),'reviewId',r.id)
 FROM lead_import_dataset d JOIN lead_import_file f ON f.id=d.file_id JOIN lead_import_review r ON r.id=d.review_id
 JOIN lead_import_row raw ON raw.file_id=f.id AND raw.sheet_index=sheet_arg AND raw.row_number=row_arg
 JOIN lead_import_sheet s ON s.file_id=raw.file_id AND s.sheet_index=raw.sheet_index
 JOIN jsonb_array_elements(r.selection) selected ON (selected->>'sheet')::integer=s.sheet_index
 JOIN lead_import_mapping_revision m ON m.file_id=f.id AND m.sheet_index=s.sheet_index AND m.version=(selected->>'version')::integer WHERE d.id=dataset_arg
$$;
CREATE FUNCTION lead_import_source_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d lead_import_dataset;j lead_import_file;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_RETAINED';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE';END IF;
 IF NEW.import_dataset_id IS NULL AND NEW.source_kind NOT IN ('IMPORT_CSV','IMPORT_EXCEL') THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR NEW.import_dataset_id IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;
 SELECT ds.* INTO d FROM lead_import_dataset ds WHERE ds.id=NEW.import_dataset_id AND ai_row_inserted_here(ds.xmin);
 SELECT * INTO j FROM lead_import_file WHERE id=d.file_id;
 IF d.id IS NULL OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (j.organization_id,j.branch_id,j.campaign_id)
  OR NEW.source_kind IS DISTINCT FROM (CASE WHEN j.format='CSV' THEN 'IMPORT_CSV' ELSE 'IMPORT_EXCEL' END)
  OR NEW.state<>'RECEIVED' OR NEW.lead_id IS NOT NULL OR NEW.resolution_contact_id IS NOT NULL OR NEW.failure_code IS NOT NULL
  OR NEW.connection_id IS NOT NULL OR NEW.external_event_id IS NOT NULL OR NEW.source_timestamp IS NOT NULL
  OR NEW.raw_payload IS DISTINCT FROM lead_import_source_payload(d.id,NEW.import_sheet_index,NEW.import_row_number)
  OR NEW.raw_payload IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_source_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON source_submission FOR EACH ROW EXECUTE FUNCTION lead_import_source_capture_guard();
CREATE FUNCTION lead_import_dataset_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d lead_import_dataset;r lead_import_review;rw lead_import_review_row;s source_submission;mv integer;dv integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_DATASET_ROW_IMMUTABLE';END IF;
 SELECT ds.* INTO d FROM lead_import_dataset ds WHERE ds.id=NEW.dataset_id AND ai_row_inserted_here(ds.xmin);
 SELECT * INTO r FROM lead_import_review WHERE id=d.review_id;
 SELECT * INTO rw FROM lead_import_review_row WHERE review_id=r.id AND sheet_index=NEW.sheet_index AND row_number=NEW.row_number;
 SELECT src.* INTO s FROM source_submission src WHERE src.id=NEW.submission_id AND ai_row_inserted_here(src.xmin);
 SELECT (x->>'version')::integer INTO mv FROM jsonb_array_elements(r.selection) x WHERE (x->>'sheet')::integer=NEW.sheet_index;
 SELECT COALESCE(max(version),0) INTO dv FROM lead_import_review_decision WHERE review_id=r.id AND sheet_index=NEW.sheet_index AND row_number=NEW.row_number;
 IF d.id IS NULL OR rw.review_id IS NULL OR s.id IS NULL OR NEW.file_id<>d.file_id OR NEW.mapping_version IS DISTINCT FROM mv OR NEW.decision_version IS DISTINCT FROM dv
  OR (s.import_dataset_id,s.import_sheet_index,s.import_row_number) IS DISTINCT FROM (NEW.dataset_id,NEW.sheet_index,NEW.row_number)
  OR NEW.disposition IS DISTINCT FROM lead_import_review_disposition(r.id,NEW.sheet_index,NEW.row_number)
  OR NEW.duplicate IS DISTINCT FROM lead_import_review_duplicate(r.id,NEW.sheet_index,NEW.row_number)
  OR (NEW.contact,NEW.fields,NEW.errors) IS DISTINCT FROM (rw.contact,rw.fields,rw.errors)
  THEN RAISE EXCEPTION 'IMPORT_DATASET_ROW_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_dataset_row_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_dataset_row FOR EACH ROW EXECUTE FUNCTION lead_import_dataset_row_guard();
CREATE FUNCTION lead_import_dataset_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;ready integer;skipped integer;invalid integer;dups integer;
BEGIN
 SELECT count(*)::integer,count(*) FILTER(WHERE disposition='READY_FOR_INTAKE')::integer,count(*) FILTER(WHERE disposition='SKIPPED')::integer,
  count(*) FILTER(WHERE disposition='INVALID')::integer,count(*) FILTER(WHERE duplicate)::integer INTO n,ready,skipped,invalid,dups FROM lead_import_dataset_row WHERE dataset_id=NEW.id;
 IF NOT COALESCE(lead_import_dataset_current(NEW),false) OR (n,ready,skipped,invalid,dups) IS DISTINCT FROM (NEW.total,NEW.ready_count,NEW.skipped_count,NEW.invalid_count,NEW.duplicate_count)
  OR n<>(SELECT count(*) FROM source_submission WHERE import_dataset_id=NEW.id) THEN RAISE EXCEPTION 'IMPORT_DATASET_COMPLETE_CAPTURE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lead_import_dataset_complete AFTER INSERT ON lead_import_dataset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lead_import_dataset_complete();
