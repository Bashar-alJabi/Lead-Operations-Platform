-- Fence the first consent INSERT, including a Contact shared by another Lead.
CREATE OR REPLACE FUNCTION ai_customer_action_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_action_admission a ON a.proposal_id=qp.id WHERE qp.id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_qualification_admissible(ctx) OR ctx IS DISTINCT FROM p.context
   OR ctx IS DISTINCT FROM (SELECT context FROM ai_customer_action_admission WHERE proposal_id=pid) THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;
