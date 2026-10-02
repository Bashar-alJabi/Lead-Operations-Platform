CREATE TABLE IF NOT EXISTS schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  timezone text NOT NULL DEFAULT 'UTC',
  active boolean NOT NULL DEFAULT true,
  ai_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE user_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid,
  role text NOT NULL CHECK (role IN ('SUPER_ADMIN','MANAGER','AGENT')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  email text NOT NULL,
  email_normalized text GENERATED ALWAYS AS (lower(trim(email))) STORED,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_branch_scope CHECK ((role = 'SUPER_ADMIN' AND branch_id IS NULL) OR (role <> 'SUPER_ADMIN' AND branch_id IS NOT NULL)),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  UNIQUE (organization_id, email_normalized),
  UNIQUE (id, branch_id)
);
CREATE INDEX user_branch_role_idx ON user_account (branch_id, role, active);

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_account(id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_session_active_idx ON user_session (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE password_reset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_account(id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid REFERENCES branch(id),
  actor_user_id uuid REFERENCES user_account(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_scope_time_idx ON audit_log (organization_id, branch_id, created_at DESC, id DESC);

CREATE TABLE contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  name text NOT NULL,
  phone text,
  phone_normalized text,
  email text,
  email_normalized text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX contact_phone_idx ON contact (organization_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX contact_email_idx ON contact (organization_id, email_normalized) WHERE email_normalized IS NOT NULL;

CREATE TABLE campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE')),
  source_kind text NOT NULL DEFAULT 'MANUAL',
  routing_method text NOT NULL DEFAULT 'MANUAL' CHECK (routing_method IN ('MANUAL','ROUND_ROBIN','WEIGHTED','PERFORMANCE')),
  routing_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  messaging_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  conversion_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  UNIQUE (id, branch_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX campaign_branch_status_idx ON campaign (branch_id, status, created_at DESC);

CREATE TABLE campaign_agent (
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  agent_id uuid NOT NULL REFERENCES user_account(id),
  active boolean NOT NULL DEFAULT true,
  weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
  capacity_override integer CHECK (capacity_override IS NULL OR capacity_override >= 0),
  PRIMARY KEY (campaign_id, agent_id)
);

CREATE TABLE lead (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  assigned_agent_id uuid,
  lifecycle text NOT NULL DEFAULT 'OPEN' CHECK (lifecycle IN ('OPEN','CLOSED','ARCHIVED')),
  source_kind text NOT NULL,
  needs_attention_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  FOREIGN KEY (campaign_id, branch_id) REFERENCES campaign(id, branch_id),
  FOREIGN KEY (contact_id, organization_id) REFERENCES contact(id, organization_id),
  FOREIGN KEY (assigned_agent_id, branch_id) REFERENCES user_account(id, branch_id),
  UNIQUE (id, branch_id)
);
CREATE INDEX lead_branch_time_idx ON lead (branch_id, created_at DESC, id DESC);
CREATE INDEX lead_campaign_time_idx ON lead (campaign_id, created_at DESC, id DESC);
CREATE INDEX lead_agent_open_idx ON lead (assigned_agent_id, created_at DESC, id DESC) WHERE lifecycle = 'OPEN';
CREATE INDEX lead_contact_open_idx ON lead (contact_id, created_at DESC) WHERE lifecycle = 'OPEN';

CREATE TABLE source_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid REFERENCES branch(id),
  lead_id uuid REFERENCES lead(id),
  source_kind text NOT NULL,
  connection_id uuid,
  external_event_id text,
  raw_payload jsonb NOT NULL,
  source_timestamp timestamptz,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED','PROCESSED','NEEDS_ATTENTION','FAILED')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX source_submission_event_idx ON source_submission (connection_id, external_event_id) WHERE connection_id IS NOT NULL AND external_event_id IS NOT NULL;
CREATE INDEX source_submission_review_idx ON source_submission (organization_id, state, created_at DESC);

CREATE TABLE assignment_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES lead(id),
  old_branch_id uuid REFERENCES branch(id),
  old_agent_id uuid REFERENCES user_account(id),
  new_branch_id uuid NOT NULL REFERENCES branch(id),
  new_agent_id uuid REFERENCES user_account(id),
  actor_user_id uuid REFERENCES user_account(id),
  method text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignment_history_lead_idx ON assignment_history (lead_id, created_at DESC);

CREATE TABLE lead_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES lead(id),
  actor_user_id uuid REFERENCES user_account(id),
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_activity_lead_idx ON lead_activity (lead_id, created_at DESC, id DESC);

CREATE TABLE field_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid REFERENCES branch(id),
  campaign_id uuid REFERENCES campaign(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('TEXT','LONG_TEXT','NUMBER','PHONE','EMAIL','DATE','TIME','DATETIME','SINGLE_SELECT','MULTI_SELECT','BOOLEAN','STATUS','INTEREST','TAGS','CURRENCY','PERCENTAGE','DURATION','URL','CALCULATED')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculation jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, campaign_id, key)
);

CREATE TABLE campaign_field (
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  field_id uuid NOT NULL REFERENCES field_definition(id),
  position integer NOT NULL DEFAULT 0,
  required boolean NOT NULL DEFAULT false,
  visible_to_agent boolean NOT NULL DEFAULT true,
  editable_by_agent boolean NOT NULL DEFAULT true,
  show_in_table boolean NOT NULL DEFAULT false,
  show_in_details boolean NOT NULL DEFAULT true,
  filterable boolean NOT NULL DEFAULT false,
  usable_by_automation boolean NOT NULL DEFAULT false,
  usable_by_ai boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, field_id)
);

CREATE TABLE lead_field_value (
  lead_id uuid NOT NULL REFERENCES lead(id),
  field_id uuid NOT NULL REFERENCES field_definition(id),
  value jsonb NOT NULL,
  source text NOT NULL,
  updated_by uuid REFERENCES user_account(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, field_id)
);
CREATE TABLE field_value_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES lead(id),
  field_id uuid NOT NULL REFERENCES field_definition(id),
  old_value jsonb,
  new_value jsonb NOT NULL,
  source text NOT NULL,
  actor_user_id uuid REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_value_history_lead_idx ON field_value_history (lead_id, created_at DESC);

CREATE TABLE follow_up (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES lead(id),
  owner_user_id uuid REFERENCES user_account(id),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  kind text NOT NULL DEFAULT 'HUMAN',
  note text,
  created_by uuid REFERENCES user_account(id),
  completed_by uuid REFERENCES user_account(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX follow_up_due_idx ON follow_up (owner_user_id, due_at, id) WHERE status = 'OPEN';

CREATE TABLE background_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue, idempotency_key)
);
CREATE INDEX background_job_ready_idx ON background_job (queue, run_after, created_at) WHERE status = 'QUEUED';
