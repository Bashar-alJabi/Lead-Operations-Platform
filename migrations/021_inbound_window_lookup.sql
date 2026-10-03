CREATE INDEX conversation_message_inbound_window_idx
  ON conversation_message (conversation_id, received_at DESC, id DESC)
  WHERE direction = 'INBOUND';
