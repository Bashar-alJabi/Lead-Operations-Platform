-- Source selection is separate from provider credentials and from mapping/intake readiness.
CREATE TABLE source_resource_access (
  resource_id uuid NOT NULL REFERENCES source_resource(id),
  branch_id uuid NOT NULL REFERENCES branch(id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_by uuid NOT NULL REFERENCES user_account(id),
  change_reason text NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id,branch_id)
);
CREATE INDEX source_resource_access_branch_idx ON source_resource_access (branch_id,resource_id) WHERE active;
CREATE TABLE source_campaign_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  resource_id uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  request_key uuid NOT NULL,
  external_campaign_id text CHECK (external_campaign_id ~ '^[0-9]{1,30}$'),
  external_adset_id text CHECK (external_adset_id ~ '^[0-9]{1,30}$'),
  external_ad_id text CHECK (external_ad_id ~ '^[0-9]{1,30}$'),
  active boolean NOT NULL DEFAULT false,
  connection_version integer NOT NULL CHECK (connection_version>0),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_by uuid NOT NULL REFERENCES user_account(id),
  change_reason text NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_id,connection_id) REFERENCES source_resource(id,connection_id),
  UNIQUE (campaign_id,request_key)
);
CREATE INDEX source_campaign_binding_campaign_idx ON source_campaign_binding (campaign_id,id);
CREATE INDEX source_campaign_binding_resolution_idx ON source_campaign_binding (connection_id,resource_id) WHERE active;
CREATE TABLE source_binding_history (
  binding_id uuid NOT NULL REFERENCES source_campaign_binding(id),
  version integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_id,version)
);
CREATE TABLE source_resource_access_history (
  resource_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  version integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  active boolean NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id,branch_id,version),
  FOREIGN KEY (resource_id,branch_id) REFERENCES source_resource_access(resource_id,branch_id)
);
CREATE FUNCTION guard_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn integration_connection; form source_resource; camp campaign;
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
  IF conn.kind<>'META' OR conn.provider<>'META_LEAD_ADS' OR form.resource_kind<>'FORM'
    OR form.connection_id<>conn.id OR camp.organization_id<>conn.organization_id
    OR (conn.branch_id IS NOT NULL AND conn.branch_id<>camp.branch_id)
    THEN RAISE EXCEPTION 'SOURCE_BINDING_SCOPE_INVALID'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_account u WHERE u.id=NEW.updated_by AND u.active
    AND u.organization_id=camp.organization_id AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=camp.branch_id)))
    THEN RAISE EXCEPTION 'SOURCE_BINDING_ACTOR_INVALID'; END IF;
  IF conn.branch_id IS NULL AND NOT EXISTS (SELECT 1 FROM user_account WHERE id=NEW.updated_by AND role='SUPER_ADMIN')
    AND (TG_OP='INSERT' OR NEW.active OR (NEW.external_campaign_id,NEW.external_adset_id,NEW.external_ad_id)
      IS DISTINCT FROM (OLD.external_campaign_id,OLD.external_adset_id,OLD.external_ad_id))
    AND NOT EXISTS (SELECT 1 FROM source_resource_access WHERE resource_id=NEW.resource_id AND branch_id=camp.branch_id AND active)
    THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_REQUIRED'; END IF;
  IF NEW.active THEN
    IF camp.source_kind<>'META' OR NOT EXISTS (SELECT 1 FROM branch WHERE id=camp.branch_id AND active)
      OR conn.status NOT IN ('CONNECTED','WARNING') OR NOT form.active OR form.connection_version<>conn.version
      OR NEW.connection_version<>conn.version OR NOT EXISTS (SELECT 1 FROM source_resource p
        WHERE p.id=form.parent_id AND p.active AND p.connection_version=conn.version)
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
CREATE TRIGGER source_binding_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_campaign_binding
  FOR EACH ROW EXECUTE FUNCTION guard_source_binding();
CREATE FUNCTION guard_source_resource_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn integration_connection;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_HISTORY_RETAINED'; END IF;
  SELECT c.* INTO conn FROM integration_connection c JOIN source_resource r ON r.connection_id=c.id
    WHERE r.id=NEW.resource_id AND r.resource_kind='FORM' FOR UPDATE OF c;
  IF conn.id IS NULL OR conn.branch_id IS NOT NULL OR conn.kind<>'META' OR conn.provider<>'META_LEAD_ADS'
    OR NOT EXISTS (SELECT 1 FROM branch WHERE id=NEW.branch_id AND organization_id=conn.organization_id)
    THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_SCOPE_INVALID'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_account WHERE id=NEW.updated_by AND organization_id=conn.organization_id AND active AND role='SUPER_ADMIN')
    THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_ACTOR_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.resource_id,NEW.branch_id) IS DISTINCT FROM (OLD.resource_id,OLD.branch_id)
      THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_IDENTITY_IMMUTABLE'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_VERSION_REQUIRED'; END IF;
  ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SOURCE_RESOURCE_ACCESS_VERSION_REQUIRED'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END;
$$;
CREATE TRIGGER source_resource_access_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_resource_access
  FOR EACH ROW EXECUTE FUNCTION guard_source_resource_access();
CREATE FUNCTION record_source_binding_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_binding_history (binding_id,version,actor_user_id,snapshot,reason)
    VALUES (NEW.id,NEW.version,NEW.updated_by,jsonb_build_object('connectionId',NEW.connection_id,'resourceId',NEW.resource_id,
      'campaignId',NEW.campaign_id,'externalCampaignId',NEW.external_campaign_id,'externalAdSetId',NEW.external_adset_id,
      'externalAdId',NEW.external_ad_id,'active',NEW.active,'connectionVersion',NEW.connection_version),NEW.change_reason);
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_binding_history_record AFTER INSERT OR UPDATE ON source_campaign_binding
  FOR EACH ROW EXECUTE FUNCTION record_source_binding_history();
CREATE FUNCTION record_source_resource_access_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_resource_access_history (resource_id,branch_id,version,actor_user_id,active,reason)
    VALUES (NEW.resource_id,NEW.branch_id,NEW.version,NEW.updated_by,NEW.active,NEW.change_reason);
  IF NOT NEW.active THEN
    UPDATE source_campaign_binding b SET active=false,version=b.version+1,updated_by=NEW.updated_by,
      change_reason='SOURCE_RESOURCE_ACCESS_REVOKED'
      FROM campaign c WHERE b.campaign_id=c.id AND c.branch_id=NEW.branch_id AND b.resource_id=NEW.resource_id AND b.active;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_resource_access_history_record AFTER INSERT OR UPDATE ON source_resource_access
  FOR EACH ROW EXECUTE FUNCTION record_source_resource_access_history();
CREATE FUNCTION retain_source_configuration_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SOURCE_CONFIGURATION_HISTORY_IMMUTABLE'; END;
$$;
CREATE TRIGGER source_binding_history_immutable BEFORE UPDATE OR DELETE ON source_binding_history
  FOR EACH ROW EXECUTE FUNCTION retain_source_configuration_history();
CREATE TRIGGER source_resource_access_history_immutable BEFORE UPDATE OR DELETE ON source_resource_access_history
  FOR EACH ROW EXECUTE FUNCTION retain_source_configuration_history();
