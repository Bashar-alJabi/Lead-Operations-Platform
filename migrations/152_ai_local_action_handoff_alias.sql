-- Keep the child source variable distinct from Handoff table aliases.
CREATE OR REPLACE FUNCTION ai_local_action_context_current(pid uuid,k text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p record;ctx jsonb;expected jsonb;child_source ai_qualification_send_source;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN false;END IF;
 ctx=ai_customer_proposal_context(p.event_id);IF ctx IS NULL THEN RETURN false;END IF;
 IF k='QUALIFICATION' THEN RETURN ai_qualification_admissible(ctx) AND ctx=p.context;
 ELSIF k='SEND' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT * INTO child_source FROM ai_qualification_send_source WHERE proposal_id=pid;
     IF child_source IS NULL OR child_source.context IS DISTINCT FROM ai_qualification_handoff_expected(child_source.qualification_action_id)
       OR ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM child_source.outcome OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM child_source.question THEN RETURN false;END IF;
     expected=child_source.context;
   ELSIF p.result->>'decision' NOT IN ('ANSWER','QUESTION') THEN RETURN false;END IF;
   RETURN ai_send_admissible(ctx) AND ctx=expected AND EXISTS(SELECT 1 FROM ai_customer_send_admission WHERE proposal_id=pid);
 ELSIF k='HANDOFF' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT hs.context INTO expected FROM ai_qualification_handoff_source hs WHERE hs.proposal_id=pid;
     IF expected IS NULL OR (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true' THEN RETURN false;END IF;
   ELSIF p.result->>'decision'<>'HANDOFF' THEN RETURN false;END IF;
   RETURN ai_handoff_admissible(ctx) AND ctx=expected;
 END IF;RETURN false;
END $$;
