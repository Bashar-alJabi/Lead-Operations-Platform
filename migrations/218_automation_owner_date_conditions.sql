ALTER TABLE automation_rule
 ADD COLUMN condition_agent_id uuid REFERENCES user_account(id),
 ADD COLUMN condition_date_basis text CHECK(condition_date_basis IN ('LEAD_CREATED','EVENT_CAPTURED')),
 ADD COLUMN condition_date_from date CHECK(isfinite(condition_date_from)),
 ADD COLUMN condition_date_through date CHECK(isfinite(condition_date_through)),
 ADD CONSTRAINT automation_rule_agent_condition_shape
  CHECK(condition_agent_id IS NULL OR owner_condition<>'UNASSIGNED'),
 ADD CONSTRAINT automation_rule_date_condition_shape CHECK(
  (condition_date_basis IS NULL AND num_nonnulls(condition_date_from,condition_date_through)=0)
  OR (condition_date_basis IS NOT NULL AND num_nonnulls(condition_date_from,condition_date_through)>0
   AND (condition_date_from IS NULL OR condition_date_through IS NULL OR condition_date_from<=condition_date_through)));

CREATE FUNCTION guard_automation_agent_condition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.condition_agent_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NOT NEW.enabled AND NEW.condition_agent_id IS NOT DISTINCT FROM OLD.condition_agent_id
 THEN RETURN NEW; END IF;
 PERFORM 1 FROM user_account a WHERE a.id=NEW.condition_agent_id AND a.active AND a.role='AGENT'
  AND a.organization_id=NEW.organization_id AND (NEW.branch_id IS NULL OR a.branch_id=NEW.branch_id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_CONDITION_AGENT_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_agent_condition_guard BEFORE INSERT OR UPDATE ON automation_rule
 FOR EACH ROW EXECUTE FUNCTION guard_automation_agent_condition();

CREATE OR REPLACE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE e automation_execution;s automation_source;r automation_rule;l lead;b branch;c campaign;u user_account;condition_day date;
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
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;
