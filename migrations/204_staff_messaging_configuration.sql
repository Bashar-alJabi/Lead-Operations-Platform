CREATE DOMAIN staff_messaging_event AS text CHECK(VALUE IN (
 'AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE',
 'PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION','AUTOMATION_NOTICE','LEAD_NEEDS_ATTENTION',
 'INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT'
));

-- A staff template only tells an employee to visit the platform. Send no dynamic values.
CREATE FUNCTION staff_messaging_template_copy(parts jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(parts)='array' THEN CASE WHEN jsonb_array_length(parts)=1
   AND upper(parts->0->>'type')='BODY' AND jsonb_typeof(parts->0->'text')='string'
   AND length(trim(parts->0->>'text')) BETWEEN 1 AND 1024 AND (parts->0->>'text') !~ '[{}]'
  THEN parts->0->>'text' END END
$$;

CREATE TABLE staff_messaging_binding (
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES organization(id),
 event_type staff_messaging_event NOT NULL,
 language text NOT NULL CHECK(language IN ('ar','en','fr')),
 sender_id uuid NOT NULL REFERENCES staff_messaging_sender(sender_id),
 template_id uuid NOT NULL REFERENCES provider_message_template(id),
 template_digest text NOT NULL CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 enabled boolean NOT NULL,
 enabled_since timestamptz,
 version integer NOT NULL CHECK(version>0),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(branch_id,event_type,language),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id),
 CHECK(enabled=(enabled_since IS NOT NULL))
);

CREATE TABLE staff_messaging_preference (
 user_id uuid NOT NULL REFERENCES user_account(id),
 event_type staff_messaging_event NOT NULL,
 language text NOT NULL CHECK(language IN ('ar','en','fr')),
 enabled boolean NOT NULL,
 enabled_since timestamptz,
 version integer NOT NULL CHECK(version>0),
 session_id uuid NOT NULL REFERENCES user_session(id),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,event_type),
 CHECK(enabled=(enabled_since IS NOT NULL))
);

CREATE TABLE staff_messaging_configuration_history (
 kind text NOT NULL CHECK(kind IN ('BINDING','PREFERENCE')),
 resource_id uuid NOT NULL,
 event_type staff_messaging_event NOT NULL,
 key_language text NOT NULL CHECK(key_language IN ('','ar','en','fr')),
 version integer NOT NULL,
 snapshot jsonb NOT NULL,
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(kind,resource_id,event_type,key_language,version)
);

CREATE FUNCTION guard_staff_messaging_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor user_account; branch_state branch; notice provider_message_template; route staff_messaging_sender;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STAFF_MESSAGING_CONFIGURATION_RETAINED'; END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'STAFF_MESSAGING_VERSION_CONFLICT'; END IF;
 NEW.changed_at=clock_timestamp();
 IF TG_TABLE_NAME='staff_messaging_binding' THEN
  IF TG_OP='UPDATE' AND (NEW.branch_id,NEW.organization_id,NEW.event_type,NEW.language)
    IS DISTINCT FROM (OLD.branch_id,OLD.organization_id,OLD.event_type,OLD.language)
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_BINDING_IDENTITY'; END IF;
  SELECT * INTO branch_state FROM branch WHERE id=NEW.branch_id AND organization_id=NEW.organization_id FOR SHARE;
  SELECT u.* INTO actor FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=NEW.organization_id
      AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=NEW.branch_id)
      AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
  IF actor.id IS NULL OR branch_state.id IS NULL THEN RAISE EXCEPTION 'STAFF_MESSAGING_ACCESS_DENIED'; END IF;
  IF NEW.enabled THEN
   SELECT r.* INTO route FROM staff_messaging_sender r JOIN messaging_sender ms ON ms.id=r.sender_id
    JOIN integration_connection c ON c.id=r.connection_id AND c.branch_id=r.branch_id AND c.organization_id=r.organization_id
    WHERE r.sender_id=NEW.sender_id AND r.branch_id=NEW.branch_id AND r.organization_id=NEW.organization_id
     AND ms.active AND ms.capabilities->'template'='true'::jsonb AND c.status IN ('CONNECTED','WARNING') FOR SHARE OF ms,c;
   SELECT * INTO notice FROM provider_message_template t WHERE t.id=NEW.template_id AND t.connection_id=route.connection_id
     AND t.active AND t.status='APPROVED' AND staff_messaging_template_copy(t.components) IS NOT NULL
     AND lower(split_part(replace(t.language,'-','_'),'_',1))=NEW.language FOR SHARE;
   IF NOT branch_state.active OR notice.id IS NULL THEN RAISE EXCEPTION 'STAFF_MESSAGING_TEMPLATE_UNAVAILABLE'; END IF;
   NEW.template_digest=encode(sha256(convert_to(jsonb_build_array(notice.external_template_id,notice.name,notice.language,notice.components)::text,'UTF8')),'hex');
  ELSIF TG_OP='INSERT' OR (NEW.sender_id,NEW.template_id) IS DISTINCT FROM (OLD.sender_id,OLD.template_id) THEN
   RAISE EXCEPTION 'STAFF_MESSAGING_DISABLED_BINDING';
  ELSE NEW.template_digest=OLD.template_digest;
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.user_id,NEW.event_type) IS DISTINCT FROM (OLD.user_id,OLD.event_type)
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_PREFERENCE_IDENTITY'; END IF;
  SELECT u.* INTO actor FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=NEW.user_id AND u.active AND u.role IN ('AGENT','MANAGER') AND s.id=NEW.session_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
  IF actor.id IS NULL OR (actor.role='AGENT' AND NEW.event_type IN ('INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT'))
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_ACCESS_DENIED'; END IF;
  IF NEW.enabled AND NOT EXISTS(SELECT 1 FROM staff_messaging_destination d JOIN branch b ON b.id=d.branch_id AND b.active
    WHERE d.user_id=actor.id AND d.organization_id=actor.organization_id AND d.branch_id=actor.branch_id AND d.user_role=actor.role
      AND d.phone IS NOT NULL AND d.consented_since IS NOT NULL FOR SHARE OF d,b)
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_CONSENT_REQUIRED'; END IF;
 END IF;
 -- Every revised configuration affects only new events.
 NEW.enabled_since=CASE WHEN NEW.enabled THEN NEW.changed_at END;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_binding
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_configuration();
CREATE TRIGGER staff_messaging_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_preference
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_configuration();

CREATE FUNCTION record_staff_messaging_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; actor uuid; org uuid; bid uuid; mode text; wording text; data jsonb;
BEGIN
 IF TG_TABLE_NAME='staff_messaging_binding' THEN
  target=NEW.branch_id; bid=NEW.branch_id; org=NEW.organization_id; actor=NEW.actor_id; mode='BINDING'; wording=NEW.language;
  data=jsonb_build_object('senderId',NEW.sender_id,'templateId',NEW.template_id,'templateDigest',NEW.template_digest,'reason',NEW.reason);
 ELSE
  target=NEW.user_id; actor=NEW.user_id; mode='PREFERENCE'; wording=''; data='{}'::jsonb;
  SELECT organization_id,branch_id INTO org,bid FROM user_account WHERE id=target;
 END IF;
 data=data||jsonb_build_object('version',NEW.version,'enabled',NEW.enabled,'language',NEW.language,'eventType',NEW.event_type);
 INSERT INTO staff_messaging_configuration_history VALUES(mode,target,NEW.event_type,wording,NEW.version,data,NEW.changed_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(org,bid,actor,'STAFF_MESSAGING_CONFIGURATION_CHANGED',mode,target,data);
 RETURN NEW;
END $$;
CREATE TRIGGER staff_messaging_binding_record AFTER INSERT OR UPDATE ON staff_messaging_binding
 FOR EACH ROW EXECUTE FUNCTION record_staff_messaging_configuration();
CREATE TRIGGER staff_messaging_preference_record AFTER INSERT OR UPDATE ON staff_messaging_preference
 FOR EACH ROW EXECUTE FUNCTION record_staff_messaging_configuration();

CREATE FUNCTION retain_staff_messaging_configuration_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'STAFF_MESSAGING_CONFIGURATION_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_staff_messaging_configuration_history BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_configuration_history
 FOR EACH ROW EXECUTE FUNCTION retain_staff_messaging_configuration_history();
