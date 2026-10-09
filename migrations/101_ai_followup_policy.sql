CREATE FUNCTION ai_followup_policy_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE delay jsonb;BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>5 OR NOT d ?& ARRAY['enabled','initialDelaySeconds','delaysSeconds','stopOnReply','finalAction']
    OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'stopOnReply') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(d->'initialDelaySeconds') IS DISTINCT FROM 'number' OR d->>'initialDelaySeconds' !~ '^[0-9]+$' OR (d->>'initialDelaySeconds')::bigint NOT BETWEEN 0 AND 2147483647
    OR jsonb_typeof(d->'delaysSeconds') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'delaysSeconds')>40
    OR jsonb_typeof(d->'finalAction') IS DISTINCT FROM 'string' OR d->>'finalAction' NOT IN ('COMPLETE','HANDOFF')
    OR d->>'enabled'='true' AND jsonb_array_length(d->'delaysSeconds')=0 THEN RETURN false;END IF;
  FOR delay IN SELECT jsonb_array_elements(d->'delaysSeconds') LOOP
    IF jsonb_typeof(delay)<>'number' OR delay#>>'{}' !~ '^[0-9]+$' OR (delay#>>'{}')::bigint NOT BETWEEN 1 AND 2147483647 THEN RETURN false;END IF;
  END LOOP;RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_followup_policy (
  campaign_id uuid PRIMARY KEY REFERENCES campaign(id),version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_followup_policy_valid(definition)),
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_followup_policy_history (
  campaign_id uuid NOT NULL REFERENCES campaign(id),version integer NOT NULL,definition jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES user_account(id),
  session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(campaign_id,version)
);
CREATE FUNCTION guard_ai_followup_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_FOLLOWUP_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'AI_FOLLOWUP_VERSION_REQUIRED';END IF;
  IF NOT ai_knowledge_manager_access(NEW.campaign_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'AI_FOLLOWUP_CURRENT_ACCESS_REQUIRED';END IF;
  IF NOT ai_followup_policy_valid(NEW.definition) THEN RAISE EXCEPTION 'AI_FOLLOWUP_INVALID';END IF;
  NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_followup_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_policy FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_policy();
CREATE FUNCTION guard_ai_followup_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_followup_policy p WHERE p.campaign_id=NEW.campaign_id AND
    (p.version,p.definition,p.actor_id,p.session_id,p.reason,p.updated_at) IS NOT DISTINCT FROM (NEW.version,NEW.definition,NEW.actor_id,NEW.session_id,NEW.reason,NEW.created_at)) THEN RAISE EXCEPTION 'AI_FOLLOWUP_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_followup_policy_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_policy_history FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_policy_history();
CREATE FUNCTION record_ai_followup_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_followup_policy_history VALUES(NEW.campaign_id,NEW.version,NEW.definition,NEW.actor_id,NEW.session_id,NEW.reason,NEW.updated_at);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT c.organization_id,c.branch_id,NEW.actor_id,'AI_FOLLOWUP_POLICY_CONFIGURED','CAMPAIGN',c.id,
    jsonb_build_object('version',NEW.version,'enabled',NEW.definition->'enabled','maxAttempts',jsonb_array_length(NEW.definition->'delaysSeconds'),'reason',NEW.reason) FROM campaign c WHERE c.id=NEW.campaign_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_followup_policy_record AFTER INSERT OR UPDATE ON ai_followup_policy FOR EACH ROW EXECUTE FUNCTION record_ai_followup_policy();
