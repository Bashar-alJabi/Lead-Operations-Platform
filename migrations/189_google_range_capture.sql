-- Private, approved read jobs. Historical approval sessions never authenticate a worker.
CREATE TABLE google_capture_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 resource_id uuid NOT NULL REFERENCES google_resource(id),connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL,resource_version integer NOT NULL,access_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER')),actor_branch_id uuid,
 approval_session_id uuid NOT NULL REFERENCES user_session(id),request_id uuid NOT NULL,label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200 AND label!~'[[:cntrl:]]'),
 sheet_id integer NOT NULL CHECK(sheet_id>=0),sheet_title text NOT NULL,spreadsheet_id text NOT NULL,
 start_row integer NOT NULL CHECK(start_row>=1),start_column integer NOT NULL CHECK(start_column BETWEEN 1 AND 18278),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),column_count integer NOT NULL CHECK(column_count BETWEEN 1 AND 64),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','RUNNING','READY','NEEDS_ATTENTION','DEAD_LETTER','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1,failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),captured_rows integer NOT NULL DEFAULT 0,payload_bytes integer NOT NULL DEFAULT 0 CHECK(payload_bytes BETWEEN 0 AND 8388608),
 lease_token uuid,lease_until timestamptz,active_grant_id uuid REFERENCES google_oauth_operation(id),next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text CHECK(error_code IS NULL OR error_code~'^GOOGLE_[A-Z_]{1,80}$'),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 verified_metadata jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),CHECK(start_row::bigint+row_count-1<=2147483647),CHECK(start_column+column_count-1<=18278),CHECK(captured_rows BETWEEN 0 AND row_count),
 CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),CHECK(state<>'READY' OR captured_rows=row_count),
 CHECK(verified_metadata IS NULL OR jsonb_typeof(verified_metadata)='object' AND octet_length(verified_metadata::text)<=8192)
);
CREATE INDEX google_capture_work_idx ON google_capture_job(next_run_at,id) WHERE state IN ('WAITING','RUNNING');
CREATE INDEX google_capture_actor_idx ON google_capture_job(actor_id,created_at DESC,id DESC);
CREATE INDEX google_capture_expiry_idx ON google_capture_job(expires_at,id) WHERE state NOT IN ('CANCELLED','EXPIRED');
CREATE TABLE google_capture_row (
 job_id uuid NOT NULL REFERENCES google_capture_job(id),row_number integer NOT NULL,cells jsonb NOT NULL,page_version integer NOT NULL,lease_token uuid NOT NULL,
 payload_bytes integer GENERATED ALWAYS AS (octet_length(cells::text)) STORED,recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(job_id,row_number)
);
CREATE INDEX google_capture_page_idx ON google_capture_row(job_id,page_version);
CREATE TABLE google_capture_history (
 job_id uuid NOT NULL REFERENCES google_capture_job(id),version integer NOT NULL,state text NOT NULL,captured_rows integer NOT NULL,payload_bytes integer NOT NULL,failures integer NOT NULL,
 active_grant_id uuid,approval_session_id uuid NOT NULL,access_version integer NOT NULL,error_code text,reason text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(job_id,version)
);
CREATE FUNCTION google_capture_allowed(j google_capture_job,session_required boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM u.id FROM user_account u JOIN branch b ON b.id=j.branch_id JOIN campaign ca ON ca.id=j.campaign_id JOIN integration_connection c ON c.id=j.connection_id JOIN google_resource r ON r.id=j.resource_id
 WHERE u.id=j.actor_id AND u.active AND u.organization_id=j.organization_id AND u.role=j.actor_role AND u.branch_id IS NOT DISTINCT FROM j.actor_branch_id
 AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) AND b.active AND b.organization_id=u.organization_id AND ca.branch_id=b.id AND ca.organization_id=u.organization_id
 AND r.connection_id=c.id AND r.version=j.resource_version AND c.version=j.connection_version AND r.spreadsheet_id=j.spreadsheet_id AND google_resource_available(r.id,j.organization_id,b.id)
 AND j.access_version=CASE WHEN c.branch_id IS NULL THEN (SELECT version FROM google_resource_access WHERE resource_id=r.id AND branch_id=b.id AND active) ELSE 0 END
 AND (NOT session_required OR EXISTS(SELECT 1 FROM user_session s WHERE s.id=j.approval_session_id AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()))
 FOR SHARE OF u,b,ca,r;
 RETURN FOUND;
END $$;
CREATE FUNCTION guard_google_capture_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;n integer;first_row integer;last_row integer;bytes integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_HISTORY_RETAINED';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.failures<>0 OR NEW.captured_rows<>0 OR NEW.payload_bytes<>0 OR NEW.verified_metadata IS NOT NULL OR NEW.active_grant_id IS NOT NULL
   OR NOT google_capture_allowed(NEW::google_capture_job,true) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_APPROVAL_REQUIRED';END IF;
  IF NEW.expires_at<clock_timestamp()+interval '4 seconds' OR NEW.expires_at>clock_timestamp()+interval '24 hours' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_RETENTION_INVALID';END IF;
  IF NOT EXISTS(SELECT 1 FROM google_resource r CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'sheets') s WHERE r.id=NEW.resource_id
    AND (s->>'id')::integer=NEW.sheet_id AND s->>'kind'='GRID' AND s->>'title'=NEW.sheet_title
    AND (s->>'rows')::bigint>=NEW.start_row::bigint+NEW.row_count-1 AND (s->>'columns')::integer>=NEW.start_column+NEW.column_count-1)
   THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_GRID_INVALID';END IF;
  NEW.created_at=clock_timestamp();
 ELSE
  IF NEW.version<>OLD.version+1 OR (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.resource_id,NEW.connection_id,NEW.connection_version,NEW.resource_version,NEW.actor_id,NEW.actor_role,NEW.actor_branch_id,NEW.request_id,NEW.label,NEW.sheet_id,NEW.sheet_title,NEW.spreadsheet_id,NEW.start_row,NEW.start_column,NEW.row_count,NEW.column_count,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.resource_id,OLD.connection_id,OLD.connection_version,OLD.resource_version,OLD.actor_id,OLD.actor_role,OLD.actor_branch_id,OLD.request_id,OLD.label,OLD.sheet_id,OLD.sheet_title,OLD.spreadsheet_id,OLD.start_row,OLD.start_column,OLD.row_count,OLD.column_count,OLD.created_at,OLD.expires_at)
   OR OLD.state IN ('CANCELLED','EXPIRED') OR NEW.captured_rows<OLD.captured_rows OR NEW.payload_bytes<OLD.payload_bytes THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_IDENTITY_IMMUTABLE';END IF;
  IF (NEW.approval_session_id,NEW.access_version) IS DISTINCT FROM (OLD.approval_session_id,OLD.access_version)
   OR OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER') AND NEW.state='WAITING' THEN
   IF NEW.state<>'WAITING' OR NOT google_capture_allowed(NEW::google_capture_job,true) OR NEW.failures<>0 THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_RECOVERY_APPROVAL_REQUIRED';END IF;
  END IF;
  IF NEW.state='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_NOT_EXPIRED';END IF;
  IF NEW.state='RUNNING' THEN
   IF OLD.state NOT IN ('WAITING','RUNNING') OR OLD.state='RUNNING' AND OLD.lease_until>clock_timestamp()
    OR NOT google_capture_allowed(NEW::google_capture_job) OR NEW.expires_at<=clock_timestamp() OR NEW.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId'
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_CURRENT_CLAIM_REQUIRED';END IF;
   IF NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '61 seconds' OR NEW.lease_token IS NULL THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_LEASE_INVALID';END IF;
  ELSIF NEW.state NOT IN ('CANCELLED','EXPIRED','NEEDS_ATTENTION') AND OLD.state<>'RUNNING' AND NOT(OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER') AND NEW.state='WAITING') THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_TRANSITION_INVALID';END IF;
  IF NEW.verified_metadata IS DISTINCT FROM OLD.verified_metadata AND (OLD.verified_metadata IS NOT NULL OR OLD.state<>'RUNNING' OR NOT google_capture_allowed(NEW::google_capture_job)) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_METADATA_IMMUTABLE';END IF;
  IF NEW.captured_rows>OLD.captured_rows THEN
   IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.state NOT IN ('WAITING','READY')
    OR NOT google_capture_allowed(NEW::google_capture_job) OR OLD.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId' OR NEW.verified_metadata IS NULL
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_CURRENT_PAGE_REQUIRED';END IF;
   SELECT count(*),min(row_number),max(row_number),COALESCE(sum(payload_bytes),0) INTO n,first_row,last_row,bytes FROM google_capture_row
    WHERE job_id=NEW.id AND page_version=NEW.version AND recorded_xid=pg_current_xact_id() AND lease_token=OLD.lease_token;
   IF n<>NEW.captured_rows-OLD.captured_rows OR first_row<>NEW.start_row+OLD.captured_rows OR last_row<>NEW.start_row+NEW.captured_rows-1 OR NEW.payload_bytes<>OLD.payload_bytes+bytes
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_COMPLETE_PAGE_REQUIRED';END IF;
  ELSIF NEW.payload_bytes<>OLD.payload_bytes THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_COMPLETE_PAGE_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_capture_job_guard BEFORE INSERT OR UPDATE OR DELETE ON google_capture_job FOR EACH ROW EXECUTE FUNCTION guard_google_capture_job();
CREATE FUNCTION guard_google_capture_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j google_capture_job;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_ROWS_IMMUTABLE';END IF;
 SELECT * INTO j FROM google_capture_job WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.job_id ELSE NEW.job_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN IF j.state NOT IN ('CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_ROWS_RETAINED';END IF;RETURN OLD;END IF;
 IF j.state<>'RUNNING' OR j.lease_until<=clock_timestamp() OR j.expires_at<=clock_timestamp() OR NEW.page_version<>j.version+1 OR NEW.lease_token<>j.lease_token
  OR NEW.row_number<j.start_row+j.captured_rows OR NEW.row_number>=j.start_row+LEAST(j.row_count,j.captured_rows+1000) OR NOT google_capture_allowed(j)
  OR jsonb_typeof(NEW.cells)<>'array' OR jsonb_array_length(NEW.cells)<>j.column_count OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.cells) v WHERE v<>'null'::jsonb AND (jsonb_typeof(v)<>'string' OR length(v#>>'{}')>20000 OR v#>>'{}'~'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'))
  THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_ROW_PROOF_REQUIRED';END IF;
 NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_capture_row_guard BEFORE INSERT OR UPDATE OR DELETE ON google_capture_row FOR EACH ROW EXECUTE FUNCTION guard_google_capture_row();
CREATE FUNCTION guard_google_capture_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_capture_job j WHERE (j.id,j.version,j.state,j.captured_rows,j.payload_bytes,j.failures,j.active_grant_id,j.approval_session_id,j.access_version,j.error_code,j.reason,j.updated_at)
  IS NOT DISTINCT FROM (NEW.job_id,NEW.version,NEW.state,NEW.captured_rows,NEW.payload_bytes,NEW.failures,NEW.active_grant_id,NEW.approval_session_id,NEW.access_version,NEW.error_code,NEW.reason,NEW.created_at)
  AND j.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_capture_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_capture_history FOR EACH ROW EXECUTE FUNCTION guard_google_capture_history();
CREATE FUNCTION record_google_capture_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO google_capture_history(job_id,version,state,captured_rows,payload_bytes,failures,active_grant_id,approval_session_id,access_version,error_code,reason,created_at)
 VALUES(NEW.id,NEW.version,NEW.state,NEW.captured_rows,NEW.payload_bytes,NEW.failures,NEW.active_grant_id,NEW.approval_session_id,NEW.access_version,NEW.error_code,NEW.reason,NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'GOOGLE_CAPTURE_STATE','GOOGLE_CAPTURE',NEW.id,
  jsonb_build_object('version',NEW.version,'state',NEW.state,'capturedRows',NEW.captured_rows,'failures',NEW.failures,'errorCode',NEW.error_code));RETURN NEW;
END $$;
CREATE TRIGGER google_capture_job_record AFTER INSERT OR UPDATE ON google_capture_job FOR EACH ROW EXECUTE FUNCTION record_google_capture_job();
CREATE FUNCTION require_google_capture_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM google_capture_history h JOIN google_capture_job j ON j.id=h.job_id WHERE h.job_id=NEW.job_id AND h.version=NEW.page_version
   AND h.captured_rows>=NEW.row_number-j.start_row+1) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_COMPLETE_PAGE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_capture_page_complete AFTER INSERT ON google_capture_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_google_capture_page();

ALTER TABLE google_oauth_operation ADD COLUMN capture_id uuid REFERENCES google_capture_job(id),ADD COLUMN capture_lease uuid;
ALTER TABLE google_oauth_operation DROP CONSTRAINT google_oauth_operation_kind_check,DROP CONSTRAINT google_oauth_operation_check2;
ALTER TABLE google_oauth_operation ADD CONSTRAINT google_operation_kind CHECK(kind IN ('AUTHORIZE','CHECK','RUNTIME')),
 ADD CONSTRAINT google_operation_parent CHECK((kind IN ('CHECK','RUNTIME'))=(previous_operation_id IS NOT NULL)),
 ADD CONSTRAINT google_operation_capture CHECK((kind='RUNTIME')=(capture_id IS NOT NULL AND capture_lease IS NOT NULL) AND (kind='RUNTIME' OR capture_id IS NULL AND capture_lease IS NULL));
DROP TRIGGER google_operation_guard ON google_oauth_operation;
CREATE TRIGGER google_operation_interactive_guard BEFORE INSERT OR UPDATE ON google_oauth_operation FOR EACH ROW WHEN(NEW.kind<>'RUNTIME') EXECUTE FUNCTION guard_google_operation();
CREATE TRIGGER google_operation_delete_guard BEFORE DELETE ON google_oauth_operation FOR EACH ROW EXECUTE FUNCTION guard_google_operation();
CREATE FUNCTION guard_google_runtime_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j google_capture_job;c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;SELECT * INTO j FROM google_capture_job WHERE id=NEW.capture_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'RUNNING' OR NEW.version<>1 OR NEW.result IS NOT NULL OR NEW.subject_hash IS NOT NULL OR cardinality(NEW.scopes)<>0 OR NEW.access_expires_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_CLAIM_REQUIRED';END IF;
  NEW.created_at=clock_timestamp();NEW.expires_at=clock_timestamp()+interval '60 seconds';
 ELSE
  IF OLD.kind<>'RUNTIME' OR OLD.state<>'RUNNING' OR NEW.version<>OLD.version+1 OR NEW.state NOT IN ('VERIFIED','FAILED','UNKNOWN','SUPERSEDED')
   OR (NEW.id,NEW.connection_id,NEW.connection_version,NEW.kind,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id,NEW.previous_operation_id,NEW.capture_id,NEW.capture_lease,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.kind,OLD.actor_id,OLD.session_id,OLD.actor_role,OLD.actor_branch_id,OLD.previous_operation_id,OLD.capture_id,OLD.capture_lease,OLD.created_at,OLD.expires_at)
   THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_IDENTITY_IMMUTABLE';END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.state='VERIFIED' THEN
  IF j.id IS NULL OR j.state<>'RUNNING' OR j.lease_token<>NEW.capture_lease OR j.lease_until<=clock_timestamp() OR j.expires_at<=clock_timestamp()
   OR NOT google_capture_allowed(j) OR NEW.expires_at<=clock_timestamp() OR NEW.connection_version<>c.version OR j.connection_id<>c.id
   OR (NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id) IS DISTINCT FROM (j.actor_id,j.approval_session_id,j.actor_role,j.actor_branch_id)
   OR c.capabilities->>'grantId' IS DISTINCT FROM NEW.previous_operation_id::text OR j.active_grant_id<>NEW.previous_operation_id
   OR NOT EXISTS(SELECT 1 FROM google_oauth_operation p WHERE p.id=NEW.previous_operation_id AND p.connection_id=c.id AND p.connection_version=c.version AND p.state='VERIFIED')
   THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_JOB_AUTHORITY_REQUIRED';END IF;
 END IF;
 IF NEW.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM google_connection_subject s WHERE s.connection_id=c.id AND s.subject_hash=NEW.subject_hash) THEN RAISE EXCEPTION 'GOOGLE_ACCOUNT_MISMATCH';END IF;
 NEW.finished_at=CASE WHEN NEW.state='RUNNING' THEN NULL ELSE clock_timestamp() END;NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_operation_runtime_guard BEFORE INSERT OR UPDATE ON google_oauth_operation FOR EACH ROW WHEN(NEW.kind='RUNTIME') EXECUTE FUNCTION guard_google_runtime_operation();
CREATE FUNCTION google_refresh_parent_safe(parent_id uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT NOT EXISTS(SELECT 1 FROM google_oauth_operation WHERE previous_operation_id=parent_id AND state IN ('UNKNOWN','SUPERSEDED'))
$$;
CREATE INDEX google_refresh_parent_outcome_idx ON google_oauth_operation(previous_operation_id,state) WHERE previous_operation_id IS NOT NULL;
CREATE FUNCTION guard_google_refresh_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT google_refresh_parent_safe(NEW.previous_operation_id) THEN RAISE EXCEPTION 'GOOGLE_NEW_AUTHORIZATION_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_refresh_parent_guard BEFORE INSERT ON google_oauth_operation FOR EACH ROW WHEN(NEW.kind IN ('CHECK','RUNTIME')) EXECUTE FUNCTION guard_google_refresh_parent();
