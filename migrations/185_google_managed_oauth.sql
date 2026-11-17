-- Managed Google authorization is separate from platform authentication and file/job approval.
CREATE TABLE google_connection_revision (
 connection_id uuid NOT NULL REFERENCES integration_connection(id),version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 actor_role text NOT NULL,actor_branch_id uuid,name text NOT NULL,status text NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),secret_changed boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(connection_id,version)
);
CREATE TABLE google_oauth_operation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('AUTHORIZE','CHECK')),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 actor_role text NOT NULL,actor_branch_id uuid,previous_operation_id uuid REFERENCES google_oauth_operation(id),
 state text NOT NULL CHECK(state IN ('WAITING','RUNNING','VERIFIED','FAILED','UNKNOWN','SUPERSEDED','EXPIRED','DENIED')),
 state_hash bytea UNIQUE,verifier jsonb,result jsonb,subject_hash bytea,scopes text[] NOT NULL DEFAULT '{}',access_expires_at timestamptz,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^GOOGLE_[A-Z_]{1,80}$'),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,finished_at timestamptz,
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((kind='AUTHORIZE')=(state_hash IS NOT NULL)),CHECK((kind='AUTHORIZE')=(verifier IS NOT NULL)),
 CHECK(state_hash IS NULL OR octet_length(state_hash)=32),CHECK(subject_hash IS NULL OR octet_length(subject_hash)=32),
 CHECK((kind='CHECK')=(previous_operation_id IS NOT NULL)),CHECK((state IN ('WAITING','RUNNING'))=(finished_at IS NULL)),
 CHECK(state<>'VERIFIED' OR (result IS NOT NULL AND subject_hash IS NOT NULL AND access_expires_at IS NOT NULL
  AND scopes @> ARRAY['openid','https://www.googleapis.com/auth/drive.file']::text[] AND error_code IS NULL)),
 CHECK(verifier IS NULL OR (jsonb_typeof(verifier)='object' AND octet_length(verifier::text)<4096)),
 CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<131072))
);
CREATE UNIQUE INDEX google_operation_active_idx ON google_oauth_operation(connection_id) WHERE state IN ('WAITING','RUNNING');
CREATE INDEX google_operation_history_idx ON google_oauth_operation(connection_id,created_at DESC,id DESC);
CREATE TABLE google_connection_subject (
 connection_id uuid PRIMARY KEY REFERENCES integration_connection(id),subject_hash bytea NOT NULL CHECK(octet_length(subject_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE google_operation_history (
 operation_id uuid NOT NULL REFERENCES google_oauth_operation(id),version integer NOT NULL,connection_id uuid NOT NULL REFERENCES integration_connection(id),
 kind text NOT NULL,state text NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(operation_id,version)
);
CREATE INDEX google_operation_event_idx ON google_operation_history(connection_id,created_at DESC,operation_id DESC,version DESC);

CREATE FUNCTION google_current_access(cid uuid,uid uuid,sid uuid,expected_role text,expected_branch uuid) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM c.id FROM integration_connection c JOIN user_account u ON u.id=uid JOIN user_session s ON s.id=sid AND s.user_id=u.id
 WHERE c.id=cid AND c.kind='GOOGLE' AND c.organization_id=u.organization_id AND u.active AND u.role=expected_role
 AND u.branch_id IS NOT DISTINCT FROM expected_branch AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF c,u,s;
 RETURN FOUND;
END $$;
CREATE FUNCTION guard_google_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GOOGLE_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 IF NOT google_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id)
 OR (NEW.version,NEW.name,NEW.status) IS DISTINCT FROM (c.version,c.name,c.status)
 OR (NEW.version=1 AND c.created_by IS DISTINCT FROM NEW.actor_id) THEN RAISE EXCEPTION 'GOOGLE_CURRENT_ACCESS_REQUIRED'; END IF;
 NEW.recorded_xid=pg_current_xact_id();NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER google_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON google_connection_revision FOR EACH ROW EXECUTE FUNCTION guard_google_revision();
CREATE FUNCTION record_google_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(c.organization_id,c.branch_id,NEW.actor_id,'GOOGLE_CONNECTION_CONFIGURED','GOOGLE_CONNECTION',c.id,
 jsonb_build_object('version',NEW.version,'status',NEW.status,'reason',NEW.reason,'secretChanged',NEW.secret_changed));RETURN NEW;
END $$;
CREATE TRIGGER google_revision_record AFTER INSERT ON google_connection_revision FOR EACH ROW EXECUTE FUNCTION record_google_revision();

CREATE FUNCTION guard_google_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.result IS NOT NULL OR NEW.subject_hash IS NOT NULL OR cardinality(NEW.scopes)<>0 OR NEW.error_code IS NOT NULL
   OR NEW.access_expires_at IS NOT NULL OR (NEW.kind='AUTHORIZE' AND NEW.state<>'WAITING') OR (NEW.kind='CHECK' AND NEW.state<>'RUNNING')
   THEN RAISE EXCEPTION 'GOOGLE_CLAIM_REQUIRED'; END IF;
  NEW.created_at=clock_timestamp();NEW.expires_at=clock_timestamp()+CASE WHEN NEW.kind='AUTHORIZE' THEN interval '10 minutes' ELSE interval '60 seconds' END;
  IF NEW.kind='CHECK' AND NOT EXISTS(SELECT 1 FROM google_oauth_operation p WHERE p.id=NEW.previous_operation_id AND p.connection_id=c.id
   AND p.connection_version=c.version AND p.state='VERIFIED' AND c.status='CONNECTED' AND c.capabilities->>'grantId'=p.id::text)
   THEN RAISE EXCEPTION 'GOOGLE_CURRENT_GRANT_REQUIRED'; END IF;
 ELSE
  IF OLD.state NOT IN ('WAITING','RUNNING') OR NEW.version<>OLD.version+1 OR
   (NEW.id,NEW.connection_id,NEW.connection_version,NEW.kind,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id,NEW.previous_operation_id,NEW.state_hash,NEW.verifier,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.kind,OLD.actor_id,OLD.session_id,OLD.actor_role,OLD.actor_branch_id,OLD.previous_operation_id,OLD.state_hash,OLD.verifier,OLD.created_at,OLD.expires_at)
   OR (OLD.state='WAITING' AND NEW.state NOT IN ('RUNNING','EXPIRED','DENIED','SUPERSEDED'))
   OR (OLD.state='RUNNING' AND NEW.state NOT IN ('VERIFIED','FAILED','UNKNOWN','SUPERSEDED')) THEN RAISE EXCEPTION 'GOOGLE_OPERATION_TRANSITION_INVALID'; END IF;
  IF OLD.state='WAITING' AND (NEW.result IS NOT NULL OR NEW.subject_hash IS NOT NULL OR cardinality(NEW.scopes)<>0 OR NEW.access_expires_at IS NOT NULL)
   THEN RAISE EXCEPTION 'GOOGLE_CLAIM_REQUIRED'; END IF;
  IF NEW.state='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_NOT_EXPIRED'; END IF;
  IF NEW.state='RUNNING' THEN NEW.expires_at=clock_timestamp()+interval '60 seconds'; END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.state IN ('RUNNING','VERIFIED') THEN
  IF c.kind<>'GOOGLE' OR c.version<>NEW.connection_version OR c.status='DISABLED'
   OR NOT google_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id)
   OR NEW.expires_at<=clock_timestamp() OR (TG_OP='UPDATE' AND OLD.expires_at<=clock_timestamp())
   THEN RAISE EXCEPTION 'GOOGLE_CURRENT_ACCESS_REQUIRED'; END IF;
  IF c.branch_id IS NOT NULL THEN PERFORM id FROM branch WHERE id=c.branch_id AND active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'GOOGLE_BRANCH_DISABLED'; END IF; END IF;
 END IF;
 IF NEW.state='VERIFIED' AND EXISTS(SELECT 1 FROM google_connection_subject s WHERE s.connection_id=c.id AND s.subject_hash<>NEW.subject_hash)
  THEN RAISE EXCEPTION 'GOOGLE_ACCOUNT_MISMATCH'; END IF;
 NEW.finished_at=CASE WHEN NEW.state IN ('WAITING','RUNNING') THEN NULL ELSE clock_timestamp() END;
 NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON google_oauth_operation FOR EACH ROW EXECUTE FUNCTION guard_google_operation();
CREATE FUNCTION guard_google_subject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_oauth_operation o WHERE o.connection_id=NEW.connection_id AND o.state='VERIFIED'
  AND o.subject_hash=NEW.subject_hash AND o.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_ACCOUNT_IDENTITY_IMMUTABLE'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_subject_guard BEFORE INSERT OR UPDATE OR DELETE ON google_connection_subject FOR EACH ROW EXECUTE FUNCTION guard_google_subject();
CREATE FUNCTION guard_google_operation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_oauth_operation o WHERE (o.id,o.version,o.connection_id,o.kind,o.state,o.error_code)
  IS NOT DISTINCT FROM (NEW.operation_id,NEW.version,NEW.connection_id,NEW.kind,NEW.state,NEW.error_code) AND o.recorded_xid=pg_current_xact_id())
  THEN RAISE EXCEPTION 'GOOGLE_HISTORY_IMMUTABLE'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_operation_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_operation_history FOR EACH ROW EXECUTE FUNCTION guard_google_operation_history();
CREATE FUNCTION record_google_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 IF NEW.state='VERIFIED' THEN INSERT INTO google_connection_subject(connection_id,subject_hash) VALUES(NEW.connection_id,NEW.subject_hash) ON CONFLICT(connection_id) DO NOTHING;END IF;
 INSERT INTO google_operation_history(operation_id,version,connection_id,kind,state,error_code) VALUES(NEW.id,NEW.version,c.id,NEW.kind,NEW.state,NEW.error_code);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(c.organization_id,c.branch_id,NEW.actor_id,'GOOGLE_AUTHORIZATION_STATE','GOOGLE_CONNECTION',c.id,
  jsonb_build_object('operationId',NEW.id,'kind',NEW.kind,'state',NEW.state,'version',NEW.connection_version,'errorCode',NEW.error_code));RETURN NEW;
END $$;
CREATE TRIGGER google_operation_record AFTER INSERT OR UPDATE ON google_oauth_operation FOR EACH ROW EXECUTE FUNCTION record_google_operation();

CREATE FUNCTION guard_google_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_HISTORY_RETAINED'; END IF;
 IF NEW.provider<>'GOOGLE_SHEETS' OR NEW.kind<>'GOOGLE' OR NEW.config IS NULL OR NEW.config- 'clientId'<>'{}'::jsonb
  OR COALESCE(NEW.config->>'clientId','') !~ '^[A-Za-z0-9._-]{1,220}\.apps\.googleusercontent\.com$' THEN RAISE EXCEPTION 'GOOGLE_CLIENT_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.status<>'NOT_CONFIGURED' OR NEW.capabilities<>'{}'::jsonb THEN RAISE EXCEPTION 'GOOGLE_CONFIGURATION_REQUIRED'; END IF;
 ELSE
  IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.kind,NEW.provider,NEW.created_by,NEW.created_at,NEW.config)
   IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.kind,OLD.provider,OLD.created_by,OLD.created_at,OLD.config)
   OR NEW.version NOT IN (OLD.version,OLD.version+1) OR (NEW.name<>OLD.name AND NEW.version<>OLD.version+1)
   THEN RAISE EXCEPTION 'GOOGLE_CONNECTION_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.version=OLD.version+1 THEN
   IF NEW.status NOT IN ('NOT_CONFIGURED','DISABLED') OR NEW.capabilities<>'{}'::jsonb OR NEW.last_error_code IS NOT NULL THEN RAISE EXCEPTION 'GOOGLE_CONFIGURATION_REQUIRED'; END IF;
  ELSIF (NEW.status,NEW.capabilities,NEW.last_success_at,NEW.last_failure_at,NEW.last_error_code)
   IS DISTINCT FROM (OLD.status,OLD.capabilities,OLD.last_success_at,OLD.last_failure_at,OLD.last_error_code) THEN
   IF NOT EXISTS(SELECT 1 FROM google_oauth_operation o WHERE o.connection_id=NEW.id AND o.connection_version=NEW.version AND o.recorded_xid=pg_current_xact_id()
    AND ((o.state='VERIFIED' AND NEW.status='CONNECTED' AND NEW.last_error_code IS NULL AND NEW.capabilities=jsonb_build_object('grantId',o.id))
      OR (o.state IN ('FAILED','UNKNOWN','DENIED') AND NEW.status IN ('ERROR','AUTH_EXPIRED') AND NEW.capabilities='{}'::jsonb AND NEW.last_error_code=o.error_code)))
    THEN RAISE EXCEPTION 'GOOGLE_CURRENT_OUTCOME_REQUIRED'; END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_google_connection_insert BEFORE INSERT ON integration_connection FOR EACH ROW WHEN(NEW.kind='GOOGLE') EXECUTE FUNCTION guard_google_connection();
CREATE TRIGGER zz_google_connection_update BEFORE UPDATE ON integration_connection FOR EACH ROW WHEN(OLD.kind='GOOGLE' OR NEW.kind='GOOGLE') EXECUTE FUNCTION guard_google_connection();
CREATE TRIGGER zz_google_connection_delete BEFORE DELETE ON integration_connection FOR EACH ROW WHEN(OLD.kind='GOOGLE') EXECUTE FUNCTION guard_google_connection();
CREATE FUNCTION require_google_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.id;
 IF NOT EXISTS(SELECT 1 FROM google_connection_revision r WHERE r.connection_id=c.id AND r.version=c.version AND r.name=c.name AND r.recorded_xid=pg_current_xact_id())
  OR NOT EXISTS(SELECT 1 FROM connection_secret s WHERE s.connection_id=c.id) THEN RAISE EXCEPTION 'GOOGLE_CONFIGURATION_RECEIPT_REQUIRED'; END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_configuration_insert AFTER INSERT ON integration_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.kind='GOOGLE') EXECUTE FUNCTION require_google_configuration();
CREATE CONSTRAINT TRIGGER google_configuration_update AFTER UPDATE ON integration_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.kind='GOOGLE' AND NEW.version IS DISTINCT FROM OLD.version) EXECUTE FUNCTION require_google_configuration();
CREATE FUNCTION require_google_secret_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;
BEGIN
 cid=CASE WHEN TG_OP='DELETE' THEN OLD.connection_id ELSE NEW.connection_id END;
 IF EXISTS(SELECT 1 FROM integration_connection WHERE id=cid AND kind='GOOGLE') THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_HISTORY_RETAINED'; END IF;
  IF octet_length(NEW.ciphertext)<1 OR octet_length(NEW.nonce)<>12 OR octet_length(NEW.auth_tag)<>16 OR NEW.key_version<>1 OR NOT EXISTS(
   SELECT 1 FROM google_connection_revision r JOIN integration_connection c ON c.id=r.connection_id AND c.version=r.version
   WHERE r.connection_id=cid AND r.secret_changed AND r.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_CREDENTIAL_REVISION_REQUIRED'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_secret_revision_required AFTER INSERT OR UPDATE OR DELETE ON connection_secret DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_google_secret_revision();
