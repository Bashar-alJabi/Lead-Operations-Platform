ALTER TABLE automation_rule
 ADD COLUMN payment_condition text NOT NULL DEFAULT 'ANY' CHECK(payment_condition IN
  ('ANY','TEST_CONFIRMED','TEST_UNCONFIRMED','LIVE_CONFIRMED','LIVE_UNCONFIRMED')),
 ADD COLUMN enrollment_condition text NOT NULL DEFAULT 'ANY' CHECK(enrollment_condition IN
  ('ANY','TEST_CONFIRMED','TEST_UNCONFIRMED','LIVE_CONFIRMED','LIVE_UNCONFIRMED'));

-- Use the request and enrollment lead indexes before looking up the current trusted record.
-- Presence of an intent, transfer request, or unverified receipt never satisfies a confirmed condition.
CREATE FUNCTION automation_payment_matches(lid uuid,oid uuid,condition text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN condition='ANY' THEN true ELSE
  (EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_record p ON p.intent_id=i.id
   WHERE i.lead_id=lid AND i.organization_id=oid AND p.state='CONFIRMED' AND p.mode=split_part(condition,'_',1))
  OR EXISTS(SELECT 1 FROM bank_transfer_request b JOIN payment_record p ON p.bank_request_id=b.id
   WHERE b.lead_id=lid AND b.organization_id=oid AND p.state='CONFIRMED' AND p.mode=split_part(condition,'_',1)))
  =(split_part(condition,'_',2)='CONFIRMED') END
$$;
CREATE FUNCTION automation_enrollment_matches(lid uuid,oid uuid,condition text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN condition='ANY' THEN true ELSE
  EXISTS(SELECT 1 FROM enrollment e JOIN lead l ON l.id=e.lead_id AND l.organization_id=oid
   JOIN payment_record p ON p.id=e.payment_id AND p.state='CONFIRMED' AND p.mode=split_part(condition,'_',1)
   WHERE e.lead_id=lid AND e.state='ENROLLED')
  =(split_part(condition,'_',2)='CONFIRMED') END
$$;

CREATE OR REPLACE FUNCTION automation_execution_reason(eid uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
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
 THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;
