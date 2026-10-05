-- Preserve signed callback evidence; resolution and processing metadata remain writable.
CREATE FUNCTION preserve_messaging_event_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.event_kind NOT IN ('INBOUND_MESSAGE','DELIVERY_STATUS') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MESSAGING_EVENT_HISTORY_RETAINED'; END IF;
  IF (NEW.id,NEW.connection_id,NEW.provider_event_id,NEW.event_kind,NEW.participant_ref,NEW.provider_thread_ref,NEW.payload,NEW.received_at)
    IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.provider_event_id,OLD.event_kind,OLD.participant_ref,OLD.provider_thread_ref,OLD.payload,OLD.received_at)
    THEN RAISE EXCEPTION 'MESSAGING_EVENT_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id AND (OLD.sender_id IS NOT NULL OR NEW.sender_id IS NULL OR NOT EXISTS
    (SELECT 1 FROM messaging_sender s WHERE s.id=NEW.sender_id AND s.connection_id=OLD.connection_id
      AND s.external_sender_id=OLD.payload->>'senderExternalId'))
    THEN RAISE EXCEPTION 'MESSAGING_EVENT_SENDER_INVALID'; END IF;
  IF OLD.state IN ('PROCESSED','IGNORED') AND
    (NEW.state,NEW.failure_code,NEW.lead_id,NEW.conversation_id,NEW.resolved_by,NEW.resolved_at,NEW.review_note)
    IS DISTINCT FROM (OLD.state,OLD.failure_code,OLD.lead_id,OLD.conversation_id,OLD.resolved_by,OLD.resolved_at,OLD.review_note)
    THEN RAISE EXCEPTION 'MESSAGING_EVENT_RESOLUTION_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messaging_event_identity_guard BEFORE UPDATE OR DELETE ON integration_event
  FOR EACH ROW EXECUTE FUNCTION preserve_messaging_event_identity();
