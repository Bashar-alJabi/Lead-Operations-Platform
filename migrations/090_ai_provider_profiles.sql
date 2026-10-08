CREATE TABLE ai_connection_revision (
  connection_id uuid NOT NULL REFERENCES integration_connection(id),version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  name text NOT NULL,status text NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  secret_changed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(connection_id,version)
);
CREATE FUNCTION guard_ai_connection_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.kind,NEW.provider,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.kind,OLD.provider,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'AI_CONNECTION_IDENTITY_IMMUTABLE'; END IF;RETURN NEW; END $$;
CREATE TRIGGER ai_connection_identity_guard BEFORE UPDATE ON integration_connection FOR EACH ROW WHEN(OLD.kind='AI' OR NEW.kind='AI') EXECUTE FUNCTION guard_ai_connection_identity();
CREATE FUNCTION guard_ai_connection_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_CONFIGURATION_HISTORY_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_id JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id
    WHERE c.id=NEW.connection_id AND c.kind='AI' AND c.version=NEW.version AND c.name=NEW.name AND c.status=NEW.status
    AND c.organization_id=u.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AI_CURRENT_CONFIGURATION_ACCESS_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER ai_connection_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_connection_revision FOR EACH ROW EXECUTE FUNCTION guard_ai_connection_revision();
CREATE TABLE ai_connection_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN ('RUNNING','VERIFIED','FAILED','SUPERSEDED')),
  models jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 seconds',finished_at timestamptz,
  CHECK((state='RUNNING')=(finished_at IS NULL)),CHECK((state='VERIFIED')=(models IS NOT NULL)),
  CHECK(models IS NULL OR (jsonb_typeof(models)='array' AND jsonb_array_length(models)<=2000))
);
CREATE UNIQUE INDEX ai_connection_probe_running_idx ON ai_connection_probe(connection_id) WHERE state='RUNNING';
CREATE INDEX ai_probe_history_idx ON ai_connection_probe(connection_id,created_at DESC,id DESC);
CREATE FUNCTION guard_ai_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.state<>'RUNNING' OR NEW.state='RUNNING' OR
    (NEW.id,NEW.connection_id,NEW.connection_version,NEW.actor_id,NEW.session_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.connection_version,OLD.actor_id,OLD.session_id,OLD.created_at,OLD.expires_at))) THEN RAISE EXCEPTION 'AI_PROBE_HISTORY_IMMUTABLE'; END IF;
  IF (TG_OP='INSERT' OR NEW.state='VERIFIED') AND NOT EXISTS(SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_id
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id LEFT JOIN branch b ON b.id=c.branch_id
    WHERE c.id=NEW.connection_id AND c.kind='AI' AND c.version=NEW.connection_version AND c.status<>'DISABLED' AND (c.branch_id IS NULL OR b.active)
    AND c.organization_id=u.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND NEW.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AI_PROBE_CURRENT_ACCESS_REQUIRED'; END IF;
  IF TG_OP='INSERT' AND NEW.state<>'RUNNING' THEN RAISE EXCEPTION 'AI_PROBE_CLAIM_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER ai_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_connection_probe FOR EACH ROW EXECUTE FUNCTION guard_ai_probe();
CREATE TABLE ai_model_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),connection_id uuid NOT NULL REFERENCES integration_connection(id),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid REFERENCES branch(id),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),task text NOT NULL CHECK(task IN ('CONVERSATION','SUMMARIZATION','CLASSIFICATION','ANALYSIS')),
  model_id text NOT NULL CHECK(model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 128 AND 16384),
  active boolean NOT NULL,version integer NOT NULL DEFAULT 1,actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_profile_scope_idx ON ai_model_profile(organization_id,branch_id,created_at DESC,id DESC);
CREATE TABLE ai_profile_history (
  profile_id uuid NOT NULL REFERENCES ai_model_profile(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(profile_id,version)
);
CREATE FUNCTION guard_ai_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_PROFILE_HISTORY_RETAINED'; END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.id,NEW.connection_id,NEW.organization_id,NEW.branch_id,NEW.task,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.branch_id,OLD.task,OLD.created_at) OR NEW.version<>OLD.version+1)
    THEN RAISE EXCEPTION 'AI_PROFILE_IDENTITY_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_connection c JOIN user_account u ON u.id=NEW.actor_id JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id
    LEFT JOIN branch b ON b.id=c.branch_id WHERE c.id=NEW.connection_id AND c.kind='AI' AND c.organization_id=NEW.organization_id AND c.branch_id IS NOT DISTINCT FROM NEW.branch_id
    AND u.organization_id=c.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND (NOT NEW.active OR (c.status='CONNECTED' AND (c.branch_id IS NULL OR b.active) AND EXISTS(SELECT 1 FROM ai_connection_probe p
      WHERE p.connection_id=c.id AND p.connection_version=c.version AND p.state='VERIFIED' AND p.models ? NEW.model_id
        AND c.capabilities->>'catalogVersion'=c.version::text AND c.capabilities->'models' ? NEW.model_id)))) THEN RAISE EXCEPTION 'AI_PROFILE_CURRENT_CATALOG_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER ai_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_model_profile FOR EACH ROW EXECUTE FUNCTION guard_ai_profile();
CREATE FUNCTION record_ai_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_profile_history(profile_id,version,snapshot) VALUES(NEW.id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'AI_PROFILE_CONFIGURED','AI_PROFILE',NEW.id,jsonb_build_object('version',NEW.version,'task',NEW.task,'model',NEW.model_id,'active',NEW.active,'reason',NEW.reason));
  RETURN NEW; END $$;
CREATE TRIGGER ai_profile_record AFTER INSERT OR UPDATE ON ai_model_profile FOR EACH ROW EXECUTE FUNCTION record_ai_profile();
CREATE FUNCTION guard_ai_profile_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_model_profile p WHERE p.id=NEW.profile_id AND p.version=NEW.version AND to_jsonb(p)=NEW.snapshot)
    THEN RAISE EXCEPTION 'AI_PROFILE_HISTORY_IMMUTABLE'; END IF;RETURN NEW; END $$;
CREATE TRIGGER ai_profile_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_profile_history FOR EACH ROW EXECUTE FUNCTION guard_ai_profile_history();
