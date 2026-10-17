-- Policy scope for a fresh authenticated source. Admission alone never grants message insertion or dispatch.
CREATE FUNCTION ai_send_admissible(ctx jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(ctx IS NOT NULL AND ctx->'conversation'->>'controller'='AI'
   AND ctx->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND ctx->'conversation'->'attentionReason'='null'::jsonb
   AND ctx->'toolPolicy'->'allowedTools' ? 'sendConversationMessage'
   AND ctx->'conversation'->>'latestMessageId'=ctx->'source'->>'messageId'
   AND EXISTS(SELECT 1 FROM conversation_message m WHERE m.id=(ctx->'source'->>'messageId')::uuid
     AND m.conversation_id=(ctx->'scope'->>'conversationId')::uuid AND m.direction='INBOUND' AND m.author_type='CUSTOMER'),false)
$$;
CREATE TABLE ai_customer_send_admission (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_proposal(id),event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),
 context jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_send_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_SEND_ADMISSION_IMMUTABLE';END IF;
 SELECT qp.*,qp.xmin AS inserted_xid INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 ctx=ai_customer_proposal_context(NEW.event_id);
 IF p IS NULL OR p.event_id<>NEW.event_id OR p.state<>'QUEUED' OR NOT ai_row_inserted_here(p.inserted_xid)
   OR NOT ai_send_admissible(ctx) OR ctx IS DISTINCT FROM NEW.context OR ctx IS DISTINCT FROM p.context
   THEN RAISE EXCEPTION 'AI_SEND_NEW_ACTIVE_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_send_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_send_admission FOR EACH ROW EXECUTE FUNCTION guard_ai_send_admission();
-- Prospective policy inspection may run before inference. The actual tool must separately require a current validated result.
CREATE FUNCTION ai_customer_send_admission_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission a ON a.proposal_id=qp.id AND a.event_id=qp.event_id AND a.context=qp.context WHERE qp.id=pid;
 IF p IS NULL OR p.state NOT IN ('QUEUED','RUNNING','PROPOSED')
   OR p.state='PROPOSED' AND p.result->>'decision' NOT IN ('ANSWER','QUESTION') THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_send_admissible(ctx) OR ctx IS DISTINCT FROM p.context THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;
-- No historical backfill, runtime activation, send job, customer message or provider call.
