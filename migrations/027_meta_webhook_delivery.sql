ALTER TABLE conversation_message ADD COLUMN delivery_provider_at timestamptz;
ALTER TABLE messaging_connection_test_send
  ADD COLUMN delivery_state text CHECK (delivery_state IN ('SENT','DELIVERED','READ','FAILED')),
  ADD COLUMN delivery_provider_at timestamptz;
CREATE UNIQUE INDEX messaging_test_send_provider_idx
  ON messaging_connection_test_send (connection_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX integration_event_delivery_pending_idx
  ON integration_event (connection_id, received_at, id)
  WHERE event_kind = 'DELIVERY_STATUS' AND state = 'NEEDS_ATTENTION';
