-- Preserve applied129; qualify the action alias separately from its record variable.
CREATE OR REPLACE FUNCTION guard_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;a record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   ctx=ai_handoff_summary_locked_context(NEW.action_id);
   SELECT ha.*,ha.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action ha WHERE ha.id=NEW.action_id;
   IF ctx IS NULL OR NEW.context IS DISTINCT FROM ctx OR NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
     OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL
     OR NEW.actor_id IS NULL AND NOT ai_row_inserted_here(a.inserted_xid)
     OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id) IS DISTINCT FROM
       ((ctx->'sourceContext'->'scope'->>'organizationId')::uuid,(ctx->'sourceContext'->'scope'->>'branchId')::uuid,a.campaign_id,a.lead_id,a.conversation_id)
     OR NOT ai_handoff_summary_current(NEW) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED';END IF;
   NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.references_json=ctx->'summaryContext'->'references';NEW.created_at=clock_timestamp();
 ELSE
   IF (NEW.id,NEW.action_id,NEW.request_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.actor_id,NEW.session_id,NEW.context,NEW.context_hash,NEW.references_json,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.action_id,OLD.request_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id,OLD.actor_id,OLD.session_id,OLD.context,OLD.context_hash,OLD.references_json,OLD.created_at)
     OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_IMMUTABLE_CONTEXT';END IF;
   IF OLD.state IN ('COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TERMINAL';END IF;
   IF NEW.state='RUNNING' THEN
     IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1
       OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds'
       OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
   ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
     IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
   ELSE
     IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
       OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
     IF NEW.state='COMPLETED' AND (NEW.error_code IS NOT NULL OR NOT ai_handoff_summary_current(NEW) OR NOT ai_simulation_result_valid(NEW.result,NEW.references_json)) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RESULT_PROOF_REQUIRED';END IF;
     IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RETRY_REQUIRED';END IF;
     IF NEW.state NOT IN ('QUEUED','COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TRANSITION_INVALID';END IF;
   END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.completed_at=CASE WHEN NEW.state IN ('COMPLETED','FAILED','BLOCKED') THEN clock_timestamp() ELSE NULL END;RETURN NEW;
END $$;
