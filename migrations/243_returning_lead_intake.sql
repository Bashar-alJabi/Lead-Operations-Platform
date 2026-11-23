CREATE FUNCTION verified_returning_lead(eid uuid,cvid uuid,expected_action text)
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
  AND expected_action IN ('REOPEN_EXISTING','CREATE_NEW') AND p.definition->'returningContact'->>'closedLead'=expected_action
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

CREATE OR REPLACE FUNCTION verified_returning_lead(eid uuid,cvid uuid)
RETURNS TABLE(lead_id uuid,organization_id uuid,branch_id uuid,campaign_id uuid,lead_version integer,
  conversation_version integer,policy_version integer,lead_closed_at timestamptz)
LANGUAGE sql VOLATILE AS $$ SELECT * FROM verified_returning_lead(eid,cvid,'REOPEN_EXISTING') $$;

CREATE TABLE messaging_returning_lead_intake (
 event_id uuid PRIMARY KEY REFERENCES integration_event(id),
 prior_conversation_id uuid NOT NULL REFERENCES conversation(id),
 prior_lead_id uuid NOT NULL REFERENCES lead(id),
 prior_lead_closed_at timestamptz NOT NULL,
 lead_id uuid NOT NULL UNIQUE REFERENCES lead(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),
 policy_version integer NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(prior_lead_id,prior_lead_closed_at)
);

CREATE FUNCTION returning_lead_intake_reason(eid uuid,cvid uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE context record; lead_contact uuid; ad_id text; linked_campaigns uuid[];
BEGIN
 SELECT * INTO context FROM verified_returning_lead(eid,cvid,'CREATE_NEW');
 IF NOT FOUND THEN RETURN 'CLOSED_LEAD_REQUIRES_REVIEW'; END IF;
 SELECT e.payload->'message'->'referral'->>'source_id' INTO ad_id FROM integration_event e
  WHERE e.id=eid AND e.state IN ('RECEIVED','NEEDS_ATTENTION') AND e.payload->'message'->'referral'->>'source_type'='ad'
   AND e.payload->'message'->>'type'<>'button';
 IF NOT FOUND OR ad_id IS NULL OR ad_id !~ '^[1-9][0-9]{0,29}$' THEN RETURN 'NEW_LEAD_TRUSTED_CONTEXT_REQUIRED'; END IF;
 SELECT ARRAY(SELECT DISTINCT ref.campaign_id FROM messaging_meta_ad_context(context.organization_id,ad_id) ref
  JOIN campaign ca ON ca.id=ref.campaign_id WHERE ca.organization_id=context.organization_id LIMIT 2) INTO linked_campaigns;
 IF linked_campaigns IS DISTINCT FROM ARRAY[context.campaign_id] THEN RETURN 'NEW_LEAD_TRUSTED_CONTEXT_REQUIRED'; END IF;
 SELECT ct.id INTO lead_contact FROM lead l JOIN contact ct ON ct.id=l.contact_id
  WHERE l.id=context.lead_id AND NULLIF(btrim(ct.name),'') IS NOT NULL;
 PERFORM cf.field_id FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
  WHERE cf.campaign_id=context.campaign_id AND cf.required_stage='LEAD_CREATION'
  ORDER BY cf.field_id FOR SHARE OF cf,fd;
 IF lead_contact IS NULL OR EXISTS(SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
  WHERE cf.campaign_id=context.campaign_id AND cf.required_stage='LEAD_CREATION' AND cf.active AND fd.active)
 THEN RETURN 'NEW_LEAD_REQUIRED_DATA_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM lead l WHERE (l.organization_id,l.branch_id,l.campaign_id,l.contact_id)
   =(context.organization_id,context.branch_id,context.campaign_id,lead_contact) AND l.lifecycle='OPEN') OR EXISTS(
  SELECT 1 FROM messaging_returning_lead_intake WHERE (prior_lead_id,prior_lead_closed_at)=(context.lead_id,context.lead_closed_at))
 THEN RETURN 'NEW_LEAD_ALREADY_HAS_SUCCESSOR'; END IF;
 IF EXISTS(SELECT 1 FROM conversation_message m JOIN integration_event e ON e.id=eid AND e.connection_id=m.connection_id
  WHERE m.provider_message_id=e.payload->'message'->>'id') THEN RETURN 'RETURNING_INBOUND_ALREADY_ATTACHED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION guard_messaging_returning_lead_intake() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context record; previous conversation; detail jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RETURNING_LEAD_INTAKE_IMMUTABLE'; END IF;
 IF returning_lead_intake_reason(NEW.event_id,NEW.prior_conversation_id) IS NOT NULL THEN
  RAISE EXCEPTION 'RETURNING_LEAD_INTAKE_TRUSTED_CONTEXT_REQUIRED';
 END IF;
 SELECT * INTO STRICT context FROM verified_returning_lead(NEW.event_id,NEW.prior_conversation_id,'CREATE_NEW');
 NEW.prior_lead_id=context.lead_id;NEW.prior_lead_closed_at=context.lead_closed_at;
 NEW.organization_id=context.organization_id;NEW.branch_id=context.branch_id;NEW.campaign_id=context.campaign_id;
 NEW.policy_version=context.policy_version;NEW.created_at=clock_timestamp();
 INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind)
  SELECT organization_id,branch_id,campaign_id,contact_id,'MESSAGING_INBOUND' FROM lead WHERE id=context.lead_id RETURNING id INTO NEW.lead_id;
 SELECT * INTO STRICT previous FROM conversation WHERE id=NEW.prior_conversation_id FOR UPDATE;
 IF previous.state<>'CLOSED' THEN
  UPDATE conversation SET state='CLOSED',controller_type='NONE',controller_user_id=NULL,version=version+1,closed_at=NEW.created_at
   WHERE id=previous.id;
  INSERT INTO conversation_handoff(conversation_id,from_controller,from_user_id,to_controller,reason,created_at)
   VALUES(previous.id,previous.controller_type,previous.controller_user_id,'NONE','RETURNING_CONTACT_NEW_LEAD',NEW.created_at);
 END IF;
 detail=jsonb_build_object('eventId',NEW.event_id,'priorLeadId',NEW.prior_lead_id,'policyVersion',NEW.policy_version);
 INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(NEW.lead_id,'RETURNING_INBOUND_LEAD_CREATED',detail);
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,'RETURNING_INBOUND_LEAD_CREATED','LEAD',NEW.lead_id,detail);
 RETURN NEW;
END $$;

CREATE FUNCTION prove_messaging_returning_lead_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM automation_trusted_inbound(NEW.event_id) inbound JOIN lead l ON l.id=inbound.lead_id
  JOIN lead previous ON previous.id=NEW.prior_lead_id AND previous.contact_id=l.contact_id
  WHERE (inbound.lead_id,inbound.organization_id,inbound.branch_id,inbound.campaign_id)
     =(NEW.lead_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id) AND l.source_kind='MESSAGING_INBOUND'
   AND EXISTS(SELECT 1 FROM assignment_history h WHERE h.lead_id=l.id AND h.new_branch_id=l.branch_id AND ai_row_inserted_here(h.xmin)))
 THEN RAISE EXCEPTION 'RETURNING_LEAD_INTAKE_EFFECT_REQUIRED'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER messaging_returning_lead_intake_guard BEFORE INSERT OR UPDATE OR DELETE ON messaging_returning_lead_intake
 FOR EACH ROW EXECUTE FUNCTION guard_messaging_returning_lead_intake();
CREATE CONSTRAINT TRIGGER messaging_returning_lead_intake_proof AFTER INSERT ON messaging_returning_lead_intake
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_messaging_returning_lead_intake();
