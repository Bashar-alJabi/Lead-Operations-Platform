-- Fence direct INSERT references without changing the already-applied migration.
CREATE OR REPLACE FUNCTION guard_ai_handoff_transition() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE act record;BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.ai_handoff_action_id IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_TRANSITION_PROOF_REQUIRED';END IF;RETURN NEW;
 END IF;
 IF NEW.ai_handoff_action_id IS NOT NULL AND NEW.ai_handoff_action_id IS DISTINCT FROM OLD.ai_handoff_action_id THEN
   SELECT a.*,a.xmin AS inserted_xid INTO act FROM ai_customer_handoff_action a WHERE a.id=NEW.ai_handoff_action_id;
   IF act IS NULL OR act.state<>'APPLIED' OR NOT ai_row_inserted_here(act.inserted_xid) OR act.conversation_id<>NEW.id
     OR act.lead_id<>NEW.lead_id OR OLD.version<>act.previous_conversation_version OR OLD.controller_type<>'AI'
     OR OLD.state NOT IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') OR OLD.needs_attention_reason IS NOT NULL
     OR NEW.controller_type<>'NONE' OR NEW.controller_user_id IS NOT NULL OR NEW.state<>'WAITING_FOR_HUMAN'
     OR NEW.version<>OLD.version+1 OR NEW.needs_attention_reason IS DISTINCT FROM 'AI_HUMAN_HANDOFF_REQUESTED'
     OR (NEW.connection_id,NEW.sender_id,NEW.participant_ref,NEW.provider_thread_ref) IS DISTINCT FROM (OLD.connection_id,OLD.sender_id,OLD.participant_ref,OLD.provider_thread_ref)
     THEN RAISE EXCEPTION 'AI_HANDOFF_TRANSITION_PROOF_REQUIRED';END IF;
 ELSIF NEW.state<>'WAITING_FOR_HUMAN' OR NEW.controller_type<>'NONE' THEN NEW.ai_handoff_action_id=NULL;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER ai_handoff_transition_guard ON conversation;
CREATE TRIGGER ai_handoff_transition_guard BEFORE INSERT OR UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_transition();
