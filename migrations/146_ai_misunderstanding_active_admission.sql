-- Diagnostic processing Attention is retained as a proposal, never promoted into an active observation.
-- Keep Native145's insert guard strict; skip admission rather than making a denied source retry forever.
CREATE OR REPLACE FUNCTION observe_ai_customer_misunderstanding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision'='HANDOFF' AND NEW.result->>'handoffReason'='REPEATED_MISUNDERSTANDING'
   AND NEW.context->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND NEW.context->'conversation'->'attentionReason'='null' THEN
   INSERT INTO ai_misunderstanding_observation(proposal_id) VALUES(NEW.id);
 END IF;RETURN NEW;
END $$;
