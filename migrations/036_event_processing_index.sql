DROP INDEX integration_event_received_due_idx;
CREATE INDEX integration_event_processing_due_idx ON integration_event
  (event_kind, processing_available_at, received_at, id)
  WHERE event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE') AND (state = 'RECEIVED' OR
    (state = 'NEEDS_ATTENTION' AND failure_code IN ('INBOUND_PROCESSING_NOT_READY','MESSAGE_NOT_FOUND')));
