CREATE FUNCTION ai_operational_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE entry record;l jsonb;BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>5 OR NOT d ?& ARRAY['profiles','language','tone','handoffTargetId','handoffSlaMinutes']
    OR jsonb_typeof(d->'profiles') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'profiles'))<>4 OR NOT (d->'profiles') ?& ARRAY['CONVERSATION','SUMMARIZATION','CLASSIFICATION','ANALYSIS'] THEN RETURN false;END IF;
  FOR entry IN SELECT * FROM jsonb_each(d->'profiles') LOOP
    IF entry.value<>'null'::jsonb AND (jsonb_typeof(entry.value)<>'string' OR entry.value#>>'{}' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN RETURN false;END IF;
  END LOOP;
  l=d->'language';IF l<>'null'::jsonb THEN
    IF jsonb_typeof(l)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(l))<>3 OR NOT l ?& ARRAY['supported','preferred','detect']
      OR jsonb_typeof(l->'supported')<>'array' OR jsonb_array_length(l->'supported') NOT BETWEEN 1 AND 10 OR jsonb_typeof(l->'preferred')<>'string' OR jsonb_typeof(l->'detect')<>'boolean' THEN RETURN false;END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(l->'supported') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}')>35 OR item#>>'{}' !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
      OR (SELECT count(DISTINCT item#>>'{}') FROM jsonb_array_elements(l->'supported') item)<>jsonb_array_length(l->'supported') OR NOT (l->'supported') ? (l->>'preferred') THEN RETURN false;END IF;
  END IF;
  IF d->'tone'<>'null'::jsonb AND (jsonb_typeof(d->'tone')<>'string' OR length(d->>'tone')>2000 OR translate(d->>'tone',E'\n\r\t','') ~ '[[:cntrl:]]')
    OR d->'handoffTargetId'<>'null'::jsonb AND (jsonb_typeof(d->'handoffTargetId')<>'string' OR d->>'handoffTargetId' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    OR d->'handoffSlaMinutes'<>'null'::jsonb AND (jsonb_typeof(d->'handoffSlaMinutes')<>'number' OR d->>'handoffSlaMinutes' !~ '^[0-9]+$' OR (d->>'handoffSlaMinutes')::bigint NOT BETWEEN 1 AND 2147483647) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION ai_operational_profile_usable(bid uuid,pid uuid,task_name text) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE p record;b record;BEGIN
  SELECT id,organization_id,active INTO b FROM branch WHERE id=bid;IF NOT FOUND OR NOT b.active THEN RETURN false;END IF;
  SELECT pr.branch_id,c.id AS connection_id INTO p FROM ai_model_profile pr JOIN integration_connection c ON c.id=pr.connection_id
    WHERE pr.id=pid AND pr.organization_id=b.organization_id AND c.organization_id=b.organization_id AND c.kind='AI'
    AND pr.task=task_name AND pr.active AND c.status='CONNECTED' AND c.capabilities->>'catalogVersion'=c.version::text AND c.capabilities->'models' ? pr.model_id
    AND (pr.branch_id=bid AND c.branch_id=bid OR pr.branch_id IS NULL AND c.branch_id IS NULL) FOR SHARE OF pr,c;
  IF NOT FOUND THEN RETURN false;END IF;
  IF p.branch_id IS NULL THEN PERFORM 1 FROM ai_connection_branch_use WHERE connection_id=p.connection_id AND branch_id=bid AND active FOR SHARE;RETURN FOUND;END IF;
  RETURN true;END $$;
CREATE TABLE ai_operational_config (
  scope text NOT NULL CHECK(scope IN ('BRANCH','CAMPAIGN')),resource_id uuid NOT NULL,branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid REFERENCES campaign(id),
  version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_operational_valid(definition)),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id),
  CHECK(scope='BRANCH' AND campaign_id IS NULL AND resource_id=branch_id OR scope='CAMPAIGN' AND campaign_id IS NOT NULL AND resource_id=campaign_id)
);
CREATE INDEX ai_operational_branch_scope ON ai_operational_config(branch_id,scope,resource_id);
CREATE TABLE ai_operational_history (
  scope text NOT NULL,resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id,version),
  FOREIGN KEY(scope,resource_id) REFERENCES ai_operational_config(scope,resource_id)
);
CREATE FUNCTION guard_ai_operational_config() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE entry record;BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_OPERATIONAL_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM branch WHERE id=NEW.branch_id FOR SHARE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.scope,NEW.resource_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.branch_id,OLD.campaign_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'AI_OPERATIONAL_VERSION_REQUIRED';END IF;
  IF NOT EXISTS(SELECT 1 FROM branch b JOIN user_account u ON u.id=NEW.actor_id JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id
    WHERE b.id=NEW.branch_id AND b.active AND u.organization_id=b.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id)
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND (NEW.campaign_id IS NULL OR EXISTS(SELECT 1 FROM campaign c WHERE c.id=NEW.campaign_id AND c.branch_id=b.id AND c.organization_id=b.organization_id))) THEN RAISE EXCEPTION 'AI_OPERATIONAL_CURRENT_ACCESS_REQUIRED';END IF;
  IF NOT ai_operational_valid(NEW.definition) THEN RAISE EXCEPTION 'AI_OPERATIONAL_INVALID';END IF;
  FOR entry IN SELECT * FROM jsonb_each(NEW.definition->'profiles') LOOP
    IF entry.value<>'null'::jsonb AND NOT ai_operational_profile_usable(NEW.branch_id,(entry.value#>>'{}')::uuid,entry.key) THEN RAISE EXCEPTION 'AI_OPERATIONAL_CURRENT_PROFILE_REQUIRED';END IF;
  END LOOP;
  IF NEW.definition->'handoffTargetId'<>'null'::jsonb THEN
    PERFORM 1 FROM user_account WHERE id=(NEW.definition->>'handoffTargetId')::uuid AND branch_id=NEW.branch_id AND active AND role IN ('AGENT','MANAGER') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AI_OPERATIONAL_CURRENT_TARGET_REQUIRED';END IF;
  END IF;NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_operational_config_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_operational_config FOR EACH ROW EXECUTE FUNCTION guard_ai_operational_config();
CREATE FUNCTION guard_ai_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_operational_config c WHERE c.scope=NEW.scope AND c.resource_id=NEW.resource_id AND c.version=NEW.version AND to_jsonb(c)=NEW.snapshot) THEN RAISE EXCEPTION 'AI_OPERATIONAL_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_operational_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_operational_history FOR EACH ROW EXECUTE FUNCTION guard_ai_operational_history();
CREATE FUNCTION record_ai_operational_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_operational_history(scope,resource_id,version,snapshot) VALUES(NEW.scope,NEW.resource_id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT b.organization_id,b.id,NEW.actor_id,'AI_OPERATIONAL_CONFIGURED',NEW.scope,NEW.resource_id,
    jsonb_build_object('version',NEW.version,'scope',NEW.scope,'reason',NEW.reason) FROM branch b WHERE b.id=NEW.branch_id;RETURN NEW;END $$;
CREATE TRIGGER ai_operational_config_record AFTER INSERT OR UPDATE ON ai_operational_config FOR EACH ROW EXECUTE FUNCTION record_ai_operational_config();
