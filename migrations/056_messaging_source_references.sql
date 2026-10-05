-- Immutable intake context and explicit current Ad bindings are correlation evidence.
CREATE INDEX source_submission_ad_context_idx ON source_submission
  (organization_id, (raw_payload->'lead'->>'ad_id'), campaign_id)
  WHERE source_kind='META' AND state='PROCESSED' AND lead_id IS NOT NULL;
CREATE INDEX source_binding_ad_context_idx ON source_campaign_binding (external_ad_id, campaign_id)
  WHERE active AND external_ad_id IS NOT NULL;

CREATE FUNCTION messaging_meta_ad_context(org uuid, ad text)
RETURNS TABLE(campaign_id uuid, evidence_kind text, evidence_id uuid, evidence_version integer)
LANGUAGE sql STABLE AS $$
  SELECT s.campaign_id, 'SOURCE_SUBMISSION'::text, s.id, NULL::integer
    FROM source_submission s WHERE s.organization_id=org AND s.source_kind='META'
      AND s.state='PROCESSED' AND s.lead_id IS NOT NULL AND s.raw_payload->'lead'->>'ad_id'=ad
  UNION ALL
  SELECT b.campaign_id, 'SOURCE_BINDING'::text, b.id, b.version
    FROM source_campaign_binding b JOIN integration_connection ic ON ic.id=b.connection_id
    JOIN campaign c ON c.id=b.campaign_id JOIN source_resource f ON f.id=b.resource_id
    JOIN source_resource p ON p.id=f.parent_id
    WHERE ic.organization_id=org AND c.organization_id=org AND b.active AND b.external_ad_id=ad
      AND ic.status IN ('CONNECTED','WARNING') AND f.active AND p.active
      AND b.connection_version=ic.version AND f.connection_version=ic.version AND p.connection_version=ic.version
      AND (ic.branch_id=c.branch_id OR (ic.branch_id IS NULL AND EXISTS
        (SELECT 1 FROM source_resource_access a WHERE a.resource_id=f.id AND a.branch_id=c.branch_id AND a.active)))
$$;

ALTER TABLE conversation_message ADD COLUMN source_event_id uuid REFERENCES integration_event(id);
ALTER TABLE conversation_message ADD COLUMN source_reference jsonb;
CREATE UNIQUE INDEX message_source_event_idx ON conversation_message (source_event_id) WHERE source_event_id IS NOT NULL;
ALTER TABLE conversation_message ADD CHECK (source_event_id IS NULL OR (direction='INBOUND' AND author_type='CUSTOMER'));
ALTER TABLE conversation_message ADD CHECK (source_reference IS NULL OR source_event_id IS NOT NULL);

CREATE FUNCTION guard_message_source_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e integration_event; cv conversation; r jsonb; expected jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.source_event_id,NEW.source_reference) IS DISTINCT FROM (OLD.source_event_id,OLD.source_reference)
      THEN RAISE EXCEPTION 'MESSAGE_SOURCE_REFERENCE_IMMUTABLE'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_event_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO e FROM integration_event WHERE id=NEW.source_event_id;
  SELECT * INTO cv FROM conversation WHERE id=NEW.conversation_id;
  IF e.id IS NULL OR e.event_kind<>'INBOUND_MESSAGE' OR e.connection_id<>NEW.connection_id
    OR cv.connection_id<>NEW.connection_id OR cv.sender_id IS DISTINCT FROM NEW.sender_id
    OR e.sender_id IS DISTINCT FROM NEW.sender_id OR e.participant_ref<>cv.participant_ref
    OR e.payload->'message'->>'id' IS DISTINCT FROM NEW.provider_message_id
    THEN RAISE EXCEPTION 'MESSAGE_SOURCE_EVENT_INVALID'; END IF;
  r=e.payload->'message'->'referral';
  IF r IS NOT NULL THEN
    IF jsonb_typeof(r)<>'object' OR coalesce(r->>'source_type','') NOT IN ('ad','post')
      OR jsonb_typeof(r->'source_id')<>'string'
      OR coalesce(r->>'source_id','') !~ '^[1-9][0-9]{0,29}$'
      THEN RAISE EXCEPTION 'MESSAGE_SOURCE_REFERENCE_INVALID'; END IF;
    expected=jsonb_build_object('namespace',CASE WHEN r->>'source_type'='ad' THEN 'META_AD' ELSE 'META_POST' END,
      'externalId',r->>'source_id','headline',r->'headline','description',r->'body');
  END IF;
  IF NEW.source_reference IS DISTINCT FROM expected THEN RAISE EXCEPTION 'MESSAGE_SOURCE_REFERENCE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_source_reference_guard BEFORE INSERT OR UPDATE ON conversation_message
  FOR EACH ROW EXECUTE FUNCTION guard_message_source_reference();
