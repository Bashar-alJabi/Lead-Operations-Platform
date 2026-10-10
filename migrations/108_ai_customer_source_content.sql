-- Native message/event identity and body must agree; caller-supplied source labels are insufficient.
CREATE FUNCTION guard_ai_customer_source_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM integration_event e JOIN conversation_message m ON m.id=NEW.message_id AND m.source_event_id=e.id
    WHERE e.id=NEW.event_id AND m.body IS NOT DISTINCT FROM CASE e.payload->'message'->>'type'
      WHEN 'text' THEN e.payload->'message'->'text'->>'body'
      WHEN 'button' THEN e.payload->'message'->'button'->>'text'
      ELSE COALESCE(e.payload->'message'->(e.payload->'message'->>'type')->>'caption','') END)
    THEN RAISE EXCEPTION 'AI_CUSTOMER_SOURCE_CONTENT_REQUIRED';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_source_content_guard BEFORE INSERT ON ai_customer_inbound_execution FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_source_content();
