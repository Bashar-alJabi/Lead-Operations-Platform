CREATE TABLE generic_source_intake_receipt (
 submission_id uuid PRIMARY KEY REFERENCES source_submission(id),
 connection_id uuid NOT NULL,
 connection_version integer NOT NULL,
 schema_version integer NOT NULL,
 resource_id uuid NOT NULL,
 binding_id uuid NOT NULL,
 binding_version integer NOT NULL,
 mapping_version integer NOT NULL,
 signed_at timestamptz NOT NULL,
 payload_hash bytea NOT NULL CHECK(octet_length(payload_hash)=32),
 received_at timestamptz NOT NULL,
 FOREIGN KEY(connection_id,connection_version) REFERENCES generic_source_setup_revision(connection_id,version),
 FOREIGN KEY(resource_id,schema_version) REFERENCES generic_source_schema_revision(resource_id,version),
 FOREIGN KEY(binding_id,binding_version) REFERENCES source_binding_history(binding_id,version),
 FOREIGN KEY(binding_id,mapping_version) REFERENCES source_mapping_revision(binding_id,version)
);
ALTER TABLE source_processing ADD COLUMN generic_reprocess_session_id uuid REFERENCES user_session(id);

CREATE FUNCTION generic_source_intake_context(connection uuid)
 RETURNS TABLE(organization_id uuid,branch_id uuid,campaign_id uuid,connection_version integer,
   resource_id uuid,schema_version integer,binding_id uuid,binding_version integer,mapping_version integer,questions jsonb)
 LANGUAGE sql AS $$
 SELECT c.organization_id,c.branch_id,k.id,c.version,r.id,r.version,b.id,b.version,m.version,r.questions
 FROM integration_connection c JOIN branch a ON a.id=c.branch_id AND a.organization_id=c.organization_id AND a.active
 JOIN source_campaign_binding b ON b.connection_id=c.id AND b.active AND b.connection_version=c.version
 JOIN source_resource r ON r.id=b.resource_id AND r.connection_id=c.id AND r.resource_kind='WEBHOOK_SCHEMA'
  AND r.active AND r.connection_version=c.version
 JOIN campaign k ON (k.id,k.branch_id,k.organization_id)=(b.campaign_id,c.branch_id,c.organization_id)
  AND k.source_kind='GENERIC_SOURCE' AND k.status='ACTIVE'
 JOIN LATERAL (SELECT revision.* FROM source_mapping_revision revision WHERE revision.binding_id=b.id AND revision.status='PUBLISHED'
  ORDER BY revision.version DESC LIMIT 1) m ON m.connection_version=c.version AND m.binding_version=b.version
  AND m.resource_version=r.version AND m.questions=r.questions
 WHERE c.id=connection AND c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK' AND c.status='CONNECTED'
$$;

CREATE FUNCTION guard_generic_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s source_submission; ctx record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_RECEIPT_IMMUTABLE'; END IF;
 SELECT * INTO s FROM source_submission WHERE id=NEW.submission_id AND source_kind='GENERIC_SOURCE'
  AND state='RECEIVED' AND lead_id IS NULL AND ai_row_inserted_here(xmin);
 IF NOT FOUND OR s.source_timestamp IS DISTINCT FROM NEW.signed_at OR
  NEW.signed_at NOT BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '5 minutes'
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_RECEIPT_REQUIRED'; END IF;
 PERFORM 1 FROM integration_connection c WHERE c.id=NEW.connection_id FOR UPDATE;
 PERFORM 1 FROM branch WHERE id=s.branch_id FOR SHARE;
 PERFORM 1 FROM campaign WHERE id=s.campaign_id FOR SHARE;
 SELECT * INTO ctx FROM generic_source_intake_context(NEW.connection_id);
 IF NOT FOUND OR (ctx.organization_id,ctx.branch_id,ctx.campaign_id,NEW.connection_id)
    IS DISTINCT FROM (s.organization_id,s.branch_id,s.campaign_id,s.connection_id)
  OR (NEW.connection_version,NEW.resource_id,NEW.schema_version,NEW.binding_id,NEW.binding_version,NEW.mapping_version)
    IS DISTINCT FROM (ctx.connection_version,ctx.resource_id,ctx.schema_version,ctx.binding_id,ctx.binding_version,ctx.mapping_version)
  OR s.external_event_id IS NULL OR s.external_event_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR s.raw_payload->>'eventId' IS DISTINCT FROM s.external_event_id
  OR (s.raw_payload - ARRAY['eventId','fields'])<>'{}'::jsonb
  OR jsonb_typeof(s.raw_payload->'fields') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_CONTEXT_CHANGED'; END IF;
 IF jsonb_array_length(s.raw_payload->'fields') NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.raw_payload->'fields') f
   WHERE (f - ARRAY['key','values'])<>'{}'::jsonb OR jsonb_typeof(f->'values') IS DISTINCT FROM 'array'
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ctx.questions) q WHERE q->>'key'=f->>'key'))
  OR jsonb_array_length(s.raw_payload->'fields')<>(SELECT count(DISTINCT f->>'key') FROM jsonb_array_elements(s.raw_payload->'fields') f)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_FIELDS_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s.raw_payload->'fields') f
     WHERE jsonb_array_length(f->'values') NOT BETWEEN 1 AND 50)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.raw_payload->'fields') f CROSS JOIN LATERAL jsonb_array_elements(f->'values') v
     WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}')>4096)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_FIELDS_INVALID'; END IF;
 NEW.received_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_intake_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON generic_source_intake_receipt
 FOR EACH ROW EXECUTE FUNCTION guard_generic_intake_receipt();

CREATE FUNCTION guard_generic_source_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.source_kind='GENERIC_SOURCE' THEN RAISE EXCEPTION 'SOURCE_SUBMISSION_IMMUTABLE'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.source_kind='GENERIC_SOURCE' OR NEW.source_kind='GENERIC_SOURCE') AND
  (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.source_kind,NEW.connection_id,NEW.external_event_id,NEW.raw_payload,NEW.source_timestamp,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.source_kind,OLD.connection_id,OLD.external_event_id,OLD.raw_payload,OLD.source_timestamp,OLD.created_at)
 THEN RAISE EXCEPTION 'SOURCE_SUBMISSION_IMMUTABLE'; END IF;
 IF NEW.source_kind='GENERIC_SOURCE' AND TG_OP='INSERT' AND (NEW.state<>'RECEIVED' OR NEW.lead_id IS NOT NULL OR NEW.resolution_contact_id IS NOT NULL)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_RECEIPT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON source_submission
 FOR EACH ROW EXECUTE FUNCTION guard_generic_source_submission();

CREATE FUNCTION require_generic_intake_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM generic_source_intake_receipt r WHERE r.submission_id=NEW.id AND ai_row_inserted_here(r.xmin))
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_INTAKE_RECEIPT_REQUIRED'; END IF;
 IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM lead_intake_receipt r
  WHERE r.submission_id=NEW.id AND r.lead_id=NEW.lead_id AND r.origin_kind='SOURCE' AND ai_row_inserted_here(r.xmin))
 THEN RAISE EXCEPTION 'LEAD_INTAKE_PROCESSED_SOURCE_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER generic_source_submission_proof AFTER INSERT OR UPDATE ON source_submission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='GENERIC_SOURCE')
 EXECUTE FUNCTION require_generic_intake_proof();

CREATE FUNCTION record_generic_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO source_processing(submission_id,connection_id,campaign_id,branch_id,resource_id,binding_id,binding_version,mapping_version,connection_version,resource_version)
 SELECT NEW.submission_id,NEW.connection_id,s.campaign_id,s.branch_id,NEW.resource_id,NEW.binding_id,NEW.binding_version,
  NEW.mapping_version,NEW.connection_version,NEW.schema_version FROM source_submission s WHERE s.id=NEW.submission_id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 SELECT s.organization_id,s.branch_id,'GENERIC_SOURCE_EVENT_ACCEPTED','SOURCE_SUBMISSION',s.id,
  jsonb_build_object('connectionId',NEW.connection_id,'connectionVersion',NEW.connection_version,'bindingId',NEW.binding_id,'mappingVersion',NEW.mapping_version)
 FROM source_submission s WHERE s.id=NEW.submission_id;
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_intake_receipt_record AFTER INSERT ON generic_source_intake_receipt
 FOR EACH ROW EXECUTE FUNCTION record_generic_intake_receipt();

CREATE OR REPLACE FUNCTION guard_source_processing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission source_submission; connection integration_connection; generic boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_PROCESSING_HISTORY_REQUIRED'; END IF;
  SELECT * INTO submission FROM source_submission WHERE id=NEW.submission_id;
  SELECT * INTO connection FROM integration_connection WHERE id=NEW.connection_id;
  generic := submission.source_kind='GENERIC_SOURCE' AND connection.kind='GENERIC_SOURCE' AND connection.provider='SIGNED_WEBHOOK';
  IF NOT (generic OR (submission.source_kind='META' AND connection.kind='META' AND connection.provider='META_LEAD_ADS'))
    OR submission.connection_id IS DISTINCT FROM NEW.connection_id OR submission.organization_id<>connection.organization_id
    THEN RAISE EXCEPTION 'SOURCE_PROCESSING_SCOPE_INVALID'; END IF;
  IF generic AND (NEW.branch_id IS DISTINCT FROM submission.branch_id OR NEW.campaign_id IS DISTINCT FROM submission.campaign_id
    OR NOT EXISTS (SELECT 1 FROM generic_source_intake_receipt r WHERE r.submission_id=NEW.submission_id
       AND r.connection_id=NEW.connection_id AND r.binding_id=NEW.binding_id AND r.resource_id=NEW.resource_id))
    THEN RAISE EXCEPTION 'SOURCE_PROCESSING_SCOPE_INVALID'; END IF;
  IF generic AND TG_OP='UPDATE' AND NEW.state='PENDING' AND NOT generic_source_session_valid(NEW.actor_user_id,
      NEW.generic_reprocess_session_id,submission.organization_id,submission.branch_id)
    THEN RAISE EXCEPTION 'SOURCE_REPROCESS_SESSION_REQUIRED'; END IF;
  IF (NOT generic OR NEW.state<>'PENDING') AND NEW.generic_reprocess_session_id IS NOT NULL
    THEN RAISE EXCEPTION 'SOURCE_PROCESSING_SCOPE_INVALID'; END IF;
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_resource r WHERE r.id=NEW.resource_id AND r.connection_id=NEW.connection_id AND r.resource_kind=(CASE WHEN generic THEN 'WEBHOOK_SCHEMA' ELSE 'FORM' END))
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

CREATE OR REPLACE FUNCTION guard_meta_intake_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind NOT IN ('META','GENERIC_SOURCE') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.lead_id IS NOT NULL AND
    (NEW.lead_id,NEW.campaign_id,NEW.branch_id,NEW.resolution_contact_id,NEW.state,NEW.failure_code)
    IS DISTINCT FROM (OLD.lead_id,OLD.campaign_id,OLD.branch_id,OLD.resolution_contact_id,OLD.state,OLD.failure_code)
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_IMMUTABLE'; END IF;
  IF NEW.lead_id IS NOT NULL AND (NEW.state<>'PROCESSED' OR NEW.failure_code IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM lead l WHERE l.id=NEW.lead_id AND l.organization_id=NEW.organization_id AND l.branch_id=NEW.branch_id
      AND l.campaign_id=NEW.campaign_id AND l.source_kind=NEW.source_kind AND l.contact_id IS NOT DISTINCT FROM NEW.resolution_contact_id))
    THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_INVALID'; END IF;
  IF NEW.state='PROCESSED' AND NEW.lead_id IS NULL THEN RAISE EXCEPTION 'SOURCE_INTAKE_LINK_INVALID'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_lead_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE birth lead_intake_birth;l lead;s source_submission;h assignment_history;p source_processing;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LEAD_INTAKE_RECEIPT_IMMUTABLE';END IF;
 SELECT bi.* INTO birth FROM lead_intake_birth bi WHERE bi.lead_id=NEW.lead_id AND ai_row_inserted_here(bi.xmin);
 IF birth IS NULL THEN RAISE EXCEPTION 'LEAD_INTAKE_FRESH_BIRTH_REQUIRED';END IF;
 -- Intake already holds these parents; this ordering also fences independently invoked application services.
 PERFORM 1 FROM branch WHERE id=birth.branch_id FOR SHARE;
 PERFORM 1 FROM campaign WHERE id=birth.campaign_id FOR SHARE;
 SELECT * INTO l FROM lead WHERE id=NEW.lead_id FOR UPDATE;
 SELECT * INTO s FROM source_submission WHERE id=NEW.submission_id FOR SHARE;
 SELECT ah.* INTO h FROM assignment_history ah WHERE ah.id=NEW.routing_history_id AND ai_row_inserted_here(ah.xmin) FOR SHARE;
 IF l IS NULL OR s IS NULL OR h IS NULL OR (l.organization_id,l.branch_id,l.campaign_id,l.contact_id,l.source_kind)
   IS DISTINCT FROM (birth.organization_id,birth.branch_id,birth.campaign_id,birth.contact_id,birth.source_kind)
   OR l.lifecycle<>'OPEN' OR h.lead_id<>l.id OR h.new_branch_id<>l.branch_id OR h.new_agent_id IS DISTINCT FROM l.assigned_agent_id
   OR h.old_branch_id IS NOT NULL OR h.old_agent_id IS NOT NULL OR h.actor_user_id IS NOT NULL
   OR h.method IS DISTINCT FROM (SELECT routing_method FROM campaign WHERE id=l.campaign_id)
   OR (CASE h.method
     WHEN 'PERFORMANCE' THEN h.reason IS NULL OR h.reason NOT IN (
       'NO_ELIGIBLE_AGENT','PERFORMANCE_POLICY_REQUIRED','HUMAN_PERFORMANCE','INSUFFICIENT_HUMAN_SAMPLE_FALLBACK')
       OR NOT EXISTS (
        SELECT 1 FROM audit_log a WHERE a.action='LEAD_PERFORMANCE_ROUTED' AND a.target_type='LEAD'
         AND a.organization_id=l.organization_id AND a.branch_id=l.branch_id AND a.target_id=l.id::text
         AND ai_row_inserted_here(a.xmin)
         AND a.detail->>'assignmentHistoryId'=h.id::text AND a.detail->>'method'=h.method
         AND a.detail->>'reason'=h.reason AND a.detail->>'agentId' IS NOT DISTINCT FROM h.new_agent_id::text
       )
     ELSE h.reason IS NULL OR h.reason NOT IN ('NO_ELIGIBLE_AGENT','MANUAL_ROUTING','ROUND_ROBIN','WEIGHTED')
   END)
   OR s.state<>'PROCESSED' OR s.failure_code IS NOT NULL OR s.lead_id IS DISTINCT FROM l.id OR s.source_kind<>l.source_kind
   OR (s.organization_id,s.branch_id,s.campaign_id) IS DISTINCT FROM (l.organization_id,l.branch_id,l.campaign_id)
   OR s.resolution_contact_id IS NOT NULL AND s.resolution_contact_id IS DISTINCT FROM l.contact_id
   OR NOT EXISTS(SELECT 1 FROM branch WHERE id=l.branch_id AND active) OR NOT EXISTS(SELECT 1 FROM campaign WHERE id=l.campaign_id AND status='ACTIVE')
   THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 IF NEW.origin_kind='HUMAN_MANUAL' THEN
   PERFORM 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=NEW.actor_id AND ss.id=NEW.session_id FOR SHARE OF u,ss;
   IF s.source_kind<>'MANUAL' OR NOT lead_intake_human_allowed(l.id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_SESSION_REQUIRED';END IF;
 ELSIF NEW.origin_kind='APPROVED_IMPORT' THEN
   IF NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR NOT COALESCE(lead_import_effect_allowed(s.id,l.id),false)
    OR NOT EXISTS(SELECT 1 FROM lead_import_result rr WHERE rr.submission_id=s.id AND rr.state='IMPORTED' AND rr.lead_id=l.id AND ai_row_inserted_here(rr.xmin))
    THEN RAISE EXCEPTION 'LEAD_INTAKE_APPROVED_IMPORT_REQUIRED';END IF;
 ELSE
   SELECT * INTO p FROM source_processing WHERE submission_id=s.id AND state='PROCESSED' FOR SHARE;
   IF s.source_kind NOT IN ('META','GENERIC_SOURCE') OR NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR p IS NULL
     OR (p.connection_id,p.branch_id,p.campaign_id) IS DISTINCT FROM (s.connection_id,l.branch_id,l.campaign_id)
     OR (s.source_kind='GENERIC_SOURCE' AND NOT EXISTS(
       SELECT 1 FROM generic_source_intake_receipt r CROSS JOIN LATERAL generic_source_intake_context(r.connection_id) ctx
       WHERE r.submission_id=s.id AND r.resource_id=ctx.resource_id AND r.binding_id=ctx.binding_id
         AND ctx.campaign_id=l.campaign_id AND ctx.branch_id=l.branch_id AND ctx.organization_id=l.organization_id
         AND p.resource_id=ctx.resource_id AND p.resource_version=ctx.schema_version AND p.binding_id=ctx.binding_id
         AND p.connection_version=ctx.connection_version AND p.binding_version=ctx.binding_version AND p.mapping_version=ctx.mapping_version))
     OR NOT EXISTS(SELECT 1 FROM source_processing_history ph WHERE ph.submission_id=s.id AND ph.version=p.version AND ph.state='PROCESSED'
       AND ph.snapshot->>'leadId'=l.id::text AND ai_row_inserted_here(ph.xmin)) THEN RAISE EXCEPTION 'LEAD_INTAKE_PROCESSED_SOURCE_REQUIRED';END IF;
 END IF;
 ctx=lead_intake_receipt_context(l.id,s.id,h.id);IF ctx IS NULL THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 NEW.context=ctx;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
