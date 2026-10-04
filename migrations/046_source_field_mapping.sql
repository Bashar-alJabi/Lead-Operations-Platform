CREATE TABLE source_mapping_revision (
  binding_id uuid NOT NULL REFERENCES source_campaign_binding(id),
  version integer NOT NULL CHECK (version>0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')),
  binding_version integer NOT NULL CHECK (binding_version>0),
  connection_version integer NOT NULL CHECK (connection_version>0),
  resource_version integer NOT NULL CHECK (resource_version>0),
  catalog_hash bytea NOT NULL CHECK (octet_length(catalog_hash)=32),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=100),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries)='array' AND jsonb_array_length(entries)<=100),
  target_snapshot jsonb NOT NULL CHECK (jsonb_typeof(target_snapshot)='array' AND jsonb_array_length(target_snapshot)<=100),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_id,version)
);
CREATE INDEX source_mapping_published_idx ON source_mapping_revision (binding_id,version DESC) WHERE status='PUBLISHED';
CREATE FUNCTION guard_source_mapping_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b source_campaign_binding; c integration_connection; f source_resource; camp campaign; actor user_account;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SOURCE_MAPPING_HISTORY_IMMUTABLE'; END IF;
  SELECT * INTO b FROM source_campaign_binding WHERE id=NEW.binding_id;
  SELECT * INTO c FROM integration_connection WHERE id=b.connection_id FOR UPDATE;
  SELECT * INTO b FROM source_campaign_binding WHERE id=NEW.binding_id;
  SELECT * INTO f FROM source_resource WHERE id=b.resource_id;
  SELECT * INTO camp FROM campaign WHERE id=b.campaign_id;
  SELECT * INTO actor FROM user_account WHERE id=NEW.actor_user_id;
  IF NOT actor.active OR actor.organization_id<>camp.organization_id OR actor.role NOT IN ('SUPER_ADMIN','MANAGER')
    OR (actor.role='MANAGER' AND actor.branch_id<>camp.branch_id) THEN RAISE EXCEPTION 'SOURCE_MAPPING_ACTOR_INVALID'; END IF;
  IF c.branch_id IS NULL AND actor.role='MANAGER' AND NOT EXISTS (SELECT 1 FROM source_resource_access
    WHERE resource_id=f.id AND branch_id=camp.branch_id AND active) THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_REQUIRED'; END IF;
  IF NEW.version<>COALESCE((SELECT max(version) FROM source_mapping_revision WHERE binding_id=NEW.binding_id),0)+1
    THEN RAISE EXCEPTION 'SOURCE_MAPPING_VERSION_REQUIRED'; END IF;
  IF NEW.binding_version<>b.version OR NEW.connection_version<>c.version OR NEW.resource_version<>f.version OR NEW.questions<>f.questions
    OR camp.source_kind<>'META' THEN RAISE EXCEPTION 'SOURCE_MAPPING_CONFIGURATION_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.entries) entry WHERE entry->>'kind'='LEAD_FIELD' AND NOT EXISTS
    (SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=camp.id
      AND fd.id=(entry->>'fieldId')::uuid AND cf.active AND fd.active AND fd.organization_id=camp.organization_id
      AND (fd.branch_id IS NULL OR fd.branch_id=camp.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=camp.id)
      AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
      AND (actor.role='SUPER_ADMIN' OR (cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))))
    THEN RAISE EXCEPTION 'SOURCE_MAPPING_TARGET_NOT_ALLOWED'; END IF;
  IF NEW.status='PUBLISHED' THEN
    IF c.status NOT IN ('CONNECTED','WARNING') OR NOT f.active OR f.connection_version<>c.version OR NOT EXISTS
      (SELECT 1 FROM source_resource WHERE id=f.parent_id AND active AND connection_version=c.version)
      OR (c.branch_id IS NULL AND NOT EXISTS (SELECT 1 FROM source_resource_access WHERE resource_id=f.id AND branch_id=camp.branch_id AND active))
      THEN RAISE EXCEPTION 'SOURCE_MAPPING_RESOURCE_NOT_AVAILABLE'; END IF;
    IF EXISTS (SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
      WHERE cf.campaign_id=camp.id AND cf.active AND fd.active AND cf.required_stage='LEAD_CREATION'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.entries) entry WHERE entry->>'kind'='LEAD_FIELD' AND entry->>'fieldId'=fd.id::text))
      THEN RAISE EXCEPTION 'SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_mapping_revision_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_mapping_revision
  FOR EACH ROW EXECUTE FUNCTION guard_source_mapping_revision();
