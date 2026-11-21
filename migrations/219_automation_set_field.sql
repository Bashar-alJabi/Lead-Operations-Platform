ALTER TABLE automation_rule
 DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN ('CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE')),
 ADD COLUMN action_field_id uuid REFERENCES field_definition(id),
 ADD COLUMN action_field_value jsonb,
 ADD COLUMN action_field_definition_version integer CHECK(action_field_definition_version>0),
 ADD CONSTRAINT automation_field_action_shape CHECK(
  num_nonnulls(action_field_id,action_field_value,action_field_definition_version)=
   CASE WHEN action_type='SET_FIELD_VALUE' THEN 3 ELSE 0 END);

-- Retain the existing AI entry point while sharing the native validation of persisted field values.
ALTER FUNCTION ai_qualification_value_valid(jsonb,field_definition) RENAME TO stored_field_value_valid;
CREATE FUNCTION ai_qualification_value_valid(v jsonb,f field_definition) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT stored_field_value_valid(v,f)
$$;

CREATE FUNCTION automation_action_field_available(fid uuid,oid uuid,bid uuid,cid uuid,manager boolean)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM field_definition f JOIN campaign_field cf ON cf.field_id=f.id
  JOIN campaign c ON c.id=cf.campaign_id AND c.organization_id=f.organization_id
  WHERE f.id=fid AND f.organization_id=oid AND f.active AND f.value_mode='MANUAL'
   AND (bid IS NULL OR c.branch_id=bid) AND (cid IS NULL OR c.id=cid)
   AND (f.branch_id IS NULL OR f.branch_id=c.branch_id) AND (f.campaign_id IS NULL OR f.campaign_id=c.id)
   AND cf.active AND cf.usable_by_automation
   AND (NOT manager OR cf.visible_to_manager AND cf.editable_by_manager AND (cf.show_in_details OR cf.show_in_table))
 )
$$;

CREATE FUNCTION guard_automation_field_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field field_definition;
BEGIN
 IF NEW.action_type<>'SET_FIELD_VALUE' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NOT NEW.enabled AND
  (NEW.action_field_id,NEW.action_field_value,NEW.action_field_definition_version)
  IS NOT DISTINCT FROM (OLD.action_field_id,OLD.action_field_value,OLD.action_field_definition_version)
 THEN RETURN NEW; END IF;
 SELECT * INTO field FROM field_definition WHERE id=NEW.action_field_id FOR SHARE;
 IF field.id IS NULL OR field.version IS DISTINCT FROM NEW.action_field_definition_version
  OR NOT automation_action_field_available(field.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,
       (SELECT role='MANAGER' FROM user_account WHERE id=NEW.actor_id))
 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_FIELD_UNAVAILABLE'; END IF;
 IF NOT stored_field_value_valid(NEW.action_field_value,field) THEN RAISE EXCEPTION 'AUTOMATION_ACTION_FIELD_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_field_action_guard BEFORE INSERT OR UPDATE ON automation_rule
 FOR EACH ROW EXECUTE FUNCTION guard_automation_field_action();

CREATE TABLE automation_field_effect (
 execution_id uuid PRIMARY KEY REFERENCES automation_execution(id),
 lead_id uuid NOT NULL REFERENCES lead(id),
 field_id uuid NOT NULL REFERENCES field_definition(id),
 rule_version integer NOT NULL,
 definition_version integer NOT NULL,
 binding_version integer NOT NULL,
 previous_version integer NOT NULL CHECK(previous_version>=0),
 previous_value jsonb,
 value jsonb NOT NULL,
 created_at timestamptz NOT NULL
);

ALTER TABLE lead_field_value ADD COLUMN automation_execution_id uuid REFERENCES automation_field_effect(execution_id);
ALTER TABLE field_value_history ADD COLUMN automation_execution_id uuid REFERENCES automation_field_effect(execution_id);
CREATE UNIQUE INDEX automation_field_history_once ON field_value_history(automation_execution_id)
 WHERE automation_execution_id IS NOT NULL;

CREATE FUNCTION guard_automation_field_effect() RETURNS trigger LANGUAGE plpgsql AS $$
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
 NEW.value=rule.action_field_value; NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER automation_field_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_field_effect
 FOR EACH ROW EXECUTE FUNCTION guard_automation_field_effect();

CREATE FUNCTION guard_automation_field_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE effect automation_field_effect;
BEGIN
 IF NEW.source<>'AUTOMATION' THEN NEW.automation_execution_id=NULL; RETURN NEW; END IF;
 SELECT * INTO effect FROM automation_field_effect WHERE execution_id=NEW.automation_execution_id AND ai_row_inserted_here(xmin);
 IF pg_trigger_depth()<2 OR effect.execution_id IS NULL OR NEW.lead_id<>effect.lead_id OR NEW.field_id<>effect.field_id
  OR NEW.value IS DISTINCT FROM effect.value OR NEW.version<>effect.previous_version+1
  OR NEW.updated_by IS NOT NULL OR NEW.ai_action_id IS NOT NULL
  OR num_nonnulls(NEW.source_submission_id,NEW.source_binding_id,NEW.source_mapping_version,
       NEW.source_import_dataset_id,NEW.source_import_sheet_index)>0
  OR (TG_OP='INSERT' AND effect.previous_version<>0)
  OR (TG_OP='UPDATE' AND (OLD.version,OLD.lead_id,OLD.field_id,OLD.value)
       IS DISTINCT FROM (effect.previous_version,effect.lead_id,effect.field_id,effect.previous_value))
 THEN RAISE EXCEPTION 'AUTOMATION_FIELD_CURRENT_EFFECT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_field_write_guard BEFORE INSERT OR UPDATE ON lead_field_value
 FOR EACH ROW EXECUTE FUNCTION guard_automation_field_write();

CREATE FUNCTION guard_automation_field_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.automation_execution_id IS NOT NULL
 THEN RAISE EXCEPTION 'AUTOMATION_FIELD_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.source<>'AUTOMATION' AND NEW.automation_execution_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' OR NEW.source<>'AUTOMATION' OR NEW.actor_user_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM automation_field_effect e JOIN lead_field_value v ON v.lead_id=e.lead_id AND v.field_id=e.field_id
   WHERE e.execution_id=NEW.automation_execution_id AND ai_row_inserted_here(e.xmin)
    AND ai_row_inserted_here(v.xmin) AND v.automation_execution_id=e.execution_id AND v.source='AUTOMATION'
    AND NEW.lead_id=e.lead_id AND NEW.field_id=e.field_id AND NEW.new_value=e.value
    AND NEW.old_value IS NOT DISTINCT FROM e.previous_value)
 THEN RAISE EXCEPTION 'AUTOMATION_FIELD_HISTORY_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON field_value_history
 FOR EACH ROW EXECUTE FUNCTION guard_automation_field_history();

CREATE OR REPLACE FUNCTION apply_automation_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule automation_rule; source automation_source; task_id uuid; effect automation_field_effect; history_id bigint;
BEGIN
 SELECT * INTO rule FROM automation_rule WHERE id=NEW.rule_id AND version=NEW.rule_version;
 SELECT * INTO source FROM automation_source WHERE id=NEW.source_id;
 CASE rule.action_type
  WHEN 'CREATE_FOLLOW_UP' THEN
   INSERT INTO follow_up(automation_execution_id) VALUES(NEW.id) RETURNING id INTO task_id;
   INSERT INTO follow_up_history(follow_up_id,event_type,detail) VALUES(task_id,'AUTOMATION_CREATED',
    jsonb_build_object('executionId',NEW.id,'ruleId',rule.id,'ruleVersion',rule.version));
   INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(source.lead_id,'AUTOMATION_FOLLOW_UP_CREATED',
    jsonb_build_object('followUpId',task_id,'executionId',NEW.id,'ruleId',rule.id,'ruleVersion',rule.version));
  WHEN 'SEND_IN_APP_NOTIFICATION' THEN
   INSERT INTO notification_event(event_type,automation_execution_id) VALUES('AUTOMATION_NOTICE',NEW.id);
  WHEN 'SET_FIELD_VALUE' THEN
   INSERT INTO automation_field_effect(execution_id) VALUES(NEW.id) RETURNING * INTO effect;
   IF effect.previous_version=0 THEN
    INSERT INTO lead_field_value(lead_id,field_id,value,source,automation_execution_id)
     VALUES(effect.lead_id,effect.field_id,effect.value,'AUTOMATION',effect.execution_id);
   ELSE
    UPDATE lead_field_value SET value=effect.value,source='AUTOMATION',updated_by=NULL,
     version=effect.previous_version+1,updated_at=clock_timestamp(),automation_execution_id=effect.execution_id,
     source_submission_id=NULL,source_binding_id=NULL,source_mapping_version=NULL,
     source_import_dataset_id=NULL,source_import_sheet_index=NULL,ai_action_id=NULL
    WHERE lead_id=effect.lead_id AND field_id=effect.field_id;
   END IF;
   INSERT INTO field_value_history(lead_id,field_id,old_value,new_value,source,automation_execution_id)
    VALUES(effect.lead_id,effect.field_id,effect.previous_value,effect.value,'AUTOMATION',effect.execution_id)
    RETURNING id INTO history_id;
   INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(source.lead_id,'FIELD_VALUE_CHANGED',
    jsonb_build_object('source','AUTOMATION','executionId',NEW.id,'ruleId',rule.id,'ruleVersion',rule.version,'fieldId',effect.field_id,'historyId',history_id));
  ELSE
   RAISE EXCEPTION 'AUTOMATION_ACTION_UNAVAILABLE';
 END CASE;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(source.organization_id,source.branch_id,'AUTOMATION_ACTION_APPLIED','AUTOMATION_EXECUTION',NEW.id,
   jsonb_build_object('ruleId',rule.id,'ruleVersion',rule.version,'action',rule.action_type,'followUpId',task_id)
    || CASE WHEN effect.field_id IS NULL THEN '{}'::jsonb
     ELSE jsonb_build_object('fieldId',effect.field_id,'fieldHistoryId',history_id) END);
 RETURN NEW;
END $$;

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
 IF r.action_type='SET_FIELD_VALUE' THEN
  PERFORM 1 FROM field_definition f JOIN campaign_field cf ON cf.field_id=f.id AND cf.campaign_id=l.campaign_id
   WHERE f.id=r.action_field_id AND f.version=r.action_field_definition_version FOR SHARE OF f,cf;
  IF NOT FOUND OR NOT automation_action_field_available(r.action_field_id,l.organization_id,l.branch_id,l.campaign_id,u.role='MANAGER')
  THEN RETURN 'AUTOMATION_ACTION_FIELD_UNAVAILABLE'; END IF;
  IF EXISTS(SELECT 1 FROM lead_field_value v WHERE v.lead_id=l.id AND v.field_id=r.action_field_id AND v.value=r.action_field_value)
  THEN RETURN 'FIELD_ALREADY_MATCHES'; END IF;
 END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event; parent record; source_scope record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE'; END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.visibility_snapshot=pg_current_snapshot(); NEW.captured_at=clock_timestamp();
 NEW.parent_execution_id=NULL; NEW.causal_rule_ids='{}'::uuid[]; NEW.notification_event_id=NULL;
 IF NEW.inbound_message_id IS NOT NULL THEN
  SELECT organization_id,branch_id,campaign_id,lead_id INTO source_scope FROM automation_trusted_inbound(NEW.id)
   WHERE message_id=NEW.inbound_message_id;
  NEW.trigger_type='MESSAGE_RECEIVED';
 ELSIF NEW.conversation_change_id IS NOT NULL THEN
  SELECT l.organization_id,l.branch_id,l.campaign_id,l.id AS lead_id INTO source_scope
   FROM automation_conversation_change change JOIN conversation cv ON cv.id=change.conversation_id JOIN lead l ON l.id=cv.lead_id
   WHERE change.id=NEW.conversation_change_id AND change.id=NEW.id AND ai_row_inserted_here(change.xmin)
    AND cv.state=change.to_state AND ai_row_inserted_here(cv.xmin);
  NEW.trigger_type='CONVERSATION_STATE_CHANGED';
 ELSIF NEW.field_change_id IS NOT NULL THEN
  SELECT l.organization_id,l.branch_id,l.campaign_id,l.id AS lead_id INTO source_scope
   FROM automation_field_change change JOIN lead l ON l.id=change.lead_id
   WHERE change.id=NEW.field_change_id AND change.id=NEW.id AND ai_row_inserted_here(change.xmin);
  SELECT ex.id,ex.rule_id,s.causal_rule_ids INTO parent
   FROM automation_field_change change
   JOIN lead_field_value v ON v.lead_id=change.lead_id AND v.field_id=change.field_id AND v.version=change.value_version
   JOIN automation_field_effect effect ON effect.execution_id=v.automation_execution_id AND ai_row_inserted_here(effect.xmin)
   JOIN automation_execution ex ON ex.id=effect.execution_id AND ex.state='SUCCEEDED'
   JOIN automation_source s ON s.id=ex.source_id AND s.lead_id=change.lead_id
   WHERE change.id=NEW.field_change_id AND v.source='AUTOMATION';
  IF FOUND THEN
   NEW.parent_execution_id=parent.id;
   NEW.causal_rule_ids=array_append(parent.causal_rule_ids,parent.rule_id);
  ELSIF EXISTS(
   SELECT 1 FROM automation_field_change change JOIN lead_field_value v
    ON v.lead_id=change.lead_id AND v.field_id=change.field_id AND v.version=change.value_version
    WHERE change.id=NEW.field_change_id AND v.source='AUTOMATION')
  THEN RAISE EXCEPTION 'AUTOMATION_FIELD_CAUSE_REQUIRED'; END IF;
  NEW.trigger_type='FIELD_CHANGED';
 ELSE
  SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
   AND automation_supports_trigger(event_type) AND event_type NOT IN ('MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED','FIELD_CHANGED');
  IF e IS NULL THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
  NEW.notification_event_id=e.id; NEW.organization_id=e.organization_id; NEW.branch_id=e.branch_id;
  NEW.campaign_id=e.campaign_id; NEW.lead_id=e.lead_id; NEW.trigger_type=e.event_type;
  IF e.event_type='FOLLOW_UP_DUE' THEN
   SELECT x.id,x.rule_id,s.causal_rule_ids INTO parent FROM follow_up f
    JOIN automation_execution x ON x.id=f.automation_execution_id AND x.state='SUCCEEDED'
    JOIN automation_source s ON s.id=x.source_id AND s.lead_id=e.lead_id AND s.organization_id=e.organization_id
    WHERE f.id=e.follow_up_id AND f.lead_id=e.lead_id AND f.kind='AUTOMATION';
   IF FOUND THEN
    NEW.parent_execution_id=parent.id;
    NEW.causal_rule_ids=array_append(parent.causal_rule_ids,parent.rule_id);
   ELSIF EXISTS(SELECT 1 FROM follow_up WHERE id=e.follow_up_id AND kind='AUTOMATION') THEN
    RAISE EXCEPTION 'AUTOMATION_FOLLOW_UP_CAUSE_REQUIRED';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF source_scope.lead_id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.organization_id=source_scope.organization_id; NEW.branch_id=source_scope.branch_id;
 NEW.campaign_id=source_scope.campaign_id; NEW.lead_id=source_scope.lead_id;
 RETURN NEW;
END $$;
