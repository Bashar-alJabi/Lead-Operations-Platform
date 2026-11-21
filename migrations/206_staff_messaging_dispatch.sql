CREATE TABLE staff_messaging_dispatch (
 event_id uuid NOT NULL,
 user_id uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES integration_connection(id),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','SENDING','ACCEPTED','UNKNOWN','REJECTED','SUPPRESSED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text CHECK(error_code IN ('STAFF_MESSAGING_CONTEXT_CHANGED','STAFF_MESSAGING_TRANSPORT_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED','PROVIDER_SEND_REJECTED','PROVIDER_SEND_OUTCOME_UNKNOWN')),
 provider_message_id text CHECK(length(provider_message_id) BETWEEN 1 AND 255 AND provider_message_id !~ '[[:cntrl:][:space:]]'),
 PRIMARY KEY(event_id,user_id),
 FOREIGN KEY(event_id,user_id) REFERENCES staff_messaging_outbox(event_id,user_id),
 CHECK((state='SENDING')=(lease_until IS NOT NULL)),
 CHECK((state='ACCEPTED')=(provider_message_id IS NOT NULL))
);
CREATE INDEX staff_messaging_dispatch_wait ON staff_messaging_dispatch(run_at,event_id,user_id) WHERE state='WAITING';
CREATE INDEX staff_messaging_dispatch_expire ON staff_messaging_dispatch(lease_until,event_id,user_id) WHERE state='SENDING';
CREATE UNIQUE INDEX staff_messaging_dispatch_per_connection ON staff_messaging_dispatch(connection_id) WHERE state='SENDING';
CREATE UNIQUE INDEX staff_messaging_provider_message ON staff_messaging_dispatch(connection_id,provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE staff_messaging_dispatch_history (
 event_id uuid NOT NULL,
 user_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 state text NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 3),
 error_code text,
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(event_id,user_id,version),
 FOREIGN KEY(event_id,user_id) REFERENCES staff_messaging_dispatch(event_id,user_id)
);

CREATE FUNCTION staff_messaging_outbox_connection(eid uuid,uid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT r.connection_id FROM staff_messaging_outbox o JOIN notification_event e ON e.id=o.event_id
 JOIN staff_messaging_configuration_history h ON h.kind='BINDING' AND h.resource_id=e.branch_id AND h.event_type=e.event_type
  AND h.key_language=o.language AND h.version=o.binding_version
 JOIN staff_messaging_sender r ON r.sender_id=(h.snapshot->>'senderId')::uuid
  AND r.branch_id=e.branch_id AND r.organization_id=e.organization_id
 WHERE o.event_id=eid AND o.user_id=uid
$$;

-- Authorization and readiness are distinct from the durable result of an already-started attempt.
CREATE FUNCTION staff_messaging_dispatch_context(eid uuid,uid uuid)
 RETURNS TABLE(connection_id uuid,sender_id uuid,template_id uuid,available_at timestamptz) LANGUAGE sql STABLE AS $$
 SELECT b.connection_id,b.sender_id,b.template_id,
   GREATEST(COALESCE(c.cooldown_until,'-infinity'),COALESCE(s.cooldown_until,'-infinity'))
 FROM staff_messaging_outbox o
 CROSS JOIN LATERAL staff_messaging_current_binding(o.event_id,o.language,o.binding_version) b
 CROSS JOIN LATERAL staff_messaging_recipient(o.event_id,o.user_id,o.language) r
 JOIN user_account u ON u.id=o.user_id AND u.credential_state='READY'
 JOIN integration_connection c ON c.id=b.connection_id
 JOIN connection_secret secret ON secret.connection_id=c.id
 JOIN messaging_sender s ON s.id=b.sender_id
 WHERE o.event_id=eid AND o.user_id=uid AND b.connection_version=o.connection_version
  AND r.preference_version=o.preference_version AND r.destination_version=o.destination_version
  AND (c.status='CONNECTED' AND s.health IN ('HEALTHY','DEGRADED') OR
       c.status='WARNING' AND c.capabilities->'senderDiscovery'='true'::jsonb
         AND c.last_error_code='SEND_NOT_TESTED' AND s.health IN ('UNKNOWN','HEALTHY','DEGRADED'))
$$;

CREATE FUNCTION guard_staff_messaging_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STAFF_MESSAGING_DISPATCH_RETAINED'; END IF;
 NEW.changed_at=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM staff_messaging_outbox o
     WHERE o.event_id=NEW.event_id AND o.user_id=NEW.user_id AND ai_row_inserted_here(o.xmin))
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_PREPARATION_REQUIRED'; END IF;
  NEW.connection_id=staff_messaging_outbox_connection(NEW.event_id,NEW.user_id);
  NEW.state='WAITING'; NEW.run_at=NEW.changed_at; NEW.version=1; NEW.attempts=0;
  NEW.lease_until=NULL; NEW.error_code=NULL; NEW.provider_message_id=NULL;
  RETURN NEW;
 END IF;
 IF (NEW.event_id,NEW.user_id,NEW.connection_id) IS DISTINCT FROM (OLD.event_id,OLD.user_id,OLD.connection_id)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STAFF_MESSAGING_DISPATCH_VERSION_REQUIRED'; END IF;
 NEW.attempts=OLD.attempts;
 NEW.provider_message_id=CASE WHEN NEW.state='ACCEPTED' THEN NEW.provider_message_id END;
 IF OLD.state='WAITING' AND NEW.state='SENDING' AND OLD.run_at<=NEW.changed_at AND OLD.attempts<3 THEN
  IF NOT EXISTS(SELECT 1 FROM staff_messaging_dispatch_context(NEW.event_id,NEW.user_id) b
       WHERE b.connection_id=NEW.connection_id AND b.available_at<=NEW.changed_at)
   THEN RAISE EXCEPTION 'STAFF_MESSAGING_DISPATCH_AUTHORITY_REQUIRED'; END IF;
  NEW.attempts=OLD.attempts+1; NEW.error_code=NULL;
  NEW.lease_until=NEW.changed_at+interval '45 seconds';
  NEW.run_at=OLD.run_at;
  RETURN NEW;
 END IF;
 NEW.lease_until=NULL;
 IF OLD.state='SENDING' AND NEW.state='WAITING' AND OLD.attempts<3 AND NEW.error_code='PROVIDER_RATE_LIMITED'
       AND OLD.lease_until>NEW.changed_at THEN
  NEW.run_at=GREATEST(NEW.changed_at+interval '1 second',LEAST(NEW.run_at,NEW.changed_at+interval '1 hour'));
 ELSIF OLD.state='WAITING' AND NEW.state='WAITING' AND NEW.error_code='PROVIDER_RATE_LIMITED' AND NEW.run_at>OLD.run_at THEN
  SELECT GREATEST(OLD.run_at,(SELECT available_at FROM staff_messaging_dispatch_context(NEW.event_id,NEW.user_id))) INTO NEW.run_at;
  IF NEW.run_at<=NEW.changed_at THEN RAISE EXCEPTION 'STAFF_MESSAGING_COOLDOWN_REQUIRED'; END IF;
 ELSIF OLD.state='WAITING' AND NEW.state='SUPPRESSED' AND
       NEW.error_code IN ('STAFF_MESSAGING_CONTEXT_CHANGED','STAFF_MESSAGING_TRANSPORT_UNAVAILABLE') THEN
  NEW.run_at='infinity';
 ELSIF OLD.state='SENDING' AND NEW.state='UNKNOWN' AND NEW.error_code='PROVIDER_SEND_OUTCOME_UNKNOWN' THEN
  NEW.run_at='infinity';
 ELSIF OLD.state='SENDING' AND OLD.lease_until>NEW.changed_at AND
     (NEW.state='ACCEPTED' AND NEW.error_code IS NULL OR
      NEW.state='REJECTED' AND NEW.error_code IN ('PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED','PROVIDER_SEND_REJECTED') OR
      NEW.state='SUPPRESSED' AND NEW.error_code IN ('STAFF_MESSAGING_CONTEXT_CHANGED','STAFF_MESSAGING_TRANSPORT_UNAVAILABLE')) THEN
  NEW.run_at='infinity';
 ELSE RAISE EXCEPTION 'STAFF_MESSAGING_DISPATCH_TRANSITION_INVALID';
 END IF;
 RETURN NEW;
END $$;

-- Existing preparation receipts may be queued only with the same frozen connection and current authorization.
INSERT INTO staff_messaging_dispatch(event_id,user_id,connection_id)
 SELECT o.event_id,o.user_id,b.connection_id FROM staff_messaging_outbox o
 CROSS JOIN LATERAL staff_messaging_dispatch_context(o.event_id,o.user_id) b;
INSERT INTO staff_messaging_dispatch_history(event_id,user_id,version,state,attempts,changed_at)
 SELECT event_id,user_id,version,state,attempts,changed_at FROM staff_messaging_dispatch;

CREATE TRIGGER staff_messaging_dispatch_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_dispatch
 FOR EACH ROW EXECUTE FUNCTION guard_staff_messaging_dispatch();

CREATE FUNCTION add_staff_messaging_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO staff_messaging_dispatch(event_id,user_id,connection_id)
 VALUES(NEW.event_id,NEW.user_id,staff_messaging_outbox_connection(NEW.event_id,NEW.user_id));
 RETURN NEW;
END $$;
CREATE TRIGGER add_staff_messaging_dispatch AFTER INSERT ON staff_messaging_outbox
 FOR EACH ROW EXECUTE FUNCTION add_staff_messaging_dispatch();

CREATE FUNCTION retain_staff_messaging_dispatch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'STAFF_MESSAGING_DISPATCH_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_staff_messaging_dispatch_history BEFORE INSERT OR UPDATE OR DELETE ON staff_messaging_dispatch_history
 FOR EACH ROW EXECUTE FUNCTION retain_staff_messaging_dispatch_history();

CREATE FUNCTION record_staff_messaging_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event;
BEGIN
 INSERT INTO staff_messaging_dispatch_history(event_id,user_id,version,state,attempts,error_code,changed_at)
 VALUES(NEW.event_id,NEW.user_id,NEW.version,NEW.state,NEW.attempts,NEW.error_code,NEW.changed_at);
 SELECT * INTO e FROM notification_event WHERE id=NEW.event_id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES(e.organization_id,e.branch_id,'STAFF_MESSAGING_DISPATCH_CHANGED','NOTIFICATION_EVENT',e.id,
  jsonb_build_object('recipientId',NEW.user_id,'version',NEW.version,'attempts',NEW.attempts,'state',NEW.state,'code',NEW.error_code));
 RETURN NEW;
END $$;
CREATE TRIGGER record_staff_messaging_dispatch AFTER INSERT OR UPDATE ON staff_messaging_dispatch
 FOR EACH ROW EXECUTE FUNCTION record_staff_messaging_dispatch();
