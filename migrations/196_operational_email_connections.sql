-- Operational provider accounts are separate from the identity-email binding.
CREATE TABLE operational_email_connection(connection_id uuid PRIMARY KEY REFERENCES integration_connection(id));
CREATE TABLE email_connection_revision(
 connection_id uuid NOT NULL REFERENCES operational_email_connection(connection_id),version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 name text NOT NULL,status text NOT NULL,settings jsonb NOT NULL,secret_changed boolean NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(connection_id,version));
CREATE TABLE email_connection_probe(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES operational_email_connection(connection_id),connection_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','FAILED','SUPERSEDED')),
 error_code text CHECK(error_code IS NULL OR error_code IN ('EMAIL_VERIFICATION_FAILED','EMAIL_CONTEXT_CHANGED','EMAIL_PROBE_EXPIRED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '60 seconds'),finished_at timestamptz,
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),CHECK((state='RUNNING')=(finished_at IS NULL)),CHECK(state<>'VERIFIED' OR error_code IS NULL));
CREATE UNIQUE INDEX email_connection_active_probe_idx ON email_connection_probe(connection_id) WHERE state='RUNNING';
CREATE INDEX email_connection_probe_history_idx ON email_connection_probe(connection_id,created_at DESC,id DESC);
CREATE FUNCTION email_current_access(cid uuid,uid uuid,sid uuid,expected_role text,expected_branch uuid,require_active boolean DEFAULT true) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT c0.* INTO c FROM integration_connection c0 JOIN operational_email_connection o ON o.connection_id=c0.id WHERE c0.id=cid FOR SHARE OF c0;
 IF c.id IS NULL OR c.kind<>'EMAIL' OR c.provider<>'SMTP' OR expected_role NOT IN ('SUPER_ADMIN','MANAGER') OR expected_role='MANAGER' AND c.branch_id IS DISTINCT FROM expected_branch THEN RETURN false;END IF;
 IF c.branch_id IS NOT NULL THEN PERFORM id FROM branch WHERE id=c.branch_id AND organization_id=c.organization_id AND (NOT require_active OR active) FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;END IF;
 PERFORM u.id FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=uid AND u.organization_id=c.organization_id AND u.active AND u.role=expected_role AND u.branch_id IS NOT DISTINCT FROM expected_branch
  AND s.id=sid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;RETURN FOUND;
END $$;
CREATE FUNCTION guard_operational_email_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM integration_connection c WHERE c.id=NEW.connection_id AND c.kind='EMAIL' AND c.provider='SMTP' AND c.status='NOT_CONFIGURED'
  AND c.version=1 AND ai_row_inserted_here(c.xmin) AND NOT EXISTS(SELECT 1 FROM identity_email_connection i WHERE i.connection_id=c.id)) THEN RAISE EXCEPTION 'EMAIL_DISTINCT_ACCOUNT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER operational_email_marker_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_email_connection FOR EACH ROW EXECUTE FUNCTION guard_operational_email_marker();
CREATE FUNCTION guard_email_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;s connection_secret;previous email_connection_revision;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_HISTORY_IMMUTABLE';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;SELECT * INTO s FROM connection_secret WHERE connection_id=c.id;
 SELECT * INTO previous FROM email_connection_revision WHERE connection_id=c.id ORDER BY version DESC LIMIT 1;
 IF NOT email_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id,c.status<>'DISABLED') OR c.status NOT IN ('NOT_CONFIGURED','DISABLED') OR s.connection_id IS NULL
  OR (NEW.version,NEW.name,NEW.status,NEW.settings) IS DISTINCT FROM(c.version,c.name,c.status,c.config) OR NEW.version<>COALESCE(previous.version,0)+1
  OR previous.connection_id IS NULL AND c.created_by IS DISTINCT FROM NEW.actor_id
  OR NEW.secret_changed IS DISTINCT FROM ai_row_inserted_here(s.xmin) THEN RAISE EXCEPTION 'EMAIL_CURRENT_CONFIGURATION_REQUIRED';END IF;
 IF length(trim(c.name)) NOT BETWEEN 1 AND 100 OR jsonb_typeof(c.config)<>'object' OR NOT(c.config?&ARRAY['host','port','secure','username','fromAddress']) OR c.config-ARRAY['host','port','secure','username','fromAddress']<>'{}'::jsonb
  OR jsonb_typeof(c.config->'host')<>'string' OR c.config->>'host'!~'^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$'
  OR jsonb_typeof(c.config->'port')<>'number' OR (c.config->>'port')!~'^[0-9]+$' OR (c.config->>'port')::numeric NOT BETWEEN 1 AND 65535
  OR jsonb_typeof(c.config->'secure')<>'boolean' OR jsonb_typeof(c.config->'username')<>'string' OR length(c.config->>'username') NOT BETWEEN 1 AND 320
  OR (c.config->>'username')~'[\x00-\x1f\x7f]' OR jsonb_typeof(c.config->'fromAddress')<>'string' OR length(c.config->>'fromAddress')>320
  OR c.config->>'fromAddress'!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'EMAIL_SETTINGS_INVALID';END IF;
 NEW.created_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER email_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON email_connection_revision FOR EACH ROW EXECUTE FUNCTION guard_email_revision();
CREATE FUNCTION record_email_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;BEGIN SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(c.organization_id,c.branch_id,NEW.actor_id,'EMAIL_CONNECTION_CONFIGURED','EMAIL_CONNECTION',c.id,
  jsonb_build_object('version',NEW.version,'status',NEW.status,'reason',NEW.reason,'secretChanged',NEW.secret_changed));RETURN NEW;END $$;
CREATE TRIGGER email_revision_record AFTER INSERT ON email_connection_revision FOR EACH ROW EXECUTE FUNCTION record_email_revision();
CREATE FUNCTION guard_email_probe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_HISTORY_IMMUTABLE';END IF;SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'RUNNING' OR NEW.error_code IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.connection_version<>c.version OR c.status='DISABLED'
   OR NOT email_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id) THEN RAISE EXCEPTION 'EMAIL_CURRENT_PROBE_REQUIRED';END IF;
  NEW.created_at=clock_timestamp();NEW.expires_at=NEW.created_at+interval '60 seconds';
 ELSE
  IF OLD.state<>'RUNNING' OR NEW.state NOT IN ('VERIFIED','FAILED','SUPERSEDED') OR (to_jsonb(NEW)-ARRAY['state','error_code','finished_at','recorded_xid']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','error_code','finished_at','recorded_xid']) THEN RAISE EXCEPTION 'EMAIL_PROBE_IMMUTABLE';END IF;
  IF NEW.state<>'SUPERSEDED' AND (NEW.expires_at<=clock_timestamp() OR c.status='DISABLED' OR c.version<>NEW.connection_version OR NOT email_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id)) THEN RAISE EXCEPTION 'EMAIL_PROBE_CONTEXT_CHANGED';END IF;
  IF NEW.state='FAILED' AND NEW.error_code IS DISTINCT FROM 'EMAIL_VERIFICATION_FAILED' OR NEW.state='SUPERSEDED' AND COALESCE(NEW.error_code,'') NOT IN ('EMAIL_CONTEXT_CHANGED','EMAIL_PROBE_EXPIRED') THEN RAISE EXCEPTION 'EMAIL_PROBE_ERROR_REQUIRED';END IF;
  NEW.finished_at=clock_timestamp();
 END IF;NEW.recorded_xid=pg_current_xact_id();RETURN NEW;END $$;
CREATE TRIGGER email_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON email_connection_probe FOR EACH ROW EXECUTE FUNCTION guard_email_probe();
CREATE FUNCTION record_email_probe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;BEGIN SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(c.organization_id,c.branch_id,NEW.actor_id,'EMAIL_CONNECTION_PROBE','EMAIL_CONNECTION',c.id,
  jsonb_build_object('probeId',NEW.id,'connectionVersion',NEW.connection_version,'state',NEW.state,'errorCode',NEW.error_code));RETURN NEW;END $$;
CREATE TRIGGER email_probe_record AFTER INSERT OR UPDATE ON email_connection_probe FOR EACH ROW EXECUTE FUNCTION record_email_probe();
CREATE FUNCTION guard_operational_email_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome email_connection_probe;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM operational_email_connection WHERE connection_id=OLD.id) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF TG_OP='DELETE' OR (NEW.id,NEW.organization_id,NEW.branch_id,NEW.kind,NEW.provider,NEW.created_by,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.organization_id,OLD.branch_id,OLD.kind,OLD.provider,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'EMAIL_CONNECTION_IDENTITY_IMMUTABLE';END IF;
 IF NEW.version<>OLD.version THEN
  IF NEW.version<>OLD.version+1 OR NEW.status NOT IN ('NOT_CONFIGURED','DISABLED') OR NEW.capabilities<>'{}'::jsonb OR NEW.last_error_code IS NOT NULL THEN RAISE EXCEPTION 'EMAIL_CONFIGURATION_VERSION_REQUIRED';END IF;
 ELSE
  IF (NEW.name,NEW.config) IS DISTINCT FROM(OLD.name,OLD.config) THEN RAISE EXCEPTION 'EMAIL_CONFIGURATION_VERSION_REQUIRED';END IF;
  SELECT * INTO outcome FROM email_connection_probe WHERE connection_id=NEW.id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF outcome.id IS NULL OR outcome.recorded_xid<>pg_current_xact_id() OR outcome.connection_version<>NEW.version OR outcome.state NOT IN ('VERIFIED','FAILED') OR NEW.capabilities<>'{}'::jsonb
   OR NOT email_current_access(NEW.id,outcome.actor_id,outcome.session_id,outcome.actor_role,outcome.actor_branch_id)
   OR NEW.status<>(CASE WHEN outcome.state='VERIFIED' THEN 'CONNECTED' ELSE 'ERROR' END) OR NEW.last_error_code IS DISTINCT FROM outcome.error_code THEN RAISE EXCEPTION 'EMAIL_CURRENT_OUTCOME_REQUIRED';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER operational_email_connection_guard BEFORE UPDATE OR DELETE ON integration_connection FOR EACH ROW EXECUTE FUNCTION guard_operational_email_connection();
CREATE FUNCTION require_email_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;c integration_connection;BEGIN
 cid=COALESCE((to_jsonb(NEW)->>'connection_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
 IF NOT EXISTS(SELECT 1 FROM operational_email_connection WHERE connection_id=cid) THEN RETURN NEW;END IF;
 SELECT * INTO c FROM integration_connection WHERE id=cid;
 IF NOT EXISTS(SELECT 1 FROM email_connection_revision r WHERE r.connection_id=cid AND r.version=c.version AND r.name=c.name AND r.settings=c.config AND r.recorded_xid=pg_current_xact_id()) OR NOT EXISTS(SELECT 1 FROM connection_secret s WHERE s.connection_id=cid) THEN RAISE EXCEPTION 'EMAIL_CONFIGURATION_RECEIPT_REQUIRED';END IF;RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER email_configuration_insert AFTER INSERT ON integration_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_email_configuration();
CREATE CONSTRAINT TRIGGER email_configuration_update AFTER UPDATE ON integration_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.version IS DISTINCT FROM OLD.version) EXECUTE FUNCTION require_email_configuration();
CREATE CONSTRAINT TRIGGER email_marker_configuration AFTER INSERT ON operational_email_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_email_configuration();
CREATE FUNCTION require_email_secret_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;BEGIN cid=CASE WHEN TG_OP='DELETE' THEN OLD.connection_id ELSE NEW.connection_id END;
 IF EXISTS(SELECT 1 FROM operational_email_connection WHERE connection_id=cid) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_HISTORY_RETAINED';END IF;
  IF octet_length(NEW.ciphertext)<1 OR octet_length(NEW.nonce)<>12 OR octet_length(NEW.auth_tag)<>16 OR NEW.key_version<>1 OR NOT EXISTS(SELECT 1 FROM email_connection_revision r JOIN integration_connection c ON c.id=r.connection_id AND c.version=r.version WHERE r.connection_id=cid AND r.secret_changed AND r.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'EMAIL_CREDENTIAL_REVISION_REQUIRED';END IF;
 END IF;RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER email_secret_revision_required AFTER INSERT OR UPDATE OR DELETE ON connection_secret DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_email_secret_revision();
