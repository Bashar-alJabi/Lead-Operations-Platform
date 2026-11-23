ALTER TABLE automation_rule DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN (
  'CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD','REQUEST_HUMAN_ATTENTION',
  'CLOSE_LEAD','REQUEST_CONVERSATION_HANDOFF','REQUEST_CONVERSATION_SUMMARY','START_AI_FOLLOWUP'
  ));

ALTER TABLE ai_followup_schedule ADD COLUMN automation_execution_id uuid REFERENCES automation_execution(id);
CREATE UNIQUE INDEX ai_followup_initial_automation_execution_idx ON ai_followup_schedule(automation_execution_id)
 WHERE automation_execution_id IS NOT NULL AND ordinal=1;

ALTER FUNCTION automation_execution_reason(uuid) RENAME TO automation_before_ai_followup_reason;
ALTER FUNCTION ai_followup_stop_reason(ai_followup_schedule) RENAME TO ai_followup_before_automation_stop_reason;

CREATE FUNCTION ai_followup_stop_reason(schedule ai_followup_schedule) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE reason text;
BEGIN
 reason=ai_followup_before_automation_stop_reason(schedule);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 IF schedule.automation_execution_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
  JOIN automation_source source ON source.id=e.source_id
  JOIN user_account approver ON approver.id=r.actor_id AND approver.organization_id=r.organization_id
  WHERE e.id=schedule.automation_execution_id AND e.state='SUCCEEDED' AND e.operation='EXECUTE'
   AND r.action_type='START_AI_FOLLOWUP' AND r.enabled AND approver.active
   AND (source.organization_id,source.branch_id,source.campaign_id,source.lead_id)=
    (schedule.organization_id,schedule.branch_id,schedule.campaign_id,schedule.lead_id)
   AND r.organization_id=schedule.organization_id AND (r.branch_id IS NULL OR r.branch_id=schedule.branch_id)
   AND (r.campaign_id IS NULL OR r.campaign_id=schedule.campaign_id)
   AND (approver.role='SUPER_ADMIN' OR approver.role='MANAGER' AND approver.branch_id=schedule.branch_id)
 ) THEN RETURN 'AUTOMATION_FOLLOWUP_APPROVAL_CHANGED'; END IF;
 RETURN NULL;
END $$;

-- Admission is based on the latest actual outbound message and a completed transport job.
-- Reusing an initial or reply acknowledgement requires the same AI control version.
CREATE FUNCTION automation_ai_followup_candidate(eid uuid) RETURNS ai_followup_schedule LANGUAGE plpgsql AS $$
DECLARE source automation_source; target conversation; candidate ai_followup_schedule;
BEGIN
 SELECT s.* INTO source FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
  JOIN automation_source s ON s.id=e.source_id WHERE e.id=eid AND r.action_type='START_AI_FOLLOWUP';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT cv.* INTO target FROM conversation cv
  WHERE cv.id=automation_condition_conversation_id(source.id,source.lead_id,NULL) AND cv.lead_id=source.lead_id FOR UPDATE;
 IF NOT FOUND OR target.controller_type<>'AI' THEN RETURN NULL; END IF;
 SELECT l.organization_id,l.branch_id,l.campaign_id,l.id,target.id,target.version,target.sender_id,target.connection_id,
  m.id,a.id,timing.version,content.version,m.sent_at,
  m.sent_at+make_interval(secs=>(timing.definition->'delaysSeconds'->>0)::integer)
 INTO candidate.organization_id,candidate.branch_id,candidate.campaign_id,candidate.lead_id,candidate.conversation_id,
  candidate.conversation_version,candidate.sender_id,candidate.connection_id,candidate.anchor_message_id,
  candidate.acknowledged_attempt_id,candidate.timing_version,candidate.message_version,candidate.anchored_at,candidate.due_at
 FROM lead l
 JOIN messaging_consent consent ON consent.contact_id=l.contact_id AND consent.channel='WHATSAPP'
  AND consent.status='GRANTED' AND NOT consent.do_not_contact
 JOIN ai_followup_policy timing ON timing.campaign_id=l.campaign_id AND timing.definition->>'enabled'='true'
 JOIN ai_followup_message_policy content ON content.campaign_id=l.campaign_id AND content.approval->>'senderId'=target.sender_id::text
  AND content.approval->>'connectionId'=target.connection_id::text
 CROSS JOIN LATERAL(
  SELECT * FROM conversation_message WHERE conversation_id=target.id AND direction='OUTBOUND' ORDER BY created_at DESC,id DESC LIMIT 1
 ) m
 JOIN outbound_delivery_job ob ON ob.message_id=m.id
 JOIN background_job j ON j.id=ob.job_id AND j.status='SUCCEEDED' AND j.queue='messaging' AND j.kind='SEND_MESSAGE'
 JOIN outbound_send_attempt a ON a.job_id=j.id AND a.message_id=m.id AND a.attempt_number=j.attempts
  AND a.state='ACKNOWLEDGED' AND a.finished_at IS NOT NULL AND a.provider_message_id=m.provider_message_id
 LEFT JOIN ai_initial_send_action initial ON initial.id=m.ai_initial_action_id AND initial.message_id=m.id AND initial.state='APPLIED'
 LEFT JOIN ai_customer_send_action response ON response.id=m.ai_send_action_id AND response.message_id=m.id AND response.state='APPLIED'
 WHERE (l.id,l.organization_id,l.branch_id,l.campaign_id)=(source.lead_id,source.organization_id,source.branch_id,source.campaign_id)
  AND (m.connection_id,m.sender_id)=(target.connection_id,target.sender_id) AND m.author_type='AI' AND m.sent_at IS NOT NULL
  AND m.delivery_state IN ('SENT','DELIVERED','READ')
  AND (initial.admission_id=target.ai_initial_admission_id AND target.version=1
    OR response.lead_id=l.id AND response.campaign_id=l.campaign_id AND response.conversation_id=target.id
    AND response.context->'conversation'->>'version'=target.version::text);
 IF candidate.anchor_message_id IS NULL OR ai_followup_before_automation_stop_reason(candidate) IS NOT NULL THEN RETURN NULL; END IF;
 RETURN candidate;
END $$;

CREATE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE reason text; candidate ai_followup_schedule;
BEGIN
 reason=automation_before_ai_followup_reason(eid);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 IF NOT EXISTS(SELECT 1 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
  WHERE e.id=eid AND r.action_type='START_AI_FOLLOWUP') THEN RETURN NULL; END IF;
 candidate=automation_ai_followup_candidate(eid);
 IF candidate.anchor_message_id IS NULL THEN RETURN 'AUTOMATION_FOLLOWUP_CONTEXT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM ai_followup_schedule WHERE anchor_message_id=candidate.anchor_message_id)
 THEN RETURN 'AUTOMATION_FOLLOWUP_ALREADY_SCHEDULED'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; candidate ai_followup_schedule; stop text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACK_REQUIRED'; END IF;
  IF NEW.automation_execution_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
    WHERE e.id=NEW.automation_execution_id AND e.state='SUCCEEDED' AND e.operation='EXECUTE'
     AND r.action_type='START_AI_FOLLOWUP' AND ai_row_inserted_here(e.xmin))
    OR automation_execution_reason(NEW.automation_execution_id) IS NOT NULL
   THEN RAISE EXCEPTION 'AUTOMATION_FOLLOWUP_EXECUTION_REQUIRED'; END IF;
   candidate=automation_ai_followup_candidate(NEW.automation_execution_id);
   IF candidate.acknowledged_attempt_id IS DISTINCT FROM NEW.acknowledged_attempt_id THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACK_REQUIRED'; END IF;
   SELECT candidate.organization_id,candidate.branch_id,candidate.campaign_id,candidate.lead_id,candidate.conversation_id,
    candidate.conversation_version,candidate.sender_id,candidate.connection_id,candidate.anchor_message_id AS message_id,
    candidate.timing_version,candidate.message_version,candidate.anchored_at AS sent_at,candidate.due_at INTO origin;
  ELSE
   SELECT * INTO origin FROM ai_followup_anchor_context(NEW.acknowledged_attempt_id);
   IF NOT FOUND THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACK_REQUIRED'; END IF;
   SELECT s.automation_execution_id INTO NEW.automation_execution_id FROM ai_followup_acknowledged_schedule(NEW.acknowledged_attempt_id) s;
  END IF;
  SELECT origin.organization_id,origin.branch_id,origin.campaign_id,origin.lead_id,origin.conversation_id,origin.conversation_version,
   origin.sender_id,origin.connection_id,origin.message_id,origin.timing_version,origin.message_version,origin.sent_at,origin.due_at
  INTO NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.conversation_version,
   NEW.sender_id,NEW.connection_id,NEW.anchor_message_id,NEW.timing_version,NEW.message_version,NEW.anchored_at,NEW.due_at;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','stop_reason','changed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','stop_reason','changed_at'])
   OR OLD.state NOT IN ('WAITING','READY') THEN RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_RETAINED'; END IF;
 END IF;
 stop=ai_followup_stop_reason(NEW);
 IF TG_OP='INSERT' THEN NEW.state=CASE WHEN stop IS NULL THEN 'WAITING' ELSE 'STOPPED' END;
 ELSIF stop IS NOT NULL THEN NEW.state='STOPPED';
 ELSIF OLD.state='WAITING' AND NEW.due_at<=clock_timestamp() THEN NEW.state='READY';
 ELSE RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_NOT_DUE'; END IF;
 NEW.stop_reason=stop;
 NEW.changed_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION record_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,'AI_FOLLOWUP_'||NEW.state,'LEAD',NEW.lead_id,
  jsonb_build_object('scheduleId',NEW.id,'anchorMessageId',NEW.anchor_message_id,'dueAt',NEW.due_at,'reason',NEW.stop_reason)
   || CASE WHEN NEW.automation_execution_id IS NULL THEN '{}'::jsonb
     ELSE jsonb_build_object('automationExecutionId',NEW.automation_execution_id) END);
 RETURN NULL;
END $$;

CREATE FUNCTION enqueue_automation_ai_followup(eid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE candidate ai_followup_schedule;
BEGIN
 candidate=automation_ai_followup_candidate(eid);
 INSERT INTO ai_followup_schedule(acknowledged_attempt_id,automation_execution_id)
 VALUES(candidate.acknowledged_attempt_id,eid);
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
  WHEN 'REQUEST_CONVERSATION_SUMMARY' THEN
   PERFORM enqueue_automation_summary(NEW.id);
  WHEN 'START_AI_FOLLOWUP' THEN
   PERFORM enqueue_automation_ai_followup(NEW.id);
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
