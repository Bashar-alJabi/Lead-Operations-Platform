-- Publication/materialization only. No SMTP dispatch authority is granted here.
-- Existing opted-in settings start now; historical notification_event rows are never published.
ALTER TABLE notification_email_preference ADD COLUMN enabled_since timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE FUNCTION track_notification_email_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.enabled_since=clock_timestamp();
 ELSIF NEW.enabled AND NOT OLD.enabled THEN NEW.enabled_since=clock_timestamp();
 ELSE NEW.enabled_since=OLD.enabled_since;END IF;RETURN NEW;
END $$;
CREATE TRIGGER notification_email_preference_activation BEFORE INSERT OR UPDATE ON notification_email_preference
 FOR EACH ROW EXECUTE FUNCTION track_notification_email_activation();
CREATE INDEX notification_email_opted_audience ON notification_email_preference(event_type,user_id) WHERE enabled;

CREATE TABLE notification_email_publication (
 event_id uuid PRIMARY KEY REFERENCES notification_event(id),organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),connection_id uuid NOT NULL REFERENCES operational_email_connection(connection_id),
 connection_version integer NOT NULL,binding_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('WAITING','DONE','SUPPRESSED')),cursor_user_id uuid,
 version integer NOT NULL CHECK(version>0),scanned integer NOT NULL DEFAULT 0 CHECK(scanned>=0),
 enqueued integer NOT NULL DEFAULT 0 CHECK(enqueued>=0 AND enqueued<=scanned),
 created_at timestamptz NOT NULL,error_code text CHECK(error_code IS NULL OR error_code='EMAIL_PUBLICATION_CONTEXT_CHANGED')
);
CREATE INDEX notification_email_pending_publication ON notification_email_publication(created_at,event_id) WHERE state='WAITING';
CREATE TABLE notification_email_materialization (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES notification_email_publication(event_id),
 version integer NOT NULL,after_user_id uuid,scanned integer NOT NULL,enqueued integer NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('WAITING','DONE','SUPPRESSED')),created_at timestamptz NOT NULL,
 UNIQUE(event_id,version)
);
CREATE TABLE notification_email_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES notification_email_publication(event_id),
 user_id uuid NOT NULL REFERENCES user_account(id),page_id uuid NOT NULL REFERENCES notification_email_materialization(id) DEFERRABLE INITIALLY DEFERRED,
 preference_version integer NOT NULL,language text NOT NULL CHECK(language IN ('ar','en','fr')),
 state text NOT NULL CHECK(state='WAITING'),created_at timestamptz NOT NULL,UNIQUE(event_id,user_id)
);
CREATE INDEX notification_email_outbox_personal ON notification_email_outbox(user_id,created_at DESC,id DESC);

CREATE FUNCTION notification_email_audience(eid uuid,after_uid uuid) RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE AS $$
 SELECT u.id FROM notification_email_publication j JOIN notification_event e ON e.id=j.event_id
 JOIN notification_email_preference p ON p.event_type=e.event_type AND p.enabled AND p.enabled_since<=j.created_at
 JOIN user_account u ON u.id=p.user_id AND u.active AND u.organization_id=j.organization_id
 WHERE j.event_id=eid AND (after_uid IS NULL OR u.id>after_uid)
 AND (u.role='SUPER_ADMIN' OR u.branch_id=j.branch_id AND u.role IN ('MANAGER','AGENT')) ORDER BY u.id LIMIT 26
$$;

-- Background authority is the current explicit channel and personal opt-in, never an old HTTP session.
CREATE FUNCTION notification_email_recipient_allowed(eid uuid,uid uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE j notification_email_publication;e notification_event;c integration_connection;b notification_email_binding;p notification_email_preference;
BEGIN
 SELECT * INTO j FROM notification_email_publication WHERE event_id=eid;
 IF j.event_id IS NULL THEN RETURN false;END IF;
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 PERFORM id FROM branch WHERE id=j.branch_id AND organization_id=j.organization_id AND active FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO e FROM notification_event WHERE id=eid;
 PERFORM id FROM lead WHERE id=e.lead_id FOR SHARE;
 PERFORM id FROM campaign WHERE id=e.campaign_id FOR SHARE;
 IF e.conversation_id IS NOT NULL THEN PERFORM id FROM conversation WHERE id=e.conversation_id FOR SHARE;END IF;
 IF e.follow_up_id IS NOT NULL THEN PERFORM id FROM follow_up WHERE id=e.follow_up_id FOR SHARE;END IF;
 PERFORM id FROM user_account WHERE id=uid AND active AND organization_id=j.organization_id FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO p FROM notification_email_preference WHERE user_id=uid AND event_type=e.event_type FOR SHARE;
 SELECT * INTO b FROM notification_email_binding WHERE branch_id=j.branch_id FOR SHARE;
 RETURN COALESCE(c.id IS NOT NULL AND c.kind='EMAIL' AND c.organization_id=j.organization_id AND c.status<>'DISABLED'
  AND c.version=j.connection_version AND (c.branch_id IS NULL OR c.branch_id=j.branch_id)
  AND b.enabled AND b.version=j.binding_version AND b.connection_id=c.id AND b.organization_id=j.organization_id
  AND p.enabled AND p.enabled_since<=j.created_at AND notification_access(eid,uid),false);
END $$;

CREATE FUNCTION guard_notification_email_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event;b notification_email_binding;c integration_connection;p notification_email_materialization;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_PUBLICATION_IMMUTABLE';END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO e FROM notification_event WHERE id=NEW.event_id;
  IF e.id IS NULL OR NOT EXISTS(SELECT 1 FROM notification_event WHERE id=e.id AND ai_row_inserted_here(xmin))
   THEN RAISE EXCEPTION 'EMAIL_FRESH_NOTIFICATION_REQUIRED';END IF;
  SELECT * INTO b FROM notification_email_binding WHERE branch_id=e.branch_id AND organization_id=e.organization_id AND enabled;
  SELECT * INTO c FROM integration_connection WHERE id=b.connection_id;
  IF b.branch_id IS NULL OR c.id IS NULL OR c.organization_id<>e.organization_id OR c.branch_id IS NOT NULL AND c.branch_id<>e.branch_id
   THEN RAISE EXCEPTION 'EMAIL_PUBLICATION_BINDING_REQUIRED';END IF;
  NEW.organization_id=e.organization_id;NEW.branch_id=e.branch_id;NEW.connection_id=c.id;
  NEW.connection_version=c.version;NEW.binding_version=b.version;NEW.state='WAITING';NEW.cursor_user_id=NULL;
  NEW.version=1;NEW.scanned=0;NEW.enqueued=0;NEW.error_code=NULL;NEW.created_at=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO p FROM notification_email_materialization WHERE event_id=OLD.event_id AND version=OLD.version AND ai_row_inserted_here(xmin);
 IF OLD.state<>'WAITING' OR p.id IS NULL OR
  (NEW.event_id,NEW.organization_id,NEW.branch_id,NEW.connection_id,NEW.connection_version,NEW.binding_version,NEW.created_at)
  IS DISTINCT FROM(OLD.event_id,OLD.organization_id,OLD.branch_id,OLD.connection_id,OLD.connection_version,OLD.binding_version,OLD.created_at)
  OR NEW.version<>OLD.version+1 OR NEW.state<>p.outcome OR NEW.cursor_user_id IS DISTINCT FROM p.after_user_id
  OR NEW.scanned<>OLD.scanned+p.scanned OR NEW.enqueued<>OLD.enqueued+p.enqueued
  OR NEW.error_code IS DISTINCT FROM (CASE WHEN p.outcome='SUPPRESSED' THEN 'EMAIL_PUBLICATION_CONTEXT_CHANGED'::text END)
  THEN RAISE EXCEPTION 'EMAIL_FRESH_MATERIALIZATION_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_email_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_publication
 FOR EACH ROW EXECUTE FUNCTION guard_notification_email_publication();
CREATE FUNCTION publish_notification_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM notification_email_binding WHERE branch_id=NEW.branch_id AND organization_id=NEW.organization_id AND enabled AND connection_id IS NOT NULL)
  THEN INSERT INTO notification_email_publication(event_id) VALUES(NEW.id);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_event_email_publication AFTER INSERT ON notification_event FOR EACH ROW EXECUTE FUNCTION publish_notification_email();

CREATE FUNCTION guard_notification_email_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j notification_email_publication;p notification_email_preference;e notification_event;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_OUTBOX_IMMUTABLE';END IF;
 SELECT * INTO j FROM notification_email_publication WHERE event_id=NEW.event_id;
 PERFORM id FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 PERFORM id FROM branch WHERE id=j.branch_id FOR SHARE;
 SELECT * INTO j FROM notification_email_publication WHERE event_id=NEW.event_id FOR UPDATE;
 SELECT * INTO e FROM notification_event WHERE id=j.event_id;
 IF j.state<>'WAITING' OR NOT notification_email_recipient_allowed(j.event_id,NEW.user_id)
  OR NOT EXISTS(SELECT 1 FROM notification_email_audience(j.event_id,j.cursor_user_id) a WHERE a.user_id=NEW.user_id)
  THEN RAISE EXCEPTION 'EMAIL_CURRENT_RECIPIENT_REQUIRED';END IF;
 SELECT * INTO p FROM notification_email_preference WHERE user_id=NEW.user_id AND event_type=e.event_type;
 NEW.preference_version=p.version;NEW.language=p.language;NEW.state='WAITING';NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_email_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_outbox
 FOR EACH ROW EXECUTE FUNCTION guard_notification_email_outbox();

CREATE FUNCTION guard_notification_email_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j notification_email_publication;b notification_email_binding;c integration_connection;candidate uuid;ids uuid[];n integer;got integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_MATERIALIZATION_IMMUTABLE';END IF;
 SELECT * INTO j FROM notification_email_publication WHERE event_id=NEW.event_id;
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 PERFORM id FROM branch WHERE id=j.branch_id FOR SHARE;
 SELECT * INTO j FROM notification_email_publication WHERE event_id=NEW.event_id FOR UPDATE;
 IF j.event_id IS NULL OR j.state<>'WAITING' THEN RAISE EXCEPTION 'EMAIL_PUBLICATION_NOT_WAITING';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 SELECT * INTO b FROM notification_email_binding WHERE branch_id=j.branch_id FOR SHARE;
 NEW.version=j.version;NEW.after_user_id=j.cursor_user_id;NEW.scanned=0;NEW.enqueued=0;NEW.created_at=clock_timestamp();
 IF c.version<>j.connection_version OR c.status='DISABLED' OR b.version<>j.binding_version OR NOT b.enabled OR b.connection_id<>j.connection_id
  OR NOT EXISTS(SELECT 1 FROM branch WHERE id=j.branch_id AND active) THEN NEW.outcome='SUPPRESSED';RETURN NEW;END IF;
 SELECT array_agg(a.user_id ORDER BY a.user_id) INTO ids FROM notification_email_audience(j.event_id,j.cursor_user_id) a;
 NEW.outcome=CASE WHEN COALESCE(cardinality(ids),0)<=25 THEN 'DONE' ELSE 'WAITING' END;
 FOR n IN 1..LEAST(COALESCE(cardinality(ids),0),25) LOOP
  candidate=ids[n];NEW.after_user_id=candidate;NEW.scanned=NEW.scanned+1;
  IF notification_email_recipient_allowed(j.event_id,candidate) THEN
   INSERT INTO notification_email_outbox(event_id,user_id,page_id) VALUES(j.event_id,candidate,NEW.id) ON CONFLICT(event_id,user_id) DO NOTHING;
   GET DIAGNOSTICS got=ROW_COUNT;NEW.enqueued=NEW.enqueued+got;
  END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER notification_email_materialization_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_materialization
 FOR EACH ROW EXECUTE FUNCTION guard_notification_email_materialization();
CREATE FUNCTION record_notification_email_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j notification_email_publication;e notification_event;
BEGIN
 UPDATE notification_email_publication SET version=version+1,state=NEW.outcome,cursor_user_id=NEW.after_user_id,
  scanned=scanned+NEW.scanned,enqueued=enqueued+NEW.enqueued,error_code=CASE WHEN NEW.outcome='SUPPRESSED' THEN 'EMAIL_PUBLICATION_CONTEXT_CHANGED' END
  WHERE event_id=NEW.event_id RETURNING * INTO j;
 SELECT * INTO e FROM notification_event WHERE id=j.event_id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES(j.organization_id,j.branch_id,
  'EMAIL_NOTIFICATION_AUDIENCE_PREPARED','LEAD',e.lead_id,jsonb_build_object('eventId',j.event_id,'version',NEW.version,'scanned',NEW.scanned,'enqueued',NEW.enqueued,'state',NEW.outcome));
 RETURN NEW;
END $$;
CREATE TRIGGER notification_email_materialization_record AFTER INSERT ON notification_email_materialization
 FOR EACH ROW EXECUTE FUNCTION record_notification_email_materialization();
CREATE FUNCTION prove_notification_email_outbox_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM notification_email_materialization p WHERE p.id=NEW.page_id AND p.event_id=NEW.event_id AND ai_row_inserted_here(p.xmin)
  AND p.enqueued=(SELECT count(*) FROM notification_email_outbox o WHERE o.page_id=p.id AND ai_row_inserted_here(o.xmin)))
  THEN RAISE EXCEPTION 'EMAIL_FRESH_OUTBOX_PAGE_REQUIRED';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_email_outbox_page_proof AFTER INSERT ON notification_email_outbox DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION prove_notification_email_outbox_page();
