-- Tool denial is retained. A fresh blocked mandatory Handoff must not resume sensitive AI replies.
-- This safety event grants no Handoff/controller/send/assignment/financial authority.
CREATE TABLE ai_handoff_safety_stop (
 action_id uuid PRIMARY KEY REFERENCES ai_customer_handoff_action(id),
 conversation_id uuid NOT NULL REFERENCES conversation(id),conversation_version integer NOT NULL CHECK(conversation_version>1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ai_handoff_stop_source_current(aid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM ai_customer_handoff_action a JOIN ai_customer_proposal p ON p.id=a.proposal_id
   JOIN integration_event e ON e.id=p.event_id JOIN conversation_message m ON m.id=p.message_id AND m.source_event_id=e.id
   JOIN conversation cv ON cv.id=a.conversation_id JOIN lead l ON l.id=cv.lead_id
   WHERE a.id=aid AND a.state='BLOCKED' AND p.state='PROPOSED' AND p.result->>'decision'='HANDOFF'
     AND a.qualification_action_id IS NULL AND ai_row_inserted_here(a.xmin)
     AND (l.id,l.organization_id,l.branch_id,l.campaign_id,cv.id)=(a.lead_id,p.organization_id,p.branch_id,a.campaign_id,p.conversation_id)
     AND cv.controller_type='AI' AND cv.controller_user_id IS NULL
     AND (cv.sender_id,cv.connection_id)=(e.sender_id,e.connection_id) AND cv.participant_ref=e.participant_ref
     AND (e.provider_thread_ref IS NULL OR e.provider_thread_ref=cv.provider_thread_ref)
     AND m.conversation_id=cv.id AND m.direction='INBOUND' AND m.author_type='CUSTOMER'
     AND m.id=(SELECT latest.id FROM conversation_message latest WHERE latest.conversation_id=cv.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
     AND NOT EXISTS(SELECT 1 FROM conversation_message later WHERE later.conversation_id=cv.id AND later.direction='INBOUND'
       AND later.author_type='CUSTOMER' AND later.received_at>m.received_at))
$$;
CREATE FUNCTION guard_ai_handoff_safety_stop() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE cv record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_HANDOFF_SAFETY_STOP_IMMUTABLE';END IF;
 SELECT c.*,c.xmin AS written_xid INTO cv FROM conversation c JOIN ai_customer_handoff_action a ON a.conversation_id=c.id WHERE a.id=NEW.action_id;
 IF cv IS NULL OR NOT ai_handoff_stop_source_current(NEW.action_id) OR NOT ai_row_inserted_here(cv.written_xid)
   OR cv.state<>'AI_HANDOFF_REQUIRED' OR cv.needs_attention_reason IS DISTINCT FROM 'AI_PROCESSING_NOT_READY'
   OR cv.ai_handoff_action_id IS NOT NULL OR NEW.conversation_id IS DISTINCT FROM cv.id OR NEW.conversation_version IS DISTINCT FROM cv.version
   THEN RAISE EXCEPTION 'AI_HANDOFF_SAFETY_STOP_CURRENT_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_safety_stop_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_safety_stop FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_safety_stop();
CREATE FUNCTION record_ai_handoff_safety_stop() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;BEGIN
 SELECT * INTO a FROM ai_customer_handoff_action WHERE id=NEW.action_id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES((a.context->'scope'->>'organizationId')::uuid,(a.context->'scope'->>'branchId')::uuid,'AI_MANDATORY_HANDOFF_STOPPED','AI_CUSTOMER_HANDOFF',a.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','conversationId',NEW.conversation_id,'conversationVersion',NEW.conversation_version,
     'proposalId',a.proposal_id,'sourceMessageId',a.context->'source'->'messageId','reason',a.handoff_reason,'errorCode',a.error_code,
     'toolApplied',false,'sendAllowed',false));
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(a.lead_id,'AI_MANDATORY_HANDOFF_STOPPED',
   jsonb_build_object('conversationId',NEW.conversation_id,'actionId',a.id,'conversationVersion',NEW.conversation_version,'reason',a.handoff_reason));
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_safety_stop_record AFTER INSERT ON ai_handoff_safety_stop FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_safety_stop();
CREATE FUNCTION stop_blocked_mandatory_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE cv record;BEGIN
 IF NEW.state<>'BLOCKED' OR NOT ai_handoff_stop_source_current(NEW.id) THEN RETURN NEW;END IF;
 UPDATE conversation SET state='AI_HANDOFF_REQUIRED',needs_attention_reason='AI_PROCESSING_NOT_READY',version=version+1
   WHERE id=NEW.conversation_id AND controller_type='AI' AND controller_user_id IS NULL
     AND state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND needs_attention_reason IS NULL
   RETURNING id,version INTO cv;
 IF FOUND THEN INSERT INTO ai_handoff_safety_stop(action_id,conversation_id,conversation_version) VALUES(NEW.id,cv.id,cv.version);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_mandatory_stop AFTER INSERT ON ai_customer_handoff_action FOR EACH ROW EXECUTE FUNCTION stop_blocked_mandatory_handoff();
