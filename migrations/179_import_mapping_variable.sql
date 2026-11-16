-- Forward fix: disambiguate the PL/pgSQL target variable from campaign_field.field_id.
CREATE OR REPLACE FUNCTION lead_import_mapping_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s lead_import_sheet;e jsonb;kind text;column_index integer;mapped_field_id uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_MAPPING_IMMUTABLE';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=NEW.file_id FOR UPDATE;
 IF j.id IS NULL OR j.state<>'REVIEW' OR j.expires_at<=clock_timestamp() OR j.purged_at IS NOT NULL OR NOT lead_import_authority(j)
  OR NEW.configuration_hash IS DISTINCT FROM lead_import_mapping_config(j)
  OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
  OR NEW.version<>COALESCE((SELECT max(version)+1 FROM lead_import_mapping_revision WHERE file_id=j.id AND sheet_index=NEW.sheet_index),1)
  OR NOT EXISTS(SELECT 1 FROM user_session us WHERE us.id=NEW.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.branch_id=j.branch_id
   AND a.target_type='LEAD_IMPORT_FILE' AND a.target_id=j.id::text AND a.action='IMPORT_MAPPING_SAVED' AND a.actor_user_id=j.actor_id
   AND ai_row_inserted_here(a.xmin) AND a.detail->>'version'=NEW.version::text AND a.detail->>'sheet'=NEW.sheet_index::text
   AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text AND a.detail->>'configurationHash'=NEW.configuration_hash)
  THEN RAISE EXCEPTION 'IMPORT_MAPPING_CURRENT_PROOF';END IF;
 SELECT * INTO s FROM lead_import_sheet WHERE file_id=j.id AND sheet_index=NEW.sheet_index;
 IF s.file_id IS NULL THEN RAISE EXCEPTION 'IMPORT_MAPPING_SHEET';END IF;
 IF (SELECT count(DISTINCT x->>'column') FROM jsonb_array_elements(NEW.entries) x)<>jsonb_array_length(NEW.entries)
  OR (SELECT count(DISTINCT CASE WHEN x->>'kind'='LEAD_FIELD' THEN 'FIELD:'||(x->>'fieldId') ELSE x->>'kind' END)
      FROM jsonb_array_elements(NEW.entries) x)<>jsonb_array_length(NEW.entries) THEN RAISE EXCEPTION 'IMPORT_MAPPING_DUPLICATE';END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(NEW.entries) LOOP
  IF jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'column')<>'number' OR (e->>'column')!~'^[0-9]+$'
   OR jsonb_typeof(e->'kind')<>'string' OR e->>'kind' NOT IN ('CONTACT_NAME','CONTACT_PHONE','CONTACT_EMAIL','LEAD_FIELD')
   OR NOT(e ? 'column' AND e ? 'kind') OR (e-ARRAY['column','kind','fieldId'])<>'{}'::jsonb
   THEN RAISE EXCEPTION 'IMPORT_MAPPING_ENTRY';END IF;
  column_index=(e->>'column')::integer;kind=e->>'kind';
  IF column_index<0 OR column_index>=jsonb_array_length(s.headers) THEN RAISE EXCEPTION 'IMPORT_MAPPING_COLUMN';END IF;
  IF kind='LEAD_FIELD' THEN
   IF jsonb_typeof(e->'fieldId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;mapped_field_id=(e->>'fieldId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id
    WHERE cf.campaign_id=j.campaign_id AND fd.id=mapped_field_id AND fd.organization_id=j.organization_id
     AND (fd.branch_id IS NULL OR fd.branch_id=j.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=j.campaign_id)
     AND fd.active AND cf.active AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
     AND (j.actor_role='SUPER_ADMIN' OR cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))
    THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;
  ELSIF e ? 'fieldId' THEN RAISE EXCEPTION 'IMPORT_MAPPING_FIELD';END IF;
 END LOOP;RETURN NEW;
END $$;
