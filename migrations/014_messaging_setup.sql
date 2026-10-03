ALTER TABLE integration_connection ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX messaging_sender_connection_idx ON messaging_sender (connection_id, active, id);
