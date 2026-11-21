CREATE FUNCTION automation_supports_trigger(kind text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT kind IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED')
$$;

ALTER TABLE automation_rule DROP CONSTRAINT automation_rule_trigger_type_check;
ALTER TABLE automation_rule ADD CONSTRAINT automation_rule_trigger_type_check CHECK(automation_supports_trigger(trigger_type));

CREATE OR REPLACE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE'; END IF;
 SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
  AND automation_supports_trigger(event_type);
 IF e IS NULL OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.organization_id=e.organization_id; NEW.branch_id=e.branch_id; NEW.campaign_id=e.campaign_id; NEW.lead_id=e.lead_id;
 NEW.trigger_type=e.event_type; NEW.visibility_snapshot=pg_current_snapshot(); NEW.captured_at=clock_timestamp();
 RETURN NEW;
END $$;

-- The financial Notification Event guards derive these records from confirmed Payment and Enrollment writes.
-- Automation's existing internal effects cannot produce either financial trigger or re-enter this source capture.
DROP TRIGGER automation_source_capture ON notification_event;
CREATE TRIGGER automation_source_capture AFTER INSERT ON notification_event FOR EACH ROW
 WHEN(automation_supports_trigger(NEW.event_type)) EXECUTE FUNCTION capture_automation_source();
