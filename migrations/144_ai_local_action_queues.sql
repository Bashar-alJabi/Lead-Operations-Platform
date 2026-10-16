-- Technical scheduling never grants Domain authority. Original admissions/actions remain unchanged.
CREATE FUNCTION ai_local_action_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$;
CREATE TABLE ai_local_action_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_id uuid NOT NULL REFERENCES ai_customer_proposal(id),
 kind text NOT NULL CHECK(kind IN ('QUALIFICATION','HANDOFF')),UNIQUE(proposal_id,kind),
 organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL CHECK(state IN ('WAITING','DEAD_LETTER','COMPLETED')),
 failure_count integer NOT NULL CHECK(failure_count BETWEEN 0 AND 5),available_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 operation text NOT NULL CHECK(operation IN ('ADMIT','COMPLETE','FAILURE','HUMAN_RETRY')),error_code text,
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),reason text,
 CHECK(state='WAITING' AND failure_count<5 AND isfinite(available_at) OR state='DEAD_LETTER' AND failure_count=5 AND available_at='infinity' OR state='COMPLETED' AND available_at='infinity'),
 CHECK(error_code IS NULL OR error_code='AI_LOCAL_ACTION_FAILED')
);
CREATE INDEX ai_local_action_due ON ai_local_action_queue(kind,available_at,id) WHERE state='WAITING' AND failure_count<5;
CREATE INDEX ai_local_action_open_conversation ON ai_local_action_queue(conversation_id,updated_at DESC,id DESC) WHERE state<>'COMPLETED';
CREATE INDEX ai_local_action_conversation ON ai_local_action_queue(conversation_id,updated_at DESC,id DESC);
CREATE TABLE ai_local_action_queue_history (
 queue_id uuid NOT NULL REFERENCES ai_local_action_queue(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(queue_id,version)
);

-- Pure read for UI readiness; mutation/recovery still takes the existing full native locks.
CREATE FUNCTION ai_local_action_context_current(pid uuid,k text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p record;ctx jsonb;expected jsonb;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN false;END IF;
 ctx=ai_customer_proposal_context(p.event_id);IF ctx IS NULL THEN RETURN false;END IF;
 IF k='QUALIFICATION' THEN RETURN ai_qualification_admissible(ctx) AND ctx=p.context;
 ELSIF k='HANDOFF' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT s.context INTO expected FROM ai_qualification_handoff_source s WHERE s.proposal_id=pid;
     IF expected IS NULL OR (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true' THEN RETURN false;END IF;
   ELSIF p.result->>'decision'<>'HANDOFF' THEN RETURN false;END IF;
   RETURN ai_handoff_admissible(ctx) AND ctx=expected;
 END IF;RETURN false;
END $$;
CREATE FUNCTION guard_ai_local_action_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;jstate text;receipt_id uuid;receipt_xid xid;u record;ctx jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_HISTORY_RETAINED';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;
 IF NEW.kind='QUALIFICATION' THEN
   SELECT state INTO jstate FROM ai_customer_action_job WHERE proposal_id=NEW.proposal_id;
   SELECT a.id,a.xmin INTO receipt_id,receipt_xid FROM ai_customer_action a WHERE proposal_id=NEW.proposal_id;
 ELSE
   SELECT state INTO jstate FROM ai_customer_handoff_job WHERE proposal_id=NEW.proposal_id;
   SELECT a.id,a.xmin INTO receipt_id,receipt_xid FROM ai_customer_handoff_action a WHERE proposal_id=NEW.proposal_id;
 END IF;
 IF p IS NULL OR jstate IS NULL THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_JOB_SOURCE_REQUIRED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.operation<>'ADMIT' OR NEW.version<>1 OR jstate<>'QUEUED' OR receipt_id IS NOT NULL
     OR NEW.organization_id IS NOT NULL AND NEW.organization_id<>p.organization_id OR NEW.branch_id IS NOT NULL AND NEW.branch_id<>p.branch_id
     OR NEW.campaign_id IS NOT NULL AND NEW.campaign_id<>p.campaign_id OR NEW.lead_id IS NOT NULL AND NEW.lead_id<>p.lead_id
     OR NEW.conversation_id IS NOT NULL AND NEW.conversation_id<>p.conversation_id THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_ADMISSION_REQUIRED';END IF;
   NEW.organization_id=p.organization_id;NEW.branch_id=p.branch_id;NEW.campaign_id=p.campaign_id;NEW.lead_id=p.lead_id;NEW.conversation_id=p.conversation_id;
 ELSE
   IF (NEW.id,NEW.proposal_id,NEW.kind,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id)
     IS DISTINCT FROM (OLD.id,OLD.proposal_id,OLD.kind,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id)
     OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_VERSION_REQUIRED';END IF;
   IF OLD.state='COMPLETED' OR NEW.operation='ADMIT' THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_TERMINAL';END IF;
 END IF;
 NEW.updated_at=ai_local_action_now();
 IF NEW.operation='ADMIT' THEN
   NEW.state='WAITING';NEW.failure_count=0;NEW.available_at=NEW.updated_at;NEW.error_code=NULL;
 ELSIF NEW.operation='COMPLETE' THEN
   IF jstate<>'DONE' OR receipt_id IS NULL OR NOT ai_row_inserted_here(receipt_xid) THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_FRESH_RECEIPT_REQUIRED';END IF;
   NEW.state='COMPLETED';NEW.failure_count=OLD.failure_count;NEW.available_at='infinity';NEW.error_code=NULL;
 ELSIF NEW.operation='FAILURE' THEN
   IF jstate<>'QUEUED' OR receipt_id IS NOT NULL OR OLD.state<>'WAITING' OR OLD.failure_count>=5 OR OLD.available_at>NEW.updated_at THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_DUE_JOB_REQUIRED';END IF;
   NEW.failure_count=OLD.failure_count+1;NEW.state=CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END;
   NEW.available_at=CASE WHEN NEW.failure_count=5 THEN 'infinity'::timestamptz ELSE NEW.updated_at+make_interval(secs=>power(2,NEW.failure_count)::integer) END;
   NEW.error_code='AI_LOCAL_ACTION_FAILED';
 ELSE
   -- Queue -> Branch -> real current User/Session -> Domain dependency locks, matching the worker.
   PERFORM 1 FROM branch WHERE id=p.branch_id AND organization_id=p.organization_id FOR UPDATE;
   IF NOT FOUND OR NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
   IF jstate<>'QUEUED' OR receipt_id IS NOT NULL OR OLD.failure_count=0 OR u.organization_id<>p.organization_id
     OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=p.branch_id)
     OR NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 3 AND 500 OR NEW.reason ~ '[\x00-\x1f\x7f]'
     THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   ctx=CASE NEW.kind WHEN 'QUALIFICATION' THEN ai_customer_action_context(p.id) ELSE ai_customer_handoff_context(p.id) END;
   IF ctx IS NULL THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_CURRENT_RECOVERY_REQUIRED';END IF;
   NEW.state='WAITING';NEW.failure_count=0;NEW.error_code=NULL;NEW.available_at=NEW.updated_at;NEW.reason=trim(NEW.reason);
 END IF;
 IF NEW.operation<>'HUMAN_RETRY' THEN NEW.actor_id=NULL;NEW.session_id=NULL;NEW.reason=NULL;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_local_action_queue_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_local_action_queue FOR EACH ROW EXECUTE FUNCTION guard_ai_local_action_queue();
CREATE FUNCTION guard_ai_local_action_queue_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_QUEUE_HISTORY_IMMUTABLE';END IF;
 SELECT r.*,r.xmin AS written_xid INTO q FROM ai_local_action_queue r WHERE r.id=NEW.queue_id AND r.version=NEW.version;
 IF q IS NULL OR NOT ai_row_inserted_here(q.written_xid) OR (to_jsonb(q)-'written_xid') IS DISTINCT FROM NEW.snapshot THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_FRESH_HISTORY_REQUIRED';END IF;
 NEW.created_at=q.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER ai_local_action_queue_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_local_action_queue_history FOR EACH ROW EXECUTE FUNCTION guard_ai_local_action_queue_history();
CREATE FUNCTION record_ai_local_action_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_local_action_queue_history VALUES(NEW.id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 IF NEW.operation='HUMAN_RETRY' OR NEW.state='DEAD_LETTER' THEN
   INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,CASE WHEN NEW.operation='HUMAN_RETRY' THEN 'AI_LOCAL_ACTION_RECOVERY_REQUESTED' ELSE 'AI_LOCAL_ACTION_DEAD_LETTER' END,
     'AI_LOCAL_ACTION_QUEUE',NEW.id,jsonb_build_object('kind',NEW.kind,'proposalId',NEW.proposal_id,'conversationId',NEW.conversation_id,'version',NEW.version,'reason',NEW.reason));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_local_action_queue_record AFTER INSERT OR UPDATE ON ai_local_action_queue FOR EACH ROW EXECUTE FUNCTION record_ai_local_action_queue();
CREATE FUNCTION sync_ai_local_action_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;BEGIN
 k=CASE TG_TABLE_NAME WHEN 'ai_customer_action_job' THEN 'QUALIFICATION' ELSE 'HANDOFF' END;
 IF TG_OP='INSERT' THEN INSERT INTO ai_local_action_queue(proposal_id,kind,operation) VALUES(NEW.proposal_id,k,'ADMIT');
 ELSIF NEW.state='DONE' THEN UPDATE ai_local_action_queue SET operation='COMPLETE',version=version+1 WHERE proposal_id=NEW.proposal_id AND kind=k;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_local_qualification_queue_sync AFTER INSERT OR UPDATE ON ai_customer_action_job FOR EACH ROW EXECUTE FUNCTION sync_ai_local_action_queue();
CREATE TRIGGER ai_local_handoff_queue_sync AFTER INSERT OR UPDATE ON ai_customer_handoff_job FOR EACH ROW EXECUTE FUNCTION sync_ai_local_action_queue();
-- Native callers as well as Services take queue before Job/parents, and cannot bypass backoff/dead-letter.
CREATE FUNCTION guard_ai_local_action_due() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;k text;BEGIN
 k=CASE TG_TABLE_NAME WHEN 'ai_customer_action' THEN 'QUALIFICATION' ELSE 'HANDOFF' END;
 SELECT * INTO q FROM ai_local_action_queue WHERE proposal_id=NEW.proposal_id AND kind=k FOR UPDATE;
 IF q IS NULL OR q.state<>'WAITING' OR q.failure_count>=5 OR q.available_at>ai_local_action_now() THEN RAISE EXCEPTION 'AI_LOCAL_ACTION_DUE_JOB_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_ai_local_action_due BEFORE INSERT ON ai_customer_action FOR EACH ROW EXECUTE FUNCTION guard_ai_local_action_due();
CREATE TRIGGER aa_ai_local_action_due BEFORE INSERT ON ai_customer_handoff_action FOR EACH ROW EXECUTE FUNCTION guard_ai_local_action_due();
-- No bulk replay/backfill here. A bounded startup sweep admits existing pending Jobs only.
