ALTER TABLE automation_rule
 DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN
  ('CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD')),
 ADD COLUMN action_agent_id uuid REFERENCES user_account(id),
 ADD CONSTRAINT automation_assignment_action_shape CHECK((action_type='ASSIGN_LEAD')=(action_agent_id IS NOT NULL));

ALTER TABLE assignment_history
 ADD COLUMN automation_execution_id uuid REFERENCES automation_execution(id),
 ADD CONSTRAINT assignment_history_automation_shape CHECK((method='AUTOMATION')=(automation_execution_id IS NOT NULL));
CREATE UNIQUE INDEX assignment_history_automation_once ON assignment_history(automation_execution_id)
 WHERE automation_execution_id IS NOT NULL;

CREATE FUNCTION guard_automation_assignment_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action_type<>'ASSIGN_LEAD' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NOT NEW.enabled AND OLD.action_agent_id=NEW.action_agent_id THEN RETURN NEW; END IF;
 PERFORM 1 FROM user_account u WHERE u.id=NEW.action_agent_id AND u.active AND u.role='AGENT'
  AND u.organization_id=NEW.organization_id AND (NEW.branch_id IS NULL OR u.branch_id=NEW.branch_id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_assignment_guard BEFORE INSERT OR UPDATE ON automation_rule
 FOR EACH ROW EXECUTE FUNCTION guard_automation_assignment_rule();

CREATE FUNCTION automation_assignment_eligible(subject lead, target uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE capacity integer; hours jsonb; timezone text;
BEGIN
 SELECT COALESCE(ca.capacity_override,u.capacity),u.working_hours,b.timezone INTO capacity,hours,timezone
 FROM campaign_agent ca JOIN user_account u ON u.id=ca.agent_id JOIN branch b ON b.id=u.branch_id
 WHERE ca.campaign_id=subject.campaign_id AND ca.active AND u.id=target AND u.active AND u.role='AGENT'
  AND u.organization_id=subject.organization_id AND u.branch_id=subject.branch_id
 FOR SHARE OF u,ca;
 RETURN FOUND AND operational_hours_open(hours,timezone,clock_timestamp())
  AND (capacity IS NULL OR capacity>(SELECT count(*) FROM lead WHERE assigned_agent_id=target AND lifecycle='OPEN'));
END $$;

CREATE FUNCTION guard_automation_assignment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.automation_execution_id IS NOT NULL
 THEN RAISE EXCEPTION 'AUTOMATION_ASSIGNMENT_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.automation_execution_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 OR NEW.actor_user_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM automation_execution x JOIN automation_source s ON s.id=x.source_id
   JOIN automation_rule r ON r.id=x.rule_id AND r.version=x.rule_version
   JOIN lead l ON l.id=s.lead_id AND l.organization_id=s.organization_id AND l.branch_id=s.branch_id AND l.campaign_id=s.campaign_id
  WHERE x.id=NEW.automation_execution_id AND x.state='SUCCEEDED' AND x.operation='EXECUTE'
   AND ai_row_inserted_here(x.xmin) AND ai_row_inserted_here(l.xmin)
   AND r.action_type='ASSIGN_LEAD' AND r.action_agent_id=l.assigned_agent_id
   AND NEW.lead_id=l.id AND NEW.new_agent_id=l.assigned_agent_id
   AND NEW.new_branch_id=l.branch_id AND NEW.old_branch_id=l.branch_id
   AND NEW.old_agent_id IS DISTINCT FROM NEW.new_agent_id
 ) THEN RAISE EXCEPTION 'AUTOMATION_ASSIGNMENT_EFFECT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assignment_history_automation_guard BEFORE INSERT OR UPDATE OR DELETE ON assignment_history
 FOR EACH ROW EXECUTE FUNCTION guard_automation_assignment_history();

CREATE FUNCTION apply_scoped_lead_assignment(
 lid uuid, expected_version integer, target uuid, uid uuid, sid uuid, assignment_reason text, action_run uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE current_lead lead; next_version integer;
BEGIN
 SELECT * INTO current_lead FROM lead WHERE id=lid FOR UPDATE;
 IF current_lead.id IS NULL THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
 IF action_run IS NULL THEN
 IF NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=uid AND u.organization_id=current_lead.organization_id AND u.active
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=current_lead.branch_id)
    AND s.id=sid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   FOR SHARE OF u,s
 ) THEN RAISE EXCEPTION 'LEAD_ASSIGNMENT_ACCESS_REVOKED'; END IF;
 ELSE
  IF uid IS NOT NULL OR sid IS NOT NULL OR pg_trigger_depth()<1 OR NOT EXISTS(
   SELECT 1 FROM automation_execution x JOIN automation_source s ON s.id=x.source_id
    JOIN automation_rule r ON r.id=x.rule_id AND r.version=x.rule_version
   WHERE x.id=action_run AND x.state='SUCCEEDED' AND x.operation='EXECUTE' AND ai_row_inserted_here(x.xmin)
    AND (s.lead_id,s.organization_id,s.branch_id,s.campaign_id)=
      (current_lead.id,current_lead.organization_id,current_lead.branch_id,current_lead.campaign_id)
    AND r.action_type='ASSIGN_LEAD' AND r.action_agent_id=target
  ) OR automation_execution_reason(action_run) IS NOT NULL
  THEN RAISE EXCEPTION 'AUTOMATION_ASSIGNMENT_EFFECT_REQUIRED'; END IF;
 END IF;
 IF current_lead.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'LEAD_VERSION_CONFLICT'; END IF;
 IF length(assignment_reason)>500 THEN RAISE EXCEPTION 'LEAD_ASSIGNMENT_REASON_INVALID'; END IF;
 IF target IS NOT DISTINCT FROM current_lead.assigned_agent_id THEN RETURN current_lead.version; END IF;
 IF target IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM user_account u WHERE u.id=target AND u.organization_id=current_lead.organization_id
   AND u.branch_id=current_lead.branch_id AND u.role='AGENT' AND u.active FOR SHARE
 ) THEN RAISE EXCEPTION 'AGENT_NOT_ELIGIBLE'; END IF;

 UPDATE lead SET assigned_agent_id=target,version=version+1,
  needs_attention_reason=CASE WHEN target IS NULL THEN 'UNASSIGNED_BY_MANAGER'
   WHEN needs_attention_reason IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','PERFORMANCE_POLICY_REQUIRED',
    'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK') THEN NULL ELSE needs_attention_reason END,
  updated_at=now() WHERE id=lid RETURNING version INTO next_version;
 INSERT INTO assignment_history(lead_id,old_branch_id,old_agent_id,new_branch_id,new_agent_id,actor_user_id,method,reason,automation_execution_id)
  VALUES(lid,current_lead.branch_id,current_lead.assigned_agent_id,current_lead.branch_id,target,uid,CASE WHEN action_run IS NULL THEN 'MANUAL' ELSE 'AUTOMATION' END,assignment_reason,action_run);

 WITH moved AS (
  UPDATE follow_up SET owner_user_id=target,version=version+1,updated_at=now()
   WHERE lead_id=lid AND status='OPEN' AND owner_user_id=current_lead.assigned_agent_id RETURNING id
 )
 INSERT INTO follow_up_history(follow_up_id,actor_user_id,event_type,detail)
  SELECT id,uid,'OWNER_CHANGED_BY_REASSIGNMENT',jsonb_build_object('from',current_lead.assigned_agent_id,'to',target)
  FROM moved;

 WITH moved AS (
  UPDATE conversation SET controller_user_id=target,
   controller_type=CASE WHEN target IS NULL THEN 'NONE' ELSE 'HUMAN' END,
   state=CASE WHEN target IS NULL THEN 'WAITING_FOR_HUMAN' ELSE 'HUMAN_ACTIVE' END,
   version=version+1,needs_attention_reason=CASE WHEN target IS NULL THEN 'LEAD_UNASSIGNED' END
   WHERE lead_id=lid AND controller_type='HUMAN' AND controller_user_id=current_lead.assigned_agent_id
    AND state='HUMAN_ACTIVE' RETURNING id
 )
 INSERT INTO conversation_handoff(conversation_id,from_controller,from_user_id,to_controller,to_user_id,reason,requested_by)
  SELECT id,'HUMAN',current_lead.assigned_agent_id,CASE WHEN target IS NULL THEN 'NONE' ELSE 'HUMAN' END,
   target,'LEAD_REASSIGNED',uid FROM moved;

 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(lid,uid,'LEAD_REASSIGNED',
  jsonb_build_object('from',current_lead.assigned_agent_id,'to',target,'reason',assignment_reason));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(current_lead.organization_id,current_lead.branch_id,uid,'LEAD_REASSIGNED','LEAD',lid,
   jsonb_build_object('from',current_lead.assigned_agent_id,'to',target));
 RETURN next_version;
END $$;

CREATE OR REPLACE FUNCTION apply_human_lead_assignment(
 lid uuid, expected_version integer, target uuid, uid uuid, sid uuid, assignment_reason text
) RETURNS integer LANGUAGE sql AS $$
 SELECT apply_scoped_lead_assignment(lid,expected_version,target,uid,sid,assignment_reason,NULL)
$$;

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
 IF r.action_type='ASSIGN_LEAD' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF l.assigned_agent_id=r.action_agent_id THEN RETURN 'ASSIGNMENT_ALREADY_MATCHES'; END IF;
  IF NOT automation_assignment_eligible(l,r.action_agent_id) THEN RETURN 'AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE'; END IF;
 END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION apply_automation_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule automation_rule; source automation_source; task_id uuid; effect automation_field_effect; history_id bigint; assigned_history_id bigint;
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
  WHEN 'ASSIGN_LEAD' THEN
   PERFORM apply_scoped_lead_assignment(source.lead_id,
    (SELECT version FROM lead WHERE id=source.lead_id),rule.action_agent_id,NULL,NULL,'Automation',NEW.id);
   SELECT id INTO assigned_history_id FROM assignment_history WHERE automation_execution_id=NEW.id;
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
     ELSE jsonb_build_object('fieldId',effect.field_id,'fieldHistoryId',history_id) END
    || CASE WHEN assigned_history_id IS NULL THEN '{}'::jsonb
     ELSE jsonb_build_object('assignmentHistoryId',assigned_history_id) END);
 RETURN NEW;
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
  ELSIF e.event_type IN ('LEAD_ASSIGNED','LEAD_REASSIGNED') THEN
   SELECT ex.id,ex.rule_id,s.causal_rule_ids INTO parent
    FROM assignment_history h JOIN automation_execution ex ON ex.id=h.automation_execution_id AND ex.state='SUCCEEDED'
    JOIN automation_source s ON s.id=ex.source_id AND s.lead_id=e.lead_id AND s.organization_id=e.organization_id
     AND s.branch_id=e.branch_id AND s.campaign_id=e.campaign_id
    WHERE h.id=e.assignment_history_id AND h.lead_id=e.lead_id AND ai_row_inserted_here(h.xmin);
   IF FOUND THEN
    NEW.parent_execution_id=parent.id;
    NEW.causal_rule_ids=array_append(parent.causal_rule_ids,parent.rule_id);
   ELSIF EXISTS(SELECT 1 FROM assignment_history h WHERE h.id=e.assignment_history_id AND h.method='AUTOMATION') THEN
    RAISE EXCEPTION 'AUTOMATION_ASSIGNMENT_CAUSE_REQUIRED';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF source_scope.lead_id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.organization_id=source_scope.organization_id; NEW.branch_id=source_scope.branch_id;
 NEW.campaign_id=source_scope.campaign_id; NEW.lead_id=source_scope.lead_id;
 RETURN NEW;
END $$;
