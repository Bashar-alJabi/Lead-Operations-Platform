ALTER TABLE branch ADD COLUMN timezone_version integer NOT NULL DEFAULT 0 CHECK(timezone_version>=0);

CREATE TABLE branch_timezone_history (
 branch_id uuid NOT NULL REFERENCES branch(id),
 version integer NOT NULL CHECK(version>0),
 previous_timezone text NOT NULL,
 timezone text NOT NULL CHECK(timezone<>previous_timezone),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(branch_id,version)
);

CREATE FUNCTION guard_branch_timezone_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.timezone_version<>0 THEN RAISE EXCEPTION 'BRANCH_TIMEZONE_CHANGE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.timezone=OLD.timezone OR NEW.timezone_version<>OLD.timezone_version+1 OR NOT OLD.active OR NOT NEW.active
  OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
 THEN RAISE EXCEPTION 'BRANCH_TIMEZONE_CHANGE_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER branch_initial_timezone_guard BEFORE INSERT ON branch FOR EACH ROW EXECUTE FUNCTION guard_branch_timezone_change();
CREATE TRIGGER branch_timezone_change_guard BEFORE UPDATE ON branch FOR EACH ROW
 WHEN((NEW.timezone,NEW.timezone_version) IS DISTINCT FROM (OLD.timezone,OLD.timezone_version))
 EXECUTE FUNCTION guard_branch_timezone_change();

CREATE FUNCTION record_branch_timezone_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b branch;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BRANCH_TIMEZONE_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO b FROM branch WHERE id=NEW.branch_id AND active AND timezone=NEW.timezone
  AND timezone_version=NEW.version AND ai_row_inserted_here(xmin);
 IF NOT FOUND OR NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=b.organization_id
   AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=b.id))
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s
 ) THEN RAISE EXCEPTION 'BRANCH_TIMEZONE_SESSION_REQUIRED'; END IF;
 NEW.changed_at=statement_timestamp();
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(b.organization_id,b.id,NEW.actor_id,'BRANCH_TIMEZONE_CHANGED','BRANCH',b.id,jsonb_build_object(
  'version',NEW.version,'previousTimezone',NEW.previous_timezone,'timezone',NEW.timezone,'reason',NEW.reason));
 RETURN NEW;
END $$;
CREATE TRIGGER branch_timezone_history_guard BEFORE INSERT OR UPDATE OR DELETE ON branch_timezone_history
 FOR EACH ROW EXECUTE FUNCTION record_branch_timezone_change();

CREATE FUNCTION require_branch_timezone_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM branch_timezone_history h WHERE (h.branch_id,h.version,h.previous_timezone,h.timezone)
  =(NEW.id,NEW.timezone_version,OLD.timezone,NEW.timezone) AND ai_row_inserted_here(h.xmin))
 THEN RAISE EXCEPTION 'BRANCH_TIMEZONE_HISTORY_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER branch_timezone_history_required AFTER UPDATE ON branch
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.timezone_version IS DISTINCT FROM OLD.timezone_version)
 EXECUTE FUNCTION require_branch_timezone_history();
