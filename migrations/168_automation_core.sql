-- Typed, approved internal actions only. No customer sends, financial writes or arbitrary expressions.
CREATE TABLE automation_rule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid REFERENCES branch(id), campaign_id uuid REFERENCES campaign(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), version integer NOT NULL CHECK(version>0),
 enabled boolean NOT NULL, trigger_type text NOT NULL CHECK(trigger_type IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED')),
 lifecycle text CHECK(lifecycle IN ('OPEN','CLOSED','ARCHIVED')),
 owner_condition text NOT NULL CHECK(owner_condition IN ('ANY','ASSIGNED','UNASSIGNED')),
 action_type text NOT NULL CHECK(action_type IN ('CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION')),
 delay_minutes integer NOT NULL CHECK(delay_minutes BETWEEN 0 AND 525600),
 priority text NOT NULL CHECK(priority IN ('LOW','NORMAL','HIGH')), note text NOT NULL CHECK(length(note)<=4000),
 actor_id uuid NOT NULL REFERENCES user_account(id), session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500), approval_xid xid8 NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CHECK(campaign_id IS NULL OR branch_id IS NOT NULL),
 CHECK(action_type='CREATE_FOLLOW_UP' OR delay_minutes=0 AND priority='NORMAL')
);
CREATE INDEX automation_rule_page ON automation_rule(organization_id,branch_id,created_at DESC,id DESC);
CREATE TABLE automation_rule_version (
 rule_id uuid NOT NULL REFERENCES automation_rule(id), version integer NOT NULL,
 snapshot jsonb NOT NULL, approval_xid xid8 NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(rule_id,version)
);
CREATE FUNCTION automation_manage_allowed(oid uuid,bid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=uid AND u.active AND u.organization_id=oid AND s.id=sid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND bid IS NOT NULL AND u.branch_id=bid) FOR SHARE OF u,s)
$$;
CREATE FUNCTION guard_automation_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AUTOMATION_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND
  (NEW.version<>OLD.version+1 OR (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.created_at))
  THEN RAISE EXCEPTION 'AUTOMATION_VERSION_IDENTITY_REQUIRED';END IF;
 IF NEW.branch_id IS NOT NULL THEN
  PERFORM 1 FROM branch WHERE id=NEW.branch_id AND organization_id=NEW.organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_SCOPE_REQUIRED';END IF;
 END IF;
 IF NEW.campaign_id IS NOT NULL THEN
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id AND branch_id=NEW.branch_id AND organization_id=NEW.organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_SCOPE_REQUIRED';END IF;
 END IF;
 IF NOT automation_manage_allowed(NEW.organization_id,NEW.branch_id,NEW.actor_id,NEW.session_id)
  THEN RAISE EXCEPTION 'AUTOMATION_CURRENT_APPROVAL_REQUIRED';END IF;
 NEW.name=trim(NEW.name);NEW.note=trim(NEW.note);NEW.reason=trim(NEW.reason);
 NEW.approval_xid=pg_current_xact_id();NEW.updated_at=clock_timestamp();
 IF TG_OP='INSERT' THEN NEW.created_at=NEW.updated_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_rule FOR EACH ROW EXECUTE FUNCTION guard_automation_rule();
CREATE FUNCTION guard_automation_rule_version() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r automation_rule;x xid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_HISTORY_IMMUTABLE';END IF;
 SELECT * INTO r FROM automation_rule WHERE id=NEW.rule_id AND version=NEW.version;
 SELECT xmin INTO x FROM automation_rule WHERE id=NEW.rule_id AND version=NEW.version;
 IF r IS NULL OR NOT ai_row_inserted_here(x) OR pg_trigger_depth()<2 OR NEW.snapshot IS DISTINCT FROM to_jsonb(r)
  THEN RAISE EXCEPTION 'AUTOMATION_FRESH_VERSION_REQUIRED';END IF;
 NEW.approval_xid=r.approval_xid;NEW.created_at=r.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_version_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_rule_version FOR EACH ROW EXECUTE FUNCTION guard_automation_rule_version();
CREATE FUNCTION record_automation_rule_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO automation_rule_version(rule_id,version,snapshot,approval_xid,created_at) VALUES(NEW.id,NEW.version,to_jsonb(NEW),NEW.approval_xid,NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'AUTOMATION_RULE_APPROVED','AUTOMATION_RULE',NEW.id,
   jsonb_build_object('version',NEW.version,'enabled',NEW.enabled,'trigger',NEW.trigger_type,'action',NEW.action_type));
 RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_history AFTER INSERT OR UPDATE ON automation_rule FOR EACH ROW EXECUTE FUNCTION record_automation_rule_version();

-- Each source has its own durable matching cursor; no commit-order timestamp/sequence polling loss.
-- The actual PostgreSQL visibility snapshot excludes uncommitted/future approvals deterministically.
CREATE TABLE automation_source (
 id uuid PRIMARY KEY REFERENCES notification_event(id), organization_id uuid NOT NULL,branch_id uuid NOT NULL,
 campaign_id uuid NOT NULL,lead_id uuid NOT NULL,trigger_type text NOT NULL,
 visibility_snapshot pg_snapshot NOT NULL,captured_at timestamptz NOT NULL
);
CREATE INDEX automation_source_scope ON automation_source(organization_id,branch_id,captured_at DESC,id DESC);
CREATE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE e notification_event;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE';END IF;
 SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
  AND event_type IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED');
 IF e IS NULL OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED';END IF;
 NEW.organization_id=e.organization_id;NEW.branch_id=e.branch_id;NEW.campaign_id=e.campaign_id;NEW.lead_id=e.lead_id;
 NEW.trigger_type=e.event_type;NEW.visibility_snapshot=pg_current_snapshot();NEW.captured_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER automation_source_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_source FOR EACH ROW EXECUTE FUNCTION guard_automation_source();
CREATE TABLE automation_match_queue (
 source_id uuid PRIMARY KEY REFERENCES automation_source(id),version integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','DONE','DEAD_LETTER')),
 cursor_rule_id uuid, failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation text NOT NULL DEFAULT 'ADMIT' CHECK(operation IN ('ADMIT','MATCH','FAILURE','RETRY')),
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id)
);
CREATE INDEX automation_match_ready ON automation_match_queue(next_run_at,source_id) WHERE state='QUEUED';
CREATE FUNCTION automation_source_rules(sid uuid,after_id uuid) RETURNS TABLE(rule_id uuid,version integer) LANGUAGE sql STABLE AS $$
 SELECT r.id,v.version FROM automation_source s JOIN automation_rule r ON r.organization_id=s.organization_id
  AND (r.branch_id IS NULL OR r.branch_id=s.branch_id) AND (r.campaign_id IS NULL OR r.campaign_id=s.campaign_id)
 JOIN LATERAL (SELECT h.version,h.snapshot FROM automation_rule_version h WHERE h.rule_id=r.id
  AND pg_visible_in_snapshot(h.approval_xid,s.visibility_snapshot) ORDER BY h.version DESC LIMIT 1) v ON true
 WHERE s.id=sid AND (after_id IS NULL OR r.id>after_id) AND (v.snapshot->>'enabled')::boolean
  AND v.snapshot->>'trigger_type'=s.trigger_type ORDER BY r.id
$$;
CREATE FUNCTION automation_source_access(sid uuid,uid uuid,ss uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM automation_source s JOIN lead l ON l.id=s.lead_id AND l.organization_id=s.organization_id
  AND l.branch_id=s.branch_id AND l.campaign_id=s.campaign_id JOIN campaign c ON c.id=l.campaign_id
  AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id WHERE s.id=sid
   AND automation_manage_allowed(s.organization_id,s.branch_id,uid,ss))
$$;
CREATE FUNCTION guard_automation_match_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ids uuid[];n integer;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AUTOMATION_QUEUE_PRESERVED';END IF;
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM automation_source WHERE id=NEW.source_id AND ai_row_inserted_here(xmin))
   THEN RAISE EXCEPTION 'AUTOMATION_FRESH_SOURCE_REQUIRED';END IF;
  NEW.version=1;NEW.state='QUEUED';NEW.cursor_rule_id=NULL;NEW.failure_count=0;NEW.operation='ADMIT';NEW.next_run_at=clock_timestamp();
 ELSE
  IF NEW.source_id<>OLD.source_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AUTOMATION_QUEUE_VERSION_REQUIRED';END IF;
  IF NEW.operation='RETRY' THEN
   IF OLD.state<>'DEAD_LETTER' OR NOT automation_source_access(OLD.source_id,NEW.actor_id,NEW.session_id)
    THEN RAISE EXCEPTION 'AUTOMATION_RETRY_DENIED';END IF;
   NEW.state='QUEUED';NEW.cursor_rule_id=OLD.cursor_rule_id;NEW.failure_count=0;NEW.next_run_at=clock_timestamp();
  ELSE
   IF OLD.state<>'QUEUED' OR OLD.next_run_at>clock_timestamp() THEN RAISE EXCEPTION 'AUTOMATION_QUEUE_NOT_READY';END IF;
   NEW.actor_id=NULL;NEW.session_id=NULL;
   IF NEW.operation='MATCH' THEN
    SELECT array_agg(rule_id ORDER BY rule_id),count(*) INTO ids,n FROM (SELECT * FROM automation_source_rules(OLD.source_id,OLD.cursor_rule_id) LIMIT 51) x;
    NEW.cursor_rule_id=COALESCE(ids[least(n,50)],OLD.cursor_rule_id);NEW.failure_count=0;
    NEW.state=CASE WHEN n>50 THEN 'QUEUED' ELSE 'DONE' END;NEW.next_run_at=CASE WHEN n>50 THEN clock_timestamp() ELSE 'infinity' END;
   ELSIF NEW.operation='FAILURE' THEN
    NEW.cursor_rule_id=OLD.cursor_rule_id;NEW.failure_count=OLD.failure_count+1;
    NEW.state=CASE WHEN NEW.failure_count>=5 THEN 'DEAD_LETTER' ELSE 'QUEUED' END;
    NEW.next_run_at=CASE WHEN NEW.failure_count>=5 THEN 'infinity' ELSE clock_timestamp()+make_interval(secs=>power(2,OLD.failure_count)::int) END;
   ELSE RAISE EXCEPTION 'AUTOMATION_QUEUE_OPERATION_DENIED';END IF;
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER automation_match_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_match_queue FOR EACH ROW EXECUTE FUNCTION guard_automation_match_queue();

CREATE TABLE automation_execution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES automation_source(id),
 rule_id uuid NOT NULL,rule_version integer NOT NULL,FOREIGN KEY(rule_id,rule_version) REFERENCES automation_rule_version(rule_id,version),
 version integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','SUCCEEDED','SKIPPED','DEAD_LETTER')),
 result_code text,failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation text NOT NULL DEFAULT 'ADMIT' CHECK(operation IN ('ADMIT','EXECUTE','FAILURE','RETRY')),
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),UNIQUE(source_id,rule_id,rule_version)
);
CREATE INDEX automation_execution_ready ON automation_execution(next_run_at,id) WHERE state='QUEUED';
CREATE INDEX automation_execution_rule_page ON automation_execution(rule_id,created_at DESC,id DESC);
CREATE INDEX automation_execution_source ON automation_execution(source_id,created_at DESC,id DESC);
CREATE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE e automation_execution;s automation_source;r automation_rule;l lead;b branch;c campaign;u user_account;BEGIN
 SELECT * INTO e FROM automation_execution WHERE id=eid;SELECT * INTO s FROM automation_source WHERE id=e.source_id;
 SELECT * INTO r FROM automation_rule WHERE id=e.rule_id;SELECT * INTO l FROM lead WHERE id=s.lead_id;
 IF r IS NULL OR r.version<>e.rule_version OR NOT r.enabled THEN RETURN 'RULE_CHANGED';END IF;
 IF l IS NULL OR (l.organization_id,l.branch_id,l.campaign_id) IS DISTINCT FROM (s.organization_id,s.branch_id,s.campaign_id)
  OR r.organization_id<>l.organization_id OR r.branch_id IS NOT NULL AND r.branch_id<>l.branch_id
  OR r.campaign_id IS NOT NULL AND r.campaign_id<>l.campaign_id THEN RETURN 'SCOPE_CHANGED';END IF;
 SELECT * INTO u FROM user_account WHERE id=r.actor_id;
 IF u IS NULL OR NOT u.active OR u.organization_id<>r.organization_id OR NOT
  (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND r.branch_id IS NOT NULL AND u.branch_id=r.branch_id) THEN RETURN 'APPROVAL_REVOKED';END IF;
 SELECT * INTO b FROM branch WHERE id=l.branch_id;SELECT * INTO c FROM campaign WHERE id=l.campaign_id;
 IF b IS NULL OR NOT b.active OR c IS NULL OR c.organization_id<>l.organization_id OR c.branch_id<>l.branch_id OR c.status<>'ACTIVE'
  THEN RETURN 'SCOPE_INACTIVE';END IF;
 IF r.lifecycle IS NOT NULL AND r.lifecycle<>l.lifecycle OR r.owner_condition='ASSIGNED' AND l.assigned_agent_id IS NULL
  OR r.owner_condition='UNASSIGNED' AND l.assigned_agent_id IS NOT NULL THEN RETURN 'CONDITIONS_NOT_MET';END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN';END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION guard_automation_execution() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q automation_match_queue;reason text;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AUTOMATION_EXECUTION_PRESERVED';END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO q FROM automation_match_queue WHERE source_id=NEW.source_id AND operation='MATCH' AND ai_row_inserted_here(xmin);
  IF q IS NULL OR pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM automation_source_rules(NEW.source_id,NULL) v
   WHERE v.rule_id=NEW.rule_id AND v.version=NEW.rule_version AND v.rule_id<=q.cursor_rule_id)
   THEN RAISE EXCEPTION 'AUTOMATION_MATCHED_SOURCE_REQUIRED';END IF;
  NEW.version=1;NEW.state='QUEUED';NEW.result_code=NULL;NEW.failure_count=0;NEW.operation='ADMIT';NEW.actor_id=NULL;NEW.session_id=NULL;
  NEW.created_at=clock_timestamp();NEW.next_run_at=NEW.created_at;
 ELSE
  IF (NEW.id,NEW.source_id,NEW.rule_id,NEW.rule_version,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.source_id,OLD.rule_id,OLD.rule_version,OLD.created_at)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AUTOMATION_EXECUTION_VERSION_REQUIRED';END IF;
  IF NEW.operation='RETRY' THEN
   IF OLD.state<>'DEAD_LETTER' OR NOT automation_source_access(OLD.source_id,NEW.actor_id,NEW.session_id)
    THEN RAISE EXCEPTION 'AUTOMATION_RETRY_DENIED';END IF;
   NEW.state='QUEUED';NEW.result_code=NULL;NEW.failure_count=0;NEW.next_run_at=clock_timestamp();
  ELSE
   IF OLD.state<>'QUEUED' OR OLD.next_run_at>clock_timestamp() THEN RAISE EXCEPTION 'AUTOMATION_EXECUTION_NOT_READY';END IF;
   NEW.actor_id=NULL;NEW.session_id=NULL;
   IF NEW.operation='EXECUTE' THEN
    reason=automation_execution_reason(OLD.id);NEW.result_code=COALESCE(reason,'APPLIED');
    NEW.state=CASE WHEN reason IS NULL THEN 'SUCCEEDED' ELSE 'SKIPPED' END;NEW.failure_count=OLD.failure_count;NEW.next_run_at='infinity';
   ELSIF NEW.operation='FAILURE' THEN
    NEW.failure_count=OLD.failure_count+1;NEW.state=CASE WHEN NEW.failure_count>=5 THEN 'DEAD_LETTER' ELSE 'QUEUED' END;
    NEW.result_code='DATABASE_OPERATION_FAILED';NEW.next_run_at=CASE WHEN NEW.failure_count>=5 THEN 'infinity' ELSE clock_timestamp()+make_interval(secs=>power(2,OLD.failure_count)::int) END;
   ELSE RAISE EXCEPTION 'AUTOMATION_EXECUTION_OPERATION_DENIED';END IF;
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER automation_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_execution FOR EACH ROW EXECUTE FUNCTION guard_automation_execution();

CREATE TABLE automation_processing_history (
 kind text NOT NULL CHECK(kind IN ('MATCH','EXECUTION')),resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(kind,resource_id,version)
);
CREATE FUNCTION guard_automation_processing_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE j jsonb;x xid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_HISTORY_IMMUTABLE';END IF;
 IF NEW.kind='MATCH' THEN SELECT to_jsonb(q),q.xmin INTO j,x FROM automation_match_queue q WHERE source_id=NEW.resource_id AND version=NEW.version;
 ELSE SELECT to_jsonb(e),e.xmin INTO j,x FROM automation_execution e WHERE id=NEW.resource_id AND version=NEW.version;END IF;
 IF j IS NULL OR NOT ai_row_inserted_here(x) OR pg_trigger_depth()<2 OR NEW.snapshot IS DISTINCT FROM j THEN RAISE EXCEPTION 'AUTOMATION_HISTORY_PROOF_REQUIRED';END IF;
 NEW.created_at=(j->>'updated_at')::timestamptz;RETURN NEW;
END $$;
CREATE TRIGGER automation_processing_history_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_processing_history FOR EACH ROW EXECUTE FUNCTION guard_automation_processing_history();
CREATE FUNCTION record_automation_processing_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE sid uuid;s automation_source;BEGIN
 INSERT INTO automation_processing_history(kind,resource_id,version,snapshot,created_at)
  VALUES(CASE WHEN TG_TABLE_NAME='automation_match_queue' THEN 'MATCH' ELSE 'EXECUTION' END,
   CASE WHEN TG_TABLE_NAME='automation_match_queue' THEN (to_jsonb(NEW)->>'source_id')::uuid ELSE (to_jsonb(NEW)->>'id')::uuid END,NEW.version,to_jsonb(NEW),NEW.updated_at);
 IF TG_OP='UPDATE' THEN
  sid=NEW.source_id;SELECT * INTO s FROM automation_source WHERE id=sid;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(s.organization_id,s.branch_id,NEW.actor_id,'AUTOMATION_'||NEW.operation,
    CASE WHEN TG_TABLE_NAME='automation_match_queue' THEN 'AUTOMATION_SOURCE' ELSE 'AUTOMATION_EXECUTION' END,
    CASE WHEN TG_TABLE_NAME='automation_match_queue' THEN sid ELSE (to_jsonb(NEW)->>'id')::uuid END,
    jsonb_build_object('version',NEW.version,'state',NEW.state,'failureCount',NEW.failure_count));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER automation_match_history AFTER INSERT OR UPDATE ON automation_match_queue FOR EACH ROW EXECUTE FUNCTION record_automation_processing_history();
CREATE TRIGGER automation_execution_history AFTER INSERT OR UPDATE ON automation_execution FOR EACH ROW EXECUTE FUNCTION record_automation_processing_history();
CREATE FUNCTION match_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO automation_execution(source_id,rule_id,rule_version)
  SELECT NEW.source_id,v.rule_id,v.version FROM automation_source_rules(NEW.source_id,OLD.cursor_rule_id) v WHERE v.rule_id<=NEW.cursor_rule_id
  ORDER BY v.rule_id LIMIT 50 ON CONFLICT(source_id,rule_id,rule_version) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_source_matching AFTER UPDATE ON automation_match_queue FOR EACH ROW WHEN(NEW.operation='MATCH') EXECUTE FUNCTION match_automation_source();
CREATE FUNCTION capture_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO automation_source(id) VALUES(NEW.id);INSERT INTO automation_match_queue(source_id) VALUES(NEW.id);RETURN NEW;
END $$;
CREATE TRIGGER automation_source_capture AFTER INSERT ON notification_event FOR EACH ROW
 WHEN(NEW.event_type IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED')) EXECUTE FUNCTION capture_automation_source();

ALTER TABLE follow_up ADD COLUMN automation_execution_id uuid UNIQUE REFERENCES automation_execution(id);
ALTER TABLE follow_up ADD CONSTRAINT follow_up_automation_provenance CHECK((kind='AUTOMATION')=(automation_execution_id IS NOT NULL));
CREATE FUNCTION guard_automation_follow_up() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE e automation_execution;s automation_source;r automation_rule;l lead;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.automation_execution_id IS DISTINCT FROM OLD.automation_execution_id OR OLD.automation_execution_id IS NOT NULL AND NEW.kind<>OLD.kind
   THEN RAISE EXCEPTION 'AUTOMATION_PROVENANCE_IMMUTABLE';END IF;RETURN NEW;
 END IF;
 IF NEW.automation_execution_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO e FROM automation_execution WHERE id=NEW.automation_execution_id AND state='SUCCEEDED' AND operation='EXECUTE' AND ai_row_inserted_here(xmin);
 SELECT * INTO r FROM automation_rule WHERE id=e.rule_id AND version=e.rule_version AND action_type='CREATE_FOLLOW_UP';
 SELECT * INTO s FROM automation_source WHERE id=e.source_id;SELECT * INTO l FROM lead WHERE id=s.lead_id;
 IF e IS NULL OR r IS NULL OR pg_trigger_depth()<2 OR automation_execution_reason(e.id) IS NOT NULL THEN RAISE EXCEPTION 'AUTOMATION_APPROVED_ACTION_REQUIRED';END IF;
 NEW.lead_id=l.id;NEW.owner_user_id=l.assigned_agent_id;NEW.kind='AUTOMATION';NEW.status='OPEN';NEW.version=1;
 NEW.due_at=s.captured_at+make_interval(mins=>r.delay_minutes);NEW.note=r.note;NEW.priority=r.priority;NEW.created_by=NULL;
 NEW.completed_by=NULL;NEW.completed_at=NULL;NEW.cancelled_by=NULL;NEW.cancelled_at=NULL;NEW.created_at=clock_timestamp();NEW.updated_at=NEW.created_at;RETURN NEW;
END $$;
CREATE TRIGGER automation_follow_up_guard BEFORE INSERT OR UPDATE ON follow_up FOR EACH ROW EXECUTE FUNCTION guard_automation_follow_up();

ALTER TABLE notification_event ADD COLUMN automation_execution_id uuid UNIQUE REFERENCES automation_execution(id);
DO $$ DECLARE tab text;expr text;BEGIN
 FOREACH tab IN ARRAY ARRAY['notification_event','notification_preference','notification_template'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid=tab::regclass AND conname=tab||'_event_type_check';
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',tab,tab||'_event_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR event_type=''AUTOMATION_NOTICE'')',tab,tab||'_event_type_check',expr);
 END LOOP;
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid='notification_event'::regclass AND conname='notification_event_source_shape';
 ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
 EXECUTE format('ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK (((%s) AND automation_execution_id IS NULL) OR
  (event_type=''AUTOMATION_NOTICE'' AND automation_execution_id IS NOT NULL AND source_id=automation_execution_id AND conversation_id IS NULL
   AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL
   AND payment_id IS NULL AND enrollment_id IS NULL AND conversation_attention_id IS NULL))',expr);
END $$;
CREATE FUNCTION guard_automation_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE e automation_execution;s automation_source;r automation_rule;BEGIN
 SELECT * INTO e FROM automation_execution WHERE id=NEW.automation_execution_id AND state='SUCCEEDED' AND operation='EXECUTE' AND ai_row_inserted_here(xmin);
 SELECT * INTO r FROM automation_rule WHERE id=e.rule_id AND version=e.rule_version AND action_type='SEND_IN_APP_NOTIFICATION';
 SELECT * INTO s FROM automation_source WHERE id=e.source_id;
 IF e IS NULL OR r IS NULL OR pg_trigger_depth()<2 OR automation_execution_reason(e.id) IS NOT NULL THEN RAISE EXCEPTION 'AUTOMATION_APPROVED_ACTION_REQUIRED';END IF;
 NEW.organization_id=s.organization_id;NEW.branch_id=s.branch_id;NEW.campaign_id=s.campaign_id;NEW.lead_id=s.lead_id;
 NEW.source_id=e.id;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER automation_notification_guard BEFORE INSERT ON notification_event FOR EACH ROW WHEN(NEW.event_type='AUTOMATION_NOTICE') EXECUTE FUNCTION guard_automation_notification();
-- This is the approved database-backed application action boundary. A failed action/history/Audit
-- rolls back the entire execution transition; there is never a committed partial RUNNING state.
CREATE FUNCTION apply_automation_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r automation_rule;s automation_source;fid uuid;BEGIN
 SELECT * INTO r FROM automation_rule WHERE id=NEW.rule_id AND version=NEW.rule_version;SELECT * INTO s FROM automation_source WHERE id=NEW.source_id;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  INSERT INTO follow_up(automation_execution_id) VALUES(NEW.id) RETURNING id INTO fid;
  INSERT INTO follow_up_history(follow_up_id,event_type,detail) VALUES(fid,'AUTOMATION_CREATED',jsonb_build_object('executionId',NEW.id,'ruleId',r.id,'ruleVersion',r.version));
  INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(s.lead_id,'AUTOMATION_FOLLOW_UP_CREATED',jsonb_build_object('followUpId',fid,'executionId',NEW.id,'ruleId',r.id,'ruleVersion',r.version));
 ELSE
  INSERT INTO notification_event(event_type,automation_execution_id) VALUES('AUTOMATION_NOTICE',NEW.id);
 END IF;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(s.organization_id,s.branch_id,'AUTOMATION_ACTION_APPLIED','AUTOMATION_EXECUTION',NEW.id,jsonb_build_object('ruleId',r.id,'ruleVersion',r.version,'action',r.action_type,'followUpId',fid));
 RETURN NEW;
END $$;
CREATE TRIGGER automation_approved_action AFTER UPDATE ON automation_execution FOR EACH ROW
 WHEN(NEW.operation='EXECUTE' AND NEW.state='SUCCEEDED') EXECUTE FUNCTION apply_automation_action();
