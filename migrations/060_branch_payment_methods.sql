CREATE TABLE payment_method (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  branch_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  currencies jsonb NOT NULL CHECK(jsonb_typeof(currencies)='array' AND jsonb_array_length(currencies) BETWEEN 1 AND 32),
  active boolean NOT NULL DEFAULT false,
  agent_mode text NOT NULL CHECK(agent_mode IN ('ALL','SELECTED')),
  agent_ids jsonb NOT NULL CHECK(jsonb_typeof(agent_ids)='array' AND jsonb_array_length(agent_ids)<=200),
  campaign_mode text NOT NULL CHECK(campaign_mode IN ('ALL','SELECTED')),
  campaign_ids jsonb NOT NULL CHECK(jsonb_typeof(campaign_ids)='array' AND jsonb_array_length(campaign_ids)<=200),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by uuid NOT NULL REFERENCES user_account(id),
  change_reason text NOT NULL CHECK(length(trim(change_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branch(id,organization_id),
  FOREIGN KEY(connection_id,organization_id) REFERENCES integration_connection(id,organization_id),
  UNIQUE(id,organization_id),
  CHECK((agent_mode='ALL' AND agent_ids='[]'::jsonb) OR (agent_mode='SELECTED' AND jsonb_array_length(agent_ids)>0)),
  CHECK((campaign_mode='ALL' AND campaign_ids='[]'::jsonb) OR (campaign_mode='SELECTED' AND jsonb_array_length(campaign_ids)>0))
);
CREATE INDEX payment_method_scope_cursor_idx ON payment_method(organization_id,branch_id,created_at DESC,id DESC);
CREATE INDEX payment_method_connection_idx ON payment_method(connection_id);
CREATE INDEX payment_method_operational_idx ON payment_method(branch_id,created_at DESC,id DESC) WHERE active;
CREATE TABLE payment_method_history (
  method_id uuid NOT NULL REFERENCES payment_method(id),
  version integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(method_id,version)
);
CREATE FUNCTION guard_payment_method() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_role text; connection_branch uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_METHOD_HISTORY_RETAINED'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.organization_id,NEW.branch_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.created_at)
    OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'PAYMENT_METHOD_IDENTITY_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 THEN RAISE EXCEPTION 'PAYMENT_METHOD_VERSION_INVALID'; END IF;
  SELECT u.role INTO actor_role FROM user_account u WHERE u.id=NEW.updated_by AND u.active AND u.organization_id=NEW.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=NEW.branch_id));
  IF actor_role IS NULL THEN RAISE EXCEPTION 'PAYMENT_METHOD_ACTOR_INVALID'; END IF;
  SELECT c.branch_id INTO connection_branch FROM integration_connection c WHERE c.id=NEW.connection_id AND c.organization_id=NEW.organization_id AND c.kind='PAYMENT';
  IF NOT FOUND OR (connection_branch IS NOT NULL AND connection_branch<>NEW.branch_id) THEN RAISE EXCEPTION 'PAYMENT_METHOD_CONNECTION_SCOPE_INVALID'; END IF;
  IF connection_branch IS NULL AND actor_role<>'SUPER_ADMIN' AND (TG_OP='INSERT' OR NEW.connection_id IS DISTINCT FROM OLD.connection_id)
    THEN RAISE EXCEPTION 'PAYMENT_SHARED_METHOD_BINDING_FORBIDDEN'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.agent_ids) x(id) WHERE NOT EXISTS(SELECT 1 FROM user_account u
    WHERE u.id=x.id::uuid AND u.organization_id=NEW.organization_id AND u.branch_id=NEW.branch_id AND u.role='AGENT'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.campaign_ids) x(id) WHERE NOT EXISTS(SELECT 1 FROM campaign c
      WHERE c.id=x.id::uuid AND c.organization_id=NEW.organization_id AND c.branch_id=NEW.branch_id)) THEN RAISE EXCEPTION 'PAYMENT_METHOD_AVAILABILITY_SCOPE_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.currencies) x(code) WHERE x.code !~ '^[A-Z]{3}$')
    OR (SELECT count(DISTINCT code) FROM jsonb_array_elements_text(NEW.currencies) x(code))<>jsonb_array_length(NEW.currencies)
    OR (SELECT count(DISTINCT id::uuid) FROM jsonb_array_elements_text(NEW.agent_ids) x(id))<>jsonb_array_length(NEW.agent_ids)
    OR (SELECT count(DISTINCT id::uuid) FROM jsonb_array_elements_text(NEW.campaign_ids) x(id))<>jsonb_array_length(NEW.campaign_ids)
      THEN RAISE EXCEPTION 'PAYMENT_METHOD_VALUES_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_method_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_method FOR EACH ROW EXECUTE FUNCTION guard_payment_method();
CREATE FUNCTION record_payment_method_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payment_method_history(method_id,version,actor_user_id,reason,snapshot) VALUES(NEW.id,NEW.version,NEW.updated_by,NEW.change_reason,
    jsonb_build_object('name',NEW.name,'branchId',NEW.branch_id,'connectionId',NEW.connection_id,'currencies',NEW.currencies,'active',NEW.active,
      'agents',jsonb_build_object('mode',NEW.agent_mode,'ids',NEW.agent_ids),'campaigns',jsonb_build_object('mode',NEW.campaign_mode,'ids',NEW.campaign_ids)));
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_method_history_record AFTER INSERT OR UPDATE ON payment_method FOR EACH ROW EXECUTE FUNCTION record_payment_method_history();
CREATE FUNCTION guard_payment_method_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM payment_method m WHERE m.id=NEW.method_id AND m.version=NEW.version
    AND m.updated_by=NEW.actor_user_id AND m.change_reason=NEW.reason AND NEW.snapshot=jsonb_build_object('name',m.name,'branchId',m.branch_id,
      'connectionId',m.connection_id,'currencies',m.currencies,'active',m.active,'agents',jsonb_build_object('mode',m.agent_mode,'ids',m.agent_ids),
      'campaigns',jsonb_build_object('mode',m.campaign_mode,'ids',m.campaign_ids))) THEN RAISE EXCEPTION 'PAYMENT_METHOD_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_method_history_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_method_history FOR EACH ROW EXECUTE FUNCTION guard_payment_method_history();
