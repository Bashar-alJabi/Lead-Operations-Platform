CREATE TABLE automation_conversation_change (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES conversation(id),
 from_state text NOT NULL,
 to_state text NOT NULL,
 CHECK(from_state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED')),
 CHECK(from_state<>to_state)
);

CREATE FUNCTION guard_automation_conversation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_CONVERSATION_CHANGE_IMMUTABLE'; END IF;
 IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM conversation cv
  WHERE cv.id=NEW.conversation_id AND cv.state=NEW.to_state AND ai_row_inserted_here(cv.xmin))
 THEN RAISE EXCEPTION 'AUTOMATION_CONVERSATION_TRANSITION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_conversation_change_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_conversation_change
 FOR EACH ROW EXECUTE FUNCTION guard_automation_conversation_change();

-- The stored values and foreign key from 209 are retained. Future domain sources do not require a heap rewrite.
ALTER TABLE automation_source
 ALTER COLUMN notification_event_id DROP EXPRESSION,
 DROP CONSTRAINT automation_source_inbound_shape,
 ADD COLUMN conversation_change_id uuid UNIQUE REFERENCES automation_conversation_change(id),
 ADD CONSTRAINT automation_source_provenance_shape CHECK(
  num_nonnulls(notification_event_id,inbound_message_id,conversation_change_id)=1
  AND (inbound_message_id IS NOT NULL)=(trigger_type='MESSAGE_RECEIVED')
  AND (conversation_change_id IS NOT NULL)=(trigger_type='CONVERSATION_STATE_CHANGED')
  AND (notification_event_id IS NULL OR notification_event_id=id)
  AND (conversation_change_id IS NULL OR conversation_change_id=id));

CREATE OR REPLACE FUNCTION automation_supports_trigger(kind text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT kind IN ('LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED',
  'FOLLOW_UP_DUE','MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED')
$$;

CREATE OR REPLACE FUNCTION guard_automation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e notification_event; parent record; source_scope record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AUTOMATION_SOURCE_IMMUTABLE'; END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
 NEW.visibility_snapshot=pg_current_snapshot(); NEW.captured_at=clock_timestamp();
 NEW.parent_execution_id=NULL; NEW.causal_rule_ids='{}'::uuid[]; NEW.notification_event_id=NULL;
 IF NEW.inbound_message_id IS NOT NULL THEN
  SELECT * INTO source_scope FROM automation_trusted_inbound(NEW.id);
  IF NOT FOUND OR source_scope.message_id IS DISTINCT FROM NEW.inbound_message_id THEN
   RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED';
  END IF;
  NEW.organization_id=source_scope.organization_id; NEW.branch_id=source_scope.branch_id;
  NEW.campaign_id=source_scope.campaign_id; NEW.lead_id=source_scope.lead_id;
  NEW.trigger_type='MESSAGE_RECEIVED';
  RETURN NEW;
 END IF;
 IF NEW.conversation_change_id IS NOT NULL THEN
  SELECT l.id,l.organization_id,l.branch_id,l.campaign_id INTO source_scope
   FROM automation_conversation_change change JOIN conversation cv ON cv.id=change.conversation_id
   JOIN lead l ON l.id=cv.lead_id
   WHERE change.id=NEW.conversation_change_id AND change.id=NEW.id AND ai_row_inserted_here(change.xmin)
    AND cv.state=change.to_state AND ai_row_inserted_here(cv.xmin);
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_TRUSTED_SOURCE_REQUIRED'; END IF;
  NEW.organization_id=source_scope.organization_id; NEW.branch_id=source_scope.branch_id;
  NEW.campaign_id=source_scope.campaign_id; NEW.lead_id=source_scope.id;
  NEW.trigger_type='CONVERSATION_STATE_CHANGED';
  RETURN NEW;
 END IF;

 SELECT * INTO e FROM notification_event WHERE id=NEW.id AND ai_row_inserted_here(xmin)
  AND automation_supports_trigger(event_type) AND event_type NOT IN ('MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED');
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
END $$;

CREATE FUNCTION capture_automation_conversation_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_id uuid;
BEGIN
 INSERT INTO automation_conversation_change(conversation_id,from_state,to_state)
  VALUES(NEW.id,OLD.state,NEW.state) RETURNING id INTO change_id;
 INSERT INTO automation_source(id,conversation_change_id) VALUES(change_id,change_id);
 INSERT INTO automation_match_queue(source_id) VALUES(change_id);
 RETURN NEW;
END $$;
CREATE TRIGGER automation_conversation_change_capture AFTER UPDATE OF state ON conversation
 FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION capture_automation_conversation_change();
