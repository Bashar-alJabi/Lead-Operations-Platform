CREATE TABLE ai_followup_send_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 schedule_id uuid NOT NULL UNIQUE REFERENCES ai_followup_schedule(id),
 message_id uuid UNIQUE REFERENCES conversation_message(id) DEFERRABLE INITIALLY DEFERRED,
 content jsonb,
 blocked_reason text CHECK(blocked_reason ~ '^[A-Z][A-Z0-9_]{0,99}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((message_id IS NOT NULL AND content IS NOT NULL AND blocked_reason IS NULL)
    OR (message_id IS NULL AND content IS NULL AND blocked_reason IS NOT NULL))
);
ALTER TABLE conversation_message ADD COLUMN ai_followup_action_id uuid UNIQUE REFERENCES ai_followup_send_action(id);

CREATE FUNCTION ai_followup_send_context(schedule_key uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('scope',jsonb_build_object('organizationId',s.organization_id,'branchId',s.branch_id,
   'campaignId',s.campaign_id,'leadId',s.lead_id,'conversationId',s.conversation_id),
  'connectionId',s.connection_id,'senderId',s.sender_id,'definition',f.definition,'approval',f.approval,
  'body',ai_initial_render_template(ai_initial_safe_components(f.approval->'template'->'components'),f.definition))
 FROM ai_followup_schedule s JOIN ai_followup_message_policy f ON f.campaign_id=s.campaign_id AND f.version=s.message_version
 WHERE s.id=schedule_key AND s.state='READY' AND s.due_at<=clock_timestamp() AND ai_followup_stop_reason(s) IS NULL
$$;

CREATE FUNCTION guard_ai_followup_send_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ai_followup_schedule; context jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_FOLLOWUP_ACTION_IMMUTABLE'; END IF;
 SELECT * INTO s FROM ai_followup_schedule WHERE id=NEW.schedule_id;
 PERFORM 1 FROM branch WHERE id=s.branch_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=s.lead_id FOR UPDATE;
 PERFORM 1 FROM conversation WHERE id=s.conversation_id FOR UPDATE;
 PERFORM 1 FROM ai_followup_schedule WHERE id=s.id FOR UPDATE;
 context=ai_followup_send_context(s.id);
 IF context IS NULL THEN RAISE EXCEPTION 'AI_FOLLOWUP_CURRENT_CONTEXT_REQUIRED'; END IF;
 IF NEW.message_id IS NOT NULL THEN
  IF jsonb_typeof(NEW.content) IS DISTINCT FROM 'object' OR NEW.content->>'body' IS DISTINCT FROM context->>'body'
   OR (NEW.content->'snapshot')-'quickReplyPayloads' IS DISTINCT FROM ai_initial_template_snapshot(jsonb_build_object('initialMessage',context))
  THEN RAISE EXCEPTION 'AI_FOLLOWUP_APPROVED_CONTENT_REQUIRED'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_send_action_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_send_action
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_send_action();

CREATE FUNCTION guard_ai_followup_send_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof ai_followup_send_action; s ai_followup_schedule;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.ai_followup_action_id IS DISTINCT FROM OLD.ai_followup_action_id THEN RAISE EXCEPTION 'AI_FOLLOWUP_PROOF_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.ai_followup_action_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO proof FROM ai_followup_send_action WHERE id=NEW.ai_followup_action_id
  AND message_id=NEW.id AND ai_row_inserted_here(xmin);
 SELECT * INTO s FROM ai_followup_schedule WHERE id=proof.schedule_id;
 IF proof.id IS NULL OR ai_followup_send_context(s.id) IS NULL OR NEW.ai_initial_action_id IS NOT NULL OR NEW.ai_send_action_id IS NOT NULL
  OR (NEW.conversation_id,NEW.connection_id,NEW.sender_id) IS DISTINCT FROM (s.conversation_id,s.connection_id,s.sender_id)
  OR NEW.direction<>'OUTBOUND' OR NEW.author_type<>'AI' OR NEW.author_user_id IS NOT NULL OR NEW.message_kind<>'TEMPLATE'
  OR NEW.delivery_state<>'QUEUED' OR NEW.body IS DISTINCT FROM proof.content->>'body' OR NEW.template_snapshot IS DISTINCT FROM proof.content->'snapshot'
  OR NEW.template_id::text IS DISTINCT FROM ai_followup_send_context(s.id)->'definition'->>'templateId'
  OR NEW.idempotency_key IS DISTINCT FROM proof.id::text OR NEW.provider_message_id IS NOT NULL OR NEW.attachment_id IS NOT NULL
  OR NEW.sent_at IS NOT NULL OR NEW.received_at IS NOT NULL OR NEW.source_event_id IS NOT NULL
  OR NEW.reply_to_message_id IS NOT NULL OR NEW.reply_button_index IS NOT NULL OR NEW.source_reference IS NOT NULL OR NEW.last_error_code IS NOT NULL
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_FRESH_MESSAGE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER ai_send_message_guard ON conversation_message;
CREATE TRIGGER ai_send_message_guard BEFORE INSERT OR UPDATE ON conversation_message FOR EACH ROW
 WHEN(NEW.ai_initial_action_id IS NULL AND NEW.ai_followup_action_id IS NULL) EXECUTE FUNCTION guard_ai_send_message();
CREATE TRIGGER ai_followup_send_message_guard BEFORE INSERT OR UPDATE ON conversation_message
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_send_message();

CREATE FUNCTION guard_ai_followup_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM conversation_message WHERE id=OLD.message_id AND ai_followup_action_id IS NOT NULL)
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_OUTBOX_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM conversation_message m WHERE m.id=NEW.message_id AND m.ai_followup_action_id IS NOT NULL
  AND (TG_OP<>'INSERT' OR NOT ai_row_inserted_here(m.xmin)))
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_FRESH_OUTBOX_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbound_delivery_job
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_outbox();

CREATE FUNCTION prove_ai_followup_send_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.message_id IS NOT NULL AND (ai_followup_send_context(NEW.schedule_id) IS NULL OR NOT EXISTS(
  SELECT 1 FROM conversation_message m JOIN outbound_delivery_job ob ON ob.message_id=m.id
  JOIN background_job j ON j.id=ob.job_id WHERE m.id=NEW.message_id AND m.ai_followup_action_id=NEW.id
   AND ai_row_inserted_here(m.xmin) AND ai_row_inserted_here(j.xmin) AND j.queue='messaging' AND j.kind='SEND_MESSAGE'
   AND j.status='QUEUED' AND j.attempts=0 AND j.payload=jsonb_build_object('messageId',m.id) AND j.idempotency_key=m.id::text
 )) THEN RAISE EXCEPTION 'AI_FOLLOWUP_ATOMIC_OUTBOX_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ai_followup_send_outbox_required AFTER INSERT ON ai_followup_send_action
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_ai_followup_send_outbox();

CREATE FUNCTION guard_ai_followup_dispatch_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m conversation_message; schedule_key uuid;
BEGIN
 SELECT * INTO m FROM conversation_message WHERE id=NEW.message_id;
 IF m.ai_followup_action_id IS NULL THEN RETURN NEW; END IF;
 SELECT schedule_id INTO schedule_key FROM ai_followup_send_action WHERE id=m.ai_followup_action_id AND message_id=m.id;
 IF NEW.state<>'PREPARED' OR NEW.provider_message_id IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.finished_at IS NOT NULL
  OR m.delivery_state<>'QUEUED' OR ai_followup_send_context(schedule_key) IS NULL
 THEN RAISE EXCEPTION 'AI_SEND_CURRENT_ATTEMPT_REQUIRED'; END IF;
 PERFORM 1 FROM background_job j JOIN outbound_delivery_job ob ON ob.job_id=j.id JOIN sender_outbound_lease lease ON lease.job_id=j.id
 WHERE j.id=NEW.job_id AND ob.message_id=m.id AND j.queue='messaging' AND j.kind='SEND_MESSAGE' AND j.status='RUNNING'
  AND j.attempts=NEW.attempt_number AND j.locked_until>clock_timestamp()+interval '15 seconds'
  AND lease.sender_id=m.sender_id AND lease.locked_until>clock_timestamp()+interval '15 seconds' FOR KEY SHARE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_SEND_CURRENT_DISPATCH_LEASE_REQUIRED'; END IF;
 NEW.started_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_dispatch_attempt_guard BEFORE INSERT ON outbound_send_attempt
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_dispatch_attempt();

CREATE FUNCTION audit_ai_followup_send_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 SELECT s.organization_id,s.branch_id,CASE WHEN NEW.message_id IS NOT NULL THEN 'AI_FOLLOWUP_QUEUED' ELSE 'AI_FOLLOWUP_BLOCKED' END,
  'LEAD',s.lead_id,jsonb_build_object('scheduleId',s.id,'messageId',NEW.message_id,'reason',NEW.blocked_reason)
 FROM ai_followup_schedule s WHERE s.id=NEW.schedule_id;
 RETURN NULL;
END $$;
CREATE TRIGGER ai_followup_send_action_audit AFTER INSERT ON ai_followup_send_action
 FOR EACH ROW EXECUTE FUNCTION audit_ai_followup_send_action();
