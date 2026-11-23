CREATE TABLE messaging_returning_lead_reopen (
 event_id uuid PRIMARY KEY REFERENCES integration_event(id),
 conversation_id uuid NOT NULL REFERENCES conversation(id),
 lead_id uuid NOT NULL REFERENCES lead(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_version integer NOT NULL,
 conversation_version integer NOT NULL,
 policy_version integer NOT NULL,
 lead_closed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION verified_returning_lead(eid uuid,cvid uuid)
RETURNS TABLE(lead_id uuid,organization_id uuid,branch_id uuid,campaign_id uuid,lead_version integer,
  conversation_version integer,policy_version integer,lead_closed_at timestamptz)
LANGUAGE sql VOLATILE AS $$
 SELECT l.id,l.organization_id,l.branch_id,l.campaign_id,l.version,cv.version,p.version,l.closed_at
 FROM integration_event e JOIN messaging_inbound_authentication a ON a.event_id=e.id
 JOIN conversation cv ON cv.id=cvid AND (cv.connection_id,cv.sender_id,cv.participant_ref)=(e.connection_id,e.sender_id,e.participant_ref)
 JOIN lead l ON l.id=cv.lead_id
 JOIN contact ct ON ct.id=l.contact_id AND ct.organization_id=l.organization_id AND ct.phone_normalized=e.participant_ref
 JOIN branch b ON b.id=l.branch_id AND b.organization_id=l.organization_id AND b.active
 JOIN campaign ca ON (ca.id,ca.branch_id,ca.organization_id)=(l.campaign_id,l.branch_id,l.organization_id)
 JOIN ai_behavior_policy p ON p.scope='CAMPAIGN' AND (p.resource_id,p.branch_id)=(ca.id,b.id)
 JOIN integration_connection ic ON ic.id=e.connection_id AND ic.organization_id=l.organization_id AND ic.kind='MESSAGING'
 JOIN messaging_sender s ON (s.id,s.connection_id,s.organization_id)=(cv.sender_id,ic.id,l.organization_id)
 WHERE e.id=eid AND e.event_kind='INBOUND_MESSAGE' AND e.state IN ('RECEIVED','NEEDS_ATTENTION','PROCESSED')
  AND l.lifecycle='CLOSED' AND l.closed_at IS NOT NULL AND cv.channel='WHATSAPP'
  AND ca.status='ACTIVE' AND ca.messaging_config->>'enabled'='true'
  AND p.definition->'returningContact'->>'closedLead'='REOPEN_EXISTING'
  AND a.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex')
  AND e.received_at>GREATEST(l.closed_at,cv.closed_at) AND a.verified_at>GREATEST(l.closed_at,cv.closed_at)
  AND CASE WHEN e.payload->'message'->>'timestamp' ~ '^[0-9]{10,11}$'
    THEN to_timestamp((e.payload->'message'->>'timestamp')::double precision)>=date_trunc('second',GREATEST(l.closed_at,cv.closed_at))
     AND to_timestamp((e.payload->'message'->>'timestamp')::double precision)<=e.received_at+interval '2 minutes'
    ELSE false END
  AND ic.status='CONNECTED' AND s.active AND s.operator_enabled AND s.health IN ('HEALTHY','DEGRADED')
  AND s.capabilities->>'text'='true'
  AND (ic.branch_id=l.branch_id OR ic.branch_id IS NULL AND EXISTS(
    SELECT 1 FROM sender_branch_binding sb WHERE sb.sender_id=s.id AND sb.branch_id=l.branch_id))
  AND (EXISTS(SELECT 1 FROM conversation_message prior WHERE prior.conversation_id=cv.id
    AND (prior.connection_id,prior.sender_id)=(cv.connection_id,cv.sender_id)
    AND prior.provider_message_id=e.payload->'message'->'context'->>'id') OR NOT EXISTS(
    SELECT 1 FROM conversation alternative JOIN lead owner ON owner.id=alternative.lead_id
    WHERE alternative.id<>cv.id AND alternative.channel=cv.channel AND owner.organization_id=l.organization_id
      AND (ic.branch_id IS NULL OR owner.branch_id=ic.branch_id)
      AND (alternative.connection_id,alternative.sender_id,alternative.participant_ref)=(cv.connection_id,cv.sender_id,cv.participant_ref)))
  AND NOT EXISTS(SELECT 1 FROM conversation other WHERE other.lead_id=l.id AND other.channel=cv.channel
    AND other.id<>cv.id AND other.state<>'CLOSED')
 FOR UPDATE OF l,cv FOR SHARE OF b,ca,p,ct,ic,s
$$;

CREATE FUNCTION guard_messaging_returning_lead_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RETURNING_LEAD_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO approved FROM verified_returning_lead(NEW.event_id,NEW.conversation_id);
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM automation_trusted_inbound(NEW.event_id) inbound
   JOIN integration_event e ON e.id=NEW.event_id AND e.conversation_id=NEW.conversation_id
   WHERE inbound.lead_id=approved.lead_id AND ai_row_inserted_here(e.xmin))
 THEN RAISE EXCEPTION 'RETURNING_LEAD_TRUSTED_ATTACHMENT_REQUIRED'; END IF;
 NEW.lead_id=approved.lead_id;NEW.organization_id=approved.organization_id;
 NEW.branch_id=approved.branch_id;NEW.campaign_id=approved.campaign_id;
 NEW.lead_version=approved.lead_version;NEW.conversation_version=approved.conversation_version;
 NEW.policy_version=approved.policy_version;NEW.lead_closed_at=approved.lead_closed_at;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE FUNCTION apply_messaging_returning_lead_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous conversation; detail jsonb;
BEGIN
 UPDATE lead SET lifecycle='OPEN',closed_at=NULL,version=version+1,updated_at=now()
  WHERE id=NEW.lead_id AND version=NEW.lead_version AND lifecycle='CLOSED';
 IF NOT FOUND THEN RAISE EXCEPTION 'RETURNING_LEAD_CONTEXT_CHANGED'; END IF;
 SELECT * INTO STRICT previous FROM conversation WHERE id=NEW.conversation_id AND version=NEW.conversation_version FOR UPDATE;
 UPDATE conversation SET state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,version=version+1,
  closed_at=GREATEST(closed_at,NEW.lead_closed_at),needs_attention_reason=COALESCE(needs_attention_reason,'NO_HUMAN_CONTROLLER')
  WHERE id=NEW.conversation_id;
 IF previous.controller_type<>'NONE' THEN
  INSERT INTO conversation_handoff(conversation_id,from_controller,from_user_id,to_controller,reason,created_at)
   VALUES(NEW.conversation_id,previous.controller_type,previous.controller_user_id,'NONE','RETURNING_LEAD_REOPENED',NEW.created_at);
 END IF;
 detail=jsonb_build_object('from','CLOSED','to','OPEN','source','RETURNING_INBOUND','eventId',NEW.event_id,
   'conversationId',NEW.conversation_id,'policyVersion',NEW.policy_version);
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(NEW.lead_id,'LIFECYCLE_CHANGED',detail);
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
   VALUES(NEW.organization_id,NEW.branch_id,'LEAD_LIFECYCLE_CHANGED','LEAD',NEW.lead_id,detail);
 RETURN NEW;
END $$;

CREATE TRIGGER messaging_returning_lead_reopen_guard BEFORE INSERT OR UPDATE OR DELETE ON messaging_returning_lead_reopen
 FOR EACH ROW EXECUTE FUNCTION guard_messaging_returning_lead_reopen();
CREATE TRIGGER messaging_returning_lead_reopen_apply AFTER INSERT ON messaging_returning_lead_reopen
 FOR EACH ROW EXECUTE FUNCTION apply_messaging_returning_lead_reopen();
