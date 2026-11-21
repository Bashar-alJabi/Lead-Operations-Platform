ALTER TABLE automation_rule ADD COLUMN trigger_field_id uuid REFERENCES field_definition(id),
 ADD CONSTRAINT automation_rule_trigger_field_shape CHECK
  ((trigger_type='FIELD_CHANGED')=(trigger_field_id IS NOT NULL));

CREATE FUNCTION automation_field_trigger_available(fid uuid,oid uuid,bid uuid,cid uuid,manager boolean)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM field_definition f JOIN campaign_field cf ON cf.field_id=f.id
  JOIN campaign c ON c.id=cf.campaign_id AND c.organization_id=f.organization_id
  WHERE f.id=fid AND f.organization_id=oid AND f.active AND f.value_mode<>'CALCULATED'
   AND (bid IS NULL OR c.branch_id=bid) AND (cid IS NULL OR c.id=cid)
   AND (f.branch_id IS NULL OR f.branch_id=c.branch_id) AND (f.campaign_id IS NULL OR f.campaign_id=c.id)
   AND cf.active AND cf.usable_by_automation AND (NOT manager OR cf.visible_to_manager AND (cf.show_in_details OR cf.show_in_table))
 )
$$;

CREATE FUNCTION guard_automation_trigger_field() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.trigger_type<>'FIELD_CHANGED' THEN RETURN NEW; END IF;
 -- A previously approved field can be disabled even after access or binding is removed.
 IF TG_OP='UPDATE' AND NOT NEW.enabled AND OLD.trigger_type='FIELD_CHANGED'
  AND NEW.trigger_field_id=OLD.trigger_field_id THEN RETURN NEW; END IF;
 IF NOT automation_field_trigger_available(NEW.trigger_field_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,
  (SELECT role='MANAGER' FROM user_account WHERE id=NEW.actor_id))
 THEN RAISE EXCEPTION 'AUTOMATION_TRIGGER_FIELD_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_trigger_field_guard BEFORE INSERT OR UPDATE ON automation_rule
 FOR EACH ROW EXECUTE FUNCTION guard_automation_trigger_field();

CREATE TABLE automation_field_change (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lead_id uuid NOT NULL,
 field_id uuid NOT NULL,
 value_version integer NOT NULL CHECK(value_version>0),
 definition_version integer NOT NULL CHECK(definition_version>0),
 binding_version integer NOT NULL CHECK(binding_version>0),
 UNIQUE(lead_id,field_id,value_version)
);

CREATE FUNCTION guard_automation_field_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_field record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_FIELD_CHANGE_IMMUTABLE'; END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_FIELD_CHANGE_WRITE_REQUIRED'; END IF;
 SELECT f.version AS definition_version,cf.version AS binding_version INTO current_field
  FROM lead_field_value v JOIN lead l ON l.id=v.lead_id
  JOIN field_definition f ON f.id=v.field_id JOIN campaign_field cf ON cf.campaign_id=l.campaign_id AND cf.field_id=f.id
  WHERE v.lead_id=NEW.lead_id AND v.field_id=NEW.field_id AND v.version=NEW.value_version AND ai_row_inserted_here(v.xmin)
   AND automation_field_trigger_available(f.id,l.organization_id,l.branch_id,l.campaign_id,false);
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_FIELD_CHANGE_WRITE_REQUIRED'; END IF;
 NEW.definition_version=current_field.definition_version; NEW.binding_version=current_field.binding_version;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_field_change_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_field_change
 FOR EACH ROW EXECUTE FUNCTION guard_automation_field_change();

ALTER TABLE automation_source
 DROP CONSTRAINT automation_source_provenance_shape,
 ADD COLUMN field_change_id uuid UNIQUE REFERENCES automation_field_change(id),
 ADD CONSTRAINT automation_source_provenance_shape CHECK(
  num_nonnulls(notification_event_id,inbound_message_id,conversation_change_id,field_change_id)=1
  AND (inbound_message_id IS NOT NULL)=(trigger_type='MESSAGE_RECEIVED')
  AND (conversation_change_id IS NOT NULL)=(trigger_type='CONVERSATION_STATE_CHANGED')
  AND (field_change_id IS NOT NULL)=(trigger_type='FIELD_CHANGED')
  AND (notification_event_id IS NULL OR notification_event_id=id)
  AND (conversation_change_id IS NULL OR conversation_change_id=id)
  AND (field_change_id IS NULL OR field_change_id=id));

CREATE OR REPLACE FUNCTION automation_supports_trigger(kind text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT kind IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED',
  'FOLLOW_UP_DUE','MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED','FIELD_CHANGED')
$$;

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

CREATE FUNCTION capture_automation_field_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM lead l WHERE l.id=NEW.lead_id
  AND automation_field_trigger_available(NEW.field_id,l.organization_id,l.branch_id,l.campaign_id,false))
 THEN RETURN NEW; END IF;
 INSERT INTO automation_field_change(lead_id,field_id,value_version)
  VALUES(NEW.lead_id,NEW.field_id,NEW.version)
  ON CONFLICT(lead_id,field_id,value_version) DO NOTHING RETURNING id INTO change_id;
 IF change_id IS NOT NULL THEN
  INSERT INTO automation_source(id,field_change_id) VALUES(change_id,change_id);
  INSERT INTO automation_match_queue(source_id) VALUES(change_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_field_capture AFTER INSERT OR UPDATE OF value ON lead_field_value
 FOR EACH ROW EXECUTE FUNCTION capture_automation_field_change();

CREATE OR REPLACE FUNCTION automation_source_rules(sid uuid,after_id uuid) RETURNS TABLE(rule_id uuid,version integer) LANGUAGE sql STABLE AS $$
 SELECT r.id,v.version FROM automation_source s JOIN automation_rule r ON r.organization_id=s.organization_id
  AND (r.branch_id IS NULL OR r.branch_id=s.branch_id) AND (r.campaign_id IS NULL OR r.campaign_id=s.campaign_id)
 LEFT JOIN automation_field_change f ON f.id=s.field_change_id
 JOIN LATERAL (SELECT h.version,h.snapshot FROM automation_rule_version h WHERE h.rule_id=r.id
  AND pg_visible_in_snapshot(h.approval_xid,s.visibility_snapshot) ORDER BY h.version DESC LIMIT 1) v ON true
 WHERE s.id=sid AND (after_id IS NULL OR r.id>after_id) AND (v.snapshot->>'enabled')::boolean
  AND v.snapshot->>'trigger_type'=s.trigger_type
  AND (s.field_change_id IS NULL OR v.snapshot->>'trigger_field_id'=f.field_id::text)
 ORDER BY r.id
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
  OR r.owner_condition='UNASSIGNED' AND l.assigned_agent_id IS NOT NULL THEN RETURN 'CONDITIONS_NOT_MET'; END IF;
 IF r.action_type='CREATE_FOLLOW_UP' THEN
  IF l.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=l.assigned_agent_id AND active AND organization_id=l.organization_id
   AND branch_id=l.branch_id AND role='AGENT') THEN RETURN 'NO_ELIGIBLE_OWNER'; END IF;
 END IF;
 RETURN NULL;
END $$;
