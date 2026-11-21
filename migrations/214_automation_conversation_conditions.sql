ALTER TABLE automation_rule
 ADD COLUMN conversation_state_condition text CHECK(conversation_state_condition IN
  ('AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED')),
 ADD COLUMN controller_condition text CHECK(controller_condition IN ('AI','HUMAN','NONE'));

CREATE FUNCTION automation_condition_conversation_id(sid uuid, lid uuid, wanted_state text)
 RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE subject uuid; candidates uuid[];
BEGIN
 SELECT COALESCE(c.conversation_id,m.conversation_id) INTO subject
  FROM automation_source s
  LEFT JOIN automation_conversation_change c ON c.id=s.conversation_change_id
  LEFT JOIN conversation_message m ON m.id=s.inbound_message_id
  WHERE s.id=sid AND s.lead_id=lid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF subject IS NOT NULL THEN RETURN subject; END IF;

 SELECT array_agg(id) INTO candidates FROM (
  SELECT id FROM conversation WHERE lead_id=lid AND state<>'CLOSED' LIMIT 2
 ) current_conversations;
 IF cardinality(candidates)=1 THEN RETURN candidates[1]; END IF;
 IF candidates IS NOT NULL OR wanted_state IS DISTINCT FROM 'CLOSED' THEN RETURN NULL; END IF;
 SELECT array_agg(id) INTO candidates FROM (
  SELECT id FROM conversation WHERE lead_id=lid AND state='CLOSED' LIMIT 2
 ) closed_conversations;
 IF cardinality(candidates)=1 THEN RETURN candidates[1]; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION automation_conversation_matches(sid uuid, lid uuid, wanted_state text, wanted_controller text)
 RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE subject uuid; current_state text; current_controller text;
BEGIN
 IF wanted_state IS NULL AND wanted_controller IS NULL THEN RETURN true; END IF;
 subject=automation_condition_conversation_id(sid,lid,wanted_state);
 IF subject IS NULL THEN RETURN false; END IF;
 SELECT state,controller_type INTO current_state,current_controller FROM conversation
  WHERE id=subject AND lead_id=lid FOR SHARE;
 IF NOT FOUND OR subject IS DISTINCT FROM automation_condition_conversation_id(sid,lid,wanted_state) THEN RETURN false; END IF;
 RETURN (wanted_state IS NULL OR wanted_state=current_state)
  AND (wanted_controller IS NULL OR wanted_controller=current_controller);
END $$;

CREATE OR REPLACE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE e automation_execution;s automation_source;r automation_rule;l lead;b branch;c campaign;u user_account;
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
 IF r.lifecycle IS NOT NULL AND r.lifecycle<>l.lifecycle OR r.owner_condition='ASSIGNED' AND l.assigned_agent_id IS NULL
  OR r.owner_condition='UNASSIGNED' AND l.assigned_agent_id IS NOT NULL
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
