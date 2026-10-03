ALTER TABLE field_definition
  ADD COLUMN description text,
  ADD COLUMN value_mode text NOT NULL DEFAULT 'MANUAL' CHECK (value_mode IN ('MANUAL','SOURCE','SYSTEM','CALCULATED')),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT field_scope_shape CHECK (
    (branch_id IS NULL AND campaign_id IS NULL) OR
    (branch_id IS NOT NULL AND campaign_id IS NULL) OR
    (branch_id IS NOT NULL AND campaign_id IS NOT NULL)
  ),
  ADD CONSTRAINT field_options_array CHECK (jsonb_typeof(options) = 'array'),
  ADD CONSTRAINT field_validation_object CHECK (jsonb_typeof(validation) = 'object'),
  ADD CONSTRAINT field_branch_org_fk FOREIGN KEY (branch_id, organization_id) REFERENCES branch(id, organization_id),
  ADD CONSTRAINT field_campaign_branch_fk FOREIGN KEY (campaign_id, branch_id) REFERENCES campaign(id, branch_id);
UPDATE field_definition SET value_mode = 'CALCULATED' WHERE field_type = 'CALCULATED';
ALTER TABLE field_definition ADD CONSTRAINT field_calculation_mode CHECK ((field_type = 'CALCULATED') = (value_mode = 'CALCULATED'));
CREATE UNIQUE INDEX field_global_key_unique ON field_definition (organization_id, key) WHERE branch_id IS NULL;
CREATE UNIQUE INDEX field_branch_key_unique ON field_definition (branch_id, key) WHERE campaign_id IS NULL AND branch_id IS NOT NULL;
CREATE INDEX field_scope_active_idx ON field_definition (organization_id, branch_id, campaign_id, active, created_at DESC);

ALTER TABLE campaign_field
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN visible_to_manager boolean NOT NULL DEFAULT true,
  ADD COLUMN editable_by_manager boolean NOT NULL DEFAULT true,
  ADD COLUMN required_stage text NOT NULL DEFAULT 'NONE' CHECK (required_stage IN ('NONE','LEAD_CREATION','CLOSE','ENROLLMENT')),
  ADD CONSTRAINT campaign_field_agent_edit_visible CHECK (NOT editable_by_agent OR visible_to_agent),
  ADD CONSTRAINT campaign_field_manager_edit_visible CHECK (NOT editable_by_manager OR visible_to_manager);
CREATE INDEX campaign_field_order_idx ON campaign_field (campaign_id, position, field_id);

ALTER TABLE lead_field_value ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX lead_field_value_field_idx ON lead_field_value (field_id, lead_id);
CREATE INDEX field_value_history_field_lead_idx ON field_value_history (field_id, lead_id, created_at DESC, id DESC);
