-- Extend the existing inbox. Historical events are never backfilled or duplicated per recipient.
ALTER TABLE notification_event DROP CONSTRAINT notification_event_event_type_check;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_event_type_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED'));
ALTER TABLE notification_template DROP CONSTRAINT notification_template_event_type_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED'));
ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_id_fkey;
ALTER TABLE notification_event ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE notification_event ADD COLUMN intake_receipt_id uuid REFERENCES lead_intake_receipt(id);
ALTER TABLE notification_event ADD COLUMN assignment_history_id bigint REFERENCES assignment_history(id);
-- Retain the original Handoff FK and strict fresh-action trigger for existing event types.
ALTER TABLE notification_event ADD COLUMN handoff_source_id uuid GENERATED ALWAYS AS
 (CASE WHEN event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED') THEN source_id END) STORED REFERENCES ai_handoff_reception_event(action_id);
ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK(
 (event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED') AND conversation_id IS NOT NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL)
 OR (event_type='LEAD_CREATED' AND conversation_id IS NULL AND intake_receipt_id IS NOT NULL AND assignment_history_id IS NULL AND source_id=intake_receipt_id)
 OR (event_type IN ('LEAD_ASSIGNED','LEAD_REASSIGNED') AND conversation_id IS NULL AND assignment_history_id IS NOT NULL AND intake_receipt_id IS NULL
  AND source_id=md5('LEAD_ASSIGNMENT:'||assignment_history_id::text)::uuid)
);

CREATE FUNCTION guard_lead_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l lead;r lead_intake_receipt;h assignment_history;fresh boolean;BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_OPERATION_REQUIRED';END IF;
 IF NEW.event_type='LEAD_CREATED' THEN
  SELECT re.* INTO r FROM lead_intake_receipt re WHERE re.id=NEW.intake_receipt_id AND ai_row_inserted_here(re.xmin);
  IF r IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_INTAKE_REQUIRED';END IF;
  SELECT * INTO l FROM lead WHERE id=r.lead_id;
  NEW.source_id=r.id;NEW.assignment_history_id=NULL;NEW.created_at=r.created_at;
 ELSE
  SELECT ah.* INTO h FROM assignment_history ah WHERE ah.id=NEW.assignment_history_id AND ai_row_inserted_here(ah.xmin);
  IF h IS NULL OR h.old_agent_id IS NOT DISTINCT FROM h.new_agent_id THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_ASSIGNMENT_REQUIRED';END IF;
  SELECT ld.* INTO l FROM lead ld WHERE ld.id=h.lead_id AND ai_row_inserted_here(ld.xmin);
  IF l IS NULL OR h.new_branch_id IS DISTINCT FROM l.branch_id OR h.new_agent_id IS DISTINCT FROM l.assigned_agent_id
   OR NEW.event_type IS DISTINCT FROM (CASE WHEN h.old_agent_id IS NULL THEN 'LEAD_ASSIGNED' ELSE 'LEAD_REASSIGNED' END)
   THEN RAISE EXCEPTION 'NOTIFICATION_CURRENT_ASSIGNMENT_REQUIRED';END IF;
  SELECT EXISTS(SELECT 1 FROM lead_intake_birth b WHERE b.lead_id=l.id AND ai_row_inserted_here(b.xmin)) INTO fresh;
  IF fresh AND NOT EXISTS(SELECT 1 FROM lead_intake_receipt re WHERE re.lead_id=l.id AND re.routing_history_id=h.id AND ai_row_inserted_here(re.xmin))
   THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_INTAKE_REQUIRED';END IF;
  NEW.source_id=md5('LEAD_ASSIGNMENT:'||h.id::text)::uuid;NEW.intake_receipt_id=NULL;NEW.created_at=h.created_at;
 END IF;
 IF l IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_LEAD_REQUIRED';END IF;
 NEW.organization_id=l.organization_id;NEW.branch_id=l.branch_id;NEW.campaign_id=l.campaign_id;NEW.lead_id=l.id;NEW.conversation_id=NULL;
 RETURN NEW;
END $$;
DROP TRIGGER notification_event_guard ON notification_event;
CREATE TRIGGER notification_ai_event_guard BEFORE INSERT ON notification_event FOR EACH ROW
 WHEN(NEW.event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED')) EXECUTE FUNCTION guard_notification_event();
CREATE TRIGGER notification_lead_event_guard BEFORE INSERT ON notification_event FOR EACH ROW
 WHEN(NEW.event_type IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED')) EXECUTE FUNCTION guard_lead_notification_event();
CREATE TRIGGER notification_event_immutable BEFORE UPDATE OR DELETE ON notification_event FOR EACH ROW EXECUTE FUNCTION guard_notification_event();

CREATE FUNCTION record_lead_operational_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n notification_event;h assignment_history;lid uuid;BEGIN
 IF TG_TABLE_NAME='lead_intake_receipt' THEN
  lid=NEW.lead_id;
  INSERT INTO notification_event(event_type,intake_receipt_id) VALUES('LEAD_CREATED',NEW.id) RETURNING * INTO n;
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
   VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','LEAD',n.lead_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
  SELECT * INTO h FROM assignment_history WHERE id=NEW.routing_history_id;
  IF h.new_agent_id IS NULL THEN RETURN NEW;END IF;
 ELSE
  h=NEW;lid=h.lead_id;
  -- Initial routing is published only after the trusted receipt has been saved.
  IF h.old_agent_id IS NOT DISTINCT FROM h.new_agent_id OR EXISTS(SELECT 1 FROM lead_intake_birth b WHERE b.lead_id=lid AND ai_row_inserted_here(b.xmin)) THEN RETURN NEW;END IF;
 END IF;
 INSERT INTO notification_event(event_type,assignment_history_id)
  VALUES(CASE WHEN h.old_agent_id IS NULL THEN 'LEAD_ASSIGNED' ELSE 'LEAD_REASSIGNED' END,h.id) RETURNING * INTO n;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','LEAD',n.lead_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
 RETURN NEW;
END $$;
CREATE TRIGGER lead_intake_notification AFTER INSERT ON lead_intake_receipt FOR EACH ROW EXECUTE FUNCTION record_lead_operational_notification();
CREATE TRIGGER lead_assignment_notification AFTER INSERT ON assignment_history FOR EACH ROW EXECUTE FUNCTION record_lead_operational_notification();

CREATE OR REPLACE FUNCTION notification_access(eid uuid,uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM notification_event e JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
  JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id
  LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
  JOIN user_account u ON u.id=uid AND u.active AND u.organization_id=e.organization_id
  WHERE e.id=eid AND (e.conversation_id IS NULL OR cv.id IS NOT NULL)
   AND (u.role='SUPER_ADMIN' OR u.branch_id=e.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id)))
$$;
