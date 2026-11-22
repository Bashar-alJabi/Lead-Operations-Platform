CREATE TABLE ai_followup_schedule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_id uuid NOT NULL REFERENCES lead(id),
 conversation_id uuid NOT NULL REFERENCES conversation(id),
 conversation_version integer NOT NULL,
 sender_id uuid NOT NULL REFERENCES messaging_sender(id),
 connection_id uuid NOT NULL REFERENCES integration_connection(id),
 anchor_message_id uuid NOT NULL UNIQUE REFERENCES conversation_message(id),
 acknowledged_attempt_id bigint NOT NULL UNIQUE REFERENCES outbound_send_attempt(id),
 timing_version integer NOT NULL,
 message_version integer NOT NULL,
 anchored_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL CHECK(due_at>anchored_at),
 state text NOT NULL CHECK(state IN ('WAITING','READY','STOPPED')),
 stop_reason text,
 changed_at timestamptz NOT NULL,
 CHECK((state='STOPPED')=(stop_reason IS NOT NULL))
);
CREATE INDEX ai_followup_schedule_due_idx ON ai_followup_schedule(due_at,id) WHERE state='WAITING';
CREATE INDEX ai_followup_schedule_active_conversation_idx ON ai_followup_schedule(conversation_id) WHERE state IN ('WAITING','READY');
CREATE INDEX ai_followup_schedule_lead_idx ON ai_followup_schedule(lead_id,anchored_at DESC,id DESC);

CREATE FUNCTION ai_followup_anchor_context(attempt_id bigint) RETURNS TABLE(
 organization_id uuid,branch_id uuid,campaign_id uuid,lead_id uuid,conversation_id uuid,conversation_version integer,
 sender_id uuid,connection_id uuid,message_id uuid,timing_version integer,message_version integer,sent_at timestamptz,due_at timestamptz
) LANGUAGE sql STABLE AS $$
 SELECT l.organization_id,l.branch_id,l.campaign_id,l.id,cv.id,cv.version,
  cv.sender_id,cv.connection_id,m.id,p.version,f.version,m.sent_at,
  m.sent_at+make_interval(secs=>(p.definition->'delaysSeconds'->>0)::integer)
 FROM outbound_send_attempt a JOIN conversation_message m ON m.id=a.message_id
 JOIN outbound_delivery_job ob ON ob.message_id=m.id AND ob.job_id=a.job_id
 JOIN background_job j ON j.id=a.job_id AND j.status='RUNNING' AND j.attempts=a.attempt_number
 JOIN conversation cv ON cv.id=m.conversation_id AND cv.connection_id=m.connection_id AND cv.sender_id=m.sender_id
 JOIN lead l ON l.id=cv.lead_id AND l.lifecycle='OPEN'
 JOIN branch br ON br.id=l.branch_id AND br.active
 JOIN campaign ca ON ca.id=l.campaign_id AND ca.status='ACTIVE'
 JOIN ai_followup_policy p ON p.campaign_id=ca.id AND p.definition->>'enabled'='true'
 JOIN ai_followup_message_policy f ON f.campaign_id=ca.id AND f.approval->>'senderId'=cv.sender_id::text
  AND f.approval->>'connectionId'=cv.connection_id::text
 WHERE a.id=attempt_id AND a.state='ACKNOWLEDGED' AND a.provider_message_id=m.provider_message_id
  AND m.sent_at IS NOT NULL AND m.delivery_state='SENT' AND m.direction='OUTBOUND' AND m.author_type='AI'
  AND (m.ai_send_action_id IS NOT NULL OR m.ai_initial_action_id IS NOT NULL)
  AND ai_row_inserted_here(a.xmin) AND ai_row_inserted_here(m.xmin)
  AND cv.controller_type='AI' AND cv.state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND cv.needs_attention_reason IS NULL
  AND ca.ai_config->>'enabled'='true' AND ca.messaging_config->>'enabled'='true'
  AND (ai_effective_tool_policy(l.branch_id,l.campaign_id)->'allowedTools') ? 'sendConversationMessage'
  AND f.approval=ai_followup_message_approval(ca.id,(f.definition->>'templateId')::uuid)
$$;

CREATE FUNCTION ai_followup_stop_reason(s ai_followup_schedule) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE cv conversation; subject lead; timing ai_followup_policy; anchor conversation_message;
BEGIN
 SELECT * INTO cv FROM conversation WHERE id=s.conversation_id;
 SELECT * INTO subject FROM lead WHERE id=s.lead_id;
 IF subject.id IS NULL OR cv.id IS NULL OR (subject.organization_id,subject.branch_id,subject.campaign_id,cv.lead_id,cv.sender_id,cv.connection_id)
  IS DISTINCT FROM (s.organization_id,s.branch_id,s.campaign_id,s.lead_id,s.sender_id,s.connection_id) THEN RETURN 'SCOPE_CHANGED'; END IF;
 IF subject.lifecycle<>'OPEN' THEN RETURN 'LEAD_NOT_OPEN'; END IF;
 IF cv.controller_type<>'AI' OR cv.version<>s.conversation_version THEN RETURN 'AI_CONTROL_CHANGED'; END IF;
 IF cv.state NOT IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') OR cv.needs_attention_reason IS NOT NULL THEN RETURN 'CONVERSATION_NOT_ELIGIBLE'; END IF;
 SELECT * INTO timing FROM ai_followup_policy WHERE campaign_id=s.campaign_id;
 IF timing.version IS DISTINCT FROM s.timing_version OR timing.definition->>'enabled' IS DISTINCT FROM 'true'
 THEN RETURN 'FOLLOWUP_TIMING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ai_followup_message_policy f WHERE f.campaign_id=s.campaign_id AND f.version=s.message_version
  AND f.approval=ai_followup_message_approval(s.campaign_id,(f.definition->>'templateId')::uuid)) THEN RETURN 'FOLLOWUP_CONTENT_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.id=s.campaign_id AND b.id=s.branch_id AND b.active
  AND c.status='ACTIVE' AND c.ai_config->>'enabled'='true' AND c.messaging_config->>'enabled'='true'
  AND (ai_effective_tool_policy(s.branch_id,s.campaign_id)->'allowedTools') ? 'sendConversationMessage') THEN RETURN 'AI_POLICY_CHANGED'; END IF;

 SELECT * INTO anchor FROM conversation_message WHERE id=s.anchor_message_id;
 IF timing.definition->>'stopOnReply'='true' AND EXISTS(SELECT 1 FROM conversation_message reply
  WHERE reply.conversation_id=s.conversation_id AND reply.direction='INBOUND' AND reply.author_type='CUSTOMER'
   AND reply.created_at>=anchor.created_at) THEN RETURN 'CUSTOMER_REPLIED'; END IF;
 IF EXISTS(SELECT 1 FROM conversation_message later WHERE later.conversation_id=s.conversation_id AND later.direction='OUTBOUND'
  AND later.sent_at IS NOT NULL AND (later.sent_at,later.id)>(s.anchored_at,s.anchor_message_id)) THEN RETURN 'OUTBOUND_SUPERSEDED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION guard_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; stop text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACK_REQUIRED'; END IF;
  SELECT * INTO origin FROM ai_followup_anchor_context(NEW.acknowledged_attempt_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACK_REQUIRED'; END IF;
  SELECT origin.organization_id,origin.branch_id,origin.campaign_id,origin.lead_id,origin.conversation_id,origin.conversation_version,
   origin.sender_id,origin.connection_id,origin.message_id,origin.timing_version,origin.message_version,origin.sent_at,origin.due_at
  INTO NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.conversation_version,
   NEW.sender_id,NEW.connection_id,NEW.anchor_message_id,NEW.timing_version,NEW.message_version,NEW.anchored_at,NEW.due_at;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','stop_reason','changed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','stop_reason','changed_at'])
   OR OLD.state NOT IN ('WAITING','READY') THEN RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_RETAINED'; END IF;
 END IF;
 stop=ai_followup_stop_reason(NEW);
 IF TG_OP='INSERT' THEN NEW.state=CASE WHEN stop IS NULL THEN 'WAITING' ELSE 'STOPPED' END;
 ELSIF stop IS NOT NULL THEN NEW.state='STOPPED';
 ELSIF OLD.state='WAITING' AND NEW.due_at<=clock_timestamp() THEN NEW.state='READY';
 ELSE RAISE EXCEPTION 'AI_FOLLOWUP_SCHEDULE_NOT_DUE'; END IF;
 NEW.stop_reason=stop;
 NEW.changed_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_schedule_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_schedule
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_schedule();

CREATE FUNCTION record_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,'AI_FOLLOWUP_'||NEW.state,'LEAD',NEW.lead_id,
  jsonb_build_object('scheduleId',NEW.id,'anchorMessageId',NEW.anchor_message_id,'dueAt',NEW.due_at,'reason',NEW.stop_reason));
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_schedule_record AFTER INSERT OR UPDATE ON ai_followup_schedule
 FOR EACH ROW EXECUTE FUNCTION record_ai_followup_schedule();

CREATE FUNCTION admit_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO ai_followup_schedule(acknowledged_attempt_id)
 SELECT NEW.id FROM ai_followup_anchor_context(NEW.id) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_acknowledgement AFTER UPDATE OF state ON outbound_send_attempt
 FOR EACH ROW WHEN(OLD.state='PREPARED' AND NEW.state='ACKNOWLEDGED') EXECUTE FUNCTION admit_ai_followup_schedule();

CREATE FUNCTION stop_ai_followup_for_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conversation_key uuid;
BEGIN
 IF TG_TABLE_NAME='conversation' THEN conversation_key=NEW.id;
 ELSE conversation_key=NEW.conversation_id;
 END IF;
 UPDATE ai_followup_schedule s SET state='STOPPED'
 WHERE s.conversation_id=conversation_key AND s.state IN ('WAITING','READY') AND ai_followup_stop_reason(s) IS NOT NULL;
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_inbound_stop AFTER INSERT ON conversation_message FOR EACH ROW
 WHEN(NEW.direction='INBOUND' AND NEW.author_type='CUSTOMER') EXECUTE FUNCTION stop_ai_followup_for_conversation();
CREATE TRIGGER ai_followup_controller_stop AFTER UPDATE OF controller_type,state,version,needs_attention_reason ON conversation
 FOR EACH ROW EXECUTE FUNCTION stop_ai_followup_for_conversation();

CREATE FUNCTION stop_ai_followup_for_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE ai_followup_schedule s SET state='STOPPED'
 WHERE s.lead_id=NEW.id AND s.state IN ('WAITING','READY') AND ai_followup_stop_reason(s) IS NOT NULL;
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_lifecycle_stop AFTER UPDATE OF lifecycle ON lead FOR EACH ROW
 WHEN(OLD.lifecycle IS DISTINCT FROM NEW.lifecycle) EXECUTE FUNCTION stop_ai_followup_for_lead();
