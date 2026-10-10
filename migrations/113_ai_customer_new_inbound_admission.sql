-- Queue admission is atomic with the NEW authenticated inbound journal, never a replay of an old BLOCKED artifact.
CREATE FUNCTION guard_ai_customer_new_inbound_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_customer_inbound_execution e WHERE e.event_id=NEW.event_id AND e.message_id=NEW.message_id AND e.xmin=pg_current_xact_id()::xid)
   THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_SOURCE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_new_inbound_admission BEFORE INSERT ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_new_inbound_admission();
