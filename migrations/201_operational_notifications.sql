CREATE TABLE operational_notification_source (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ordinal bigint GENERATED ALWAYS AS IDENTITY,
 event_type text NOT NULL CHECK(event_type IN ('INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT')),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid,
 connection_id uuid REFERENCES integration_connection(id),
 inbound_event_id uuid UNIQUE REFERENCES integration_event(id),
 lead_attention_source_id uuid REFERENCES lead_attention_transition(id),
 source_version integer,
 condition text CHECK(condition IN ('UNRESOLVED','ERROR','WARNING','DISCONNECTED','AUTH_EXPIRED','LEAD_NOTIFICATION_FAILED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id),
 UNIQUE(lead_attention_source_id,source_version),
 CHECK(
   (event_type='INBOUND_REVIEW_REQUIRED' AND connection_id IS NOT NULL AND inbound_event_id IS NOT NULL
     AND lead_attention_source_id IS NULL AND source_version IS NULL AND condition IS NOT DISTINCT FROM 'UNRESOLVED')
   OR (event_type='INTEGRATION_ALERT' AND connection_id IS NOT NULL AND inbound_event_id IS NULL
     AND lead_attention_source_id IS NULL AND source_version IS NULL
     AND (condition IS NULL OR condition IN ('ERROR','WARNING','DISCONNECTED','AUTH_EXPIRED')))
   OR (event_type='SYSTEM_ALERT' AND connection_id IS NULL AND inbound_event_id IS NULL
     AND lead_attention_source_id IS NOT NULL AND branch_id IS NOT NULL AND source_version IS NOT NULL
     AND condition IS NOT DISTINCT FROM 'LEAD_NOTIFICATION_FAILED')
 )
);
CREATE INDEX operational_notification_health_latest
 ON operational_notification_source(connection_id,ordinal DESC) WHERE event_type='INTEGRATION_ALERT';

CREATE TABLE operational_notification_queue (
 source_id uuid PRIMARY KEY REFERENCES operational_notification_source(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','RECORDED','STALE_SCOPE','DEAD_LETTER')),
 operation text NOT NULL DEFAULT 'ADMIT' CHECK(operation IN ('ADMIT','PUBLISH','FAILURE','RETRY')),
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid REFERENCES user_account(id),
 session_id uuid REFERENCES user_session(id),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operational_notification_queue_ready ON operational_notification_queue(run_at,source_id) WHERE state='WAITING';
CREATE INDEX operational_notification_queue_failed ON operational_notification_queue(changed_at DESC,source_id) WHERE state='DEAD_LETTER';

CREATE FUNCTION operational_notification_scope(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM operational_notification_source s LEFT JOIN integration_connection c ON c.id=s.connection_id
  WHERE s.id=source AND
   ((s.connection_id IS NOT NULL AND c.organization_id=s.organization_id AND c.branch_id IS NOT DISTINCT FROM s.branch_id)
    OR (s.event_type='SYSTEM_ALERT' AND lead_attention_scope(s.lead_attention_source_id)))
 )
$$;

CREATE FUNCTION operational_notification_current(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((
  SELECT CASE s.event_type
   WHEN 'INBOUND_REVIEW_REQUIRED' THEN e.state='NEEDS_ATTENTION' AND e.failure_code IS DISTINCT FROM 'INBOUND_PROCESSING_NOT_READY'
   WHEN 'INTEGRATION_ALERT' THEN s.condition IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM operational_notification_source newer WHERE newer.connection_id=s.connection_id
      AND newer.event_type='INTEGRATION_ALERT' AND newer.ordinal>s.ordinal)
   WHEN 'SYSTEM_ALERT' THEN q.state='DEAD_LETTER' AND q.version=s.source_version END
  FROM operational_notification_source s LEFT JOIN integration_event e ON e.id=s.inbound_event_id
  LEFT JOIN lead_attention_queue q ON q.source_id=s.lead_attention_source_id WHERE s.id=source
 ),false)
$$;

-- Bootstrap existing cases that still need attention. Resolved cases stay in their original history.
INSERT INTO operational_notification_source(event_type,organization_id,branch_id,connection_id,inbound_event_id,condition,created_at)
 SELECT 'INBOUND_REVIEW_REQUIRED',c.organization_id,c.branch_id,c.id,e.id,'UNRESOLVED',e.received_at
 FROM integration_event e JOIN messaging_inbound_authentication a ON a.event_id=e.id
 JOIN integration_connection c ON c.id=e.connection_id AND c.kind='MESSAGING'
 WHERE e.event_kind='INBOUND_MESSAGE' AND e.state='NEEDS_ATTENTION' AND e.failure_code IS DISTINCT FROM 'INBOUND_PROCESSING_NOT_READY'
   AND a.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex');
INSERT INTO operational_notification_source(event_type,organization_id,branch_id,connection_id,condition,created_at)
 SELECT 'INTEGRATION_ALERT',organization_id,branch_id,id,status,COALESCE(last_failure_at,updated_at)
 FROM integration_connection WHERE status IN ('ERROR','WARNING','DISCONNECTED','AUTH_EXPIRED');
INSERT INTO operational_notification_source(event_type,organization_id,branch_id,lead_attention_source_id,source_version,condition,created_at)
 SELECT 'SYSTEM_ALERT',s.organization_id,s.branch_id,s.id,q.version,'LEAD_NOTIFICATION_FAILED',q.changed_at
 FROM lead_attention_queue q JOIN lead_attention_transition s ON s.id=q.source_id
 WHERE q.state='DEAD_LETTER' AND lead_attention_scope(s.id);
INSERT INTO operational_notification_queue(source_id) SELECT id FROM operational_notification_source;

CREATE FUNCTION guard_operational_notification_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_SOURCE_IMMUTABLE'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER operational_notification_source_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_notification_source
 FOR EACH ROW EXECUTE FUNCTION guard_operational_notification_source();

CREATE FUNCTION capture_inbound_review_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO operational_notification_source(event_type,organization_id,branch_id,connection_id,inbound_event_id,condition)
  SELECT 'INBOUND_REVIEW_REQUIRED',c.organization_id,c.branch_id,c.id,NEW.id,'UNRESOLVED'
  FROM integration_connection c JOIN messaging_inbound_authentication a ON a.event_id=NEW.id
  WHERE c.id=NEW.connection_id AND c.kind='MESSAGING'
    AND a.payload_sha256=encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex')
  ON CONFLICT(inbound_event_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_inbound_review_notification AFTER UPDATE OF state,failure_code ON integration_event
 FOR EACH ROW WHEN(NEW.event_kind='INBOUND_MESSAGE' AND NEW.state='NEEDS_ATTENTION'
  AND NEW.failure_code IS DISTINCT FROM 'INBOUND_PROCESSING_NOT_READY'
  AND (OLD.state<>'NEEDS_ATTENTION' OR OLD.failure_code='INBOUND_PROCESSING_NOT_READY'))
 EXECUTE FUNCTION capture_inbound_review_notification();

CREATE FUNCTION capture_integration_health_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unhealthy boolean;
BEGIN
 unhealthy=NEW.status IN ('ERROR','WARNING','DISCONNECTED','AUTH_EXPIRED');
 IF TG_OP='INSERT' THEN
  IF NOT unhealthy THEN RETURN NEW; END IF;
 ELSE
  IF OLD.status=NEW.status OR (NOT unhealthy AND OLD.status NOT IN ('ERROR','WARNING','DISCONNECTED','AUTH_EXPIRED'))
   THEN RETURN NEW; END IF;
 END IF;
 INSERT INTO operational_notification_source(event_type,organization_id,branch_id,connection_id,condition)
 VALUES('INTEGRATION_ALERT',NEW.organization_id,NEW.branch_id,NEW.id,CASE WHEN unhealthy THEN NEW.status END);
 RETURN NEW;
END $$;
CREATE TRIGGER capture_integration_health_notification AFTER INSERT OR UPDATE OF status ON integration_connection
 FOR EACH ROW EXECUTE FUNCTION capture_integration_health_notification();

CREATE FUNCTION capture_notification_worker_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO operational_notification_source(event_type,organization_id,branch_id,lead_attention_source_id,source_version,condition)
 SELECT 'SYSTEM_ALERT',s.organization_id,s.branch_id,s.id,NEW.version,'LEAD_NOTIFICATION_FAILED'
 FROM lead_attention_transition s WHERE s.id=NEW.source_id;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_notification_worker_failure AFTER UPDATE ON lead_attention_queue
 FOR EACH ROW WHEN(NEW.state='DEAD_LETTER' AND OLD.state<>'DEAD_LETTER') EXECUTE FUNCTION capture_notification_worker_failure();

CREATE FUNCTION queue_operational_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.condition IS NOT NULL THEN INSERT INTO operational_notification_queue(source_id) VALUES(NEW.id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_operational_notification AFTER INSERT ON operational_notification_source
 FOR EACH ROW EXECUTE FUNCTION queue_operational_notification();

CREATE FUNCTION guard_operational_notification_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source operational_notification_source;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_QUEUE_RETAINED'; END IF;
 SELECT * INTO source FROM operational_notification_source WHERE id=NEW.source_id;
 IF source.condition IS NULL THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_SOURCE_REQUIRED'; END IF;
 NEW.changed_at=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<3 OR NOT ai_row_inserted_here((SELECT xmin FROM operational_notification_source WHERE id=source.id))
   THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_SOURCE_REQUIRED'; END IF;
  NEW.version=1; NEW.operation='ADMIT'; NEW.state='WAITING'; NEW.failures=0; NEW.run_at=NEW.changed_at;
 ELSE
  IF NEW.source_id<>OLD.source_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_VERSION_REQUIRED'; END IF;
  IF OLD.state='WAITING' AND OLD.run_at<=NEW.changed_at AND NEW.operation IN ('PUBLISH','FAILURE') THEN
   IF NEW.operation='PUBLISH' THEN
    NEW.state=CASE WHEN operational_notification_scope(source.id) THEN 'RECORDED' ELSE 'STALE_SCOPE' END;
    NEW.failures=OLD.failures; NEW.run_at='infinity';
   ELSE
    NEW.failures=OLD.failures+1;
    NEW.state=CASE WHEN NEW.failures=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
    NEW.run_at=NEW.changed_at+make_interval(secs=>power(2,NEW.failures-1));
   END IF;
  ELSIF NEW.operation='RETRY' AND OLD.state='DEAD_LETTER' AND operational_notification_scope(source.id) THEN
   IF NOT EXISTS (
    SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
    WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=source.organization_id
     AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=source.branch_id)
     AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s
   ) THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_RETRY_DENIED'; END IF;
   NEW.state='WAITING'; NEW.failures=0; NEW.run_at=NEW.changed_at;
  ELSE RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_OPERATION_INVALID'; END IF;
 END IF;
 IF NEW.operation<>'RETRY' THEN NEW.actor_id=NULL; NEW.session_id=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operational_notification_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_notification_queue
 FOR EACH ROW EXECUTE FUNCTION guard_operational_notification_queue();

ALTER TABLE notification_event
 ADD COLUMN operational_source_id uuid UNIQUE REFERENCES operational_notification_source(id),
 ALTER COLUMN branch_id DROP NOT NULL,
 ALTER COLUMN campaign_id DROP NOT NULL,
 ALTER COLUMN lead_id DROP NOT NULL;
DO $$
DECLARE target text; expression text;
BEGIN
 FOREACH target IN ARRAY ARRAY['notification_event','notification_preference','notification_template','notification_email_preference'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=target::regclass AND conname=target||'_event_type_check';
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target,target||'_event_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR event_type IN (''INBOUND_REVIEW_REQUIRED'',''INTEGRATION_ALERT'',''SYSTEM_ALERT''))',
   target,target||'_event_type_check',expression);
 END LOOP;
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
 WHERE conrelid='notification_event'::regclass AND conname='notification_event_source_shape';
 ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
 EXECUTE format('ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK (
  ((%s) AND operational_source_id IS NULL AND branch_id IS NOT NULL AND campaign_id IS NOT NULL AND lead_id IS NOT NULL)
  OR (event_type IN (''INBOUND_REVIEW_REQUIRED'',''INTEGRATION_ALERT'',''SYSTEM_ALERT'') AND operational_source_id IS NOT NULL
   AND source_id=operational_source_id AND campaign_id IS NULL AND lead_id IS NULL AND conversation_id IS NULL
   AND lead_attention_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL
   AND follow_up_due_id IS NULL AND payment_id IS NULL AND enrollment_id IS NULL AND conversation_attention_id IS NULL
   AND automation_execution_id IS NULL))',expression);
END $$;
ALTER TABLE notification_template ADD CONSTRAINT notification_operational_template_shape CHECK(
 event_type NOT IN ('INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT')
 OR (scope IN ('BRANCH','GLOBAL') AND title !~ '[{}]' AND body !~ '[{}]')
);

CREATE FUNCTION guard_operational_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source operational_notification_source;
BEGIN
 SELECT s.* INTO source FROM operational_notification_source s JOIN operational_notification_queue q ON q.source_id=s.id
 WHERE s.id=NEW.operational_source_id AND q.state='RECORDED' AND q.operation='PUBLISH'
  AND ai_row_inserted_here(q.xmin);
 IF pg_trigger_depth()<2 OR source.id IS NULL OR source.event_type<>NEW.event_type OR NOT operational_notification_scope(source.id)
  THEN RAISE EXCEPTION 'OPERATIONAL_NOTIFICATION_PUBLICATION_REQUIRED'; END IF;
 NEW.source_id=source.id; NEW.organization_id=source.organization_id; NEW.branch_id=source.branch_id;
 NEW.created_at=source.created_at;
 RETURN NEW;
END $$;
CREATE TRIGGER operational_notification_event_guard BEFORE INSERT ON notification_event
 FOR EACH ROW WHEN(NEW.event_type IN ('INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT'))
 EXECUTE FUNCTION guard_operational_notification_event();

CREATE FUNCTION record_operational_notification_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source operational_notification_source;
BEGIN
 SELECT * INTO source FROM operational_notification_source WHERE id=NEW.source_id;
 IF NEW.state='RECORDED' THEN
  INSERT INTO notification_event(event_type,operational_source_id) VALUES(source.event_type,source.id);
 END IF;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(source.organization_id,source.branch_id,NEW.actor_id,'OPERATIONAL_NOTIFICATION_CHANGED','OPERATIONAL_NOTIFICATION',source.id,
   jsonb_build_object('eventType',source.event_type,'state',NEW.state,'version',NEW.version,'operation',NEW.operation));
 RETURN NEW;
END $$;
CREATE TRIGGER operational_notification_queue_record AFTER UPDATE ON operational_notification_queue
 FOR EACH ROW EXECUTE FUNCTION record_operational_notification_queue();

CREATE OR REPLACE FUNCTION notification_access(eid uuid,uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM notification_event e
  JOIN user_account u ON u.id=uid AND u.active AND u.organization_id=e.organization_id
  LEFT JOIN lead l ON l.id=e.lead_id AND (l.organization_id,l.branch_id,l.campaign_id)=(e.organization_id,e.branch_id,e.campaign_id)
  LEFT JOIN campaign c ON (c.id,c.branch_id,c.organization_id)=(l.campaign_id,l.branch_id,l.organization_id)
  LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
  LEFT JOIN follow_up f ON f.id=e.follow_up_id AND f.lead_id=l.id
  WHERE e.id=eid AND
   ((e.operational_source_id IS NOT NULL AND operational_notification_scope(e.operational_source_id)
     AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=e.branch_id))
    OR (e.operational_source_id IS NULL AND c.id IS NOT NULL AND (e.conversation_id IS NULL OR cv.id IS NOT NULL)
     AND (e.follow_up_id IS NULL OR f.id IS NOT NULL)
     AND (u.role='SUPER_ADMIN' OR u.branch_id=e.branch_id AND
      (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id AND (e.follow_up_id IS NULL OR f.owner_user_id=u.id)))))
 )
$$;

CREATE OR REPLACE FUNCTION notification_email_audience(eid uuid,after_uid uuid) RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE AS $$
 SELECT u.id FROM notification_email_publication j JOIN notification_event e ON e.id=j.event_id
 JOIN notification_email_preference p ON p.event_type=e.event_type AND p.enabled AND p.enabled_since<=j.created_at
 JOIN user_account u ON u.id=p.user_id AND u.active AND u.organization_id=j.organization_id
 WHERE j.event_id=eid AND (after_uid IS NULL OR u.id>after_uid)
  AND (u.role='SUPER_ADMIN' OR u.branch_id=j.branch_id AND
   (u.role='MANAGER' OR u.role='AGENT' AND e.lead_id IS NOT NULL))
 ORDER BY u.id LIMIT 26
$$;
