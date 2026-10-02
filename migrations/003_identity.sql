ALTER TABLE user_account ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE user_account ADD COLUMN credential_state text NOT NULL DEFAULT 'READY'
  CHECK (credential_state IN ('INVITED','READY'));
ALTER TABLE user_account ADD CONSTRAINT user_credential_state_check
  CHECK ((credential_state = 'READY' AND password_hash IS NOT NULL) OR
         (credential_state = 'INVITED' AND password_hash IS NULL));

ALTER TABLE password_reset RENAME TO credential_token;
ALTER TABLE credential_token ADD COLUMN purpose text NOT NULL DEFAULT 'RESET'
  CHECK (purpose IN ('INVITATION','RESET'));
CREATE INDEX credential_token_user_purpose_idx ON credential_token (user_id, purpose, created_at DESC)
  WHERE used_at IS NULL;

CREATE TABLE identity_email_connection (
  organization_id uuid PRIMARY KEY REFERENCES organization(id),
  connection_id uuid NOT NULL UNIQUE,
  updated_by uuid REFERENCES user_account(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, organization_id) REFERENCES integration_connection(id, organization_id)
);
