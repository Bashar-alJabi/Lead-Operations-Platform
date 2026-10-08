CREATE FUNCTION ai_qualification_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE q jsonb;r jsonb;rules jsonb;BEGIN
  IF jsonb_typeof(d)<>'object' OR octet_length(d::text)>65536 OR (SELECT count(*) FROM jsonb_object_keys(d))<>4 OR NOT d ?& ARRAY['enabled','questions','completion','handoff']
    OR jsonb_typeof(d->'enabled')<>'boolean' OR jsonb_typeof(d->'questions')<>'array' OR jsonb_array_length(d->'questions')>40 THEN RETURN false;END IF;
  FOR q IN SELECT jsonb_array_elements(d->'questions') LOOP
    IF jsonb_typeof(q)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(q))<>4 OR NOT q ?& ARRAY['id','prompt','fieldId','required']
      OR jsonb_typeof(q->'id')<>'string' OR (q->>'id') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      OR jsonb_typeof(q->'prompt')<>'string' OR length(trim(q->>'prompt')) NOT BETWEEN 1 AND 500 OR (q->>'prompt') ~ '[[:cntrl:]]'
      OR jsonb_typeof(q->'required')<>'boolean' OR NOT (q->'fieldId'='null'::jsonb OR jsonb_typeof(q->'fieldId')='string' AND (q->>'fieldId') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN RETURN false;END IF;
  END LOOP;
  IF (SELECT count(DISTINCT q->>'id') FROM jsonb_array_elements(d->'questions') q)<>jsonb_array_length(d->'questions') THEN RETURN false;END IF;
  IF jsonb_typeof(d->'completion')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'completion'))<>3 OR NOT (d->'completion') ?& ARRAY['mode','match','conditions']
    OR jsonb_typeof(d->'completion'->'mode')<>'string' OR jsonb_typeof(d->'completion'->'match')<>'string'
    OR d->'completion'->>'mode' NOT IN ('ALL_REQUIRED','CONDITIONS') OR d->'completion'->>'match' NOT IN ('ALL','ANY')
    OR jsonb_typeof(d->'handoff')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'handoff'))<>3 OR NOT (d->'handoff') ?& ARRAY['onCompletion','match','conditions']
    OR jsonb_typeof(d->'handoff'->'onCompletion')<>'boolean' OR jsonb_typeof(d->'handoff'->'match')<>'string' OR d->'handoff'->>'match' NOT IN ('ALL','ANY') THEN RETURN false;END IF;
  FOR rules IN SELECT d->'completion'->'conditions' UNION ALL SELECT d->'handoff'->'conditions' LOOP
    IF jsonb_typeof(rules)<>'array' OR jsonb_array_length(rules)>40 THEN RETURN false;END IF;
    FOR r IN SELECT jsonb_array_elements(rules) LOOP
      IF jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>3 OR NOT r ?& ARRAY['questionId','operator','value']
        OR jsonb_typeof(r->'operator')<>'string' OR jsonb_typeof(r->'questionId')<>'string' OR r->>'operator' NOT IN ('ANSWERED','EQUALS') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') q WHERE q->>'id'=r->>'questionId')
        OR octet_length((r->'value')::text)>4096 OR r->>'operator'='ANSWERED' AND r->'value'<>'null'::jsonb OR r->>'operator'='EQUALS' AND r->'value'='null'::jsonb THEN RETURN false;END IF;
    END LOOP;
  END LOOP;
  IF d->'completion'->>'mode'='ALL_REQUIRED' AND (jsonb_array_length(d->'completion'->'conditions')<>0 OR d->'completion'->>'match'<>'ALL') THEN RETURN false;END IF;
  IF (d->>'enabled')::boolean AND (jsonb_array_length(d->'questions')=0 OR d->'completion'->>'mode'='ALL_REQUIRED' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') q WHERE (q->>'required')::boolean)
    OR d->'completion'->>'mode'='CONDITIONS' AND jsonb_array_length(d->'completion'->'conditions')=0) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_qualification_config (
  campaign_id uuid PRIMARY KEY REFERENCES campaign(id),version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_qualification_valid(definition)),
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_qualification_history (
  campaign_id uuid NOT NULL REFERENCES campaign(id),version integer NOT NULL,definition jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES user_account(id),
  session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(campaign_id,version)
);
CREATE FUNCTION guard_ai_qualification_config() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q jsonb;BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'QUALIFICATION_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'QUALIFICATION_VERSION_CONFLICT';END IF;
  IF NOT ai_knowledge_manager_access(NEW.campaign_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
  FOR q IN SELECT jsonb_array_elements(NEW.definition->'questions') LOOP
    IF q->'fieldId'<>'null'::jsonb THEN
      PERFORM 1 FROM campaign c JOIN campaign_field cf ON cf.campaign_id=c.id JOIN field_definition f ON f.id=cf.field_id JOIN user_account u ON u.id=NEW.actor_id
        WHERE c.id=NEW.campaign_id AND f.id=(q->>'fieldId')::uuid AND f.organization_id=c.organization_id AND cf.active AND f.active AND cf.usable_by_ai AND f.value_mode='MANUAL'
        AND (f.branch_id IS NULL OR f.branch_id=c.branch_id) AND (f.campaign_id IS NULL OR f.campaign_id=c.id) AND (u.role='SUPER_ADMIN' OR cf.visible_to_manager) FOR SHARE OF cf,f;
      IF NOT FOUND THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_FIELD_REQUIRED';END IF;
    END IF;
  END LOOP;RETURN NEW;END $$;
CREATE TRIGGER ai_qualification_config_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_qualification_config FOR EACH ROW EXECUTE FUNCTION guard_ai_qualification_config();
CREATE FUNCTION guard_ai_qualification_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_qualification_config c WHERE c.campaign_id=NEW.campaign_id AND
    (c.version,c.definition,c.actor_id,c.session_id,c.reason,c.updated_at) IS NOT DISTINCT FROM (NEW.version,NEW.definition,NEW.actor_id,NEW.session_id,NEW.reason,NEW.created_at))
    THEN RAISE EXCEPTION 'QUALIFICATION_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_qualification_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_qualification_history FOR EACH ROW EXECUTE FUNCTION guard_ai_qualification_history();
CREATE FUNCTION record_ai_qualification_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_qualification_history VALUES(NEW.campaign_id,NEW.version,NEW.definition,NEW.actor_id,NEW.session_id,NEW.reason,NEW.updated_at);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,c.branch_id,NEW.actor_id,'AI_QUALIFICATION_CONFIGURED','CAMPAIGN',c.id,
      jsonb_build_object('version',NEW.version,'enabled',NEW.definition->'enabled','questionCount',jsonb_array_length(NEW.definition->'questions'),'reason',NEW.reason) FROM campaign c WHERE c.id=NEW.campaign_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_qualification_config_record AFTER INSERT OR UPDATE ON ai_qualification_config FOR EACH ROW EXECUTE FUNCTION record_ai_qualification_config();
