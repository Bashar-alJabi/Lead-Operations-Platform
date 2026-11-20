CREATE TABLE staff_messaging_destination (
 user_id uuid PRIMARY KEY REFERENCES user_account(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL,
 user_role text NOT NULL CHECK(user_role IN ('AGENT','MANAGER')),
 phone text CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
 consented_since timestamptz,
 version integer NOT NULL CHECK(version>0),
 operation text NOT NULL CHECK(operation IN ('SET','GRANT','REVOKE','ACCOUNT_CHANGED')),
 actor_id uuid REFERENCES user_account(id),
 session_id uuid REFERENCES user_session(id),
 changed_at timestamptz NOT NULL,
 FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id),
 CHECK(phone IS NOT NULL OR consented_since IS NULL),
 CHECK((operation='ACCOUNT_CHANGED' AND actor_id IS NULL AND session_id IS NULL)
    OR (operation<>'ACCOUNT_CHANGED' AND actor_id IS NOT NULL AND session_id IS NOT NULL))
);
CREATE UNIQUE INDEX staff_messaging_destination_unique_phone
 ON staff_messaging_destination(organization_id,phone) WHERE phone IS NOT NULL;

CREATE TABLE staff_messaging_destination_history (
 user_id uuid NOT NULL REFERENCES user_account(id),
 version integer NOT NULL,
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL,
 operation text NOT NULL,
 phone_last4 text,
 consented boolean NOT NULL,
 actor_id uuid REFERENCES user_account(id),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,version),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id)
);

CREATE FUNCTION guard_staff_messaging_destination() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target user_account; actor user_account;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STAFF_DESTINATION_RETAINED'; END IF;
 IF (TG_OP='INSERT' AND (NEW.version<>1 OR NEW.operation<>'SET')) OR
    (TG_OP='UPDATE' AND (NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1))
 THEN RAISE EXCEPTION 'STAFF_DESTINATION_VERSION_REQUIRED'; END IF;
 SELECT * INTO target FROM user_account WHERE id=NEW.user_id FOR SHARE;
 NEW.changed_at=clock_timestamp();
 IF NEW.operation='ACCOUNT_CHANGED' THEN
  IF pg_trigger_depth()<2 OR (target.active AND (target.organization_id,target.branch_id,target.role)
        IS NOT DISTINCT FROM (OLD.organization_id,OLD.branch_id,OLD.user_role))
  THEN RAISE EXCEPTION 'STAFF_DESTINATION_ACCOUNT_CHANGE_REQUIRED'; END IF;
  NEW.organization_id=OLD.organization_id; NEW.branch_id=OLD.branch_id; NEW.user_role=OLD.user_role;
  NEW.phone=NULL; NEW.consented_since=NULL; NEW.actor_id=NULL; NEW.session_id=NULL;
  RETURN NEW;
 END IF;
 IF target.role NOT IN ('AGENT','MANAGER') OR target.branch_id IS NULL
 THEN RAISE EXCEPTION 'STAFF_DESTINATION_SCOPE_REQUIRED'; END IF;
 SELECT u.* INTO actor FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=target.organization_id
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
 IF actor.id IS NULL THEN RAISE EXCEPTION 'STAFF_DESTINATION_ACCESS_DENIED'; END IF;
 NEW.organization_id=target.organization_id; NEW.branch_id=target.branch_id; NEW.user_role=target.role;
 IF NEW.operation='SET' THEN
  IF NOT (actor.role='SUPER_ADMIN' OR (actor.role='MANAGER' AND target.role='AGENT' AND actor.branch_id=target.branch_id))
  THEN RAISE EXCEPTION 'STAFF_DESTINATION_ACCESS_DENIED'; END IF;
  NEW.consented_since=NULL;
 ELSE
  IF actor.id<>target.id OR OLD.phone IS NULL OR (OLD.organization_id,OLD.branch_id,OLD.user_role)
      IS DISTINCT FROM (target.organization_id,target.branch_id,target.role)
     OR NEW.phone IS DISTINCT FROM OLD.phone
  THEN RAISE EXCEPTION 'STAFF_DESTINATION_ACCESS_DENIED'; END IF;
  NEW.consented_since=CASE WHEN NEW.operation='GRANT' THEN COALESCE(OLD.consented_since,NEW.changed_at) END;
 END IF;
 IF (NEW.operation='SET' AND NEW.phone IS NOT NULL OR NEW.operation='GRANT') AND
    (NOT target.active OR NOT EXISTS(SELECT 1 FROM branch WHERE id=target.branch_id AND active FOR SHARE))
 THEN RAISE EXCEPTION 'STAFF_DESTINATION_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_destination_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_destination
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_destination();

CREATE FUNCTION guard_staff_messaging_destination_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'STAFF_DESTINATION_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_destination_history_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_destination_history
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_destination_history();

CREATE FUNCTION record_staff_messaging_destination() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO staff_messaging_destination_history(user_id,version,organization_id,branch_id,operation,phone_last4,consented,actor_id,changed_at)
 VALUES(NEW.user_id,NEW.version,NEW.organization_id,NEW.branch_id,NEW.operation,right(NEW.phone,4),NEW.consented_since IS NOT NULL,NEW.actor_id,NEW.changed_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'STAFF_MESSAGING_DESTINATION_CHANGED','USER',NEW.user_id,
  jsonb_build_object('version',NEW.version,'operation',NEW.operation,'configured',NEW.phone IS NOT NULL,'consented',NEW.consented_since IS NOT NULL));
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_destination_record AFTER INSERT OR UPDATE ON staff_messaging_destination
 FOR EACH ROW EXECUTE FUNCTION record_staff_messaging_destination();

CREATE FUNCTION invalidate_staff_messaging_destination() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE staff_messaging_destination SET operation='ACCOUNT_CHANGED',version=version+1
  WHERE user_id=NEW.id AND phone IS NOT NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_staff_messaging_destination AFTER UPDATE OF active,role,branch_id,organization_id ON user_account
 FOR EACH ROW WHEN((OLD.active AND NOT NEW.active) OR
  (OLD.organization_id,OLD.branch_id,OLD.role) IS DISTINCT FROM (NEW.organization_id,NEW.branch_id,NEW.role))
 EXECUTE FUNCTION invalidate_staff_messaging_destination();
