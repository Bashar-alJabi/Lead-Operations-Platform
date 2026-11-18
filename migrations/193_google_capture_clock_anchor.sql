-- A single statement clock anchors new capture creation and its duration fence.
-- Existing rows and older API nodes retain the original clock contract; no historical expiry is rewritten.
ALTER TABLE google_capture_job ADD COLUMN retention_clock text NOT NULL DEFAULT 'LEGACY_CLOCK' CHECK(retention_clock IN ('LEGACY_CLOCK','STATEMENT'));
CREATE OR REPLACE FUNCTION guard_google_capture_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection;n integer;first_row integer;last_row integer;bytes integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_HISTORY_RETAINED';END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.failures<>0 OR NEW.captured_rows<>0 OR NEW.payload_bytes<>0 OR NEW.verified_metadata IS NOT NULL OR NEW.active_grant_id IS NOT NULL
   OR NOT google_capture_allowed(NEW::google_capture_job,true) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_APPROVAL_REQUIRED';END IF;
  IF NEW.retention_clock='STATEMENT' THEN
   IF NEW.expires_at<statement_timestamp()+interval '4 seconds' OR NEW.expires_at>statement_timestamp()+interval '24 hours' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_RETENTION_INVALID';END IF;
  ELSE
   -- Rolling compatibility: existing callers keep their original validation and semantics.
   IF NEW.expires_at<clock_timestamp()+interval '4 seconds' OR NEW.expires_at>clock_timestamp()+interval '24 hours' THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_RETENTION_INVALID';END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM google_resource r CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'sheets') s WHERE r.id=NEW.resource_id
    AND (s->>'id')::integer=NEW.sheet_id AND s->>'kind'='GRID' AND s->>'title'=NEW.sheet_title
    AND (s->>'rows')::bigint>=NEW.start_row::bigint+NEW.row_count-1 AND (s->>'columns')::integer>=NEW.start_column+NEW.column_count-1)
   THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_GRID_INVALID';END IF;
  NEW.created_at=CASE WHEN NEW.retention_clock='STATEMENT' THEN statement_timestamp() ELSE clock_timestamp() END;
 ELSE
  IF NEW.version<>OLD.version+1 OR NEW.retention_clock IS DISTINCT FROM OLD.retention_clock OR (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.resource_id,NEW.connection_id,NEW.connection_version,NEW.resource_version,NEW.actor_id,NEW.actor_role,NEW.actor_branch_id,NEW.request_id,NEW.label,NEW.sheet_id,NEW.sheet_title,NEW.spreadsheet_id,NEW.start_row,NEW.start_column,NEW.row_count,NEW.column_count,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.resource_id,OLD.connection_id,OLD.connection_version,OLD.resource_version,OLD.actor_id,OLD.actor_role,OLD.actor_branch_id,OLD.request_id,OLD.label,OLD.sheet_id,OLD.sheet_title,OLD.spreadsheet_id,OLD.start_row,OLD.start_column,OLD.row_count,OLD.column_count,OLD.created_at,OLD.expires_at)
   OR OLD.state IN ('CANCELLED','EXPIRED') OR NEW.captured_rows<OLD.captured_rows OR NEW.payload_bytes<OLD.payload_bytes THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_IDENTITY_IMMUTABLE';END IF;
  IF (NEW.approval_session_id,NEW.access_version) IS DISTINCT FROM (OLD.approval_session_id,OLD.access_version)
   OR OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER') AND NEW.state='WAITING' THEN
   IF NEW.state<>'WAITING' OR NOT google_capture_allowed(NEW::google_capture_job,true) OR NEW.failures<>0 THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_RECOVERY_APPROVAL_REQUIRED';END IF;
  END IF;
  IF NEW.state='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_NOT_EXPIRED';END IF;
  IF NEW.state='RUNNING' THEN
   IF OLD.state NOT IN ('WAITING','RUNNING') OR OLD.state='RUNNING' AND OLD.lease_until>clock_timestamp()
    OR NOT google_capture_allowed(NEW::google_capture_job) OR NEW.expires_at<=clock_timestamp() OR NEW.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId'
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_CURRENT_CLAIM_REQUIRED';END IF;
   IF NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '61 seconds' OR NEW.lease_token IS NULL THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_LEASE_INVALID';END IF;
  ELSIF NEW.state NOT IN ('CANCELLED','EXPIRED','NEEDS_ATTENTION') AND OLD.state<>'RUNNING' AND NOT(OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER') AND NEW.state='WAITING') THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_TRANSITION_INVALID';END IF;
  IF NEW.verified_metadata IS DISTINCT FROM OLD.verified_metadata AND (OLD.verified_metadata IS NOT NULL OR OLD.state<>'RUNNING' OR NOT google_capture_allowed(NEW::google_capture_job)) THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_METADATA_IMMUTABLE';END IF;
  IF NEW.captured_rows>OLD.captured_rows THEN
   IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.state NOT IN ('WAITING','READY')
    OR NOT google_capture_allowed(NEW::google_capture_job) OR OLD.active_grant_id::text IS DISTINCT FROM c.capabilities->>'grantId' OR NEW.verified_metadata IS NULL
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_CURRENT_PAGE_REQUIRED';END IF;
   SELECT count(*),min(row_number),max(row_number),COALESCE(sum(payload_bytes),0) INTO n,first_row,last_row,bytes FROM google_capture_row
    WHERE job_id=NEW.id AND page_version=NEW.version AND recorded_xid=pg_current_xact_id() AND lease_token=OLD.lease_token;
   IF n<>NEW.captured_rows-OLD.captured_rows OR first_row<>NEW.start_row+OLD.captured_rows OR last_row<>NEW.start_row+NEW.captured_rows-1 OR NEW.payload_bytes<>OLD.payload_bytes+bytes
    THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_COMPLETE_PAGE_REQUIRED';END IF;
  ELSIF NEW.payload_bytes<>OLD.payload_bytes THEN RAISE EXCEPTION 'GOOGLE_CAPTURE_COMPLETE_PAGE_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
