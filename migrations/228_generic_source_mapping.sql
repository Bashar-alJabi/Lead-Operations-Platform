ALTER TABLE source_resource DROP CONSTRAINT source_resource_resource_kind_check,
 DROP CONSTRAINT source_resource_external_id_check, DROP CONSTRAINT source_resource_check;
ALTER TABLE source_resource ADD CONSTRAINT source_resource_identity_check CHECK (
 (resource_kind='PAGE' AND external_id ~ '^[0-9]{1,30}$' AND parent_id IS NULL AND questions='[]'::jsonb)
 OR (resource_kind='FORM' AND external_id ~ '^[0-9]{1,30}$' AND parent_id IS NOT NULL)
 OR (resource_kind='WEBHOOK_SCHEMA' AND external_id='webhook' AND parent_id IS NULL AND jsonb_array_length(questions)>0)
);

CREATE TABLE generic_source_schema_revision (
 resource_id uuid NOT NULL REFERENCES source_resource(id),
 version integer NOT NULL CHECK(version>0),
 connection_version integer NOT NULL CHECK(connection_version>0),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 questions jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(resource_id,version)
);
ALTER TABLE source_campaign_binding ADD COLUMN generic_session_id uuid REFERENCES user_session(id);
ALTER TABLE source_mapping_revision ADD COLUMN generic_session_id uuid REFERENCES user_session(id);

CREATE FUNCTION generic_source_session_valid(actor uuid, actor_session uuid, org uuid, managing_branch uuid) RETURNS boolean
 LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=actor AND u.active AND u.organization_id=org
   AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=managing_branch)
   AND s.id=actor_session AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
$$;

CREATE FUNCTION check_generic_schema_resource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.resource_kind='WEBHOOK_SCHEMA' THEN RAISE EXCEPTION 'SOURCE_HISTORY_RETAINED'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.resource_kind<>'WEBHOOK_SCHEMA' THEN
  IF EXISTS(SELECT 1 FROM integration_connection WHERE id=NEW.connection_id AND kind='GENERIC_SOURCE' AND provider='SIGNED_WEBHOOK')
  THEN RAISE EXCEPTION 'GENERIC_SOURCE_RESOURCE_KIND_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN branch b ON (b.id,b.organization_id)=(c.branch_id,c.organization_id)
  WHERE c.id=NEW.connection_id AND c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK' AND c.status='CONNECTED'
   AND c.version=NEW.connection_version AND b.active FOR UPDATE OF c FOR SHARE OF b)
  OR NOT NEW.active OR NEW.provider_status IS NOT NULL
  OR (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND NEW.version<>OLD.version+1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.questions) q
   WHERE q->>'key' IS NULL OR q->>'key' !~ '^[a-z][a-z0-9_]{0,63}$'
    OR q IS DISTINCT FROM jsonb_build_object('key',q->>'key','externalId',NULL,'label',q->>'key','type','CUSTOM','options','[]'::jsonb))
  OR jsonb_array_length(NEW.questions)<>(SELECT count(DISTINCT q->>'key') FROM jsonb_array_elements(NEW.questions) q)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_SCHEMA_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generic_schema_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON source_resource
 FOR EACH ROW EXECUTE FUNCTION check_generic_schema_resource();

CREATE FUNCTION record_generic_schema_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource source_resource; c integration_connection;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GENERIC_SOURCE_SCHEMA_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO resource FROM source_resource WHERE id=NEW.resource_id AND resource_kind='WEBHOOK_SCHEMA'
  AND version=NEW.version AND connection_version=NEW.connection_version AND questions=NEW.questions AND ai_row_inserted_here(xmin);
 IF NOT FOUND THEN RAISE EXCEPTION 'GENERIC_SOURCE_SCHEMA_PROOF_REQUIRED'; END IF;
 SELECT * INTO c FROM integration_connection WHERE id=resource.connection_id;
 IF NOT generic_source_session_valid(NEW.actor_id,NEW.session_id,c.organization_id,c.branch_id)
  OR NEW.version<>COALESCE((SELECT max(version)+1 FROM generic_source_schema_revision WHERE resource_id=resource.id),1)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_SCHEMA_PROOF_REQUIRED'; END IF;
 NEW.created_at=statement_timestamp();
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES(c.organization_id,c.branch_id,NEW.actor_id,'GENERIC_SOURCE_SCHEMA_SAVED','SOURCE_RESOURCE',resource.id,
  jsonb_build_object('version',NEW.version,'connectionVersion',NEW.connection_version,'reason',NEW.reason));
 RETURN NEW;
END $$;
CREATE TRIGGER generic_schema_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON generic_source_schema_revision
 FOR EACH ROW EXECUTE FUNCTION record_generic_schema_revision();

CREATE FUNCTION require_generic_schema_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM generic_source_schema_revision WHERE resource_id=NEW.id AND version=NEW.version AND ai_row_inserted_here(xmin))
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_SCHEMA_REVISION_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER generic_schema_revision_required AFTER INSERT OR UPDATE ON source_resource
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.resource_kind='WEBHOOK_SCHEMA')
 EXECUTE FUNCTION require_generic_schema_revision();

CREATE OR REPLACE FUNCTION guard_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn integration_connection; form source_resource; camp campaign; generic boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_HISTORY_RETAINED'; END IF;
  SELECT * INTO conn FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
  SELECT * INTO form FROM source_resource WHERE id=NEW.resource_id;
  SELECT * INTO camp FROM campaign WHERE id=NEW.campaign_id;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.connection_id,NEW.resource_id,NEW.campaign_id,NEW.request_key,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.resource_id,OLD.campaign_id,OLD.request_key,OLD.created_at)
      THEN RAISE EXCEPTION 'SOURCE_BINDING_IDENTITY_IMMUTABLE'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'SOURCE_BINDING_VERSION_REQUIRED'; END IF;
  ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SOURCE_BINDING_VERSION_REQUIRED'; END IF;
  generic := conn.kind='GENERIC_SOURCE' AND conn.provider='SIGNED_WEBHOOK';
  IF NOT ((generic AND form.resource_kind='WEBHOOK_SCHEMA') OR
    (conn.kind='META' AND conn.provider='META_LEAD_ADS' AND form.resource_kind='FORM'))
    OR form.connection_id<>conn.id OR camp.organization_id<>conn.organization_id
    OR (conn.branch_id IS NOT NULL AND conn.branch_id<>camp.branch_id)
    THEN RAISE EXCEPTION 'SOURCE_BINDING_SCOPE_INVALID'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_account u WHERE u.id=NEW.updated_by AND u.active
    AND u.organization_id=camp.organization_id AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=camp.branch_id)))
    THEN RAISE EXCEPTION 'SOURCE_BINDING_ACTOR_INVALID'; END IF;
  IF generic THEN
    IF conn.branch_id IS NULL OR num_nonnulls(NEW.external_campaign_id,NEW.external_adset_id,NEW.external_ad_id)>0
      THEN RAISE EXCEPTION 'SOURCE_BINDING_SCOPE_INVALID'; END IF;
    IF NOT generic_source_session_valid(NEW.updated_by,NEW.generic_session_id,camp.organization_id,camp.branch_id)
      THEN RAISE EXCEPTION 'SOURCE_BINDING_SESSION_REQUIRED'; END IF;
  ELSIF NEW.generic_session_id IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_BINDING_SCOPE_INVALID';
  END IF;
  IF conn.branch_id IS NULL AND NOT EXISTS (SELECT 1 FROM user_account WHERE id=NEW.updated_by AND role='SUPER_ADMIN')
    AND (TG_OP='INSERT' OR NEW.active OR (NEW.external_campaign_id,NEW.external_adset_id,NEW.external_ad_id)
      IS DISTINCT FROM (OLD.external_campaign_id,OLD.external_adset_id,OLD.external_ad_id))
    AND NOT EXISTS (SELECT 1 FROM source_resource_access WHERE resource_id=NEW.resource_id AND branch_id=camp.branch_id AND active)
    THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_REQUIRED'; END IF;
  IF NEW.active THEN
    IF camp.source_kind<>(CASE WHEN generic THEN 'GENERIC_SOURCE' ELSE 'META' END) OR NOT EXISTS (SELECT 1 FROM branch WHERE id=camp.branch_id AND active)
      OR conn.status NOT IN ('CONNECTED','WARNING') OR NOT form.active OR form.connection_version<>conn.version
      OR NEW.connection_version<>conn.version OR (NOT generic AND NOT EXISTS (SELECT 1 FROM source_resource p
        WHERE p.id=form.parent_id AND p.active AND p.connection_version=conn.version))
      THEN RAISE EXCEPTION 'SOURCE_BINDING_NOT_AVAILABLE'; END IF;
    IF conn.branch_id IS NULL AND NOT EXISTS (SELECT 1 FROM source_resource_access
      WHERE resource_id=NEW.resource_id AND branch_id=camp.branch_id AND active)
      THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_REQUIRED'; END IF;
    IF EXISTS (SELECT 1 FROM source_campaign_binding b WHERE b.id<>NEW.id AND b.active
      AND b.connection_id=NEW.connection_id AND b.resource_id=NEW.resource_id
      AND (b.external_campaign_id IS NULL OR NEW.external_campaign_id IS NULL OR b.external_campaign_id=NEW.external_campaign_id)
      AND (b.external_adset_id IS NULL OR NEW.external_adset_id IS NULL OR b.external_adset_id=NEW.external_adset_id)
      AND (b.external_ad_id IS NULL OR NEW.external_ad_id IS NULL OR b.external_ad_id=NEW.external_ad_id))
      THEN RAISE EXCEPTION 'SOURCE_BINDING_CONTEXT_CONFLICT'; END IF;
  END IF;
  NEW.updated_at=now(); RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_source_mapping_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b source_campaign_binding; c integration_connection; f source_resource; camp campaign; actor user_account; generic boolean;
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
  generic := c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK' AND f.resource_kind='WEBHOOK_SCHEMA';
  IF generic THEN
    IF c.branch_id IS DISTINCT FROM camp.branch_id OR c.organization_id IS DISTINCT FROM camp.organization_id
      OR NOT generic_source_session_valid(NEW.actor_user_id,NEW.generic_session_id,camp.organization_id,camp.branch_id)
      THEN RAISE EXCEPTION 'SOURCE_MAPPING_SESSION_REQUIRED'; END IF;
    IF b.connection_version<>c.version OR NOT EXISTS (SELECT 1 FROM branch WHERE id=camp.branch_id AND active)
      THEN RAISE EXCEPTION 'SOURCE_MAPPING_CONFIGURATION_CHANGED'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.entries) entry
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.questions) q WHERE q->>'key'=entry->>'sourceKey'))
      THEN RAISE EXCEPTION 'SOURCE_MAPPING_QUESTION_UNKNOWN_OR_AMBIGUOUS'; END IF;
  ELSIF NEW.generic_session_id IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_MAPPING_ACTOR_INVALID';
  END IF;
  IF c.branch_id IS NULL AND actor.role='MANAGER' AND NOT EXISTS (SELECT 1 FROM source_resource_access
    WHERE resource_id=f.id AND branch_id=camp.branch_id AND active) THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_REQUIRED'; END IF;
  IF NEW.version<>COALESCE((SELECT max(version) FROM source_mapping_revision WHERE binding_id=NEW.binding_id),0)+1
    THEN RAISE EXCEPTION 'SOURCE_MAPPING_VERSION_REQUIRED'; END IF;
  IF NEW.binding_version<>b.version OR NEW.connection_version<>c.version OR NEW.resource_version<>f.version OR NEW.questions<>f.questions
    OR camp.source_kind<>(CASE WHEN generic THEN 'GENERIC_SOURCE' ELSE 'META' END) THEN RAISE EXCEPTION 'SOURCE_MAPPING_CONFIGURATION_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.entries) entry WHERE entry->>'kind'='LEAD_FIELD' AND NOT EXISTS
    (SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=camp.id
      AND fd.id=(entry->>'fieldId')::uuid AND cf.active AND fd.active AND fd.organization_id=camp.organization_id
      AND (fd.branch_id IS NULL OR fd.branch_id=camp.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=camp.id)
      AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
      AND (actor.role='SUPER_ADMIN' OR (cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))))
    THEN RAISE EXCEPTION 'SOURCE_MAPPING_TARGET_NOT_ALLOWED'; END IF;
  IF NEW.status='PUBLISHED' THEN
    IF c.status NOT IN ('CONNECTED','WARNING') OR NOT f.active OR f.connection_version<>c.version
      OR (generic AND NOT b.active)
      OR (NOT generic AND NOT EXISTS (SELECT 1 FROM source_resource WHERE id=f.parent_id AND active AND connection_version=c.version))
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
