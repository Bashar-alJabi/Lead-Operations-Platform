-- Preserve the already applied migration. CHECK must reject SQL NULL explicitly.
ALTER TABLE conversation_message DROP CONSTRAINT template_reply_shape;
ALTER TABLE conversation_message ADD CONSTRAINT template_reply_shape CHECK (
  (reply_to_message_id IS NULL AND reply_button_index IS NULL)
  OR (reply_to_message_id IS NOT NULL AND reply_button_index IS NOT NULL AND reply_button_index BETWEEN 0 AND 2
    AND direction = 'INBOUND' AND message_kind = 'TEXT' AND author_type = 'CUSTOMER')
);
