CREATE TABLE notification_email_dispatch (
  outbox_id uuid PRIMARY KEY REFERENCES notification_email_outbox(id),
  connection_id uuid NOT NULL REFERENCES operational_email_connection(connection_id),
  state text NOT NULL DEFAULT 'WAITING' CHECK (state IN ('WAITING','SENDING','ACCEPTED','UNKNOWN','SUPPRESSED','DEAD_LETTER')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 5),
  run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  error_code text CHECK (error_code IN ('EMAIL_PREPARATION_FAILED','EMAIL_CONTEXT_CHANGED','EMAIL_OUTCOME_UNKNOWN')),
  CHECK ((state = 'SENDING') = (lease_until IS NOT NULL))
);
CREATE INDEX notification_email_dispatch_waiting ON notification_email_dispatch(run_at,outbox_id) WHERE state='WAITING';
CREATE INDEX notification_email_dispatch_expired ON notification_email_dispatch(lease_until,outbox_id) WHERE state='SENDING';
CREATE UNIQUE INDEX notification_email_dispatch_connection ON notification_email_dispatch(connection_id) WHERE state='SENDING';

CREATE TABLE notification_email_attempt (
  outbox_id uuid PRIMARY KEY REFERENCES notification_email_dispatch(outbox_id),
  connection_version integer NOT NULL,
  binding_version integer NOT NULL,
  preference_version integer NOT NULL,
  language text NOT NULL CHECK (language IN ('ar','en','fr')),
  template_scope text NOT NULL CHECK (template_scope IN ('DEFAULT','GLOBAL','BRANCH','CAMPAIGN')),
  template_version integer NOT NULL CHECK (template_version >= 0),
  created_at timestamptz NOT NULL
);
CREATE TABLE notification_email_dispatch_history (
  outbox_id uuid NOT NULL REFERENCES notification_email_dispatch(outbox_id),
  version integer NOT NULL,
  state text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (outbox_id,version)
);

-- Only private outbox receipts can create dispatch work, including those from Native198.
CREATE FUNCTION attach_notification_email_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_email_dispatch(outbox_id,connection_id)
    SELECT NEW.id,p.connection_id FROM notification_email_publication p WHERE p.event_id=NEW.event_id;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_outbox_dispatch AFTER INSERT ON notification_email_outbox
  FOR EACH ROW EXECUTE FUNCTION attach_notification_email_dispatch();
INSERT INTO notification_email_dispatch(outbox_id,connection_id)
  SELECT o.id,p.connection_id FROM notification_email_outbox o JOIN notification_email_publication p ON p.event_id=o.event_id;

CREATE FUNCTION notification_email_dispatch_allowed(oid uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE o notification_email_outbox; cid uuid;
BEGIN
  SELECT * INTO o FROM notification_email_outbox WHERE id=oid;
  IF o.id IS NULL OR NOT notification_email_recipient_allowed(o.event_id,o.user_id) THEN RETURN false; END IF;
  SELECT connection_id INTO cid FROM notification_email_publication WHERE event_id=o.event_id;
  RETURN EXISTS (
    SELECT 1 FROM integration_connection c JOIN operational_email_connection oe ON oe.connection_id=c.id
    JOIN connection_secret s ON s.connection_id=c.id
    JOIN user_account u ON u.id=o.user_id AND u.credential_state='READY'
    WHERE c.id=cid AND c.status='CONNECTED'
  );
END $$;

CREATE FUNCTION guard_notification_email_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d notification_email_dispatch; o notification_email_outbox; e notification_event;
        p notification_email_publication; pref notification_email_preference; tpl notification_template;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'EMAIL_ATTEMPT_IMMUTABLE'; END IF;
  SELECT * INTO d FROM notification_email_dispatch WHERE outbox_id=NEW.outbox_id FOR UPDATE;
  IF d.state IS DISTINCT FROM 'WAITING' OR d.run_at>clock_timestamp() OR NOT notification_email_dispatch_allowed(NEW.outbox_id)
    THEN RAISE EXCEPTION 'EMAIL_ATTEMPT_AUTHORITY_REQUIRED'; END IF;
  SELECT * INTO o FROM notification_email_outbox WHERE id=d.outbox_id;
  SELECT * INTO e FROM notification_event WHERE id=o.event_id;
  SELECT * INTO p FROM notification_email_publication WHERE event_id=o.event_id;
  SELECT * INTO pref FROM notification_email_preference WHERE user_id=o.user_id AND event_type=e.event_type;
  SELECT t.* INTO tpl FROM notification_template t
    WHERE t.organization_id=e.organization_id AND t.channel='EMAIL' AND t.event_type=e.event_type AND t.language=pref.language AND t.active
      AND ((t.scope='CAMPAIGN' AND t.resource_id=e.campaign_id AND t.branch_id=e.branch_id)
        OR (t.scope='BRANCH' AND t.resource_id=e.branch_id AND t.branch_id=e.branch_id)
        OR (t.scope='GLOBAL' AND t.resource_id=e.organization_id AND t.branch_id IS NULL))
    ORDER BY CASE t.scope WHEN 'CAMPAIGN' THEN 1 WHEN 'BRANCH' THEN 2 ELSE 3 END LIMIT 1 FOR SHARE;
  NEW.connection_version=p.connection_version;
  NEW.binding_version=p.binding_version;
  NEW.preference_version=pref.version;
  NEW.language=pref.language;
  NEW.template_scope=COALESCE(tpl.scope,'DEFAULT');
  NEW.template_version=COALESCE(tpl.version,0);
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_attempt
  FOR EACH ROW EXECUTE FUNCTION guard_notification_email_attempt();

CREATE FUNCTION guard_notification_email_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EMAIL_DISPATCH_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM notification_email_outbox o JOIN notification_email_publication p ON p.event_id=o.event_id
      WHERE o.id=NEW.outbox_id AND p.connection_id=NEW.connection_id AND ai_row_inserted_here(o.xmin)
    ) THEN RAISE EXCEPTION 'EMAIL_OUTBOX_RECEIPT_REQUIRED'; END IF;
    NEW.state='WAITING'; NEW.version=1; NEW.failures=0; NEW.lease_until=NULL; NEW.error_code=NULL;
    NEW.run_at=clock_timestamp(); NEW.changed_at=NEW.run_at;
    RETURN NEW;
  END IF;
  IF (NEW.outbox_id,NEW.connection_id) IS DISTINCT FROM (OLD.outbox_id,OLD.connection_id)
    THEN RAISE EXCEPTION 'EMAIL_DISPATCH_IMMUTABLE'; END IF;
  NEW.changed_at=clock_timestamp(); NEW.version=OLD.version+1; NEW.failures=OLD.failures;
  NEW.run_at=OLD.run_at; NEW.lease_until=NULL; NEW.error_code=NULL;
  IF OLD.state='WAITING' AND OLD.run_at<=NEW.changed_at THEN
    IF NEW.state='SENDING' AND EXISTS(SELECT 1 FROM notification_email_attempt a WHERE a.outbox_id=OLD.outbox_id AND ai_row_inserted_here(a.xmin)) THEN
      NEW.lease_until=NEW.changed_at+interval '2 minutes';
    ELSIF NEW.state='SUPPRESSED' AND NOT notification_email_recipient_allowed(
      (SELECT event_id FROM notification_email_outbox WHERE id=OLD.outbox_id),
      (SELECT user_id FROM notification_email_outbox WHERE id=OLD.outbox_id)) THEN
      NEW.error_code='EMAIL_CONTEXT_CHANGED';
    ELSIF NEW.state='WAITING' AND NOT EXISTS(SELECT 1 FROM notification_email_attempt WHERE outbox_id=OLD.outbox_id) THEN
      NEW.failures=OLD.failures+1;
      NEW.state=CASE WHEN NEW.failures=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
      NEW.error_code='EMAIL_PREPARATION_FAILED';
      NEW.run_at=NEW.changed_at+make_interval(secs=>power(2,NEW.failures-1));
    ELSE RAISE EXCEPTION 'EMAIL_DISPATCH_TRANSITION_INVALID'; END IF;
  ELSIF OLD.state='SENDING' AND NEW.state IN ('ACCEPTED','UNKNOWN','SUPPRESSED') THEN
    IF NEW.state='ACCEPTED' AND OLD.lease_until<=NEW.changed_at THEN NEW.state='UNKNOWN'; END IF;
    IF NEW.state='UNKNOWN' THEN NEW.error_code='EMAIL_OUTCOME_UNKNOWN'; END IF;
    IF NEW.state='SUPPRESSED' THEN NEW.error_code='EMAIL_CONTEXT_CHANGED'; END IF;
  ELSIF OLD.state='DEAD_LETTER' AND NEW.state='WAITING' AND EXISTS (
    SELECT 1 FROM notification_email_dispatch_recovery r
    WHERE r.outbox_id=OLD.outbox_id AND r.version=OLD.version AND ai_row_inserted_here(r.xmin)
  ) THEN
    NEW.failures=0; NEW.run_at=NEW.changed_at;
  ELSE RAISE EXCEPTION 'EMAIL_DISPATCH_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE notification_email_dispatch_recovery (
  outbox_id uuid NOT NULL REFERENCES notification_email_dispatch(outbox_id),
  version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_account(id),
  session_id uuid NOT NULL REFERENCES user_session(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(outbox_id,version)
);
CREATE TRIGGER notification_email_dispatch_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_dispatch
  FOR EACH ROW EXECUTE FUNCTION guard_notification_email_dispatch();

CREATE FUNCTION prove_notification_email_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM notification_email_dispatch d WHERE d.outbox_id=NEW.outbox_id AND d.state='SENDING' AND ai_row_inserted_here(d.xmin))
    THEN RAISE EXCEPTION 'EMAIL_COMMITTED_DISPATCH_REQUIRED'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_email_attempt_dispatch_proof AFTER INSERT ON notification_email_attempt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_notification_email_attempt();

CREATE FUNCTION record_notification_email_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p notification_email_publication; actor uuid;
BEGIN
  SELECT j.* INTO p FROM notification_email_outbox o JOIN notification_email_publication j ON j.event_id=o.event_id WHERE o.id=NEW.outbox_id;
  SELECT actor_id INTO actor FROM notification_email_dispatch_recovery WHERE outbox_id=NEW.outbox_id AND version=OLD.version;
  INSERT INTO notification_email_dispatch_history VALUES (NEW.outbox_id,NEW.version,NEW.state,NEW.error_code,NEW.changed_at);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (p.organization_id,p.branch_id,actor,'EMAIL_NOTIFICATION_DISPATCH_CHANGED','EMAIL_DELIVERY',NEW.outbox_id,
      jsonb_build_object('state',NEW.state,'code',NEW.error_code,'version',NEW.version));
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_dispatch_record AFTER UPDATE ON notification_email_dispatch
  FOR EACH ROW EXECUTE FUNCTION record_notification_email_dispatch();
CREATE FUNCTION guard_notification_email_dispatch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS (SELECT 1 FROM notification_email_dispatch d WHERE d.outbox_id=NEW.outbox_id
    AND (d.version,d.state,d.error_code,d.changed_at) IS NOT DISTINCT FROM (NEW.version,NEW.state,NEW.error_code,NEW.created_at)
    AND ai_row_inserted_here(d.xmin)) THEN RAISE EXCEPTION 'EMAIL_DISPATCH_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_dispatch_history_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_dispatch_history
  FOR EACH ROW EXECUTE FUNCTION guard_notification_email_dispatch_history();

CREATE FUNCTION recover_notification_email_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d notification_email_dispatch; recipient uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_RECOVERY_IMMUTABLE'; END IF;
  SELECT * INTO d FROM notification_email_dispatch WHERE outbox_id=NEW.outbox_id FOR UPDATE;
  SELECT user_id INTO recipient FROM notification_email_outbox WHERE id=NEW.outbox_id;
  IF d.state IS DISTINCT FROM 'DEAD_LETTER' OR d.version<>NEW.version OR recipient IS DISTINCT FROM NEW.actor_id
    OR EXISTS (SELECT 1 FROM notification_email_attempt WHERE outbox_id=NEW.outbox_id)
    OR NOT notification_email_dispatch_allowed(NEW.outbox_id)
    OR NOT EXISTS (SELECT 1 FROM user_session s WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE)
    THEN RAISE EXCEPTION 'EMAIL_RECOVERY_AUTHORITY_REQUIRED'; END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_dispatch_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_dispatch_recovery
  FOR EACH ROW EXECUTE FUNCTION recover_notification_email_dispatch();
CREATE FUNCTION apply_notification_email_dispatch_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE notification_email_dispatch SET state='WAITING' WHERE outbox_id=NEW.outbox_id;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_dispatch_recovery_apply AFTER INSERT ON notification_email_dispatch_recovery
  FOR EACH ROW EXECUTE FUNCTION apply_notification_email_dispatch_recovery();

CREATE TABLE notification_email_page_retry (
  event_id uuid NOT NULL REFERENCES notification_email_publication(event_id),
  page_version integer NOT NULL,
  sequence integer NOT NULL,
  failures integer NOT NULL CHECK (failures BETWEEN 0 AND 5),
  actor_id uuid REFERENCES user_account(id),
  session_id uuid REFERENCES user_session(id),
  run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (event_id,page_version,sequence)
);
CREATE FUNCTION guard_notification_email_page_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p notification_email_publication; prev notification_email_page_retry;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EMAIL_PAGE_RETRY_IMMUTABLE'; END IF;
  SELECT * INTO p FROM notification_email_publication WHERE event_id=NEW.event_id FOR UPDATE;
  IF p.state IS DISTINCT FROM 'WAITING' OR NEW.page_version IS DISTINCT FROM p.version
    THEN RAISE EXCEPTION 'EMAIL_PAGE_VERSION_INVALID'; END IF;
  SELECT * INTO prev FROM notification_email_page_retry WHERE event_id=p.event_id AND page_version=p.version
    ORDER BY sequence DESC LIMIT 1;
  NEW.sequence=COALESCE(prev.sequence,0)+1;
  NEW.created_at=clock_timestamp();
  IF NEW.actor_id IS NULL THEN
    IF NEW.session_id IS NOT NULL OR prev.failures=5 OR prev.run_at>NEW.created_at
      THEN RAISE EXCEPTION 'EMAIL_PAGE_RETRY_INVALID'; END IF;
    NEW.failures=COALESCE(prev.failures,0)+1;
    NEW.run_at=NEW.created_at+make_interval(secs=>power(2,NEW.failures-1));
  ELSE
    IF prev.failures IS DISTINCT FROM 5 OR NOT EXISTS (
      SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=NEW.actor_id AND u.active
        AND u.organization_id=p.organization_id AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=p.branch_id)
        AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s
    ) THEN RAISE EXCEPTION 'EMAIL_PAGE_RECOVERY_AUTHORITY_REQUIRED'; END IF;
    NEW.failures=0;
    NEW.run_at=NEW.created_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_page_retry_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_email_page_retry
  FOR EACH ROW EXECUTE FUNCTION guard_notification_email_page_retry();
CREATE FUNCTION audit_notification_email_page_retry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT p.organization_id,p.branch_id,NEW.actor_id,
      CASE WHEN NEW.actor_id IS NULL THEN 'EMAIL_NOTIFICATION_PAGE_FAILED' ELSE 'EMAIL_NOTIFICATION_PAGE_RETRIED' END,
      'NOTIFICATION_EVENT',NEW.event_id,jsonb_build_object('pageVersion',NEW.page_version,'failures',NEW.failures)
    FROM notification_email_publication p WHERE p.event_id=NEW.event_id;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_email_page_retry_audit AFTER INSERT ON notification_email_page_retry
  FOR EACH ROW EXECUTE FUNCTION audit_notification_email_page_retry();
