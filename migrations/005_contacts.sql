ALTER TABLE source_submission ADD COLUMN campaign_id uuid REFERENCES campaign(id);
ALTER TABLE source_submission ADD COLUMN resolution_contact_id uuid REFERENCES contact(id);
ALTER TABLE contact ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX source_submission_branch_review_idx ON source_submission (organization_id, branch_id, state, created_at DESC, id DESC);

CREATE TABLE contact_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES contact(id),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  old_data jsonb NOT NULL,
  new_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_history_contact_idx ON contact_history (contact_id, created_at DESC, id DESC);
CREATE INDEX lead_contact_time_idx ON lead (contact_id, created_at DESC, id DESC);
