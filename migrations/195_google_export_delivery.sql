-- A private preview is not permission to disclose data. Delivery has a separate real approval.
CREATE TABLE google_export_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL UNIQUE REFERENCES google_export_job(id),actor_id uuid NOT NULL REFERENCES user_account(id),
 approval_session_id uuid NOT NULL REFERENCES user_session(id),request_id uuid NOT NULL,request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 payload_version integer NOT NULL,payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','SENDING','VERIFYING','READING','DONE','UNKNOWN','NEEDS_ATTENTION','DEAD_LETTER','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1,verified_rows integer NOT NULL DEFAULT 0 CHECK(verified_rows BETWEEN 0 AND 10001),
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),error_code text CHECK(error_code IS NULL OR error_code~'^GOOGLE_[A-Z_]{1,80}$'),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),attempt_at timestamptz,lease_token uuid,lease_until timestamptz,active_grant_id uuid REFERENCES google_oauth_operation(id),
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),CHECK((state IN ('SENDING','READING'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state NOT IN ('VERIFYING','READING','DONE','UNKNOWN') OR attempt_at IS NOT NULL),CHECK(verified_rows=0 OR attempt_at IS NOT NULL)
);
CREATE INDEX google_export_delivery_work_idx ON google_export_delivery(next_run_at,id) WHERE state IN ('WAITING','SENDING','VERIFYING','READING');
CREATE INDEX google_export_delivery_actor_idx ON google_export_delivery(actor_id,id DESC);
CREATE TABLE google_export_write_attempt (
 delivery_id uuid PRIMARY KEY REFERENCES google_export_delivery(id),lease_token uuid NOT NULL,grant_id uuid NOT NULL REFERENCES google_oauth_operation(id),
 payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),metadata_sha256 bytea NOT NULL CHECK(octet_length(metadata_sha256)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE google_export_read_receipt (
 delivery_id uuid NOT NULL REFERENCES google_export_delivery(id),start_row integer NOT NULL CHECK(start_row BETWEEN 0 AND 10000),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 1000),
 delivery_version integer NOT NULL,lease_token uuid NOT NULL,grant_id uuid NOT NULL REFERENCES google_oauth_operation(id),cells_sha256 bytea NOT NULL CHECK(octet_length(cells_sha256)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(delivery_id,start_row)
);
CREATE TABLE google_export_delivery_history (
 delivery_id uuid NOT NULL REFERENCES google_export_delivery(id),version integer NOT NULL,state text NOT NULL,verified_rows integer NOT NULL,failures integer NOT NULL,
 attempt_at timestamptz,error_code text,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(delivery_id,version)
);
CREATE FUNCTION google_export_expected_grid(jid uuid,start_at integer,take_rows integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(cells ORDER BY n),'[]'::jsonb) FROM (
  SELECT 0 n,header_cells cells FROM google_export_job WHERE id=jid AND start_at=0
  UNION ALL SELECT row_number,cells FROM google_export_row WHERE job_id=jid AND row_number>=start_at AND row_number<start_at+take_rows
 ) x WHERE n>=start_at AND n<start_at+take_rows
$$;
CREATE FUNCTION google_export_delivery_allowed(d google_export_delivery,session_required boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j google_export_job;p lead_export_job;
BEGIN
 SELECT * INTO j FROM google_export_job WHERE id=d.job_id FOR SHARE;SELECT * INTO p FROM lead_export_job WHERE id=j.source_export_id FOR SHARE;
 IF j.id IS NULL OR j.state<>'READY' OR j.version<>d.payload_version OR j.actor_id<>d.actor_id OR j.expires_at<=clock_timestamp()
  OR NOT google_export_allowed(j) OR NOT lead_export_manifest_visible(p) THEN RETURN false;END IF;
 IF session_required AND NOT EXISTS(SELECT 1 FROM user_session WHERE id=d.approval_session_id AND user_id=d.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION guard_google_export_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j google_export_job;c integration_connection;expected bytea;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_HISTORY_RETAINED';END IF;
 SELECT c0.* INTO c FROM integration_connection c0 JOIN google_export_job j0 ON j0.connection_id=c0.id WHERE j0.id=NEW.job_id FOR UPDATE OF c0;
 SELECT * INTO j FROM google_export_job WHERE id=NEW.job_id FOR SHARE;
 IF TG_OP='INSERT' THEN
  expected=sha256(convert_to(google_export_expected_grid(j.id,0,j.expected_rows+1)::text,'UTF8'));
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.verified_rows<>0 OR NEW.failures<>0 OR NEW.error_code IS NOT NULL OR NEW.attempt_at IS NOT NULL
   OR NEW.active_grant_id IS NOT NULL OR NEW.payload_sha256 IS DISTINCT FROM expected OR NOT google_export_delivery_allowed(NEW,true)
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.actor_user_id=j.actor_id AND a.action='GOOGLE_EXPORT_DELIVERY_APPROVED'
    AND a.target_type='GOOGLE_EXPORT_DELIVERY' AND a.target_id=NEW.id::text AND a.detail->>'preparedId'=j.id::text AND a.detail->>'requestId'=NEW.request_id::text
    AND a.detail->>'sessionId'=NEW.approval_session_id::text AND ai_row_inserted_here(a.xmin)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_APPROVAL_REQUIRED';END IF;
  NEW.created_at=statement_timestamp();
 ELSE
  IF NEW.version<>OLD.version+1 OR OLD.state IN ('DONE','CANCELLED','EXPIRED') OR NEW.verified_rows<OLD.verified_rows
   OR (to_jsonb(NEW)-ARRAY['state','version','verified_rows','failures','error_code','reason','attempt_at','lease_token','lease_until','active_grant_id','next_run_at','updated_at','recorded_xid','approval_session_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','verified_rows','failures','error_code','reason','attempt_at','lease_token','lease_until','active_grant_id','next_run_at','updated_at','recorded_xid','approval_session_id'])
   OR OLD.attempt_at IS NOT NULL AND NEW.attempt_at IS DISTINCT FROM OLD.attempt_at THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_IDENTITY_IMMUTABLE';END IF;
  IF NEW.state='CANCELLED' OR OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER','UNKNOWN') AND NEW.state IN ('WAITING','VERIFYING') THEN
   PERFORM u.id FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=j.actor_id AND u.organization_id=j.organization_id AND u.active AND u.role=j.actor_role
    AND u.branch_id IS NOT DISTINCT FROM j.branch_scope AND s.id=NEW.approval_session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
   IF NOT FOUND OR NEW.failures<>0 OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.actor_user_id=j.actor_id
    AND a.action=CASE WHEN NEW.state='CANCELLED' THEN 'GOOGLE_EXPORT_DELIVERY_CANCELLED' ELSE 'GOOGLE_EXPORT_DELIVERY_RECOVERED' END AND a.target_type='GOOGLE_EXPORT_DELIVERY'
    AND a.target_id=NEW.id::text AND a.detail->>'sessionId'=NEW.approval_session_id::text AND ai_row_inserted_here(a.xmin)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_ACTION_REQUIRED';END IF;
   IF NEW.state='CANCELLED' THEN
    IF OLD.attempt_at IS NOT NULL OR OLD.state IN ('SENDING','READING') AND OLD.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_EXPORT_WRITE_CANNOT_BE_RETRACTED';END IF;
   ELSIF NOT google_export_delivery_allowed(NEW,true) OR NEW.state<>(CASE WHEN OLD.attempt_at IS NULL THEN 'WAITING' ELSE 'VERIFYING' END) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_CURRENT_APPROVAL_REQUIRED';END IF;
  ELSIF NEW.approval_session_id<>OLD.approval_session_id OR NEW.reason<>OLD.reason THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_ACTION_REQUIRED';
  ELSIF NEW.state='EXPIRED' THEN
   IF j.expires_at>clock_timestamp() AND j.state NOT IN ('CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_NOT_EXPIRED';END IF;
  ELSIF NEW.state IN ('SENDING','READING') AND OLD.state IN ('WAITING','VERIFYING') THEN
   IF NEW.state<>(CASE WHEN OLD.state='WAITING' THEN 'SENDING' ELSE 'READING' END) OR NEW.state='SENDING' AND OLD.attempt_at IS NOT NULL
    OR NOT google_export_delivery_allowed(NEW) OR NEW.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId'
    OR NOT EXISTS(SELECT 1 FROM google_oauth_operation g WHERE g.id=NEW.active_grant_id AND g.connection_id=c.id AND g.connection_version=c.version AND g.state='VERIFIED')
    OR NEW.lease_token IS NULL OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '61 seconds' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_CLAIM_REQUIRED';END IF;
  ELSIF NEW.state='SENDING' AND OLD.state='SENDING' AND OLD.attempt_at IS NULL AND NEW.attempt_at IS NOT NULL THEN
   IF OLD.lease_until<=clock_timestamp() OR (NEW.lease_token,NEW.lease_until,NEW.active_grant_id) IS DISTINCT FROM (OLD.lease_token,OLD.lease_until,OLD.active_grant_id)
    OR NOT google_export_delivery_allowed(NEW) OR NEW.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId'
    OR NOT EXISTS(SELECT 1 FROM google_export_write_attempt a WHERE a.delivery_id=NEW.id AND a.created_at=NEW.attempt_at AND a.lease_token=OLD.lease_token
      AND a.grant_id=OLD.active_grant_id AND a.payload_sha256=NEW.payload_sha256 AND a.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DURABLE_ATTEMPT_REQUIRED';END IF;
  ELSE
   IF OLD.state NOT IN ('WAITING','SENDING','VERIFYING','READING') OR NEW.state NOT IN ('WAITING','VERIFYING','DONE','UNKNOWN','NEEDS_ATTENTION','DEAD_LETTER')
    OR NEW.state='UNKNOWN' AND OLD.attempt_at IS NULL OR NEW.state='WAITING' AND OLD.attempt_at IS NOT NULL
    OR NEW.state IN ('VERIFYING','DONE') AND OLD.attempt_at IS NULL OR NEW.state='DEAD_LETTER' AND NEW.failures<>5
    OR NEW.attempt_at IS DISTINCT FROM OLD.attempt_at OR NEW.active_grant_id IS DISTINCT FROM OLD.active_grant_id THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_TRANSITION_INVALID';END IF;
   IF OLD.state IN ('SENDING','READING') AND NEW.state IN ('WAITING','VERIFYING','DONE') AND NOT google_export_delivery_allowed(NEW) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_ACCESS_CHANGED';END IF;
  END IF;
  IF NEW.verified_rows>OLD.verified_rows THEN
   IF OLD.state<>'READING' OR OLD.lease_until<=clock_timestamp() OR NEW.state NOT IN ('VERIFYING','DONE') OR NOT google_export_delivery_allowed(NEW)
    OR NOT EXISTS(SELECT 1 FROM google_export_read_receipt r WHERE r.delivery_id=NEW.id AND r.delivery_version=NEW.version AND r.start_row=OLD.verified_rows
     AND r.start_row+r.row_count=NEW.verified_rows AND r.lease_token=OLD.lease_token AND r.grant_id=OLD.active_grant_id AND r.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_READ_RECEIPT_REQUIRED';END IF;
  END IF;
  IF NEW.state='DONE' AND (OLD.state<>'READING' OR NEW.verified_rows<>j.expected_rows+1 OR NEW.verified_rows=OLD.verified_rows) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_INDEPENDENT_CONFIRMATION_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_export_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_delivery FOR EACH ROW EXECUTE FUNCTION guard_google_export_delivery();
CREATE FUNCTION guard_google_export_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d google_export_delivery;j google_export_job;c integration_connection;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_ATTEMPT_IMMUTABLE';END IF;
 SELECT * INTO d FROM google_export_delivery WHERE id=NEW.delivery_id FOR UPDATE;SELECT * INTO j FROM google_export_job WHERE id=d.job_id;
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 IF d.state<>'SENDING' OR d.attempt_at IS NOT NULL OR d.lease_until<=clock_timestamp() OR NOT google_export_delivery_allowed(d)
  OR (NEW.lease_token,NEW.grant_id,NEW.payload_sha256) IS DISTINCT FROM (d.lease_token,d.active_grant_id,d.payload_sha256)
  OR d.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_ATTEMPT_AUTHORITY_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_export_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_write_attempt FOR EACH ROW EXECUTE FUNCTION guard_google_export_attempt();
CREATE FUNCTION guard_google_export_read() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d google_export_delivery;j google_export_job;c integration_connection;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_READ_IMMUTABLE';END IF;
 SELECT * INTO d FROM google_export_delivery WHERE id=NEW.delivery_id FOR UPDATE;SELECT * INTO j FROM google_export_job WHERE id=d.job_id;
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 IF d.state<>'READING' OR d.lease_until<=clock_timestamp() OR NOT google_export_delivery_allowed(d) OR d.attempt_at IS NULL
  OR NEW.delivery_version<>d.version+1 OR NEW.start_row<>d.verified_rows OR NEW.start_row+NEW.row_count>j.expected_rows+1
  OR (NEW.lease_token,NEW.grant_id) IS DISTINCT FROM (d.lease_token,d.active_grant_id) OR d.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId'
  OR NEW.cells_sha256 IS DISTINCT FROM sha256(convert_to(google_export_expected_grid(j.id,NEW.start_row,NEW.row_count)::text,'UTF8')) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_MATCHING_READ_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_export_read_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_read_receipt FOR EACH ROW EXECUTE FUNCTION guard_google_export_read();
CREATE FUNCTION record_google_export_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j google_export_job;
BEGIN
 SELECT * INTO j FROM google_export_job WHERE id=NEW.job_id;
 INSERT INTO google_export_delivery_history(delivery_id,version,state,verified_rows,failures,attempt_at,error_code,reason)
  VALUES(NEW.id,NEW.version,NEW.state,NEW.verified_rows,NEW.failures,NEW.attempt_at,NEW.error_code,NEW.reason);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(j.organization_id,j.branch_scope,j.actor_id,'GOOGLE_EXPORT_DELIVERY_STATE','GOOGLE_EXPORT_DELIVERY',NEW.id,
  jsonb_build_object('version',NEW.version,'state',NEW.state,'verifiedRows',NEW.verified_rows,'attempted',NEW.attempt_at IS NOT NULL,'errorCode',NEW.error_code));RETURN NEW;
END $$;
CREATE TRIGGER google_export_delivery_record AFTER INSERT OR UPDATE ON google_export_delivery FOR EACH ROW EXECUTE FUNCTION record_google_export_delivery();
CREATE FUNCTION guard_google_export_delivery_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_export_delivery d WHERE d.id=NEW.delivery_id AND d.version=NEW.version AND d.recorded_xid=pg_current_xact_id()
  AND (d.state,d.verified_rows,d.failures,d.attempt_at,d.error_code,d.reason) IS NOT DISTINCT FROM (NEW.state,NEW.verified_rows,NEW.failures,NEW.attempt_at,NEW.error_code,NEW.reason)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DELIVERY_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_export_delivery_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_delivery_history FOR EACH ROW EXECUTE FUNCTION guard_google_export_delivery_history();
CREATE FUNCTION require_google_export_delivery_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='google_export_write_attempt' THEN
  IF NOT EXISTS(SELECT 1 FROM google_export_delivery d WHERE d.id=NEW.delivery_id AND d.attempt_at=NEW.created_at AND d.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_DURABLE_ATTEMPT_REQUIRED';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM google_export_delivery d WHERE d.id=NEW.delivery_id AND d.version=NEW.delivery_version AND d.verified_rows=NEW.start_row+NEW.row_count AND d.recorded_xid=pg_current_xact_id()
   AND d.state IN ('VERIFYING','DONE')) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_READ_RECEIPT_REQUIRED';END IF;
 END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_export_attempt_complete AFTER INSERT ON google_export_write_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_google_export_delivery_proof();
CREATE CONSTRAINT TRIGGER google_export_read_complete AFTER INSERT ON google_export_read_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_google_export_delivery_proof();

-- RUNTIME delegates to exactly one genuine capture or export delivery and its current lease.
ALTER TABLE google_oauth_operation ADD COLUMN export_delivery_id uuid REFERENCES google_export_delivery(id),ADD COLUMN export_lease uuid;
ALTER TABLE google_oauth_operation DROP CONSTRAINT google_operation_capture;
ALTER TABLE google_oauth_operation ADD CONSTRAINT google_operation_runtime_target CHECK(
 (kind<>'RUNTIME' AND capture_id IS NULL AND capture_lease IS NULL AND export_delivery_id IS NULL AND export_lease IS NULL) OR
 (kind='RUNTIME' AND ((capture_id IS NOT NULL AND capture_lease IS NOT NULL AND export_delivery_id IS NULL AND export_lease IS NULL)
  OR (export_delivery_id IS NOT NULL AND export_lease IS NOT NULL AND capture_id IS NULL AND capture_lease IS NULL))));
DROP TRIGGER google_operation_runtime_guard ON google_oauth_operation;
CREATE TRIGGER google_operation_runtime_guard BEFORE INSERT OR UPDATE ON google_oauth_operation FOR EACH ROW WHEN(NEW.kind='RUNTIME' AND NEW.export_delivery_id IS NULL) EXECUTE FUNCTION guard_google_runtime_operation();
CREATE FUNCTION guard_google_export_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d google_export_delivery;j google_export_job;c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;SELECT * INTO d FROM google_export_delivery WHERE id=NEW.export_delivery_id FOR UPDATE;SELECT * INTO j FROM google_export_job WHERE id=d.job_id;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'RUNNING' OR NEW.version<>1 OR NEW.result IS NOT NULL OR NEW.subject_hash IS NOT NULL OR cardinality(NEW.scopes)<>0 OR NEW.access_expires_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_CLAIM_REQUIRED';END IF;
  NEW.created_at=clock_timestamp();NEW.expires_at=clock_timestamp()+interval '60 seconds';
 ELSE
  IF OLD.kind<>'RUNTIME' OR OLD.state<>'RUNNING' OR NEW.version<>OLD.version+1 OR NEW.state NOT IN ('VERIFIED','FAILED','UNKNOWN','SUPERSEDED')
   OR (NEW.id,NEW.connection_id,NEW.connection_version,NEW.kind,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id,NEW.previous_operation_id,NEW.capture_id,NEW.capture_lease,NEW.export_delivery_id,NEW.export_lease,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.kind,OLD.actor_id,OLD.session_id,OLD.actor_role,OLD.actor_branch_id,OLD.previous_operation_id,OLD.capture_id,OLD.capture_lease,OLD.export_delivery_id,OLD.export_lease,OLD.created_at,OLD.expires_at) THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_IDENTITY_IMMUTABLE';END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.state='VERIFIED' THEN
  IF d.id IS NULL OR d.state NOT IN ('SENDING','READING') OR d.lease_token<>NEW.export_lease OR d.lease_until<=clock_timestamp() OR NOT google_export_delivery_allowed(d)
   OR NEW.expires_at<=clock_timestamp() OR NEW.connection_version<>c.version OR j.connection_id<>c.id
   OR (NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id) IS DISTINCT FROM (j.actor_id,d.approval_session_id,j.actor_role,j.branch_scope)
   OR c.capabilities->>'grantId' IS DISTINCT FROM NEW.previous_operation_id::text OR d.active_grant_id<>NEW.previous_operation_id
   OR NOT EXISTS(SELECT 1 FROM google_oauth_operation p WHERE p.id=NEW.previous_operation_id AND p.connection_id=c.id AND p.connection_version=c.version AND p.state='VERIFIED') THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_JOB_AUTHORITY_REQUIRED';END IF;
 END IF;
 IF NEW.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM google_connection_subject s WHERE s.connection_id=c.id AND s.subject_hash=NEW.subject_hash) THEN RAISE EXCEPTION 'GOOGLE_ACCOUNT_MISMATCH';END IF;
 NEW.finished_at=CASE WHEN NEW.state='RUNNING' THEN NULL ELSE clock_timestamp() END;NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_operation_export_runtime_guard BEFORE INSERT OR UPDATE ON google_oauth_operation FOR EACH ROW WHEN(NEW.kind='RUNTIME' AND NEW.export_delivery_id IS NOT NULL) EXECUTE FUNCTION guard_google_export_runtime();
