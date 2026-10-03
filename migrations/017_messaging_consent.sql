ALTER TABLE messaging_consent ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE messaging_consent_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES contact(id),
  channel text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  do_not_contact boolean NOT NULL,
  evidence text,
  source text NOT NULL,
  changed_by uuid NOT NULL REFERENCES user_account(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, channel, version)
);
CREATE INDEX messaging_consent_history_contact_idx ON messaging_consent_history (contact_id, channel, changed_at DESC);
