ALTER TABLE branch
  ADD COLUMN messaging_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN messaging_policy_version integer NOT NULL DEFAULT 1 CHECK (messaging_policy_version > 0);

ALTER TABLE campaign ADD COLUMN messaging_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
