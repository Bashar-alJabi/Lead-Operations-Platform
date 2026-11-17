-- A separate actual-intake origin; existing Human/Meta paths retain their original proofs.
ALTER TABLE lead_import_dataset_sheet ADD UNIQUE(dataset_id,sheet_index,mapping_version);
ALTER TABLE lead_field_value ADD COLUMN source_import_dataset_id uuid;
ALTER TABLE lead_field_value ADD COLUMN source_import_sheet_index integer;
ALTER TABLE field_value_history ADD COLUMN source_import_dataset_id uuid;
ALTER TABLE field_value_history ADD COLUMN source_import_sheet_index integer;
ALTER TABLE lead_field_value ADD FOREIGN KEY(source_import_dataset_id,source_import_sheet_index,source_mapping_version)
 REFERENCES lead_import_dataset_sheet(dataset_id,sheet_index,mapping_version);
ALTER TABLE field_value_history ADD FOREIGN KEY(source_import_dataset_id,source_import_sheet_index,source_mapping_version)
 REFERENCES lead_import_dataset_sheet(dataset_id,sheet_index,mapping_version);
DO $$ DECLARE t text;con record;BEGIN
 FOREACH t IN ARRAY ARRAY['lead_field_value','field_value_history'] LOOP
  FOR con IN SELECT conname FROM pg_constraint WHERE conrelid=t::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%source_submission_id IS NULL%' AND pg_get_constraintdef(oid) LIKE '%source_binding_id IS NOT NULL%' LOOP
   EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,con.conname);
  END LOOP;
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT import_or_meta_source_provenance CHECK(
   (source_submission_id IS NULL AND source_import_dataset_id IS NULL AND source_import_sheet_index IS NULL) OR
   (source_submission_id IS NOT NULL AND source=''SOURCE'' AND source_mapping_version>0 AND
    (source_binding_id IS NOT NULL AND source_import_dataset_id IS NULL AND source_import_sheet_index IS NULL OR
     source_binding_id IS NULL AND source_import_dataset_id IS NOT NULL AND source_import_sheet_index IS NOT NULL)))',t);
 END LOOP;
END $$;
CREATE FUNCTION lead_import_fields_allowed(subid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(dr.fields) AS v("fieldId" uuid,value jsonb) WHERE NOT EXISTS(
  SELECT 1 FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id WHERE fd.id=v."fieldId" AND cf.campaign_id=f.campaign_id
   AND fd.organization_id=f.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=f.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=f.campaign_id)
   AND fd.active AND cf.active AND fd.value_mode IN ('MANUAL','SOURCE') AND (f.actor_role='SUPER_ADMIN' OR cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager))
   AND ai_qualification_value_valid(v.value,fd)))
 AND NOT EXISTS(SELECT 1 FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id WHERE cf.campaign_id=f.campaign_id AND cf.active AND fd.active
  AND cf.required_stage='LEAD_CREATION' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(dr.fields) v WHERE v->>'fieldId'=fd.id::text))
 FROM lead_import_dataset_row dr JOIN lead_import_file f ON f.id=dr.file_id WHERE dr.submission_id=subid
$$;
CREATE FUNCTION lead_import_field_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE dr lead_import_dataset_row;v jsonb;BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.source_import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_FIELD_HISTORY_RETAINED';END IF;RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='field_value_history' AND TG_OP='UPDATE' AND OLD.source_import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_FIELD_HISTORY_IMMUTABLE';END IF;
 IF NEW.source_import_dataset_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO dr FROM lead_import_dataset_row WHERE submission_id=NEW.source_submission_id;
 v=CASE WHEN TG_TABLE_NAME='lead_field_value' THEN to_jsonb(NEW)->'value' ELSE to_jsonb(NEW)->'new_value' END;
 IF dr.submission_id IS NULL OR NEW.source_binding_id IS NOT NULL OR NEW.source<>'SOURCE'
  OR (NEW.source_import_dataset_id,NEW.source_import_sheet_index,NEW.source_mapping_version) IS DISTINCT FROM (dr.dataset_id,dr.sheet_index,dr.mapping_version)
  OR NOT COALESCE(lead_import_effect_allowed(dr.submission_id,NEW.lead_id),false) OR NOT COALESCE(lead_import_fields_allowed(dr.submission_id),false)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(dr.fields) f WHERE f->>'fieldId'=NEW.field_id::text AND f->'value'=v)
  THEN RAISE EXCEPTION 'IMPORT_FIELD_CURRENT_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER import_field_guard BEFORE INSERT OR UPDATE ON lead_field_value FOR EACH ROW EXECUTE FUNCTION lead_import_field_guard();
CREATE TRIGGER import_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON field_value_history FOR EACH ROW EXECUTE FUNCTION lead_import_field_guard();
CREATE FUNCTION lead_import_attempt_complete() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE dr lead_import_dataset_row;BEGIN
 SELECT * INTO dr FROM lead_import_dataset_row WHERE submission_id=NEW.submission_id;
 IF NOT COALESCE(lead_import_effect_allowed(NEW.submission_id,NEW.lead_id),false) OR NOT COALESCE(lead_import_fields_allowed(NEW.submission_id),false)
 OR NOT EXISTS(SELECT 1 FROM lead_import_result r WHERE r.submission_id=NEW.submission_id AND r.version=NEW.result_version AND r.state='IMPORTED' AND r.lead_id=NEW.lead_id)
 OR NOT EXISTS(SELECT 1 FROM source_submission s WHERE s.id=NEW.submission_id AND s.state='PROCESSED' AND s.lead_id=NEW.lead_id AND s.resolution_contact_id IS NOT DISTINCT FROM NEW.contact_id)
 OR NOT EXISTS(SELECT 1 FROM lead_intake_receipt ir WHERE ir.submission_id=NEW.submission_id AND ir.lead_id=NEW.lead_id AND ir.origin_kind='APPROVED_IMPORT' AND ai_row_inserted_here(ir.xmin))
 OR (SELECT count(*) FROM lead_field_value WHERE lead_id=NEW.lead_id)<>jsonb_array_length(dr.fields)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(dr.fields) f WHERE NOT EXISTS(SELECT 1 FROM lead_field_value v WHERE v.lead_id=NEW.lead_id
   AND v.field_id::text=f->>'fieldId' AND v.value=f->'value' AND v.source='SOURCE' AND v.source_submission_id=NEW.submission_id
   AND v.source_import_dataset_id=dr.dataset_id AND v.source_import_sheet_index=dr.sheet_index AND v.source_mapping_version=dr.mapping_version)
  OR NOT EXISTS(SELECT 1 FROM field_value_history h WHERE h.lead_id=NEW.lead_id AND h.field_id::text=f->>'fieldId' AND h.new_value=f->'value'
   AND h.source='SOURCE' AND h.source_submission_id=NEW.submission_id AND h.source_import_dataset_id=dr.dataset_id AND ai_row_inserted_here(h.xmin)))
 THEN RAISE EXCEPTION 'IMPORT_ATOMIC_INTAKE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lead_import_attempt_complete AFTER INSERT ON lead_import_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lead_import_attempt_complete();
CREATE OR REPLACE FUNCTION lead_import_source_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d lead_import_dataset;j lead_import_file;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.import_dataset_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_RETAINED';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.import_dataset_id IS NOT NULL THEN
  IF OLD.state<>'RECEIVED' OR NEW.state<>'PROCESSED' OR NEW.failure_code IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['state','lead_id','resolution_contact_id','failure_code']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','lead_id','resolution_contact_id','failure_code'])
   OR NOT COALESCE(lead_import_effect_allowed(OLD.id,NEW.lead_id),false)
   OR NEW.resolution_contact_id IS DISTINCT FROM (SELECT contact_id FROM lead WHERE id=NEW.lead_id)
   THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE';END IF;RETURN NEW;
 END IF;
 IF NEW.import_dataset_id IS NULL AND NEW.source_kind NOT IN ('IMPORT_CSV','IMPORT_EXCEL') THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR NEW.import_dataset_id IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;
 SELECT ds.* INTO d FROM lead_import_dataset ds WHERE ds.id=NEW.import_dataset_id AND ai_row_inserted_here(ds.xmin);
 SELECT * INTO j FROM lead_import_file WHERE id=d.file_id;
 IF d.id IS NULL OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (j.organization_id,j.branch_id,j.campaign_id)
  OR NEW.source_kind IS DISTINCT FROM (CASE WHEN j.format='CSV' THEN 'IMPORT_CSV' ELSE 'IMPORT_EXCEL' END)
  OR NEW.state<>'RECEIVED' OR NEW.lead_id IS NOT NULL OR NEW.resolution_contact_id IS NOT NULL OR NEW.failure_code IS NOT NULL
  OR NEW.connection_id IS NOT NULL OR NEW.external_event_id IS NOT NULL OR NEW.source_timestamp IS NOT NULL
  OR NEW.raw_payload IS DISTINCT FROM lead_import_source_payload(d.id,NEW.import_sheet_index,NEW.import_row_number)
  OR NEW.raw_payload IS NULL THEN RAISE EXCEPTION 'IMPORT_SOURCE_CAPTURE_PROOF';END IF;RETURN NEW;
END $$;

ALTER TABLE lead_intake_receipt DROP CONSTRAINT lead_intake_receipt_origin_kind_check;
ALTER TABLE lead_intake_receipt ADD CONSTRAINT lead_intake_receipt_origin_kind_check CHECK(origin_kind IN ('HUMAN_MANUAL','SOURCE','APPROVED_IMPORT'));
ALTER FUNCTION lead_intake_receipt_context(uuid,uuid,bigint) RENAME TO lead_intake_receipt_base_context;
CREATE FUNCTION lead_intake_receipt_context(lid uuid,subid uuid,rid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.import_dataset_id IS NULL THEN base.ctx ELSE jsonb_set(base.ctx,'{source}',base.ctx->'source'||jsonb_build_object(
  'datasetId',s.import_dataset_id,'sheet',s.import_sheet_index,'row',s.import_row_number,'mappingVersion',dr.mapping_version,
  'approvalVersion',d.review_version,'executionId',r.execution_id,'resultVersion',r.version)) END
 FROM source_submission s LEFT JOIN lead_import_dataset_row dr ON dr.submission_id=s.id LEFT JOIN lead_import_dataset d ON d.id=dr.dataset_id
 LEFT JOIN lead_import_result r ON r.submission_id=s.id CROSS JOIN LATERAL(SELECT lead_intake_receipt_base_context(lid,subid,rid) ctx) base WHERE s.id=subid
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
   OR h.reason NOT IN ('NO_ELIGIBLE_AGENT','MANUAL_ROUTING','ROUND_ROBIN','WEIGHTED','INSUFFICIENT_HUMAN_SAMPLE_FALLBACK') OR h.reason IS NULL
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
   IF s.source_kind<>'META' OR NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR p IS NULL
     OR (p.connection_id,p.branch_id,p.campaign_id) IS DISTINCT FROM (s.connection_id,l.branch_id,l.campaign_id)
     OR NOT EXISTS(SELECT 1 FROM source_processing_history ph WHERE ph.submission_id=s.id AND ph.version=p.version AND ph.state='PROCESSED'
       AND ph.snapshot->>'leadId'=l.id::text AND ai_row_inserted_here(ph.xmin)) THEN RAISE EXCEPTION 'LEAD_INTAKE_PROCESSED_SOURCE_REQUIRED';END IF;
 END IF;
 ctx=lead_intake_receipt_context(l.id,s.id,h.id);IF ctx IS NULL THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 NEW.context=ctx;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
