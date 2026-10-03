ALTER TABLE lead ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE follow_up ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE follow_up ADD COLUMN priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH'));
ALTER TABLE follow_up ADD COLUMN cancelled_by uuid REFERENCES user_account(id);
ALTER TABLE follow_up ADD COLUMN cancelled_at timestamptz;
CREATE TABLE follow_up_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  follow_up_id uuid NOT NULL REFERENCES follow_up(id),
  actor_user_id uuid REFERENCES user_account(id),
  event_type text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX follow_up_history_item_idx ON follow_up_history (follow_up_id, id DESC);
CREATE INDEX follow_up_lead_time_idx ON follow_up (lead_id, created_at DESC, id DESC);
CREATE INDEX lead_activity_lead_id_idx ON lead_activity (lead_id, id DESC);
CREATE INDEX assignment_history_lead_id_idx ON assignment_history (lead_id, id DESC);
