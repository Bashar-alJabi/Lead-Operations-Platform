CREATE TABLE saved_lead_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid REFERENCES branch(id),
  owner_user_id uuid NOT NULL REFERENCES user_account(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  scope text NOT NULL CHECK (scope IN ('PERSONAL','BRANCH','ORGANIZATION')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  columns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(columns) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  UNIQUE (owner_user_id, name),
  CHECK ((scope = 'ORGANIZATION' AND branch_id IS NULL) OR
    (scope = 'BRANCH' AND branch_id IS NOT NULL) OR scope = 'PERSONAL')
);
CREATE INDEX saved_lead_view_scope_idx ON saved_lead_view (organization_id, scope, branch_id, created_at DESC, id DESC);
