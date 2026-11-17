-- Picker selection is untrusted input. Only an independent, scoped metadata read can admit a resource.
CREATE TABLE google_picker_ticket (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL,
 settings_version integer NOT NULL,grant_id uuid NOT NULL REFERENCES google_oauth_operation(id),request_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 locale text NOT NULL CHECK(locale IN ('ar','en','fr')),state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','PICKING','VERIFYING','VERIFIED','FAILED','EXPIRED','SUPERSEDED','CANCELLED')),
 version integer NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 spreadsheet_id text CHECK(spreadsheet_id ~ '^[A-Za-z0-9_-]{1,200}$'),metadata jsonb,resource_id uuid,resource_version integer,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^GOOGLE_[A-Z_]{1,80}$'),retryable boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,finished_at timestamptz,recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,session_id,request_id),
 CHECK((state IN ('WAITING','PICKING','VERIFYING'))=(finished_at IS NULL)),
 CHECK((state='VERIFIED')=(metadata IS NOT NULL)),CHECK((state='VERIFIED')=(resource_id IS NOT NULL)),CHECK((state='VERIFIED')=(resource_version IS NOT NULL)),
 CHECK(metadata IS NULL OR (jsonb_typeof(metadata)='object' AND metadata->>'id'=spreadsheet_id AND jsonb_typeof(metadata->'sheets')='array'
  AND jsonb_array_length(metadata->'sheets')<=2000 AND octet_length(metadata::text)<=2097152))
);
CREATE UNIQUE INDEX google_picker_pending_actor_idx ON google_picker_ticket(connection_id,actor_id,session_id) WHERE state IN ('WAITING','PICKING','VERIFYING');
CREATE INDEX google_picker_ticket_history_idx ON google_picker_ticket(connection_id,created_at DESC,id DESC);
CREATE TABLE google_resource (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid REFERENCES branch(id),
 spreadsheet_id text NOT NULL,metadata jsonb NOT NULL,version integer NOT NULL DEFAULT 1,connection_version integer NOT NULL,active boolean NOT NULL DEFAULT true,
 source_ticket_id uuid NOT NULL REFERENCES google_picker_ticket(id),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),actor_role text NOT NULL,actor_branch_id uuid,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(connection_id,spreadsheet_id)
);
ALTER TABLE google_picker_ticket ADD CONSTRAINT google_ticket_resource_fk FOREIGN KEY(resource_id) REFERENCES google_resource(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX google_resource_scope_idx ON google_resource(organization_id,branch_id,created_at DESC,id DESC);
CREATE TABLE google_resource_history (
 resource_id uuid NOT NULL REFERENCES google_resource(id),version integer NOT NULL,source_ticket_id uuid NOT NULL REFERENCES google_picker_ticket(id),
 metadata jsonb NOT NULL,active boolean NOT NULL,actor_id uuid NOT NULL REFERENCES user_account(id),reason text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(resource_id,version)
);
CREATE TABLE google_picker_ticket_history (
 ticket_id uuid NOT NULL REFERENCES google_picker_ticket(id),version integer NOT NULL,state text NOT NULL,attempts integer NOT NULL,
 error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(ticket_id,version)
);
CREATE FUNCTION google_picker_context_current(t google_picker_ticket) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=t.connection_id FOR UPDATE;
 IF c.id IS NULL OR c.version<>t.connection_version OR c.status<>'CONNECTED' OR c.capabilities->>'grantId' IS DISTINCT FROM t.grant_id::text
  OR NOT google_current_access(c.id,t.actor_id,t.session_id,t.actor_role,t.actor_branch_id) THEN RETURN false;END IF;
 IF c.branch_id IS NOT NULL THEN PERFORM id FROM branch WHERE id=c.branch_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;END IF;
 PERFORM 1 FROM google_picker_settings s JOIN google_oauth_operation g ON g.id=t.grant_id
 WHERE s.connection_id=c.id AND s.version=t.settings_version AND g.connection_id=c.id AND g.connection_version=c.version
 AND g.state='VERIFIED' AND g.access_expires_at>clock_timestamp()+interval '15 seconds' FOR SHARE OF s,g;
 RETURN FOUND;
END $$;
CREATE FUNCTION guard_google_picker_ticket() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_PICKER_TICKET_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.attempts<>0 OR NEW.spreadsheet_id IS NOT NULL OR NEW.metadata IS NOT NULL OR NEW.error_code IS NOT NULL
   THEN RAISE EXCEPTION 'GOOGLE_PICKER_TICKET_CLAIM_REQUIRED';END IF;
  NEW.created_at=clock_timestamp();NEW.expires_at=clock_timestamp()+interval '10 minutes';
 ELSE
  IF (NEW.id,NEW.connection_id,NEW.connection_version,NEW.settings_version,NEW.grant_id,NEW.request_id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id,NEW.locale,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.settings_version,OLD.grant_id,OLD.request_id,OLD.actor_id,OLD.session_id,OLD.actor_role,OLD.actor_branch_id,OLD.locale,OLD.created_at,OLD.expires_at)
   OR NEW.version<>OLD.version+1 OR OLD.state NOT IN ('WAITING','PICKING','VERIFYING','FAILED')
   OR (OLD.state='WAITING' AND NEW.state NOT IN ('PICKING','EXPIRED','SUPERSEDED','CANCELLED'))
   OR (OLD.state='PICKING' AND NEW.state NOT IN ('VERIFYING','EXPIRED','SUPERSEDED','CANCELLED'))
   OR (OLD.state='VERIFYING' AND NEW.state NOT IN ('VERIFIED','FAILED','EXPIRED','SUPERSEDED'))
   OR (OLD.state='FAILED' AND (NOT OLD.retryable OR NEW.state NOT IN ('VERIFYING','SUPERSEDED')))
   THEN RAISE EXCEPTION 'GOOGLE_PICKER_TICKET_TRANSITION_INVALID';END IF;
  IF OLD.spreadsheet_id IS NOT NULL AND NEW.spreadsheet_id IS DISTINCT FROM OLD.spreadsheet_id THEN RAISE EXCEPTION 'GOOGLE_PICKER_SELECTED_ID_IMMUTABLE';END IF;
  IF NEW.state='VERIFYING' THEN
   IF OLD.expires_at<=clock_timestamp() AND OLD.state<>'FAILED' OR NEW.attempts<>OLD.attempts+1 OR NEW.spreadsheet_id IS NULL THEN RAISE EXCEPTION 'GOOGLE_PICKER_READ_CLAIM_REQUIRED';END IF;
   NEW.expires_at=clock_timestamp()+interval '60 seconds';
  ELSIF NEW.attempts<>OLD.attempts THEN RAISE EXCEPTION 'GOOGLE_PICKER_READ_CLAIM_REQUIRED';END IF;
  IF NEW.state='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_PICKER_NOT_EXPIRED';END IF;
  IF NEW.state IN ('PICKING','VERIFIED') AND OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_PICKER_TICKET_EXPIRED';END IF;
 END IF;
 IF (TG_OP='INSERT' OR NEW.state IN ('PICKING','VERIFYING','VERIFIED')) AND NOT google_picker_context_current(NEW::google_picker_ticket) THEN RAISE EXCEPTION 'GOOGLE_PICKER_CONTEXT_CHANGED';END IF;
 IF NEW.state IN ('WAITING','PICKING') AND NEW.spreadsheet_id IS NOT NULL THEN RAISE EXCEPTION 'GOOGLE_PICKER_READ_CLAIM_REQUIRED';END IF;
 NEW.finished_at=CASE WHEN NEW.state IN ('WAITING','PICKING','VERIFYING') THEN NULL ELSE clock_timestamp() END;
 NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_picker_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON google_picker_ticket FOR EACH ROW EXECUTE FUNCTION guard_google_picker_ticket();
CREATE FUNCTION guard_google_picker_ticket_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_picker_ticket t WHERE (t.id,t.version,t.state,t.attempts,t.error_code)
  IS NOT DISTINCT FROM (NEW.ticket_id,NEW.version,NEW.state,NEW.attempts,NEW.error_code) AND t.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_PICKER_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_picker_ticket_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_picker_ticket_history FOR EACH ROW EXECUTE FUNCTION guard_google_picker_ticket_history();
CREATE FUNCTION record_google_picker_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id;
 INSERT INTO google_picker_ticket_history(ticket_id,version,state,attempts,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempts,NEW.error_code);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(c.organization_id,c.branch_id,NEW.actor_id,'GOOGLE_PICKER_STATE','GOOGLE_CONNECTION',c.id,jsonb_build_object('ticketId',NEW.id,'state',NEW.state,'attempts',NEW.attempts,'errorCode',NEW.error_code));RETURN NEW;
END $$;
CREATE TRIGGER google_picker_ticket_record AFTER INSERT OR UPDATE ON google_picker_ticket FOR EACH ROW EXECUTE FUNCTION record_google_picker_ticket();
CREATE FUNCTION guard_google_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_HISTORY_RETAINED';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF NOT google_current_access(c.id,NEW.actor_id,NEW.session_id,NEW.actor_role,NEW.actor_branch_id) OR c.version<>NEW.connection_version
  OR (c.organization_id,c.branch_id) IS DISTINCT FROM (NEW.organization_id,NEW.branch_id) THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_CURRENT_ACCESS_REQUIRED';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_VERIFICATION_REQUIRED';END IF;NEW.created_at=clock_timestamp();
 ELSE
  IF (NEW.id,NEW.connection_id,NEW.organization_id,NEW.branch_id,NEW.spreadsheet_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.branch_id,OLD.spreadsheet_id,OLD.created_at)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_IDENTITY_IMMUTABLE';END IF;
  IF NOT NEW.active AND (NEW.metadata,NEW.source_ticket_id) IS DISTINCT FROM (OLD.metadata,OLD.source_ticket_id) THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_VERIFICATION_REQUIRED';END IF;
 END IF;
 IF NEW.active AND NOT EXISTS(SELECT 1 FROM google_picker_ticket t WHERE t.connection_id=c.id AND t.state='VERIFIED' AND t.id=NEW.source_ticket_id
  AND t.resource_id=NEW.id AND t.resource_version=NEW.version AND t.spreadsheet_id=NEW.spreadsheet_id AND t.metadata=NEW.metadata
  AND t.actor_id=NEW.actor_id AND t.session_id=NEW.session_id AND t.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_VERIFICATION_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON google_resource FOR EACH ROW EXECUTE FUNCTION guard_google_resource();
CREATE FUNCTION guard_google_resource_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_resource r WHERE (r.id,r.version,r.source_ticket_id,r.metadata,r.active,r.actor_id,r.reason,r.updated_at)
  IS NOT DISTINCT FROM (NEW.resource_id,NEW.version,NEW.source_ticket_id,NEW.metadata,NEW.active,NEW.actor_id,NEW.reason,NEW.created_at)
  AND r.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_RESOURCE_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_resource_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_resource_history FOR EACH ROW EXECUTE FUNCTION guard_google_resource_history();
CREATE FUNCTION record_google_resource() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO google_resource_history(resource_id,version,source_ticket_id,metadata,active,actor_id,reason,created_at)
 VALUES(NEW.id,NEW.version,NEW.source_ticket_id,NEW.metadata,NEW.active,NEW.actor_id,NEW.reason,NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'GOOGLE_RESOURCE_RECORDED','GOOGLE_RESOURCE',NEW.id,jsonb_build_object('version',NEW.version,'active',NEW.active,'ticketId',NEW.source_ticket_id,'reason',NEW.reason));RETURN NEW;
END $$;
CREATE TRIGGER google_resource_record AFTER INSERT OR UPDATE ON google_resource FOR EACH ROW EXECUTE FUNCTION record_google_resource();
CREATE FUNCTION require_google_picker_resource() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM google_resource_history h JOIN google_resource r ON r.id=h.resource_id WHERE h.resource_id=NEW.resource_id
  AND h.version=NEW.resource_version AND h.source_ticket_id=NEW.id AND h.metadata=NEW.metadata AND h.active AND r.connection_id=NEW.connection_id)
  THEN RAISE EXCEPTION 'GOOGLE_PICKER_COMPLETE_RESOURCE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_picker_complete_resource AFTER UPDATE ON google_picker_ticket DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.state='VERIFIED') EXECUTE FUNCTION require_google_picker_resource();
