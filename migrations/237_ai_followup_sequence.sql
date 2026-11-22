ALTER TABLE ai_followup_schedule ADD COLUMN ordinal integer NOT NULL DEFAULT 1 CHECK(ordinal BETWEEN 1 AND 40);

-- The accepted outgoing message for this schedule is its own effect, not a superseding reply.
CREATE OR REPLACE FUNCTION ai_followup_stop_reason(s ai_followup_schedule) RETURNS text LANGUAGE plpgsql STABLE AS $$
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
  AND later.sent_at IS NOT NULL AND (later.sent_at,later.id)>(s.anchored_at,s.anchor_message_id)
  AND NOT EXISTS(SELECT 1 FROM ai_followup_send_action a WHERE a.schedule_id=s.id AND a.message_id=later.id))
 THEN RETURN 'OUTBOUND_SUPERSEDED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION ai_followup_acknowledged_schedule(attempt_key bigint) RETURNS ai_followup_schedule LANGUAGE sql STABLE AS $$
 SELECT s FROM outbound_send_attempt a JOIN conversation_message m ON m.id=a.message_id
 JOIN outbound_delivery_job ob ON ob.message_id=m.id AND ob.job_id=a.job_id
 JOIN background_job j ON j.id=ob.job_id AND j.status='RUNNING' AND j.attempts=a.attempt_number
 JOIN ai_followup_send_action proof ON proof.id=m.ai_followup_action_id AND proof.message_id=m.id
 JOIN ai_followup_schedule s ON s.id=proof.schedule_id AND s.state='READY'
 WHERE a.id=attempt_key AND a.state='ACKNOWLEDGED' AND a.provider_message_id=m.provider_message_id
  AND m.sent_at IS NOT NULL AND m.delivery_state='SENT' AND ai_row_inserted_here(a.xmin) AND ai_row_inserted_here(m.xmin)
  AND ai_followup_stop_reason(s) IS NULL
$$;

ALTER FUNCTION ai_followup_anchor_context(bigint) RENAME TO ai_followup_initial_anchor_context;
CREATE FUNCTION ai_followup_anchor_context(attempt_id bigint) RETURNS TABLE(
 organization_id uuid,branch_id uuid,campaign_id uuid,lead_id uuid,conversation_id uuid,conversation_version integer,
 sender_id uuid,connection_id uuid,message_id uuid,timing_version integer,message_version integer,sent_at timestamptz,due_at timestamptz
) LANGUAGE sql STABLE AS $$
 SELECT * FROM ai_followup_initial_anchor_context(attempt_id)
 UNION ALL
 SELECT s.organization_id,s.branch_id,s.campaign_id,s.lead_id,s.conversation_id,s.conversation_version,
  s.sender_id,s.connection_id,m.id,s.timing_version,s.message_version,m.sent_at,
  m.sent_at+make_interval(secs=>(p.definition->'delaysSeconds'->>s.ordinal)::integer)
 FROM ai_followup_acknowledged_schedule(attempt_id) s JOIN ai_followup_policy p ON p.campaign_id=s.campaign_id AND p.version=s.timing_version
 JOIN outbound_send_attempt a ON a.id=attempt_id JOIN conversation_message m ON m.id=a.message_id
 WHERE s.ordinal<jsonb_array_length(p.definition->'delaysSeconds')
$$;

CREATE FUNCTION ai_followup_set_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.ordinal=COALESCE((SELECT s.ordinal+1 FROM ai_followup_acknowledged_schedule(NEW.acknowledged_attempt_id) s),1);
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_schedule_ordinal BEFORE INSERT ON ai_followup_schedule
 FOR EACH ROW EXECUTE FUNCTION ai_followup_set_ordinal();

CREATE TABLE ai_followup_final_action (
 schedule_id uuid PRIMARY KEY REFERENCES ai_followup_schedule(id),
 acknowledged_attempt_id bigint NOT NULL UNIQUE REFERENCES outbound_send_attempt(id),
 requested text NOT NULL CHECK(requested IN ('COMPLETE','HANDOFF')),
 state text NOT NULL CHECK(state IN ('PENDING','COMPLETE','HANDOFF','STOPPED')),
 reason text,
 updated_at timestamptz NOT NULL,
 CHECK((state='STOPPED')=(reason IS NOT NULL))
);
CREATE INDEX ai_followup_final_pending_idx ON ai_followup_final_action(updated_at,schedule_id) WHERE state='PENDING';

CREATE FUNCTION guard_ai_followup_final_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous ai_followup_schedule; timing ai_followup_policy; stop text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_FOLLOWUP_FINAL_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO previous FROM ai_followup_acknowledged_schedule(NEW.acknowledged_attempt_id);
  SELECT * INTO timing FROM ai_followup_policy WHERE campaign_id=previous.campaign_id AND version=previous.timing_version;
  IF pg_trigger_depth()<2 OR previous.id IS DISTINCT FROM NEW.schedule_id OR timing.campaign_id IS NULL
   OR previous.ordinal<>jsonb_array_length(timing.definition->'delaysSeconds')
  THEN RAISE EXCEPTION 'AI_FOLLOWUP_FINAL_ACK_REQUIRED'; END IF;
  NEW.requested=timing.definition->>'finalAction'; NEW.state='PENDING'; NEW.reason=NULL;
 ELSE
  IF OLD.state<>'PENDING' OR (NEW.schedule_id,NEW.acknowledged_attempt_id,NEW.requested)
   IS DISTINCT FROM (OLD.schedule_id,OLD.acknowledged_attempt_id,OLD.requested) THEN RAISE EXCEPTION 'AI_FOLLOWUP_FINAL_RETAINED'; END IF;
  SELECT * INTO previous FROM ai_followup_schedule WHERE id=OLD.schedule_id;
  PERFORM 1 FROM branch WHERE id=previous.branch_id FOR SHARE;
  PERFORM 1 FROM lead WHERE id=previous.lead_id FOR UPDATE;
  PERFORM 1 FROM conversation WHERE id=previous.conversation_id FOR UPDATE;
  stop=ai_followup_stop_reason(previous);
  IF stop IS NULL AND OLD.requested='HANDOFF' AND NOT COALESCE(
   (ai_effective_tool_policy(previous.branch_id,previous.campaign_id)->'allowedTools') ? 'requestHumanHandoff',false)
  THEN stop='HANDOFF_TOOL_NOT_APPROVED'; END IF;
  NEW.state=CASE WHEN stop IS NOT NULL THEN 'STOPPED' ELSE OLD.requested END;
  NEW.reason=stop;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_final_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_final_action
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_final_action();

CREATE FUNCTION apply_ai_followup_final_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source ai_followup_schedule;
BEGIN
 SELECT * INTO source FROM ai_followup_schedule WHERE id=NEW.schedule_id;
 IF NEW.state='HANDOFF' THEN
  UPDATE conversation SET controller_type='NONE',controller_user_id=NULL,state='WAITING_FOR_HUMAN',
   version=version+1,needs_attention_reason='AI_FOLLOWUP_EXHAUSTED' WHERE id=source.conversation_id;
  INSERT INTO conversation_handoff(conversation_id,from_controller,to_controller,reason)
   VALUES(source.conversation_id,'AI','NONE','AI_FOLLOWUP_EXHAUSTED');
  UPDATE lead SET needs_attention_reason='AI_FOLLOWUP_HANDOFF_REQUIRED',version=version+1,updated_at=clock_timestamp()
   WHERE id=source.lead_id AND needs_attention_reason IS NULL;
 END IF;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES(source.organization_id,source.branch_id,'AI_FOLLOWUP_FINAL_'||NEW.state,'LEAD',source.lead_id,
  jsonb_build_object('scheduleId',source.id,'attempt',source.ordinal,'reason',NEW.reason));
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_final_apply AFTER INSERT OR UPDATE ON ai_followup_final_action
 FOR EACH ROW EXECUTE FUNCTION apply_ai_followup_final_action();

CREATE OR REPLACE FUNCTION admit_ai_followup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous ai_followup_schedule;
BEGIN
 INSERT INTO ai_followup_schedule(acknowledged_attempt_id)
 SELECT NEW.id FROM ai_followup_anchor_context(NEW.id) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM ai_followup_acknowledged_schedule(NEW.id);
 IF previous.id IS NOT NULL AND EXISTS(SELECT 1 FROM ai_followup_policy p WHERE p.campaign_id=previous.campaign_id
  AND p.version=previous.timing_version AND jsonb_array_length(p.definition->'delaysSeconds')=previous.ordinal)
 THEN INSERT INTO ai_followup_final_action(schedule_id,acknowledged_attempt_id)
  VALUES(previous.id,NEW.id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
