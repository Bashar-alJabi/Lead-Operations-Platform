ALTER TABLE integration_event ADD CONSTRAINT event_processing_terminal_failure CHECK (
  processing_attempts >= processing_failures AND
  (processing_failures < 5 OR (state = 'FAILED' AND failure_code IS NOT NULL AND failure_code = 'EVENT_PROCESSING_FAILED'))
);
