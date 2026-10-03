ALTER TABLE integration_event ADD COLUMN review_note text
  CHECK (review_note IS NULL OR length(review_note) <= 500);
CREATE INDEX integration_event_inbound_pending_idx
  ON integration_event (received_at, id)
  WHERE event_kind = 'INBOUND_MESSAGE' AND state = 'NEEDS_ATTENTION'
    AND failure_code = 'INBOUND_PROCESSING_NOT_READY';
