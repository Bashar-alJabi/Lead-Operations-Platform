-- Other future integration event kinds keep their own retention rules.
DROP TRIGGER messaging_event_identity_guard ON integration_event;
CREATE TRIGGER messaging_event_identity_guard BEFORE UPDATE OR DELETE ON integration_event
  FOR EACH ROW WHEN (OLD.event_kind IN ('INBOUND_MESSAGE','DELIVERY_STATUS'))
  EXECUTE FUNCTION preserve_messaging_event_identity();
