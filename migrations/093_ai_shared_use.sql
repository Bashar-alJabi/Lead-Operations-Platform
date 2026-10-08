CREATE TABLE ai_connection_branch_use (
  connection_id uuid NOT NULL REFERENCES integration_connection(id),branch_id uuid NOT NULL REFERENCES branch(id),active boolean NOT NULL,
  version integer NOT NULL CHECK(version>0),connection_version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(connection_id,branch_id)
);
CREATE INDEX ai_connection_branch_use_lookup ON ai_connection_branch_use(branch_id,connection_id) WHERE active;
CREATE TABLE ai_connection_branch_use_history (
  connection_id uuid NOT NULL,branch_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connection_id,branch_id,version),FOREIGN KEY(connection_id,branch_id) REFERENCES ai_connection_branch_use(connection_id,branch_id)
);
CREATE FUNCTION guard_ai_shared_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SHARED_USE_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND
    ((NEW.connection_id,NEW.branch_id) IS DISTINCT FROM (OLD.connection_id,OLD.branch_id) OR NEW.version<>OLD.version+1)
    THEN RAISE EXCEPTION 'AI_SHARED_USE_IDENTITY_VERSION_REQUIRED';END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN branch b ON b.id=NEW.branch_id JOIN user_account u ON u.id=NEW.actor_id
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE c.id=NEW.connection_id AND c.kind='AI' AND c.branch_id IS NULL AND c.version=NEW.connection_version
    AND b.organization_id=c.organization_id AND (NOT NEW.active OR b.active) AND u.organization_id=c.organization_id AND u.active AND u.role='SUPER_ADMIN'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AI_SHARED_USE_CURRENT_ADMIN_REQUIRED';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_shared_use_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_connection_branch_use FOR EACH ROW EXECUTE FUNCTION guard_ai_shared_use();
CREATE FUNCTION guard_ai_shared_use_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_connection_branch_use g WHERE g.connection_id=NEW.connection_id AND g.branch_id=NEW.branch_id AND g.version=NEW.version AND to_jsonb(g)=NEW.snapshot)
    THEN RAISE EXCEPTION 'AI_SHARED_USE_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_shared_use_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_connection_branch_use_history FOR EACH ROW EXECUTE FUNCTION guard_ai_shared_use_history();
CREATE FUNCTION record_ai_shared_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_connection_branch_use_history(connection_id,branch_id,version,snapshot) VALUES(NEW.connection_id,NEW.branch_id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,NEW.branch_id,NEW.actor_id,'AI_SHARED_USE_CONFIGURED','AI_CONNECTION',c.id,
      jsonb_build_object('version',NEW.version,'connectionVersion',NEW.connection_version,'active',NEW.active,'reason',NEW.reason) FROM integration_connection c WHERE c.id=NEW.connection_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_shared_use_record AFTER INSERT OR UPDATE ON ai_connection_branch_use FOR EACH ROW EXECUTE FUNCTION record_ai_shared_use();
