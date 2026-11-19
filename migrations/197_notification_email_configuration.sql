-- Explicit operational channel setup; this migration grants no SMTP send authority.
CREATE TABLE notification_email_binding (
 branch_id uuid PRIMARY KEY REFERENCES branch(id),organization_id uuid NOT NULL REFERENCES organization(id),
 connection_id uuid REFERENCES operational_email_connection(connection_id),enabled boolean NOT NULL,
 version integer NOT NULL CHECK(version>0),actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[\x00-\x1f\x7f]'),
 updated_at timestamptz NOT NULL,CHECK(NOT enabled OR connection_id IS NOT NULL)
);
CREATE TABLE notification_email_binding_history (
 branch_id uuid NOT NULL REFERENCES notification_email_binding(branch_id),version integer NOT NULL,
 snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(branch_id,version)
);
CREATE FUNCTION guard_notification_email_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;b branch;u user_account;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR
  (NEW.branch_id,NEW.organization_id) IS DISTINCT FROM(OLD.branch_id,OLD.organization_id)) THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_VERSION_REQUIRED';END IF;
 IF NEW.connection_id IS NOT NULL THEN
  SELECT c0.* INTO c FROM integration_connection c0 JOIN operational_email_connection o ON o.connection_id=c0.id WHERE c0.id=NEW.connection_id FOR SHARE OF c0;
  IF c.id IS NULL OR c.organization_id<>NEW.organization_id OR c.branch_id IS NOT NULL AND c.branch_id<>NEW.branch_id
   THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_CONNECTION_SCOPE_REQUIRED';END IF;
 END IF;
 SELECT * INTO b FROM branch WHERE id=NEW.branch_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF b.id IS NULL OR NEW.enabled AND (NOT b.active OR c.id IS NULL OR c.status<>'CONNECTED') THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_CONNECTION_NOT_READY';END IF;
 SELECT u0.* INTO u FROM user_account u0 JOIN user_session s ON s.user_id=u0.id WHERE u0.id=NEW.actor_id AND u0.active
  AND u0.organization_id=NEW.organization_id AND u0.role=NEW.actor_role AND u0.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id
  AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u0,s;
 IF u.id IS NULL OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=NEW.branch_id)
  THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
 -- Organization account use is explicitly approved by Super Admin for this Branch.
 -- A Manager may revoke it, but cannot create or renew that approval.
 IF u.role='MANAGER' AND c.id IS NOT NULL AND c.branch_id IS NULL THEN
  IF TG_OP='INSERT' OR NEW.enabled OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
   THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_ORGANIZATION_APPROVAL_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_email_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_binding FOR EACH ROW EXECUTE FUNCTION guard_notification_email_binding();

-- Email needs a persisted language for background delivery. IN_APP remains locale-based.
CREATE TABLE notification_email_preference (
 user_id uuid NOT NULL REFERENCES user_account(id),event_type text NOT NULL CHECK(event_type IN
 ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION','AUTOMATION_NOTICE')),
 enabled boolean NOT NULL,language text NOT NULL CHECK(language IN ('ar','en','fr')),version integer NOT NULL CHECK(version>0),
 session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,updated_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,event_type)
);
CREATE TABLE notification_email_preference_history (
 user_id uuid NOT NULL,event_type text NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,event_type,version),FOREIGN KEY(user_id,event_type) REFERENCES notification_email_preference(user_id,event_type)
);
CREATE FUNCTION guard_notification_email_preference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR
  (NEW.user_id,NEW.event_type) IS DISTINCT FROM(OLD.user_id,OLD.event_type)) THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_VERSION_REQUIRED';END IF;
 PERFORM u.id FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=NEW.user_id AND u.active
  AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.actor_branch_id AND s.id=NEW.session_id
  AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_CURRENT_SESSION_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_email_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_preference FOR EACH ROW EXECUTE FUNCTION guard_notification_email_preference();

CREATE FUNCTION guard_notification_email_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE j jsonb;x xid;ts timestamptz;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='notification_email_binding_history' THEN
  SELECT to_jsonb(b),b.xmin,b.updated_at INTO j,x,ts FROM notification_email_binding b WHERE b.branch_id=NEW.branch_id AND b.version=NEW.version;
 ELSE
  SELECT to_jsonb(p),p.xmin,p.updated_at INTO j,x,ts FROM notification_email_preference p WHERE p.user_id=NEW.user_id AND p.event_type=NEW.event_type AND p.version=NEW.version;
 END IF;
 IF j IS NULL OR NOT ai_row_inserted_here(x) OR j IS DISTINCT FROM NEW.snapshot THEN RAISE EXCEPTION 'EMAIL_NOTIFICATION_FRESH_HISTORY_REQUIRED';END IF;
 NEW.created_at=ts;RETURN NEW;
END $$;
CREATE TRIGGER notification_email_binding_history_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_binding_history FOR EACH ROW EXECUTE FUNCTION guard_notification_email_history();
CREATE TRIGGER notification_email_preference_history_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_preference_history FOR EACH ROW EXECUTE FUNCTION guard_notification_email_history();
CREATE FUNCTION record_notification_email_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE oid uuid;bid uuid;BEGIN
 IF TG_TABLE_NAME='notification_email_binding' THEN
  INSERT INTO notification_email_binding_history(branch_id,version,snapshot,created_at) VALUES(NEW.branch_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,
   'EMAIL_NOTIFICATION_BINDING_CONFIGURED','BRANCH',NEW.branch_id,jsonb_build_object('version',NEW.version,'connectionId',NEW.connection_id,'enabled',NEW.enabled,'reason',NEW.reason));
 ELSE
  INSERT INTO notification_email_preference_history(user_id,event_type,version,snapshot,created_at) VALUES(NEW.user_id,NEW.event_type,NEW.version,to_jsonb(NEW),NEW.updated_at);
  SELECT organization_id,branch_id INTO oid,bid FROM user_account WHERE id=NEW.user_id;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(oid,bid,NEW.user_id,
   'EMAIL_NOTIFICATION_PREFERENCE_CONFIGURED','USER',NEW.user_id,jsonb_build_object('eventType',NEW.event_type,'version',NEW.version,'enabled',NEW.enabled,'language',NEW.language));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER notification_email_binding_record AFTER INSERT OR UPDATE ON notification_email_binding FOR EACH ROW EXECUTE FUNCTION record_notification_email_configuration();
CREATE TRIGGER notification_email_preference_record AFTER INSERT OR UPDATE ON notification_email_preference FOR EACH ROW EXECUTE FUNCTION record_notification_email_configuration();

-- Reuse existing scoped wording, history and native authorization, keeping channel identity.
ALTER TABLE notification_template DROP CONSTRAINT notification_template_channel_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_channel_check CHECK(channel IN ('IN_APP','EMAIL'));
ALTER TABLE notification_template ADD CONSTRAINT notification_email_subject_check CHECK(channel<>'EMAIL' OR title !~ '[\r\n]');
CREATE OR REPLACE FUNCTION record_notification_template() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO notification_template_history(scope,resource_id,event_type,channel,language,version,snapshot,created_at)
  VALUES(NEW.scope,NEW.resource_id,NEW.event_type,NEW.channel,NEW.language,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,NEW.channel||'_NOTIFICATION_TEMPLATE_CONFIGURED','USER',NEW.actor_id,
   jsonb_build_object('scope',NEW.scope,'resourceId',NEW.resource_id,'language',NEW.language,'version',NEW.version,'reason',NEW.reason,'eventType',NEW.event_type,'channel',NEW.channel));
 RETURN NEW;
END $$;
