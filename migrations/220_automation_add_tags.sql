ALTER TABLE automation_rule
 ADD COLUMN action_field_operation text NOT NULL DEFAULT 'SET' CHECK(action_field_operation IN ('SET','ADD_TAGS')),
 ADD CONSTRAINT automation_rule_field_operation_shape CHECK(action_type='SET_FIELD_VALUE' OR action_field_operation='SET');

ALTER TABLE automation_field_effect
 ADD COLUMN operation text NOT NULL DEFAULT 'SET' CHECK(operation IN ('SET','ADD_TAGS'));

CREATE FUNCTION automation_field_next_value(operation text,approved jsonb,prior jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN operation='ADD_TAGS' THEN (
  SELECT jsonb_agg(value ORDER BY first_position) FROM (
   SELECT value,min(position) AS first_position
   FROM jsonb_array_elements(COALESCE(NULLIF(prior,'null'::jsonb),'[]'::jsonb)||approved) WITH ORDINALITY AS tags(value,position)
   GROUP BY value
  ) deduplicated
 ) ELSE approved END
$$;

CREATE OR REPLACE FUNCTION guard_automation_field_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field field_definition;
BEGIN
 IF NEW.action_type<>'SET_FIELD_VALUE' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NOT NEW.enabled AND
  (NEW.action_field_id,NEW.action_field_value,NEW.action_field_definition_version,NEW.action_field_operation)
  IS NOT DISTINCT FROM (OLD.action_field_id,OLD.action_field_value,OLD.action_field_definition_version,OLD.action_field_operation)
 THEN RETURN NEW; END IF;
 SELECT * INTO field FROM field_definition WHERE id=NEW.action_field_id FOR SHARE;
 IF field.id IS NULL OR field.version IS DISTINCT FROM NEW.action_field_definition_version
  OR NOT automation_action_field_available(field.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,
       (SELECT role='MANAGER' FROM user_account WHERE id=NEW.actor_id))
 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_FIELD_UNAVAILABLE'; END IF;
 IF NOT stored_field_value_valid(NEW.action_field_value,field) THEN RAISE EXCEPTION 'AUTOMATION_ACTION_FIELD_INVALID'; END IF;
 IF NEW.action_field_operation='ADD_TAGS' AND (field.field_type<>'TAGS' OR NEW.action_field_value='[]'::jsonb)
 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_FIELD_INVALID'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_automation_field_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution automation_execution; source automation_source; rule automation_rule; binding campaign_field; prior lead_field_value;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_FIELD_EFFECT_IMMUTABLE'; END IF;
 SELECT * INTO execution FROM automation_execution WHERE id=NEW.execution_id AND ai_row_inserted_here(xmin);
 IF pg_trigger_depth()<2 OR execution.id IS NULL OR execution.operation<>'EXECUTE' OR execution.state<>'SUCCEEDED'
  OR automation_execution_reason(execution.id) IS NOT NULL
 THEN RAISE EXCEPTION 'AUTOMATION_FIELD_EFFECT_REQUIRED'; END IF;
 SELECT * INTO source FROM automation_source WHERE id=execution.source_id;
 SELECT * INTO rule FROM automation_rule WHERE id=execution.rule_id AND version=execution.rule_version AND action_type='SET_FIELD_VALUE';
 IF rule.id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_FIELD_ACTION_REQUIRED'; END IF;
 SELECT * INTO binding FROM campaign_field WHERE campaign_id=source.campaign_id AND field_id=rule.action_field_id FOR SHARE;
 SELECT * INTO prior FROM lead_field_value WHERE lead_id=source.lead_id AND field_id=rule.action_field_id FOR UPDATE;
 NEW.lead_id=source.lead_id; NEW.field_id=rule.action_field_id; NEW.rule_version=rule.version;
 NEW.definition_version=rule.action_field_definition_version; NEW.binding_version=binding.version;
 NEW.previous_version=COALESCE(prior.version,0); NEW.previous_value=prior.value;
 NEW.operation=rule.action_field_operation;
 NEW.value=automation_field_next_value(NEW.operation,rule.action_field_value,prior.value); NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE e automation_execution;s automation_source;r automation_rule;l lead;b branch;c campaign;u user_account;condition_day date; current_value jsonb; next_value jsonb; target_field field_definition;
BEGIN
 SELECT * INTO e FROM automation_execution WHERE id=eid; SELECT * INTO s FROM automation_source WHERE id=e.source_id;
 SELECT * INTO r FROM automation_rule WHERE id=e.rule_id; SELECT * INTO l FROM lead WHERE id=s.lead_id;
 IF r IS NULL OR r.version<>e.rule_version OR NOT r.enabled THEN RETURN 'RULE_CHANGED'; END IF;
 IF l IS NULL OR (l.organization_id,l.branch_id,l.campaign_id) IS DISTINCT FROM (s.organization_id,s.branch_id,s.campaign_id)
  OR r.organization_id<>l.organization_id OR r.branch_id IS NOT NULL AND r.branch_id<>l.branch_id
  OR r.campaign_id IS NOT NULL AND r.campaign_id<>l.campaign_id THEN RETURN 'SCOPE_CHANGED'; END IF;
 SELECT * INTO u FROM user_account WHERE id=r.actor_id;
 IF u IS NULL OR NOT u.active OR u.organization_id<>r.organization_id OR NOT
  (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND r.branch_id IS NOT NULL AND u.branch_id=r.branch_id) THEN RETURN 'APPROVAL_REVOKED'; END IF;
 SELECT * INTO b FROM branch WHERE id=l.branch_id; SELECT * INTO c FROM campaign WHERE id=l.campaign_id;
 IF b IS NULL OR NOT b.active OR c IS NULL OR c.organization_id<>l.organization_id OR c.branch_id<>l.branch_id OR c.status<>'ACTIVE'
  THEN RETURN 'SCOPE_INACTIVE'; END IF;
 IF r.id=ANY(s.causal_rule_ids) THEN RETURN 'AUTOMATION_CAUSAL_REPEAT'; END IF;
 IF cardinality(s.causal_rule_ids)>=8 THEN RETURN 'AUTOMATION_CAUSAL_LIMIT'; END IF;
 IF s.field_change_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM automation_field_change f JOIN field_definition d ON d.id=f.field_id AND d.version=f.definition_version
  JOIN campaign_field cf ON cf.field_id=f.field_id AND cf.campaign_id=l.campaign_id AND cf.version=f.binding_version
   WHERE f.id=s.field_change_id AND f.field_id=r.trigger_field_id
    AND automation_field_trigger_available(f.field_id,l.organization_id,l.branch_id,l.campaign_id,u.role='MANAGER'))
 THEN RETURN 'AUTOMATION_TRIGGER_FIELD_UNAVAILABLE'; END IF;
 IF r.condition_field_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM field_definition d WHERE d.id=r.condition_field_id AND d.version=r.condition_field_definition_version
    AND automation_field_trigger_available(d.id,l.organization_id,l.branch_id,l.campaign_id,u.role='MANAGER'))
 THEN RETURN 'AUTOMATION_CONDITION_FIELD_UNAVAILABLE'; END IF;
 IF r.condition_agent_id IS NOT NULL AND (
  l.assigned_agent_id IS DISTINCT FROM r.condition_agent_id OR NOT EXISTS(
   SELECT 1 FROM user_account a WHERE a.id=r.condition_agent_id AND a.active AND a.role='AGENT'
    AND a.organization_id=l.organization_id AND a.branch_id=l.branch_id FOR SHARE))
 THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 IF r.condition_date_basis IS NOT NULL THEN
  condition_day=((CASE r.condition_date_basis WHEN 'LEAD_CREATED' THEN l.created_at ELSE s.captured_at END)
    AT TIME ZONE 'UTC')::date;
  IF r.condition_date_from IS NOT NULL AND condition_day<r.condition_date_from
   OR r.condition_date_through IS NOT NULL AND condition_day>r.condition_date_through
  THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 END IF;
 IF r.lifecycle IS NOT NULL AND r.lifecycle<>l.lifecycle OR r.owner_condition='ASSIGNED' AND l.assigned_agent_id IS NULL
  OR r.owner_condition='UNASSIGNED' AND l.assigned_agent_id IS NOT NULL
  OR (r.condition_field_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lead_field_value v
   WHERE v.lead_id=l.id AND v.field_id=r.condition_field_id AND v.value=r.condition_field_value))
  OR NOT automation_payment_matches(l.id,l.organization_id,r.payment_condition)
  OR NOT automation_enrollment_matches(l.id,l.organization_id,r.enrollment_condition)
  OR NOT automation_conversation_matches(s.id,l.id,r.conversation_state_condition,r.controller_condition)
 THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 IF r.action_type='SET_FIELD_VALUE' THEN
  PERFORM 1 FROM field_definition f JOIN campaign_field cf ON cf.field_id=f.id AND cf.campaign_id=l.campaign_id
   WHERE f.id=r.action_field_id AND f.version=r.action_field_definition_version FOR SHARE OF f,cf;
  IF NOT FOUND OR NOT automation_action_field_available(r.action_field_id,l.organization_id,l.branch_id,l.campaign_id,u.role='MANAGER')
  THEN RETURN 'AUTOMATION_ACTION_FIELD_UNAVAILABLE'; END IF;
  SELECT value INTO current_value FROM lead_field_value WHERE lead_id=l.id AND field_id=r.action_field_id;
  next_value=automation_field_next_value(r.action_field_operation,r.action_field_value,current_value);
  IF current_value IS NOT DISTINCT FROM next_value THEN RETURN 'FIELD_ALREADY_MATCHES'; END IF;
  IF r.action_field_operation='ADD_TAGS' THEN
   SELECT * INTO target_field FROM field_definition WHERE id=r.action_field_id;
   IF jsonb_array_length(next_value)>50 THEN RETURN 'AUTOMATION_TAG_LIMIT_REACHED'; END IF;
   IF NOT stored_field_value_valid(next_value,target_field) THEN RETURN 'AUTOMATION_ACTION_FIELD_INVALID'; END IF;
  END IF;
 END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;
