-- Financial authority remains with the existing provider-independent native Payment/Enrollment guards.
ALTER TABLE notification_event DROP CONSTRAINT notification_event_event_type_check;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_event_type_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'));
ALTER TABLE notification_template DROP CONSTRAINT notification_template_event_type_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'));
ALTER TABLE notification_event ADD COLUMN payment_id uuid REFERENCES payment_record(id);
ALTER TABLE notification_event ADD COLUMN enrollment_id uuid REFERENCES enrollment(id);
ALTER TABLE notification_event DROP CONSTRAINT notification_event_source_shape;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_source_shape CHECK(
 (payment_id IS NULL AND enrollment_id IS NULL AND (
  (event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED') AND conversation_id IS NOT NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
  OR (event_type='LEAD_CREATED' AND conversation_id IS NULL AND intake_receipt_id IS NOT NULL AND assignment_history_id IS NULL AND source_id=intake_receipt_id AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
  OR (event_type IN ('LEAD_ASSIGNED','LEAD_REASSIGNED') AND conversation_id IS NULL AND assignment_history_id IS NOT NULL AND intake_receipt_id IS NULL AND source_id=md5('LEAD_ASSIGNMENT:'||assignment_history_id::text)::uuid AND follow_up_id IS NULL AND follow_up_due_id IS NULL)
  OR (event_type='FOLLOW_UP_DUE' AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NOT NULL AND follow_up_due_id IS NOT NULL AND source_id=follow_up_due_id)))
 OR (event_type IN ('PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED') AND conversation_id IS NULL AND intake_receipt_id IS NULL AND assignment_history_id IS NULL AND follow_up_id IS NULL AND follow_up_due_id IS NULL
  AND payment_id IS NOT NULL AND (event_type='PAYMENT_CONFIRMED' AND enrollment_id IS NULL AND source_id=payment_id OR event_type='ENROLLMENT_CONFIRMED' AND enrollment_id IS NOT NULL AND source_id=enrollment_id))
);
CREATE FUNCTION guard_financial_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_record;e enrollment;r record;BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_OPERATION_REQUIRED';END IF;
 IF NEW.event_type='ENROLLMENT_CONFIRMED' THEN
  SELECT * INTO e FROM enrollment WHERE id=NEW.enrollment_id AND ai_row_inserted_here(xmin);
  IF e IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_ENROLLMENT_REQUIRED';END IF;
  NEW.payment_id=e.payment_id;NEW.source_id=e.id;
 ELSE NEW.enrollment_id=NULL;NEW.source_id=NEW.payment_id;END IF;
 SELECT * INTO p FROM payment_record WHERE id=NEW.payment_id AND state='CONFIRMED';
 IF p IS NULL OR NEW.event_type='PAYMENT_CONFIRMED' AND NOT EXISTS(SELECT 1 FROM payment_record WHERE id=p.id AND ai_row_inserted_here(xmin))
  THEN RAISE EXCEPTION 'NOTIFICATION_TRUSTED_PAYMENT_REQUIRED';END IF;
 -- Original financial scope survives requester disable/credential rotation, just like the trusted record.
 SELECT COALESCE(i.organization_id,b.organization_id) AS organization_id,COALESCE(i.branch_id,b.branch_id) AS branch_id,
  COALESCE(i.campaign_id,l.campaign_id) AS campaign_id,COALESCE(i.lead_id,b.lead_id) AS lead_id INTO r
  FROM payment_record pr LEFT JOIN payment_link_intent i ON i.id=pr.intent_id LEFT JOIN bank_transfer_request b ON b.id=pr.bank_request_id
  LEFT JOIN lead l ON l.id=COALESCE(i.lead_id,b.lead_id) WHERE pr.id=p.id;
 IF r IS NULL OR r.lead_id IS NULL OR NEW.event_type='ENROLLMENT_CONFIRMED' AND e.lead_id IS DISTINCT FROM r.lead_id
  THEN RAISE EXCEPTION 'NOTIFICATION_FINANCIAL_SCOPE_REQUIRED';END IF;
 NEW.organization_id=r.organization_id;NEW.branch_id=r.branch_id;NEW.campaign_id=r.campaign_id;NEW.lead_id=r.lead_id;NEW.created_at=clock_timestamp();
 NEW.conversation_id=NULL;NEW.intake_receipt_id=NULL;NEW.assignment_history_id=NULL;NEW.follow_up_id=NULL;NEW.follow_up_due_id=NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_financial_event_guard BEFORE INSERT ON notification_event FOR EACH ROW
 WHEN(NEW.event_type IN ('PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED')) EXECUTE FUNCTION guard_financial_notification_event();
CREATE FUNCTION record_financial_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n notification_event;BEGIN
 IF TG_TABLE_NAME='payment_record' THEN
  IF NEW.state<>'CONFIRMED' OR TG_OP='UPDATE' AND OLD.state='CONFIRMED' THEN RETURN NEW;END IF;
  INSERT INTO notification_event(event_type,payment_id) VALUES('PAYMENT_CONFIRMED',NEW.id) RETURNING * INTO n;
 ELSE
  INSERT INTO notification_event(event_type,enrollment_id) VALUES('ENROLLMENT_CONFIRMED',NEW.id) RETURNING * INTO n;
 END IF;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','LEAD',n.lead_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
 RETURN NEW;
END $$;
CREATE TRIGGER payment_confirmed_notification AFTER INSERT OR UPDATE ON payment_record FOR EACH ROW EXECUTE FUNCTION record_financial_notification();
CREATE TRIGGER enrollment_confirmed_notification AFTER INSERT ON enrollment FOR EACH ROW EXECUTE FUNCTION record_financial_notification();
