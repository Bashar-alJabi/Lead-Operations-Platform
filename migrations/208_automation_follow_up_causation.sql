ALTER TABLE automation_source
 ADD COLUMN parent_execution_id uuid REFERENCES automation_execution(id),
 ADD COLUMN causal_rule_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
 ADD CONSTRAINT automation_source_chain_shape CHECK(
  cardinality(causal_rule_ids)<=8 AND (parent_execution_id IS NULL)=(cardinality(causal_rule_ids)=0));

CREATE OR REPLACE FUNCTION automation_supports_trigger(kind text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT kind IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','FOLLOW_UP_DUE')
$$;

CREATE OR REPLACE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event; parent record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE'; END IF;
 SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
  AND automation_supports_trigger(event_type);
 IF e IS NULL OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.organization_id=e.organization_id; NEW.branch_id=e.branch_id; NEW.campaign_id=e.campaign_id; NEW.lead_id=e.lead_id;
 NEW.trigger_type=e.event_type; NEW.visibility_snapshot=pg_current_snapshot(); NEW.captured_at=clock_timestamp();
 NEW.parent_execution_id=NULL; NEW.causal_rule_ids='{}'::uuid[];
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
END $$;

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
 IF r.lifecycle IS NOT NULL AND r.lifecycle<>l.lifecycle OR r.owner_condition='ASSIGNED' AND l.assigned_agent_id IS NULL
  OR r.owner_condition='UNASSIGNED' AND l.assigned_agent_id IS NOT NULL THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;
