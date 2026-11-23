ALTER TABLE automation_rule DROP CONSTRAINT automation_rule_action_type_check,
 ADD CONSTRAINT automation_rule_action_type_check CHECK(action_type IN (
  'CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD','REQUEST_HUMAN_ATTENTION',
  'CLOSE_LEAD','REQUEST_CONVERSATION_HANDOFF','REQUEST_CONVERSATION_SUMMARY'
 ));

ALTER TABLE ai_handoff_summary ALTER COLUMN action_id DROP NOT NULL,
 ADD COLUMN automation_execution_id uuid UNIQUE REFERENCES automation_execution(id),
 ADD CONSTRAINT ai_summary_single_source CHECK ((action_id IS NOT NULL) <> (automation_execution_id IS NOT NULL)),
 ADD CONSTRAINT ai_summary_autonomous_actor CHECK (automation_execution_id IS NULL OR (actor_id IS NULL AND session_id IS NULL));
CREATE UNIQUE INDEX ai_automation_summary_pending_conversation ON ai_handoff_summary(conversation_id)
 WHERE automation_execution_id IS NOT NULL AND state IN ('QUEUED','RUNNING');

ALTER FUNCTION automation_execution_reason(uuid) RENAME TO automation_before_summary_reason;

CREATE FUNCTION ai_automation_summary_context(eid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('kind','AUTOMATION_SUMMARY','executionId',e.id,'ruleId',r.id,'ruleVersion',r.version,
   'sourceContext',jsonb_build_object('scope',jsonb_build_object('organizationId',l.organization_id,'branchId',l.branch_id,
     'campaignId',l.campaign_id,'leadId',l.id,'conversationId',cv.id)),
   'summaryContext',summary.context,'language',COALESCE(NULLIF(cc.definition->'language','null'),NULLIF(bc.definition->'language','null')),
   'profile',jsonb_build_object('id',pr.id,'version',pr.version,'connectionId',ic.id,'connectionVersion',ic.version,'provider',ic.provider,
     'modelId',pr.model_id,'maxOutputTokens',pr.max_output_tokens,'catalogVersion',ic.capabilities->'catalogVersion',
     'grantVersion',(SELECT g.version FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=l.branch_id AND g.active)))
 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
 JOIN automation_source s ON s.id=e.source_id
 JOIN lead l ON (l.id,l.organization_id,l.branch_id,l.campaign_id)=(s.lead_id,s.organization_id,s.branch_id,s.campaign_id)
 JOIN campaign c ON (c.id,c.branch_id,c.organization_id)=(l.campaign_id,l.branch_id,l.organization_id)
 JOIN branch b ON b.id=l.branch_id AND b.organization_id=l.organization_id
 JOIN user_account approver ON approver.id=r.actor_id AND approver.organization_id=l.organization_id AND approver.active
 JOIN conversation cv ON cv.id=automation_condition_conversation_id(s.id,l.id,NULL) AND cv.lead_id=l.id
 LEFT JOIN ai_operational_config cc ON cc.scope='CAMPAIGN' AND cc.resource_id=c.id
 LEFT JOIN ai_operational_config bc ON bc.scope='BRANCH' AND bc.resource_id=b.id
 JOIN ai_model_profile pr ON pr.id=COALESCE((cc.definition->'profiles'->>'SUMMARIZATION')::uuid,(bc.definition->'profiles'->>'SUMMARIZATION')::uuid)
 JOIN integration_connection ic ON ic.id=pr.connection_id
 CROSS JOIN LATERAL (SELECT ai_copilot_summary_context(cv.id) AS context) summary
 WHERE e.id=eid AND r.action_type='REQUEST_CONVERSATION_SUMMARY' AND r.enabled AND r.organization_id=l.organization_id
   AND (r.branch_id IS NULL OR r.branch_id=b.id) AND (r.campaign_id IS NULL OR r.campaign_id=c.id)
   AND (approver.role='SUPER_ADMIN' OR approver.role='MANAGER' AND r.branch_id=b.id AND approver.branch_id=b.id)
   AND b.active AND c.status='ACTIVE' AND l.lifecycle='OPEN' AND cv.state<>'CLOSED'
   AND ai_operational_profile_usable(b.id,pr.id,'SUMMARIZATION') AND jsonb_array_length(summary.context->'references')>0
$$;

CREATE FUNCTION ai_automation_summary_locked_context(eid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE scope record; snapshot jsonb;
BEGIN
 SELECT s.lead_id,s.campaign_id,s.branch_id,r.id AS rule_id,r.actor_id INTO scope
 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
 JOIN automation_source s ON s.id=e.source_id WHERE e.id=eid AND r.action_type='REQUEST_CONVERSATION_SUMMARY';
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM branch WHERE id=scope.branch_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=scope.lead_id FOR SHARE;
 PERFORM 1 FROM campaign WHERE id=scope.campaign_id FOR SHARE;
 PERFORM 1 FROM user_account WHERE id=scope.actor_id FOR SHARE;
 PERFORM 1 FROM automation_rule WHERE id=scope.rule_id FOR SHARE;
 IF automation_before_summary_reason(eid) IS NOT NULL THEN RETURN NULL; END IF;
 snapshot=ai_automation_summary_context(eid);
 IF snapshot IS NULL THEN RETURN NULL; END IF;
 PERFORM 1 FROM conversation WHERE id=(snapshot->'sourceContext'->'scope'->>'conversationId')::uuid FOR UPDATE;
 PERFORM 1 FROM ai_model_profile p JOIN integration_connection c ON c.id=p.connection_id
  WHERE p.id=(snapshot->'profile'->>'id')::uuid FOR SHARE OF p,c;
 PERFORM 1 FROM ai_connection_branch_use WHERE connection_id=(snapshot->'profile'->>'connectionId')::uuid
  AND branch_id=scope.branch_id FOR SHARE;
 IF snapshot IS DISTINCT FROM ai_automation_summary_context(eid) THEN RETURN NULL; END IF;
 RETURN snapshot;
END $$;

CREATE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE reason text; ctx jsonb;
BEGIN
 reason=automation_before_summary_reason(eid);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 IF NOT EXISTS(SELECT 1 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
   WHERE e.id=eid AND r.action_type='REQUEST_CONVERSATION_SUMMARY') THEN RETURN NULL; END IF;
 ctx=ai_automation_summary_locked_context(eid);
 IF ctx IS NULL THEN RETURN 'AUTOMATION_SUMMARY_CONTEXT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM ai_handoff_summary WHERE conversation_id=(ctx->'sourceContext'->'scope'->>'conversationId')::uuid
  AND automation_execution_id IS NOT NULL AND state IN ('QUEUED','RUNNING')) THEN RETURN 'AUTOMATION_SUMMARY_ALREADY_PENDING'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ai_handoff_summary_current(s ai_handoff_summary) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
 IF s.automation_execution_id IS NOT NULL THEN
  RETURN s.context IS NOT DISTINCT FROM ai_automation_summary_locked_context(s.automation_execution_id);
 END IF;
 IF s.context IS DISTINCT FROM ai_handoff_summary_locked_context(s.action_id) THEN RETURN false;END IF;
 IF s.actor_id IS NOT NULL THEN
   PERFORM 1 FROM user_account u JOIN user_session us ON us.user_id=u.id WHERE u.id=s.actor_id AND us.id=s.session_id AND u.active
     AND u.organization_id=s.organization_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp()
     AND (u.role='SUPER_ADMIN' OR u.branch_id=s.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND u.id=(SELECT assigned_agent_id FROM lead WHERE id=s.lead_id))) FOR SHARE OF u,us;
   IF NOT FOUND THEN RETURN false;END IF;
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx jsonb; a record; scope jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_HISTORY_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.automation_execution_id IS NULL THEN
     ctx=ai_handoff_summary_locked_context(NEW.action_id);
     SELECT ha.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action ha WHERE ha.id=NEW.action_id;
     IF NEW.actor_id IS NULL AND (a IS NULL OR NOT ai_row_inserted_here(a.inserted_xid))
     THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED'; END IF;
   ELSE
     IF pg_trigger_depth()<2 OR NEW.request_id IS DISTINCT FROM NEW.automation_execution_id OR NOT EXISTS(
       SELECT 1 FROM automation_execution e JOIN automation_rule r ON (r.id,r.version)=(e.rule_id,e.rule_version)
       WHERE e.id=NEW.automation_execution_id AND e.state='SUCCEEDED' AND e.operation='EXECUTE'
        AND r.action_type='REQUEST_CONVERSATION_SUMMARY' AND ai_row_inserted_here(e.xmin))
     THEN RAISE EXCEPTION 'AUTOMATION_SUMMARY_APPROVED_EXECUTION_REQUIRED'; END IF;
     ctx=ai_automation_summary_locked_context(NEW.automation_execution_id);
   END IF;
   scope=ctx->'sourceContext'->'scope';
   IF ctx IS NULL OR NEW.context IS DISTINCT FROM ctx OR NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
     OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL
     OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id) IS DISTINCT FROM
       ((scope->>'organizationId')::uuid,(scope->>'branchId')::uuid,(scope->>'campaignId')::uuid,(scope->>'leadId')::uuid,(scope->>'conversationId')::uuid)
     OR NOT ai_handoff_summary_current(NEW) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED'; END IF;
   NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.references_json=ctx->'summaryContext'->'references';NEW.created_at=clock_timestamp();
 ELSE
   IF (NEW.id,NEW.action_id,NEW.automation_execution_id,NEW.request_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,
       NEW.actor_id,NEW.session_id,NEW.context,NEW.context_hash,NEW.references_json,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.action_id,OLD.automation_execution_id,OLD.request_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id,
       OLD.actor_id,OLD.session_id,OLD.context,OLD.context_hash,OLD.references_json,OLD.created_at)
     OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_IMMUTABLE_CONTEXT'; END IF;
   IF OLD.state IN ('COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TERMINAL'; END IF;
   IF NEW.state='RUNNING' THEN
     IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1
       OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds'
       OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED'; END IF;
   ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
     IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED'; END IF;
   ELSE
     IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
       OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED'; END IF;
     IF NEW.state='COMPLETED' AND (NEW.error_code IS NOT NULL OR NOT ai_handoff_summary_current(NEW) OR NOT ai_simulation_result_valid(NEW.result,NEW.references_json)) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RESULT_PROOF_REQUIRED'; END IF;
     IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RETRY_REQUIRED'; END IF;
     IF NEW.state NOT IN ('QUEUED','COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TRANSITION_INVALID'; END IF;
   END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.completed_at=CASE WHEN NEW.state IN ('COMPLETED','FAILED','BLOCKED') THEN clock_timestamp() ELSE NULL END;RETURN NEW;
END $$;

CREATE FUNCTION enqueue_automation_summary(eid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ctx jsonb; scope jsonb;
BEGIN
 ctx=ai_automation_summary_locked_context(eid);scope=ctx->'sourceContext'->'scope';
 IF ctx IS NULL OR octet_length(ctx::text)>1048576 THEN RAISE EXCEPTION 'AUTOMATION_SUMMARY_CONTEXT_UNAVAILABLE'; END IF;
 INSERT INTO ai_handoff_summary(automation_execution_id,request_id,organization_id,branch_id,campaign_id,lead_id,conversation_id,context,context_hash)
  VALUES(eid,eid,(scope->>'organizationId')::uuid,(scope->>'branchId')::uuid,(scope->>'campaignId')::uuid,
   (scope->>'leadId')::uuid,(scope->>'conversationId')::uuid,ctx,'');
END $$;

CREATE OR REPLACE FUNCTION record_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_handoff_summary_history(summary_id,version,state,attempt_count,error_code)
  VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,
   CASE WHEN NEW.automation_execution_id IS NULL THEN 'AI_HANDOFF_SUMMARY_' ELSE 'AI_AUTOMATION_SUMMARY_' END||NEW.state,
   CASE WHEN NEW.automation_execution_id IS NULL THEN 'AI_HANDOFF_SUMMARY' ELSE 'AI_AUTOMATION_SUMMARY' END,NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','handoffActionId',NEW.action_id,'automationExecutionId',NEW.automation_execution_id,
    'leadId',NEW.lead_id,'conversationId',NEW.conversation_id,'campaignId',NEW.campaign_id,'version',NEW.version,'attempt',NEW.attempt_count,
    'errorCode',NEW.error_code,'contextHash',NEW.context_hash,'knowledgeVersion',NEW.context->'sourceContext'->'knowledge'->'version',
    'profileId',NEW.context->'profile'->'id'));
 RETURN NEW;
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
