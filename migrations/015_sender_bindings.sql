ALTER TABLE messaging_sender
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN operator_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE branch ADD COLUMN sender_version integer NOT NULL DEFAULT 1 CHECK (sender_version > 0);
