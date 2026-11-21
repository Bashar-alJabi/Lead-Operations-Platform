ALTER TABLE automation_rule
 DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN (
  'CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD','REQUEST_HUMAN_ATTENTION','CLOSE_LEAD'
 ));

CREATE FUNCTION lead_missing_closure_fields(lid uuid,cid uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 -- Callers hold the Lead and Campaign. Lock existing definitions before reading the current configuration.
 PERFORM fd.id FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
  WHERE cf.campaign_id=cid AND cf.required_stage='CLOSE' ORDER BY fd.id FOR SHARE OF fd,cf;
 RETURN EXISTS(
  SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
   LEFT JOIN lead_field_value value ON value.field_id=fd.id AND value.lead_id=lid
  WHERE cf.campaign_id=cid AND cf.required_stage='CLOSE' AND cf.active AND fd.active
   AND (value.value IS NULL OR value.value='null'::jsonb)
 );
END $$;

ALTER FUNCTION automation_execution_reason(uuid) RENAME TO automation_common_execution_reason;

CREATE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE reason text; subject lead;
BEGIN
 reason=automation_common_execution_reason(eid);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 SELECT l.* INTO subject FROM automation_execution e JOIN automation_rule r ON r.id=e.rule_id AND r.version=e.rule_version
  JOIN automation_source s ON s.id=e.source_id JOIN lead l ON l.id=s.lead_id
  WHERE e.id=eid AND r.action_type='CLOSE_LEAD' FOR UPDATE OF l;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF subject.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
 PERFORM id FROM campaign WHERE id=subject.campaign_id FOR SHARE;
 IF lead_missing_closure_fields(subject.id,subject.campaign_id) THEN RETURN 'FIELD_REQUIRED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION apply_lead_lifecycle(
 lid uuid,target text,uid uuid,sid uuid,action_run uuid
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE subject lead; change_detail jsonb;
BEGIN
 SELECT * INTO subject FROM lead WHERE id=lid FOR UPDATE;
 IF subject.id IS NULL THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
 IF target IS NULL OR target NOT IN ('OPEN','CLOSED','ARCHIVED') THEN RAISE EXCEPTION 'LEAD_LIFECYCLE_INVALID'; END IF;
 PERFORM id FROM campaign WHERE id=subject.campaign_id AND organization_id=subject.organization_id
  AND branch_id=subject.branch_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
 IF action_run IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM user_account u WHERE u.id=uid AND u.active AND u.organization_id=subject.organization_id
   AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=subject.branch_id) FOR SHARE)
  THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=sid AND s.user_id=uid AND s.revoked_at IS NULL
   AND s.expires_at>clock_timestamp() FOR SHARE)
  THEN RAISE EXCEPTION 'LEAD_LIFECYCLE_ACCESS_REVOKED'; END IF;
 ELSE
  IF pg_trigger_depth()<1 OR target<>'CLOSED' OR uid IS NOT NULL OR sid IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM automation_execution e JOIN automation_source s ON s.id=e.source_id
    JOIN automation_rule r ON r.id=e.rule_id AND r.version=e.rule_version
   WHERE e.id=action_run AND e.state='SUCCEEDED' AND e.operation='EXECUTE' AND ai_row_inserted_here(e.xmin)
    AND (s.lead_id,s.organization_id,s.branch_id,s.campaign_id)=(lid,subject.organization_id,subject.branch_id,subject.campaign_id)
    AND r.action_type='CLOSE_LEAD'
  ) OR automation_execution_reason(action_run) IS NOT NULL
  THEN RAISE EXCEPTION 'AUTOMATION_LIFECYCLE_EFFECT_REQUIRED'; END IF;
 END IF;

 IF subject.lifecycle=target THEN RETURN subject.lifecycle; END IF;
 IF target='CLOSED' AND action_run IS NULL AND lead_missing_closure_fields(lid,subject.campaign_id)
 THEN RAISE EXCEPTION 'FIELD_REQUIRED'; END IF;
 UPDATE lead SET lifecycle=target,closed_at=CASE WHEN target='OPEN' THEN NULL ELSE clock_timestamp() END,
  version=version+1,updated_at=now() WHERE id=lid;
 change_detail=jsonb_build_object('from',subject.lifecycle,'to',target,'source',
  CASE WHEN action_run IS NULL THEN 'MANUAL' ELSE 'AUTOMATION' END);
 IF action_run IS NOT NULL THEN change_detail=change_detail || jsonb_build_object('executionId',action_run); END IF;
 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(lid,uid,'LIFECYCLE_CHANGED',change_detail);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(subject.organization_id,subject.branch_id,uid,'LEAD_LIFECYCLE_CHANGED','LEAD',lid,change_detail);
 RETURN target;
END $$;

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
