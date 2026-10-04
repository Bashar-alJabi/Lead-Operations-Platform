CREATE TABLE source_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  resource_kind text NOT NULL CHECK (resource_kind IN ('PAGE','FORM')),
  parent_id uuid,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,30}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  provider_status text,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=100),
  connection_version integer NOT NULL CHECK (connection_version>0),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id,resource_kind,external_id),
  UNIQUE (id,connection_id),
  FOREIGN KEY (parent_id,connection_id) REFERENCES source_resource(id,connection_id),
  CHECK ((resource_kind='PAGE' AND parent_id IS NULL AND questions='[]'::jsonb) OR (resource_kind='FORM' AND parent_id IS NOT NULL))
);
CREATE INDEX source_resource_catalog_idx ON source_resource (connection_id,resource_kind,parent_id,id);
CREATE TABLE source_resource_secret (
  resource_id uuid PRIMARY KEY REFERENCES source_resource(id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_resource_sync (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK (connection_version>0),
  resource_kind text NOT NULL CHECK (resource_kind IN ('PAGE','FORM')),
  parent_id uuid,
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','SUPERSEDED')),
  lease_until timestamptz NOT NULL,
  resource_count integer CHECK (resource_count BETWEEN 0 AND 1000),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (parent_id,connection_id) REFERENCES source_resource(id,connection_id),
  CHECK ((resource_kind='PAGE' AND parent_id IS NULL) OR (resource_kind='FORM' AND parent_id IS NOT NULL)),
  CHECK ((state='RUNNING' AND finished_at IS NULL) OR (state<>'RUNNING' AND finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX source_resource_sync_running_idx ON source_resource_sync (connection_id) WHERE state='RUNNING';
CREATE INDEX source_resource_sync_history_idx ON source_resource_sync (connection_id,started_at DESC,id DESC);
CREATE FUNCTION guard_source_resource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.connection_id,NEW.resource_kind,NEW.external_id,NEW.parent_id)
    IS DISTINCT FROM (OLD.connection_id,OLD.resource_kind,OLD.external_id,OLD.parent_id)
    THEN RAISE EXCEPTION 'SOURCE_RESOURCE_IDENTITY_IMMUTABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM integration_connection WHERE id=NEW.connection_id AND kind IN ('META','GENERIC_SOURCE'))
    THEN RAISE EXCEPTION 'SOURCE_CONNECTION_REQUIRED'; END IF;
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_resource
    WHERE id=NEW.parent_id AND connection_id=NEW.connection_id AND resource_kind='PAGE')
    THEN RAISE EXCEPTION 'SOURCE_PARENT_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_resource_integrity BEFORE INSERT OR UPDATE ON source_resource
  FOR EACH ROW EXECUTE FUNCTION guard_source_resource();
CREATE FUNCTION guard_source_resource_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source_resource WHERE id=NEW.resource_id AND resource_kind='PAGE')
    THEN RAISE EXCEPTION 'SOURCE_PAGE_SECRET_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_resource_secret_integrity BEFORE INSERT OR UPDATE ON source_resource_secret
  FOR EACH ROW EXECUTE FUNCTION guard_source_resource_secret();
