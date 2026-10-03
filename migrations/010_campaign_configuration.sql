ALTER TABLE campaign ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE campaign ADD COLUMN last_activated_at timestamptz;
ALTER TABLE campaign ADD COLUMN last_deactivated_at timestamptz;
CREATE INDEX campaign_org_time_idx ON campaign (organization_id, created_at DESC, id DESC);
