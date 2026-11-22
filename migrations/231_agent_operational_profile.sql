ALTER TABLE user_account ADD COLUMN agent_profile_version integer NOT NULL DEFAULT 0 CHECK(agent_profile_version>=0);

CREATE TABLE agent_profile_history (
 user_id uuid NOT NULL REFERENCES user_account(id),
 version integer NOT NULL CHECK(version>0),
 branch_id uuid NOT NULL REFERENCES branch(id),
 previous_name text NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 previous_capacity integer CHECK(previous_capacity>=0),
 capacity integer CHECK(capacity>=0),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,version)
);

CREATE FUNCTION guard_agent_profile_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.role<>'AGENT' OR NEW.role<>'AGENT' OR (OLD.organization_id,OLD.branch_id) IS DISTINCT FROM (NEW.organization_id,NEW.branch_id)
  OR (OLD.name,OLD.capacity) IS NOT DISTINCT FROM (NEW.name,NEW.capacity) OR NEW.agent_profile_version<>OLD.agent_profile_version+1
 THEN RAISE EXCEPTION 'AGENT_PROFILE_VERSION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_change_guard BEFORE UPDATE ON user_account FOR EACH ROW
 WHEN((OLD.role='AGENT' OR NEW.role='AGENT') AND
  (OLD.name,OLD.capacity,OLD.agent_profile_version) IS DISTINCT FROM (NEW.name,NEW.capacity,NEW.agent_profile_version))
 EXECUTE FUNCTION guard_agent_profile_change();

CREATE FUNCTION record_agent_profile_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target user_account;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AGENT_PROFILE_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO target FROM user_account WHERE id=NEW.user_id AND role='AGENT' AND branch_id=NEW.branch_id
  AND agent_profile_version=NEW.version AND (name,capacity) IS NOT DISTINCT FROM (NEW.name,NEW.capacity) AND ai_row_inserted_here(xmin);
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM branch WHERE id=target.branch_id AND active FOR SHARE)
  OR NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=target.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=target.branch_id))
    AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
 THEN RAISE EXCEPTION 'AGENT_PROFILE_SESSION_REQUIRED'; END IF;
 NEW.changed_at=statement_timestamp();
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(target.organization_id,target.branch_id,NEW.actor_id,'AGENT_PROFILE_CHANGED','USER',target.id,
  jsonb_build_object('version',NEW.version,'previousCapacity',NEW.previous_capacity,'capacity',NEW.capacity,'reason',NEW.reason));
 RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_history_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_profile_history
 FOR EACH ROW EXECUTE FUNCTION record_agent_profile_change();

CREATE FUNCTION require_agent_profile_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agent_profile_history h WHERE h.user_id=NEW.id AND h.version=NEW.agent_profile_version
  AND h.branch_id=NEW.branch_id AND (h.previous_name,h.previous_capacity,h.name,h.capacity) IS NOT DISTINCT FROM
    (OLD.name,OLD.capacity,NEW.name,NEW.capacity) AND ai_row_inserted_here(h.xmin))
 THEN RAISE EXCEPTION 'AGENT_PROFILE_HISTORY_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER agent_profile_history_required AFTER UPDATE ON user_account
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.role='AGENT' AND NEW.agent_profile_version IS DISTINCT FROM OLD.agent_profile_version)
 EXECUTE FUNCTION require_agent_profile_history();
