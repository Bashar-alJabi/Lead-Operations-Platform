ALTER TABLE staff_messaging_publication
 ADD COLUMN recovery_version integer NOT NULL DEFAULT 0 CHECK(recovery_version>=0);
CREATE INDEX staff_messaging_publication_recovery_list
 ON staff_messaging_publication(branch_id,language,created_at DESC,event_id DESC)
 WHERE state='DEAD_LETTER' OR recovery_version>0;

CREATE TABLE staff_messaging_publication_recovery (
 event_id uuid NOT NULL,
 language text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(event_id,language,version),
 FOREIGN KEY(event_id,language) REFERENCES staff_messaging_publication(event_id,language)
);

CREATE FUNCTION guard_staff_messaging_publication_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job staff_messaging_publication; notice notification_event;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STAFF_MESSAGING_RECOVERY_IMMUTABLE'; END IF;
 SELECT * INTO job FROM staff_messaging_publication WHERE event_id=NEW.event_id AND language=NEW.language FOR UPDATE;
 SELECT * INTO notice FROM notification_event WHERE id=job.event_id;
 IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=notice.organization_id
   AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=job.branch_id)
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND notification_access(notice.id,u.id) FOR SHARE OF u,s)
 THEN RAISE EXCEPTION 'STAFF_MESSAGING_RECOVERY_DENIED'; END IF;
 IF job.state<>'DEAD_LETTER' OR NEW.version<>job.recovery_version+1
   OR NOT EXISTS(SELECT 1 FROM staff_messaging_current_binding(job.event_id,job.language,job.binding_version))
 THEN RAISE EXCEPTION 'STAFF_MESSAGING_RECOVERY_CONFLICT'; END IF;
 NEW.reason=trim(NEW.reason); NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_publication_recovery
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_publication_recovery();

CREATE OR REPLACE FUNCTION guard_staff_messaging_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source notification_event; recovery staff_messaging_publication_recovery;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source FROM notification_event WHERE id=NEW.event_id AND ai_row_inserted_here(xmin);
  IF pg_trigger_depth()<2 OR source.id IS NULL OR NOT EXISTS(
    SELECT 1 FROM staff_messaging_current_binding(NEW.event_id,NEW.language,NEW.binding_version))
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_SOURCE_REQUIRED'; END IF;
  NEW.branch_id=source.branch_id; NEW.state='WAITING'; NEW.after_user_id=NULL; NEW.failures=0;
  NEW.created_at=clock_timestamp(); NEW.run_at=NEW.created_at; NEW.recovery_version=0;
  RETURN NEW;
 END IF;
 IF (NEW.event_id,NEW.language,NEW.branch_id,NEW.binding_version,NEW.created_at)
   IS DISTINCT FROM (OLD.event_id,OLD.language,OLD.branch_id,OLD.binding_version,OLD.created_at)
 THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_IDENTITY'; END IF;
 IF OLD.state='DEAD_LETTER' AND NEW.recovery_version=OLD.recovery_version+1 AND pg_trigger_depth()>=2 THEN
  SELECT * INTO recovery FROM staff_messaging_publication_recovery
   WHERE event_id=OLD.event_id AND language=OLD.language AND version=NEW.recovery_version AND ai_row_inserted_here(xmin);
  IF recovery.event_id IS NOT NULL THEN
   NEW.state='WAITING'; NEW.failures=0; NEW.run_at=recovery.created_at; NEW.after_user_id=OLD.after_user_id;
   RETURN NEW;
  END IF;
 END IF;
 IF OLD.state<>'WAITING' OR NEW.recovery_version<>OLD.recovery_version
 THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_IDENTITY'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION reopen_staff_messaging_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE staff_messaging_publication SET recovery_version=NEW.version
  WHERE event_id=NEW.event_id AND language=NEW.language;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  SELECT e.organization_id,e.branch_id,NEW.actor_id,'STAFF_MESSAGING_PUBLICATION_RECOVERED','NOTIFICATION_EVENT',e.id,
   jsonb_build_object('language',NEW.language,'version',NEW.version,'reason',NEW.reason)
  FROM notification_event e WHERE e.id=NEW.event_id;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_recovery_apply AFTER INSERT ON staff_messaging_publication_recovery
 FOR EACH ROW EXECUTE FUNCTION reopen_staff_messaging_publication();
