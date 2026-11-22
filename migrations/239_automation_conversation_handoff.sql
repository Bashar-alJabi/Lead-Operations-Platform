ALTER TABLE automation_rule
 DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN (
  'CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD','REQUEST_HUMAN_ATTENTION',
  'CLOSE_LEAD','REQUEST_CONVERSATION_HANDOFF'
 ));

CREATE TABLE automation_conversation_handoff (
 execution_id uuid PRIMARY KEY REFERENCES automation_execution(id),
 conversation_id uuid NOT NULL REFERENCES conversation(id),
 previous_state text NOT NULL CHECK(previous_state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED')),
 resulting_version integer NOT NULL CHECK(resulting_version>1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(conversation_id,resulting_version)
);

ALTER FUNCTION automation_execution_reason(uuid) RENAME TO automation_before_conversation_handoff_reason;

CREATE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE reason text; source automation_source; subject lead; target conversation;
BEGIN
 reason=automation_before_conversation_handoff_reason(eid);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 SELECT s.* INTO source FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
  JOIN automation_source s ON s.id=e.source_id WHERE e.id=eid AND r.action_type='REQUEST_CONVERSATION_HANDOFF';
 IF source.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO subject FROM lead WHERE id=source.lead_id FOR UPDATE;
 IF subject.lifecycle IS DISTINCT FROM 'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
 SELECT cv.* INTO target FROM conversation cv
  WHERE cv.id=automation_condition_conversation_id(source.id,subject.id,NULL) AND cv.lead_id=subject.id FOR UPDATE;
 IF target.id IS NULL THEN RETURN 'AUTOMATION_HANDOFF_CONVERSATION_UNAVAILABLE'; END IF;
 IF target.controller_type<>'AI' OR target.state NOT IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED')
 THEN RETURN 'AUTOMATION_HANDOFF_CONTROLLER_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campaign ca WHERE (ca.id,ca.organization_id,ca.branch_id)=
   (subject.campaign_id,subject.organization_id,subject.branch_id) AND ca.ai_config->>'enabled'='true'
   AND (ai_effective_tool_policy(ca.branch_id,ca.id)->'allowedTools') ? 'requestHumanHandoff')
 THEN RETURN 'AUTOMATION_HANDOFF_TOOL_NOT_APPROVED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION guard_automation_conversation_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source automation_source; target conversation;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_HANDOFF_IMMUTABLE'; END IF;
 SELECT s.* INTO source FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
  JOIN automation_source s ON s.id=e.source_id WHERE e.id=NEW.execution_id AND e.state='SUCCEEDED'
   AND e.operation='EXECUTE' AND ai_row_inserted_here(e.xmin) AND r.action_type='REQUEST_CONVERSATION_HANDOFF';
 IF pg_trigger_depth()<2 OR source.id IS NULL OR automation_execution_reason(NEW.execution_id) IS NOT NULL
 THEN RAISE EXCEPTION 'AUTOMATION_HANDOFF_PROOF_REQUIRED'; END IF;
 SELECT cv.* INTO STRICT target FROM conversation cv
  WHERE cv.id=automation_condition_conversation_id(source.id,source.lead_id,NULL) AND cv.lead_id=source.lead_id FOR UPDATE;
 NEW.conversation_id=target.id;
 NEW.previous_state=target.state;
 NEW.resulting_version=target.version+1;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER automation_conversation_handoff_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_conversation_handoff
 FOR EACH ROW EXECUTE FUNCTION guard_automation_conversation_handoff();

CREATE FUNCTION apply_automation_conversation_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject lead;
BEGIN
 UPDATE conversation SET state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,
  needs_attention_reason=coalesce(needs_attention_reason,'AI_HUMAN_HANDOFF_REQUESTED'),version=NEW.resulting_version
  WHERE id=NEW.conversation_id AND version=NEW.resulting_version-1 AND state=NEW.previous_state AND controller_type='AI';
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_HANDOFF_CONTEXT_CHANGED'; END IF;
 SELECT l.* INTO STRICT subject FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=NEW.conversation_id;
 INSERT INTO conversation_handoff(conversation_id,from_controller,to_controller,reason)
  VALUES(NEW.conversation_id,'AI','NONE','AUTOMATION_HANDOFF_REQUESTED');
 INSERT INTO lead_activity(lead_id,event_type,detail)
  VALUES(subject.id,'AUTOMATION_HANDOFF_REQUESTED',jsonb_build_object('conversationId',NEW.conversation_id,'executionId',NEW.execution_id));
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(subject.organization_id,subject.branch_id,'AUTOMATION_HANDOFF_REQUESTED','CONVERSATION',NEW.conversation_id,
   jsonb_build_object('executionId',NEW.execution_id,'previousState',NEW.previous_state,'version',NEW.resulting_version));
 RETURN NEW;
END $$;
CREATE TRIGGER automation_conversation_handoff_apply AFTER INSERT ON automation_conversation_handoff
 FOR EACH ROW EXECUTE FUNCTION apply_automation_conversation_handoff();

CREATE OR REPLACE FUNCTION apply_automation_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule automation_rule; source automation_source; task_id uuid; effect automation_field_effect; history_id bigint; assigned_history_id bigint; review_id uuid; review_opened boolean;
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
  WHEN 'CLOSE_LEAD' THEN
   PERFORM apply_lead_lifecycle(source.lead_id,'CLOSED',NULL,NULL,NEW.id);
  WHEN 'REQUEST_CONVERSATION_HANDOFF' THEN
   INSERT INTO automation_conversation_handoff(execution_id) VALUES(NEW.id);
  WHEN 'REQUEST_HUMAN_ATTENTION' THEN
   INSERT INTO automation_human_review(execution_id) VALUES(NEW.id)
    ON CONFLICT (lead_id,branch_id,campaign_id) WHERE resolved_at IS NULL DO NOTHING
    RETURNING execution_id INTO review_id;
   review_opened=FOUND;
   IF NOT review_opened THEN
    SELECT execution_id INTO STRICT review_id FROM automation_human_review WHERE lead_id=source.lead_id
     AND organization_id=source.organization_id AND branch_id=source.branch_id AND campaign_id=source.campaign_id
     AND resolved_at IS NULL;
   END IF;
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
     ELSE jsonb_build_object('assignmentHistoryId',assigned_history_id) END
    || CASE WHEN review_id IS NULL THEN '{}'::jsonb
     ELSE jsonb_build_object('humanReviewId',review_id,'humanReviewOpened',review_opened) END);
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
  SELECT ex.id,ex.rule_id,s.causal_rule_ids INTO parent
   FROM automation_conversation_change change JOIN conversation cv ON cv.id=change.conversation_id
   JOIN automation_conversation_handoff h ON h.conversation_id=cv.id AND h.resulting_version=cv.version
    AND ai_row_inserted_here(h.xmin)
   JOIN automation_execution ex ON ex.id=h.execution_id AND ex.state='SUCCEEDED'
   JOIN automation_source s ON s.id=ex.source_id AND s.lead_id=cv.lead_id
   WHERE change.id=NEW.conversation_change_id AND change.to_state='WAITING_FOR_HUMAN';
  IF FOUND THEN
   NEW.parent_execution_id=parent.id;
   NEW.causal_rule_ids=array_append(parent.causal_rule_ids,parent.rule_id);
  END IF;
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
