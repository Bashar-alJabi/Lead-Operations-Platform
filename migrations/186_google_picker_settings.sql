-- Provider prerequisites are configuration, not proof of a working Picker or file authorization.
CREATE TABLE google_picker_settings (
 connection_id uuid PRIMARY KEY REFERENCES integration_connection(id),version integer NOT NULL DEFAULT 1,
 connection_version integer NOT NULL,project_number text NOT NULL CHECK(project_number ~ '^[1-9][0-9]{0,29}$'),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 16 AND 4096),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),key_version integer NOT NULL CHECK(key_version=1),key_revision integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE google_picker_settings_history (
 connection_id uuid NOT NULL REFERENCES integration_connection(id),version integer NOT NULL,connection_version integer NOT NULL,
 project_number text NOT NULL,key_revision integer NOT NULL,secret_changed boolean NOT NULL,actor_id uuid NOT NULL REFERENCES user_account(id),
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(connection_id,version)
);
CREATE FUNCTION guard_google_picker_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;changed boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_PICKER_HISTORY_RETAINED'; END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF c.id IS NULL OR c.version<>NEW.connection_version OR c.status='DISABLED'
  OR NOT google_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id) THEN RAISE EXCEPTION 'GOOGLE_PICKER_CURRENT_ACCESS_REQUIRED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.key_revision<>1 THEN RAISE EXCEPTION 'GOOGLE_PICKER_REVISION_INVALID'; END IF;
  NEW.created_at=clock_timestamp();
 ELSE
  changed=(NEW.ciphertext,NEW.nonce,NEW.auth_tag,NEW.key_version) IS DISTINCT FROM (OLD.ciphertext,OLD.nonce,OLD.auth_tag,OLD.key_version);
  IF (NEW.connection_id,NEW.created_at) IS DISTINCT FROM (OLD.connection_id,OLD.created_at) OR NEW.version<>OLD.version+1
   OR NEW.key_revision<>(CASE WHEN changed THEN NEW.version ELSE OLD.key_revision END) THEN RAISE EXCEPTION 'GOOGLE_PICKER_REVISION_INVALID'; END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER google_picker_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON google_picker_settings FOR EACH ROW EXECUTE FUNCTION guard_google_picker_settings();
CREATE FUNCTION guard_google_picker_settings_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_picker_settings s WHERE
  (s.connection_id,s.version,s.connection_version,s.project_number,s.key_revision,s.actor_id,s.reason,s.updated_at)
  IS NOT DISTINCT FROM (NEW.connection_id,NEW.version,NEW.connection_version,NEW.project_number,NEW.key_revision,NEW.actor_id,NEW.reason,NEW.created_at))
  THEN RAISE EXCEPTION 'GOOGLE_PICKER_HISTORY_IMMUTABLE'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_picker_settings_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_picker_settings_history FOR EACH ROW EXECUTE FUNCTION guard_google_picker_settings_history();
CREATE FUNCTION record_google_picker_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;changed boolean;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 changed=TG_OP='INSERT' OR (NEW.ciphertext,NEW.nonce,NEW.auth_tag,NEW.key_version) IS DISTINCT FROM (OLD.ciphertext,OLD.nonce,OLD.auth_tag,OLD.key_version);
 INSERT INTO google_picker_settings_history(connection_id,version,connection_version,project_number,key_revision,secret_changed,actor_id,reason,created_at)
 VALUES(NEW.connection_id,NEW.version,NEW.connection_version,NEW.project_number,NEW.key_revision,changed,NEW.actor_id,NEW.reason,NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(c.organization_id,c.branch_id,NEW.actor_id,'GOOGLE_PICKER_CONFIGURED','GOOGLE_CONNECTION',c.id,
  jsonb_build_object('version',NEW.version,'connectionVersion',NEW.connection_version,'projectNumber',NEW.project_number,'keyRevision',NEW.key_revision,'secretChanged',changed,'reason',NEW.reason));RETURN NEW;
END $$;
CREATE TRIGGER google_picker_settings_record AFTER INSERT OR UPDATE ON google_picker_settings FOR EACH ROW EXECUTE FUNCTION record_google_picker_settings();
