-- Preserve the original foreign key for notification sources while admitting independently proven inbound messages.
ALTER TABLE automation_source
 ADD COLUMN inbound_message_id uuid UNIQUE REFERENCES conversation_message(id),
 ADD COLUMN notification_event_id uuid GENERATED ALWAYS AS
   (CASE WHEN inbound_message_id IS NULL THEN id END) STORED REFERENCES notification_event(id),
 ADD CONSTRAINT automation_source_inbound_shape CHECK
   ((trigger_type='MESSAGE_RECEIVED')=(inbound_message_id IS NOT NULL)),
 DROP CONSTRAINT automation_source_id_fkey;

CREATE OR REPLACE FUNCTION automation_supports_trigger(kind text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT kind IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','FOLLOW_UP_DUE','MESSAGE_RECEIVED')
$$;

CREATE FUNCTION automation_trusted_inbound(eid uuid)
 RETURNS TABLE(message_id uuid,organization_id uuid,branch_id uuid,campaign_id uuid,lead_id uuid)
 LANGUAGE sql VOLATILE AS $$
 SELECT m.id,l.organization_id,l.branch_id,l.campaign_id,l.id
 FROM integration_event e
 JOIN messaging_inbound_authentication a ON a.event_id=e.id
 JOIN conversation_message m ON m.connection_id=e.connection_id
  AND m.provider_message_id=e.payload->'message'->>'id' AND m.source_event_id=e.id
 JOIN conversation cv ON cv.id=m.conversation_id AND cv.id=e.conversation_id
  AND cv.connection_id=e.connection_id AND cv.sender_id=e.sender_id AND cv.participant_ref=e.participant_ref
 JOIN lead l ON l.id=cv.lead_id AND l.id=e.lead_id
 JOIN branch b ON b.id=l.branch_id AND b.organization_id=l.organization_id
 JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id
 JOIN messaging_sender s ON s.id=cv.sender_id AND s.connection_id=cv.connection_id AND s.organization_id=l.organization_id
 JOIN integration_connection ic ON ic.id=cv.connection_id AND ic.organization_id=l.organization_id AND ic.kind='MESSAGING'
 WHERE e.id=eid AND e.event_kind='INBOUND_MESSAGE' AND e.state='PROCESSED'
  AND m.direction='INBOUND' AND m.author_type='CUSTOMER' AND m.sender_id=cv.sender_id
  AND ai_row_inserted_here(m.xmin)
  AND a.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex')
$$;

CREATE OR REPLACE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event; parent record; inbound record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE'; END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.visibility_snapshot=pg_current_snapshot(); NEW.captured_at=clock_timestamp();
 NEW.parent_execution_id=NULL; NEW.causal_rule_ids='{}'::uuid[];
 IF NEW.inbound_message_id IS NOT NULL THEN
  SELECT * INTO inbound FROM automation_trusted_inbound(NEW.id);
  IF NOT FOUND OR inbound.message_id IS DISTINCT FROM NEW.inbound_message_id THEN
   RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED';
  END IF;
  NEW.organization_id=inbound.organization_id; NEW.branch_id=inbound.branch_id;
  NEW.campaign_id=inbound.campaign_id; NEW.lead_id=inbound.lead_id;
  NEW.trigger_type='MESSAGE_RECEIVED';
  RETURN NEW;
 END IF;

 SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
  AND automation_supports_trigger(event_type) AND event_type<>'MESSAGE_RECEIVED';
 IF e IS NULL THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.organization_id=e.organization_id; NEW.branch_id=e.branch_id; NEW.campaign_id=e.campaign_id; NEW.lead_id=e.lead_id;
 NEW.trigger_type=e.event_type;
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

CREATE FUNCTION capture_automation_inbound() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid;
BEGIN
 INSERT INTO automation_source(id,inbound_message_id)
  SELECT NEW.id,m.message_id FROM automation_trusted_inbound(NEW.id) m
  ON CONFLICT (inbound_message_id) DO NOTHING RETURNING id INTO source_id;
 IF source_id IS NOT NULL THEN
  INSERT INTO automation_match_queue(source_id) VALUES(source_id);
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER automation_inbound_capture AFTER UPDATE OF state ON integration_event FOR EACH ROW
 WHEN (NEW.event_kind='INBOUND_MESSAGE' AND OLD.state<>'PROCESSED' AND NEW.state='PROCESSED')
 EXECUTE FUNCTION capture_automation_inbound();
