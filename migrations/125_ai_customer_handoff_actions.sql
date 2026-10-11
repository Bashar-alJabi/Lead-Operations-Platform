-- Handoff authority is separate from readonly proposals and from Qualification writes.
CREATE FUNCTION ai_handoff_admissible(ctx jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(ctx IS NOT NULL AND ctx->'conversation'->>'controller'='AI'
   AND ctx->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD')
   AND ctx->'conversation'->'attentionReason'='null'::jsonb
   AND ctx->'toolPolicy'->'allowedTools' ? 'requestHumanHandoff'
   AND EXISTS(SELECT 1 FROM conversation_message source WHERE source.id=(ctx->'source'->>'messageId')::uuid
     AND source.conversation_id=(ctx->'scope'->>'conversationId')::uuid AND source.direction='INBOUND' AND source.author_type='CUSTOMER'
     AND NOT EXISTS(SELECT 1 FROM conversation_message later WHERE later.conversation_id=source.conversation_id
       AND later.direction='INBOUND' AND later.author_type='CUSTOMER' AND later.received_at>source.received_at)),false)
$$;
CREATE TABLE ai_customer_handoff_admission (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_proposal(id),event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),
 context jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_handoff_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_HANDOFF_ADMISSION_IMMUTABLE';END IF;
 SELECT qp.*,qp.xmin AS inserted_xid INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 ctx=ai_customer_proposal_context(NEW.event_id);
 IF p IS NULL OR p.event_id<>NEW.event_id OR p.state<>'QUEUED' OR NOT ai_row_inserted_here(p.inserted_xid)
   OR NOT ai_handoff_admissible(ctx) OR ctx IS DISTINCT FROM NEW.context OR ctx IS DISTINCT FROM p.context
   THEN RAISE EXCEPTION 'AI_HANDOFF_NEW_ACTIVE_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_handoff_admission FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_admission();
CREATE TABLE ai_customer_handoff_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_id uuid NOT NULL UNIQUE REFERENCES ai_customer_handoff_admission(proposal_id),
 lead_id uuid NOT NULL REFERENCES lead(id),campaign_id uuid NOT NULL REFERENCES campaign(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 tool text NOT NULL DEFAULT 'requestHumanHandoff' CHECK(tool='requestHumanHandoff'),
 state text NOT NULL CHECK(state IN ('APPLIED','BLOCKED')),error_code text,
 context jsonb NOT NULL,handoff_reason text NOT NULL,previous_conversation_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='BLOCKED')=(error_code IS NOT NULL)),CHECK(error_code IS NULL OR error_code='AI_HANDOFF_CONTEXT_CHANGED'),
 CHECK(handoff_reason IN ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE'))
);
CREATE INDEX ai_handoff_conversation_history ON ai_customer_handoff_action(conversation_id,created_at DESC,id DESC);
CREATE TABLE ai_customer_handoff_job (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_handoff_admission(proposal_id),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','DONE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 CHECK((state='DONE')=(completed_at IS NOT NULL))
);
CREATE INDEX ai_handoff_pending ON ai_customer_handoff_job(created_at,proposal_id) WHERE state='QUEUED';
CREATE FUNCTION guard_ai_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id
     WHERE qp.id=NEW.proposal_id AND qp.state='PROPOSED' AND qp.result->>'decision'='HANDOFF')
     OR EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_SOURCE_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_job_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_handoff_job FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_job();
CREATE FUNCTION enqueue_ai_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision'='HANDOFF' AND EXISTS(SELECT 1 FROM ai_customer_handoff_admission WHERE proposal_id=NEW.id) THEN
   INSERT INTO ai_customer_handoff_job(proposal_id) VALUES(NEW.id);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_job_enqueue AFTER UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION enqueue_ai_handoff_job();
CREATE FUNCTION ai_customer_handoff_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id WHERE qp.id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'HANDOFF' THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_handoff_admissible(ctx) OR ctx IS DISTINCT FROM p.context
   OR ctx IS DISTINCT FROM (SELECT context FROM ai_customer_handoff_admission WHERE proposal_id=pid) THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;
CREATE FUNCTION guard_ai_handoff_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_HANDOFF_ACTION_IMMUTABLE';END IF;
 SELECT qp.* INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'HANDOFF' OR (NEW.lead_id,NEW.campaign_id,NEW.conversation_id,NEW.context)
   IS DISTINCT FROM (p.lead_id,p.campaign_id,p.conversation_id,p.context)
   OR NOT EXISTS(SELECT 1 FROM ai_customer_handoff_job WHERE proposal_id=p.id AND state='QUEUED' FOR UPDATE)
   THEN RAISE EXCEPTION 'AI_HANDOFF_SOURCE_REQUIRED';END IF;
 ctx=ai_customer_handoff_context(p.id);
 IF NEW.state='APPLIED' AND ctx IS NULL OR NEW.state='BLOCKED' AND (ctx IS NOT NULL OR NEW.error_code IS DISTINCT FROM 'AI_HANDOFF_CONTEXT_CHANGED')
   THEN RAISE EXCEPTION 'AI_HANDOFF_CURRENT_ACTION_REQUIRED';END IF;
 NEW.handoff_reason=p.result->>'handoffReason';NEW.previous_conversation_version=(p.context->'conversation'->>'version')::integer;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_action_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_handoff_action FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_action();
ALTER TABLE conversation ADD COLUMN ai_handoff_action_id uuid REFERENCES ai_customer_handoff_action(id);
ALTER TABLE conversation_handoff ADD COLUMN ai_action_id uuid UNIQUE REFERENCES ai_customer_handoff_action(id);
CREATE FUNCTION guard_ai_handoff_transition() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE act record;BEGIN
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
CREATE TRIGGER ai_handoff_transition_guard BEFORE UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_transition();
CREATE FUNCTION guard_ai_handoff_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE act record;BEGIN
 IF TG_OP<>'INSERT' THEN
   IF OLD.ai_action_id IS NOT NULL OR TG_OP='UPDATE' AND NEW.ai_action_id IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_HISTORY_IMMUTABLE';END IF;
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 IF NEW.ai_action_id IS NOT NULL THEN
   SELECT a.*,a.xmin AS inserted_xid INTO act FROM ai_customer_handoff_action a WHERE a.id=NEW.ai_action_id;
   IF act IS NULL OR act.state<>'APPLIED' OR NOT ai_row_inserted_here(act.inserted_xid) OR act.conversation_id<>NEW.conversation_id
     OR NEW.from_controller<>'AI' OR NEW.from_user_id IS NOT NULL OR NEW.to_controller<>'NONE' OR NEW.to_user_id IS NOT NULL
     OR NEW.requested_by IS NOT NULL OR NEW.reason IS DISTINCT FROM act.handoff_reason THEN RAISE EXCEPTION 'AI_HANDOFF_HISTORY_PROOF_REQUIRED';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_history_guard BEFORE INSERT OR UPDATE OR DELETE ON conversation_handoff FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_history();
CREATE FUNCTION record_ai_handoff_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_customer_handoff_job SET state='DONE' WHERE proposal_id=NEW.proposal_id AND state='QUEUED';
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,
   CASE NEW.state WHEN 'APPLIED' THEN 'AI_HUMAN_HANDOFF_APPLIED' ELSE 'AI_HUMAN_HANDOFF_BLOCKED' END,'AI_CUSTOMER_HANDOFF',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','tool',NEW.tool,'leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,
     'proposalId',NEW.proposal_id,'sourceMessageId',NEW.context->'source'->'messageId','knowledgeVersion',NEW.context->'knowledge'->'version',
     'profileId',NEW.context->'profile'->'id','reason',NEW.handoff_reason,'errorCode',NEW.error_code));
 IF NEW.state='APPLIED' THEN INSERT INTO lead_activity(lead_id,event_type,detail)
   VALUES(NEW.lead_id,'AI_HUMAN_HANDOFF_REQUESTED',jsonb_build_object('conversationId',NEW.conversation_id,'actionId',NEW.id,'reason',NEW.handoff_reason));END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_action_record AFTER INSERT ON ai_customer_handoff_action FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_action();
CREATE FUNCTION prove_ai_handoff_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='APPLIED' AND (NOT EXISTS(SELECT 1 FROM conversation cv WHERE cv.id=NEW.conversation_id AND cv.lead_id=NEW.lead_id
   AND cv.ai_handoff_action_id=NEW.id AND cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE' AND cv.version=NEW.previous_conversation_version+1)
   OR NOT EXISTS(SELECT 1 FROM conversation_handoff h WHERE h.ai_action_id=NEW.id AND h.conversation_id=NEW.conversation_id))
   THEN RAISE EXCEPTION 'AI_HANDOFF_ATOMIC_TRANSITION_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_handoff_action_proof AFTER INSERT ON ai_customer_handoff_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_handoff_action();
