-- A delivery admitted before explicit AI control returned remains part of the conversation,
-- but cannot create a fresh AI execution even if the inbound worker resolves it afterward.
CREATE FUNCTION ai_inbound_after_control_return(eid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(
  SELECT 1 FROM integration_event e JOIN conversation_handoff h ON h.conversation_id=e.conversation_id
  WHERE e.id=eid AND h.from_controller='HUMAN' AND h.to_controller='AI' AND h.created_at>=e.received_at
 )
$$;

CREATE OR REPLACE FUNCTION guard_ai_customer_inbound_execution() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_CUSTOMER_EXECUTION_IMMUTABLE';END IF;
  IF NOT ai_inbound_after_control_return(NEW.event_id) THEN RAISE EXCEPTION 'AI_CUSTOMER_EVENT_PRECEDES_CONTROL'; END IF;
  ctx=ai_customer_inbound_context(NEW.event_id);
  IF ctx IS NULL OR ctx->'conversation'->>'controller'<>'AI' OR NEW.context IS DISTINCT FROM ctx
    OR ctx->'scope'<>jsonb_build_object('organizationId',NEW.organization_id,'branchId',NEW.branch_id,'campaignId',NEW.campaign_id,'leadId',NEW.lead_id,'conversationId',NEW.conversation_id)
    OR ctx->'source'->>'messageId' IS DISTINCT FROM NEW.message_id::text THEN RAISE EXCEPTION 'AI_CUSTOMER_TRUSTED_SOURCE_REQUIRED';END IF;
  NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
