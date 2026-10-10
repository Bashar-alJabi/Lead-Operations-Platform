-- Keep pending local actions indexed independently of historical admission/receipt volume.
CREATE TABLE ai_customer_action_job (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_action_admission(proposal_id),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','DONE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 CHECK((state='DONE')=(completed_at IS NOT NULL))
);
CREATE INDEX ai_customer_action_job_pending ON ai_customer_action_job(created_at,proposal_id) WHERE state='QUEUED';
CREATE FUNCTION guard_ai_action_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_ACTION_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM ai_customer_proposal p JOIN ai_customer_action_admission a ON a.proposal_id=p.id
     WHERE p.id=NEW.proposal_id AND p.state='PROPOSED' AND p.result->>'decision'='QUALIFICATION') OR EXISTS(SELECT 1 FROM ai_customer_action WHERE proposal_id=NEW.proposal_id)
     THEN RAISE EXCEPTION 'AI_ACTION_JOB_SOURCE_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_ACTION_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_action_job_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_action_job FOR EACH ROW EXECUTE FUNCTION guard_ai_action_job();
CREATE FUNCTION enqueue_ai_action_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision'='QUALIFICATION' AND EXISTS(SELECT 1 FROM ai_customer_action_admission WHERE proposal_id=NEW.id) THEN
   INSERT INTO ai_customer_action_job(proposal_id) VALUES(NEW.id);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_action_job_enqueue AFTER UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION enqueue_ai_action_job();
CREATE FUNCTION complete_ai_action_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_customer_action_job SET state='DONE' WHERE proposal_id=NEW.proposal_id AND state='QUEUED';RETURN NEW;
END $$;
CREATE TRIGGER ai_action_job_complete AFTER INSERT ON ai_customer_action FOR EACH ROW EXECUTE FUNCTION complete_ai_action_job();
INSERT INTO ai_customer_action_job(proposal_id) SELECT a.proposal_id FROM ai_customer_action_admission a JOIN ai_customer_proposal p ON p.id=a.proposal_id
 WHERE p.state='PROPOSED' AND p.result->>'decision'='QUALIFICATION' AND NOT EXISTS(SELECT 1 FROM ai_customer_action done WHERE done.proposal_id=a.proposal_id);
