CREATE UNIQUE INDEX conversation_one_open_lead_channel_idx ON conversation (lead_id, channel)
  WHERE state <> 'CLOSED';

CREATE INDEX conversation_lead_channel_recent_idx ON conversation (lead_id, channel, started_at DESC, id DESC);
