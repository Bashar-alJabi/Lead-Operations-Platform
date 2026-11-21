ALTER TABLE automation_rule
 DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK (action_type IN (
  'CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD','REQUEST_HUMAN_ATTENTION'
 ));

CREATE TABLE automation_human_review (
 execution_id uuid PRIMARY KEY REFERENCES automation_execution(id),
 lead_id uuid NOT NULL REFERENCES lead(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),
 note text NOT NULL,
 created_at timestamptz NOT NULL,
 resolved_at timestamptz,
 resolved_by uuid REFERENCES user_account(id),
 resolution_session_id uuid REFERENCES user_session(id),
 resolution_note text,
 CHECK ((resolved_at IS NULL AND resolved_by IS NULL AND resolution_session_id IS NULL AND resolution_note IS NULL)
  OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_session_id IS NOT NULL
   AND resolution_note IS NOT NULL AND length(trim(resolution_note)) BETWEEN 3 AND 500))
);
CREATE UNIQUE INDEX automation_human_review_pending ON automation_human_review(lead_id,branch_id,campaign_id)
 WHERE resolved_at IS NULL;

CREATE FUNCTION automation_review_pending(lead_arg uuid, branch_arg uuid, campaign_arg uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM automation_human_review WHERE lead_id=lead_arg AND branch_id=branch_arg
  AND campaign_id=campaign_arg AND resolved_at IS NULL)
$$;

CREATE FUNCTION guard_automation_human_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source automation_source; approved_note text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AUTOMATION_REVIEW_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT s.* INTO source FROM automation_execution e JOIN automation_source s ON s.id=e.source_id
   JOIN automation_rule r ON r.id=e.rule_id AND r.version=e.rule_version
   WHERE e.id=NEW.execution_id AND e.state='SUCCEEDED' AND e.operation='EXECUTE'
    AND ai_row_inserted_here(e.xmin) AND r.action_type='REQUEST_HUMAN_ATTENTION';
  IF pg_trigger_depth()<2 OR source.id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_REVIEW_PROOF_REQUIRED'; END IF;
  SELECT r.note INTO STRICT approved_note FROM automation_execution e JOIN automation_rule r ON r.id=e.rule_id
   AND r.version=e.rule_version WHERE e.id=NEW.execution_id;
  NEW.lead_id=source.lead_id;
  NEW.organization_id=source.organization_id;
  NEW.branch_id=source.branch_id;
  NEW.campaign_id=source.campaign_id;
  NEW.note=approved_note;
  NEW.created_at=statement_timestamp();
  NEW.resolved_at=NULL;
  NEW.resolved_by=NULL;
  NEW.resolution_session_id=NULL;
  NEW.resolution_note=NULL;
  RETURN NEW;
 END IF;

 IF OLD.resolved_at IS NOT NULL OR
  (NEW.execution_id,NEW.lead_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.note,NEW.created_at)
   IS DISTINCT FROM (OLD.execution_id,OLD.lead_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.note,OLD.created_at)
 THEN RAISE EXCEPTION 'AUTOMATION_REVIEW_IMMUTABLE'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM lead l JOIN campaign c ON (c.id,c.organization_id,c.branch_id)=(l.campaign_id,l.organization_id,l.branch_id)
   JOIN user_account u ON u.organization_id=l.organization_id
   JOIN user_session s ON s.user_id=u.id
   WHERE (l.id,l.organization_id,l.branch_id,l.campaign_id)=(OLD.lead_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id)
    AND u.id=NEW.resolved_by AND u.active AND s.id=NEW.resolution_session_id
    AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL
    AND (u.role='SUPER_ADMIN' OR u.branch_id=l.branch_id
     AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id))
   FOR SHARE OF l,c,u,s
 ) THEN RAISE EXCEPTION 'AUTOMATION_REVIEW_ACCESS_REVOKED'; END IF;
 NEW.resolution_note=trim(NEW.resolution_note);
 NEW.resolved_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER automation_human_review_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_human_review
 FOR EACH ROW EXECUTE FUNCTION guard_automation_human_review();

ALTER TABLE lead_attention_transition
 ADD COLUMN automation_review_id uuid UNIQUE REFERENCES automation_human_review(execution_id),
 DROP CONSTRAINT lead_attention_transition_reason_code_check,
 ADD CONSTRAINT lead_attention_transition_reason_code_check CHECK (reason_code IN (
  'NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','LEAD_UNASSIGNED','REVIEW_REQUIRED','AUTOMATION_REVIEW_REQUIRED'
 )),
 ADD CONSTRAINT lead_attention_review_shape CHECK (
  (reason_code IS NOT DISTINCT FROM 'AUTOMATION_REVIEW_REQUIRED')=(automation_review_id IS NOT NULL)
 );

CREATE OR REPLACE FUNCTION guard_lead_attention_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_lead lead; review automation_human_review;
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'LEAD_ATTENTION_TRANSITION_IMMUTABLE'; END IF;
 IF NEW.automation_review_id IS NOT NULL THEN
  SELECT * INTO review FROM automation_human_review WHERE execution_id=NEW.automation_review_id
   AND resolved_at IS NULL AND ai_row_inserted_here(xmin);
  IF review.execution_id IS NULL THEN RAISE EXCEPTION 'LEAD_ATTENTION_TRANSITION_REQUIRED'; END IF;
  NEW.lead_id=review.lead_id;
  NEW.organization_id=review.organization_id;
  NEW.branch_id=review.branch_id;
  NEW.campaign_id=review.campaign_id;
  NEW.reason_code='AUTOMATION_REVIEW_REQUIRED';
  NEW.created_at=review.created_at;
  RETURN NEW;
 END IF;
 SELECT * INTO current_lead FROM lead WHERE id=NEW.lead_id AND ai_row_inserted_here(xmin);
 IF current_lead.id IS NULL THEN RAISE EXCEPTION 'LEAD_ATTENTION_TRANSITION_REQUIRED'; END IF;
 NEW.organization_id=current_lead.organization_id;
 NEW.branch_id=current_lead.branch_id;
 NEW.campaign_id=current_lead.campaign_id;
 NEW.reason_code=CASE
  WHEN current_lead.needs_attention_reason IS NULL THEN NULL
  WHEN current_lead.needs_attention_reason IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','LEAD_UNASSIGNED')
   THEN current_lead.needs_attention_reason
  ELSE 'REVIEW_REQUIRED'
 END;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE FUNCTION record_automation_human_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence uuid; event_name text; actor uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  event_name='AUTOMATION_HUMAN_REVIEW_REQUESTED';
  INSERT INTO lead_attention_transition(automation_review_id) VALUES(NEW.execution_id) RETURNING id INTO occurrence;
  INSERT INTO lead_attention_queue(source_id,operation) VALUES(occurrence,'ADMIT');
 ELSE
  event_name='AUTOMATION_HUMAN_REVIEW_RESOLVED';
  actor=NEW.resolved_by;
 END IF;
 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail)
  VALUES(NEW.lead_id,actor,event_name,jsonb_build_object('executionId',NEW.execution_id));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,actor,event_name,'LEAD',NEW.lead_id,
   jsonb_build_object('executionId',NEW.execution_id,'attentionId',occurrence));
 RETURN NEW;
END $$;
CREATE TRIGGER automation_human_review_record AFTER INSERT OR UPDATE ON automation_human_review
 FOR EACH ROW EXECUTE FUNCTION record_automation_human_review();

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
