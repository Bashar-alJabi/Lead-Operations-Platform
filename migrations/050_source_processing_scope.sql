-- Additive repair after applying 049: avoid a PL/pgSQL record/SQL alias collision.
CREATE OR REPLACE FUNCTION guard_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission source_submission; connection integration_connection;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_HISTORY_REQUIRED'; END IF;
  SELECT * INTO submission FROM source_submission WHERE id=NEW.submission_id;
  SELECT * INTO connection FROM integration_connection WHERE id=NEW.connection_id;
  IF submission.source_kind<>'META' OR submission.connection_id IS DISTINCT FROM NEW.connection_id OR submission.organization_id<>connection.organization_id
    OR connection.kind<>'META' OR connection.provider<>'META_LEAD_ADS' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_SCOPE_INVALID'; END IF;
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_resource r WHERE r.id=NEW.resource_id AND r.connection_id=NEW.connection_id AND r.resource_kind='FORM')
    THEN RAISE EXCEPTION 'SOURCE_PROCESSING_RESOURCE_INVALID'; END IF;
  IF TG_OP='UPDATE' AND (NEW.submission_id<>OLD.submission_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.version<>OLD.version+1 OR NEW.evaluations<OLD.evaluations) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_VERSION_REQUIRED'; END IF;
  IF NEW.campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign c WHERE c.id=NEW.campaign_id
    AND c.organization_id=submission.organization_id AND c.branch_id=NEW.branch_id) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_CAMPAIGN_INVALID'; END IF;
  IF NEW.binding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_campaign_binding b WHERE b.id=NEW.binding_id
    AND b.connection_id=NEW.connection_id AND b.campaign_id=NEW.campaign_id AND b.resource_id=NEW.resource_id) THEN RAISE EXCEPTION 'SOURCE_PROCESSING_BINDING_INVALID'; END IF;
  RETURN NEW;
END;
$$;
