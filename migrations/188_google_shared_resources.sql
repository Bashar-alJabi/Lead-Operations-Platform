-- Explicit availability is separate from Connection configuration and OAuth credentials.
CREATE TABLE google_resource_access (
 resource_id uuid NOT NULL REFERENCES google_resource(id),branch_id uuid NOT NULL REFERENCES branch(id),
 active boolean NOT NULL,version integer NOT NULL DEFAULT 1,connection_version integer NOT NULL,resource_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(resource_id,branch_id)
);
CREATE INDEX google_resource_access_branch_idx ON google_resource_access(branch_id,resource_id) WHERE active;
CREATE TABLE google_resource_access_history (
 resource_id uuid NOT NULL,branch_id uuid NOT NULL,version integer NOT NULL,active boolean NOT NULL,
 connection_version integer NOT NULL,resource_version integer NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(resource_id,branch_id,version),FOREIGN KEY(resource_id,branch_id) REFERENCES google_resource_access(resource_id,branch_id)
);
CREATE INDEX google_resource_branch_catalog_idx ON google_resource(organization_id,branch_id,id) WHERE active;
-- Two indexed candidate sets, rather than a scalar availability query per Organization resource.
CREATE VIEW google_available_resource AS
 SELECT r.id AS resource_id,r.organization_id,b.id AS branch_id FROM google_resource r
 JOIN integration_connection c ON c.id=r.connection_id JOIN branch b ON b.id=r.branch_id AND b.organization_id=r.organization_id
 WHERE b.active AND r.active AND c.organization_id=r.organization_id AND c.branch_id=b.id
 AND c.kind='GOOGLE' AND c.provider='GOOGLE_SHEETS' AND c.status='CONNECTED' AND r.connection_version=c.version
 UNION ALL
 SELECT r.id AS resource_id,r.organization_id,b.id AS branch_id FROM google_resource_access a JOIN google_resource r ON r.id=a.resource_id
 JOIN integration_connection c ON c.id=r.connection_id JOIN branch b ON b.id=a.branch_id AND b.organization_id=r.organization_id
 WHERE a.active AND b.active AND r.active AND c.organization_id=r.organization_id AND c.branch_id IS NULL
 AND c.kind='GOOGLE' AND c.provider='GOOGLE_SHEETS' AND c.status='CONNECTED' AND r.connection_version=c.version;
CREATE FUNCTION google_resource_available(rid uuid,oid uuid,bid uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM google_available_resource WHERE resource_id=rid AND organization_id=oid AND branch_id=bid)
$$;
CREATE FUNCTION guard_google_resource_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r google_resource;c integration_connection;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_ACCESS_HISTORY_RETAINED';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=(SELECT connection_id FROM google_resource WHERE id=NEW.resource_id) FOR UPDATE;
 SELECT * INTO r FROM google_resource WHERE id=NEW.resource_id FOR SHARE;
 IF c.id IS NULL OR c.branch_id IS NOT NULL OR NOT google_current_access(c.id,NEW.actor_id,NEW.session_id,'SUPER_ADMIN',NULL)
  OR c.version<>NEW.connection_version OR r.version<>NEW.resource_version THEN RAISE EXCEPTION 'GOOGLE_SHARED_RESOURCE_CURRENT_ACCESS_REQUIRED';END IF;
 PERFORM id FROM branch WHERE id=NEW.branch_id AND organization_id=c.organization_id AND (NOT NEW.active OR active) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOOGLE_SHARED_BRANCH_REQUIRED';END IF;
 IF NEW.active AND (NOT r.active OR c.status<>'CONNECTED' OR r.connection_version<>c.version) THEN RAISE EXCEPTION 'GOOGLE_SHARED_RESOURCE_UNAVAILABLE';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_ACCESS_VERSION_INVALID';END IF;
 ELSE
  IF (NEW.resource_id,NEW.branch_id) IS DISTINCT FROM (OLD.resource_id,OLD.branch_id) OR NEW.version<>OLD.version+1
   THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_ACCESS_IDENTITY_IMMUTABLE';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_resource_access_guard BEFORE INSERT OR UPDATE OR DELETE ON google_resource_access FOR EACH ROW EXECUTE FUNCTION guard_google_resource_access();
CREATE FUNCTION guard_google_resource_access_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_resource_access a WHERE
  (a.resource_id,a.branch_id,a.version,a.active,a.connection_version,a.resource_version,a.actor_id,a.reason,a.updated_at)
  IS NOT DISTINCT FROM (NEW.resource_id,NEW.branch_id,NEW.version,NEW.active,NEW.connection_version,NEW.resource_version,NEW.actor_id,NEW.reason,NEW.created_at)
  AND a.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_ACCESS_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_resource_access_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_resource_access_history FOR EACH ROW EXECUTE FUNCTION guard_google_resource_access_history();
CREATE FUNCTION record_google_resource_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oid uuid;
BEGIN
 SELECT organization_id INTO oid FROM google_resource WHERE id=NEW.resource_id;
 INSERT INTO google_resource_access_history(resource_id,branch_id,version,active,connection_version,resource_version,actor_id,reason,created_at)
 VALUES(NEW.resource_id,NEW.branch_id,NEW.version,NEW.active,NEW.connection_version,NEW.resource_version,NEW.actor_id,NEW.reason,NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(oid,NEW.branch_id,NEW.actor_id,'GOOGLE_RESOURCE_ACCESS_CHANGED','GOOGLE_RESOURCE',NEW.resource_id,
  jsonb_build_object('branchId',NEW.branch_id,'version',NEW.version,'active',NEW.active,'reason',NEW.reason,'resourceVersion',NEW.resource_version,'connectionVersion',NEW.connection_version));RETURN NEW;
END $$;
CREATE TRIGGER google_resource_access_record AFTER INSERT OR UPDATE ON google_resource_access FOR EACH ROW EXECUTE FUNCTION record_google_resource_access();
