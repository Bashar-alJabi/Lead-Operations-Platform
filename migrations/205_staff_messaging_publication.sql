CREATE TABLE staff_messaging_publication (
 event_id uuid NOT NULL REFERENCES notification_event(id),
 language text NOT NULL CHECK(language IN ('ar','en','fr')),
 branch_id uuid NOT NULL REFERENCES branch(id),
 binding_version integer NOT NULL CHECK(binding_version>0),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','DONE','SUPPRESSED','DEAD_LETTER')),
 after_user_id uuid,
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,language)
);
CREATE INDEX staff_messaging_publication_ready ON staff_messaging_publication(run_at,event_id,language) WHERE state='WAITING';

CREATE TABLE staff_messaging_outbox (
 event_id uuid NOT NULL,
 language text NOT NULL,
 user_id uuid NOT NULL REFERENCES user_account(id),
 preference_version integer NOT NULL CHECK(preference_version>0),
 destination_version integer NOT NULL CHECK(destination_version>0),
 binding_version integer NOT NULL CHECK(binding_version>0),
 connection_version integer NOT NULL CHECK(connection_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,user_id),
 FOREIGN KEY(event_id,language) REFERENCES staff_messaging_publication(event_id,language)
);
CREATE INDEX staff_messaging_outbox_personal ON staff_messaging_outbox(user_id,created_at DESC,event_id DESC);

-- A provider catalog change invalidates a binding until a Manager approves the revised copy.
CREATE FUNCTION staff_messaging_current_binding(eid uuid,locale text,expected integer)
 RETURNS TABLE(sender_id uuid, template_id uuid, connection_id uuid, connection_version integer)
 LANGUAGE sql STABLE AS $$
 SELECT b.sender_id,b.template_id,c.id,c.version
 FROM notification_event e JOIN staff_messaging_binding b ON b.branch_id=e.branch_id AND b.organization_id=e.organization_id
   AND b.event_type=e.event_type AND b.language=locale AND b.version=expected AND b.enabled AND b.enabled_since<=e.created_at
 JOIN branch br ON br.id=b.branch_id AND br.active
 JOIN staff_messaging_sender i ON i.sender_id=b.sender_id AND i.branch_id=b.branch_id AND i.organization_id=b.organization_id
 JOIN messaging_sender s ON s.id=i.sender_id AND s.active AND s.capabilities->'template'='true'::jsonb AND NOT s.operator_enabled
 JOIN integration_connection c ON c.id=i.connection_id AND c.id=s.connection_id AND c.branch_id=b.branch_id
    AND c.organization_id=b.organization_id AND c.kind='MESSAGING' AND c.status IN ('CONNECTED','WARNING')
 JOIN provider_message_template t ON t.id=b.template_id AND t.connection_id=c.id AND t.active AND t.status='APPROVED'
 WHERE e.id=eid AND staff_messaging_template_copy(t.components) IS NOT NULL
   AND encode(sha256(convert_to(jsonb_build_array(t.external_template_id,t.name,t.language,t.components)::text,'UTF8')),'hex')=b.template_digest
$$;

CREATE FUNCTION staff_messaging_recipient(eid uuid,uid uuid,locale text)
 RETURNS TABLE(preference_version integer,destination_version integer) LANGUAGE sql STABLE AS $$
 SELECT p.version,d.version FROM notification_event e
 JOIN user_account u ON u.id=uid AND u.active AND u.role IN ('MANAGER','AGENT') AND u.branch_id=e.branch_id AND u.organization_id=e.organization_id
 JOIN staff_messaging_destination d ON d.user_id=u.id AND d.branch_id=u.branch_id AND d.organization_id=u.organization_id AND d.user_role=u.role
   AND d.phone IS NOT NULL AND d.consented_since<=e.created_at
 JOIN staff_messaging_preference p ON p.user_id=u.id AND p.event_type=e.event_type AND p.language=locale AND p.enabled AND p.enabled_since<=e.created_at
 WHERE e.id=eid AND notification_access(e.id,u.id)
$$;

CREATE FUNCTION guard_staff_messaging_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source notification_event;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source FROM notification_event WHERE id=NEW.event_id AND ai_row_inserted_here(xmin);
  IF pg_trigger_depth()<2 OR source.id IS NULL OR NOT EXISTS(
    SELECT 1 FROM staff_messaging_current_binding(NEW.event_id,NEW.language,NEW.binding_version))
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_SOURCE_REQUIRED'; END IF;
  NEW.branch_id=source.branch_id; NEW.state='WAITING'; NEW.after_user_id=NULL; NEW.failures=0;
  NEW.created_at=clock_timestamp(); NEW.run_at=NEW.created_at;
 ELSIF (NEW.event_id,NEW.language,NEW.branch_id,NEW.binding_version,NEW.created_at)
   IS DISTINCT FROM (OLD.event_id,OLD.language,OLD.branch_id,OLD.binding_version,OLD.created_at) OR OLD.state<>'WAITING' THEN
  RAISE EXCEPTION 'STAFF_MESSAGING_PUBLICATION_IDENTITY';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_publication
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_publication();

CREATE FUNCTION publish_staff_messaging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO staff_messaging_publication(event_id,language,branch_id,binding_version)
 SELECT NEW.id,b.language,NEW.branch_id,b.version FROM staff_messaging_binding b
 WHERE b.branch_id=NEW.branch_id AND b.event_type=NEW.event_type
  AND EXISTS(SELECT 1 FROM staff_messaging_current_binding(NEW.id,b.language,b.version));
 RETURN NEW;
END $$;
CREATE TRIGGER publish_staff_messaging AFTER INSERT ON notification_event
 FOR EACH ROW WHEN(NEW.branch_id IS NOT NULL) EXECUTE FUNCTION publish_staff_messaging();

CREATE FUNCTION guard_staff_messaging_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pub staff_messaging_publication; authority record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STAFF_MESSAGING_OUTBOX_IMMUTABLE'; END IF;
 SELECT * INTO pub FROM staff_messaging_publication WHERE event_id=NEW.event_id AND language=NEW.language AND state='WAITING' FOR SHARE;
 SELECT a.*,b.connection_version INTO authority FROM staff_messaging_recipient(NEW.event_id,NEW.user_id,NEW.language) a
 CROSS JOIN staff_messaging_current_binding(NEW.event_id,NEW.language,pub.binding_version) b;
 IF pub.event_id IS NULL OR authority.preference_version IS NULL THEN RAISE EXCEPTION 'STAFF_MESSAGING_RECIPIENT_NOT_ELIGIBLE'; END IF;
 NEW.binding_version=pub.binding_version; NEW.preference_version=authority.preference_version;
 NEW.destination_version=authority.destination_version; NEW.connection_version=authority.connection_version;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_outbox
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_outbox();

CREATE FUNCTION materialize_staff_messaging_page(eid uuid,locale text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE pub staff_messaging_publication; notice notification_event; scanned uuid[]; inserted integer;
BEGIN
 SELECT * INTO pub FROM staff_messaging_publication WHERE event_id=eid AND language=locale
  AND state='WAITING' AND run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED;
 IF pub.event_id IS NULL THEN RETURN false; END IF;
 SELECT * INTO notice FROM notification_event WHERE id=eid;
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM staff_messaging_current_binding(eid,locale,pub.binding_version)) THEN
   UPDATE staff_messaging_publication SET state='SUPPRESSED' WHERE event_id=eid AND language=locale;
  ELSE
   -- Scan a bounded keyset page, including users excluded by access or preference.
   SELECT array_agg(id ORDER BY id) INTO scanned FROM (
    SELECT u.id FROM user_account u WHERE u.branch_id=notice.branch_id AND u.organization_id=notice.organization_id
     AND u.role IN ('MANAGER','AGENT') AND (pub.after_user_id IS NULL OR u.id>pub.after_user_id)
    ORDER BY u.id LIMIT 25
   ) page;
   INSERT INTO staff_messaging_outbox(event_id,language,user_id)
   SELECT eid,locale,uid FROM unnest(scanned) AS page(uid)
   CROSS JOIN staff_messaging_recipient(eid,uid,locale) r ON CONFLICT(event_id,user_id) DO NOTHING;
   GET DIAGNOSTICS inserted=ROW_COUNT;
   UPDATE staff_messaging_publication SET state=CASE WHEN COALESCE(cardinality(scanned),0)<25 THEN 'DONE' ELSE 'WAITING' END,
    after_user_id=COALESCE(scanned[cardinality(scanned)],after_user_id),failures=0
    WHERE event_id=eid AND language=locale;
  END IF;
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
   VALUES(notice.organization_id,notice.branch_id,'STAFF_MESSAGING_AUDIENCE_PREPARED','NOTIFICATION_EVENT',eid,
    jsonb_build_object('language',locale,'prepared',COALESCE(inserted,0),'scanned',COALESCE(cardinality(scanned),0)));
 EXCEPTION WHEN OTHERS THEN
  UPDATE staff_messaging_publication SET failures=failures+1,
    state=CASE WHEN failures=4 THEN 'DEAD_LETTER' ELSE 'WAITING' END,
    run_at=clock_timestamp()+make_interval(secs=>power(2,failures)) WHERE event_id=eid AND language=locale;
 END;
 RETURN true;
END $$;
