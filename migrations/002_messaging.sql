CREATE TABLE integration_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid REFERENCES branch(id),
  kind text NOT NULL CHECK (kind IN ('META','MESSAGING','PAYMENT','EMAIL','AI','GOOGLE','GENERIC_SOURCE')),
  provider text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED','CONNECTED','WARNING','ERROR','DISCONNECTED','DISABLED','AUTH_EXPIRED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  created_by uuid REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX integration_connection_scope_idx ON integration_connection (organization_id, kind, branch_id, status);

CREATE TABLE connection_secret (
  connection_id uuid PRIMARY KEY REFERENCES integration_connection(id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  branch_id uuid NOT NULL REFERENCES branch(id),
  campaign_id uuid REFERENCES campaign(id),
  external_resource_kind text NOT NULL,
  external_resource_id text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_binding_active_resource_idx ON integration_binding (connection_id, external_resource_kind, external_resource_id)
  WHERE active = true;
CREATE INDEX integration_binding_campaign_idx ON integration_binding (campaign_id, active);

CREATE TABLE messaging_sender (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  external_sender_id text NOT NULL,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  health text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_sender_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE sender_branch_binding (
  sender_id uuid NOT NULL REFERENCES messaging_sender(id),
  branch_id uuid NOT NULL REFERENCES branch(id),
  allow_shared_fallback boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sender_id, branch_id)
);
CREATE INDEX sender_branch_binding_branch_idx ON sender_branch_binding (branch_id, sender_id);

ALTER TABLE branch ADD COLUMN default_sender_id uuid REFERENCES messaging_sender(id);
ALTER TABLE campaign ADD COLUMN sender_override_id uuid REFERENCES messaging_sender(id);
ALTER TABLE source_submission ADD CONSTRAINT source_submission_connection_fk FOREIGN KEY (connection_id) REFERENCES integration_connection(id);

CREATE TABLE messaging_consent (
  contact_id uuid NOT NULL REFERENCES contact(id),
  channel text NOT NULL,
  status text NOT NULL CHECK (status IN ('GRANTED','REVOKED','UNKNOWN')),
  do_not_contact boolean NOT NULL DEFAULT false,
  evidence text,
  source text NOT NULL,
  updated_by uuid REFERENCES user_account(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, channel)
);

CREATE TABLE provider_message_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  external_template_id text NOT NULL,
  name text NOT NULL,
  language text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_template_id)
);

CREATE TABLE conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES lead(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  sender_id uuid NOT NULL REFERENCES messaging_sender(id),
  channel text NOT NULL,
  participant_ref text NOT NULL,
  provider_thread_ref text,
  controller_type text NOT NULL CHECK (controller_type IN ('AI','HUMAN','NONE')),
  controller_user_id uuid REFERENCES user_account(id),
  state text NOT NULL CHECK (state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED')),
  version integer NOT NULL DEFAULT 1,
  needs_attention_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  closed_at timestamptz,
  CHECK ((controller_type = 'HUMAN' AND controller_user_id IS NOT NULL) OR (controller_type <> 'HUMAN' AND controller_user_id IS NULL))
);
CREATE UNIQUE INDEX conversation_thread_idx ON conversation (connection_id, sender_id, provider_thread_ref)
  WHERE provider_thread_ref IS NOT NULL;
CREATE INDEX conversation_lead_idx ON conversation (lead_id, started_at DESC);
CREATE INDEX conversation_participant_idx ON conversation (connection_id, sender_id, participant_ref, state);

CREATE TABLE conversation_handoff (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id),
  from_controller text NOT NULL,
  from_user_id uuid REFERENCES user_account(id),
  to_controller text NOT NULL,
  to_user_id uuid REFERENCES user_account(id),
  reason text NOT NULL,
  requested_by uuid REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_handoff_time_idx ON conversation_handoff (conversation_id, created_at DESC);

CREATE TABLE conversation_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation(id),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  sender_id uuid NOT NULL REFERENCES messaging_sender(id),
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  author_type text NOT NULL CHECK (author_type IN ('CUSTOMER','HUMAN','AI','AUTOMATION','FOLLOW_UP')),
  author_user_id uuid REFERENCES user_account(id),
  body text NOT NULL CHECK (length(body) <= 20000),
  provider_message_id text,
  delivery_state text NOT NULL CHECK (delivery_state IN ('QUEUED','SENT','DELIVERED','READ','FAILED','RECEIVED')),
  delivery_rank integer NOT NULL DEFAULT 0,
  idempotency_key text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  received_at timestamptz,
  UNIQUE (conversation_id, idempotency_key)
);
CREATE UNIQUE INDEX conversation_message_provider_idx ON conversation_message (connection_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX conversation_message_time_idx ON conversation_message (conversation_id, created_at DESC, id DESC);

CREATE TABLE integration_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  provider_event_id text NOT NULL,
  event_kind text NOT NULL,
  sender_id uuid REFERENCES messaging_sender(id),
  participant_ref text,
  provider_thread_ref text,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED','PROCESSED','NEEDS_ATTENTION','FAILED','IGNORED')),
  failure_code text,
  lead_id uuid REFERENCES lead(id),
  conversation_id uuid REFERENCES conversation(id),
  resolved_by uuid REFERENCES user_account(id),
  resolved_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_event_id)
);
CREATE INDEX integration_event_review_idx ON integration_event (connection_id, state, received_at DESC);
CREATE INDEX integration_event_participant_idx ON integration_event (connection_id, sender_id, participant_ref, received_at DESC);

CREATE TABLE message_delivery_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES conversation_message(id),
  integration_event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),
  status text NOT NULL,
  provider_timestamp timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);
