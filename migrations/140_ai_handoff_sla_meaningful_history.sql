-- Persist business observations and failures, not identical snapshots on every closed-calendar poll.
CREATE OR REPLACE FUNCTION record_ai_handoff_sla_timer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' OR (NEW.state,NEW.reason_code,NEW.elapsed_microseconds,NEW.clock,NEW.revision) IS DISTINCT FROM (OLD.state,OLD.reason_code,OLD.elapsed_microseconds,OLD.clock,OLD.revision) THEN
  INSERT INTO ai_handoff_sla_history VALUES(NEW.action_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 END IF;
 IF TG_OP='INSERT' OR NEW.state IN ('EXPIRED','CANCELLED') OR NEW.revision<>OLD.revision THEN
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,
   CASE WHEN NEW.state='EXPIRED' THEN 'AI_HANDOFF_SLA_EXCEEDED' WHEN NEW.state='CANCELLED' THEN 'AI_HANDOFF_SLA_CANCELLED' WHEN TG_OP='INSERT' THEN 'AI_HANDOFF_SLA_STARTED' ELSE 'AI_HANDOFF_SLA_CLOCK_CHANGED' END,
   'CONVERSATION',NEW.conversation_id,jsonb_build_object('actionId',NEW.action_id,'version',NEW.version,'revision',NEW.revision,'reason',NEW.reason_code));
 END IF;
 IF NEW.state='EXPIRED' THEN INSERT INTO ai_handoff_sla_breach(action_id) VALUES(NEW.action_id);END IF;
 INSERT INTO ai_handoff_sla_queue(action_id,version,operation) VALUES(NEW.action_id,1,'STEP') ON CONFLICT(action_id) DO UPDATE SET version=ai_handoff_sla_queue.version+1,operation='STEP';RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION record_ai_handoff_sla_queue() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;BEGIN
 SELECT * INTO t FROM ai_handoff_sla_timer WHERE action_id=NEW.action_id;
 IF TG_OP='INSERT' OR NEW.operation<>'STEP' OR t.state IN ('EXPIRED','CANCELLED') OR OLD.failure_count<>0 THEN
  INSERT INTO ai_handoff_sla_queue_history VALUES(NEW.action_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 END IF;
 IF NEW.operation='HUMAN_RETRY' OR NEW.failure_count=5 THEN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(t.organization_id,t.branch_id,NEW.actor_id,
   CASE WHEN NEW.operation='HUMAN_RETRY' THEN 'AI_HANDOFF_SLA_RECOVERY_REQUESTED' ELSE 'AI_HANDOFF_SLA_JOB_FAILED' END,'CONVERSATION',t.conversation_id,jsonb_build_object('actionId',t.action_id,'reason',NEW.reason));
 END IF;RETURN NEW;
END $$;
