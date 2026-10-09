CREATE FUNCTION ai_behavior_policy_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE v jsonb;BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>4 OR NOT d ?& ARRAY['formality','disclosure','handoff','returningContact'] THEN RETURN false;END IF;
  v=d->'formality';IF v<>'null'::jsonb AND (jsonb_typeof(v)<>'string' OR length(v#>>'{}')>1000 OR translate(v#>>'{}',E'\n\r\t','') ~ '[[:cntrl:]]') THEN RETURN false;END IF;
  v=d->'disclosure';IF v<>'null'::jsonb THEN
    IF jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>2 OR NOT v ?& ARRAY['mode','text'] OR v->>'mode' NOT IN ('FIRST_AI_MESSAGE','EVERY_AI_MESSAGE') OR jsonb_typeof(v->'mode')<>'string'
      OR jsonb_typeof(v->'text')<>'string' OR length(trim(v->>'text')) NOT BETWEEN 3 AND 2000 OR translate(v->>'text',E'\n\r\t','') ~ '[[:cntrl:]]' THEN RETURN false;END IF;
  END IF;
  v=d->'handoff';IF v<>'null'::jsonb THEN
    IF jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>3 OR NOT v ?& ARRAY['initialContactWithoutAgent','transitionMessage','misunderstandingLimit'] OR jsonb_typeof(v->'initialContactWithoutAgent')<>'boolean'
      OR v->'transitionMessage'<>'null'::jsonb AND (jsonb_typeof(v->'transitionMessage')<>'string' OR length(trim(v->>'transitionMessage')) NOT BETWEEN 3 AND 2000 OR translate(v->>'transitionMessage',E'\n\r\t','') ~ '[[:cntrl:]]')
      OR v->'misunderstandingLimit'<>'null'::jsonb AND (jsonb_typeof(v->'misunderstandingLimit')<>'number' OR v->>'misunderstandingLimit' !~ '^[0-9]+$' OR (v->>'misunderstandingLimit')::bigint NOT BETWEEN 1 AND 2147483647) THEN RETURN false;END IF;
  END IF;
  v=d->'returningContact';IF v<>'null'::jsonb THEN
    IF jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>2 OR NOT v ?& ARRAY['closedConversation','closedLead'] OR jsonb_typeof(v->'closedConversation')<>'string' OR v->>'closedConversation' NOT IN ('REVIEW','REOPEN_EXISTING')
      OR jsonb_typeof(v->'closedLead')<>'string' OR v->>'closedLead' NOT IN ('REVIEW','REOPEN_EXISTING','CREATE_NEW') THEN RETURN false;END IF;
  END IF;
  RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_behavior_policy (
  scope text NOT NULL CHECK(scope IN ('BRANCH','CAMPAIGN')),resource_id uuid NOT NULL,branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid REFERENCES campaign(id),
  version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_behavior_policy_valid(definition)),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id),
  CHECK(scope='BRANCH' AND campaign_id IS NULL AND resource_id=branch_id AND definition->'returningContact'='null'::jsonb OR scope='CAMPAIGN' AND campaign_id IS NOT NULL AND resource_id=campaign_id)
);
CREATE INDEX ai_behavior_branch_scope ON ai_behavior_policy(branch_id,scope,resource_id);
CREATE TABLE ai_behavior_policy_history (
  scope text NOT NULL,resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,resource_id,version),
  FOREIGN KEY(scope,resource_id) REFERENCES ai_behavior_policy(scope,resource_id)
);
CREATE FUNCTION guard_ai_behavior_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_BEHAVIOR_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM branch WHERE id=NEW.branch_id AND active FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'AI_BEHAVIOR_CURRENT_ACCESS_REQUIRED';END IF;
  IF NEW.campaign_id IS NOT NULL THEN PERFORM 1 FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.id=NEW.campaign_id AND c.branch_id=NEW.branch_id AND c.organization_id=b.organization_id FOR SHARE OF c;
    IF NOT FOUND THEN RAISE EXCEPTION 'AI_BEHAVIOR_CURRENT_ACCESS_REQUIRED';END IF;END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.scope,NEW.resource_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.branch_id,OLD.campaign_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'AI_BEHAVIOR_VERSION_REQUIRED';END IF;
  PERFORM 1 FROM user_account u JOIN user_session s ON s.user_id=u.id JOIN branch b ON b.id=NEW.branch_id
    WHERE u.id=NEW.actor_id AND s.id=NEW.session_id AND u.organization_id=b.organization_id AND u.active AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_BEHAVIOR_CURRENT_ACCESS_REQUIRED';END IF;
  IF NOT ai_behavior_policy_valid(NEW.definition) OR NEW.scope='BRANCH' AND NEW.definition->'returningContact'<>'null'::jsonb THEN RAISE EXCEPTION 'AI_BEHAVIOR_INVALID';END IF;
  NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_behavior_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_behavior_policy FOR EACH ROW EXECUTE FUNCTION guard_ai_behavior_policy();
CREATE FUNCTION guard_ai_behavior_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_behavior_policy c WHERE c.scope=NEW.scope AND c.resource_id=NEW.resource_id AND c.version=NEW.version AND to_jsonb(c)=NEW.snapshot) THEN RAISE EXCEPTION 'AI_BEHAVIOR_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_behavior_policy_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_behavior_policy_history FOR EACH ROW EXECUTE FUNCTION guard_ai_behavior_policy_history();
CREATE FUNCTION record_ai_behavior_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_behavior_policy_history(scope,resource_id,version,snapshot) VALUES(NEW.scope,NEW.resource_id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT b.organization_id,b.id,NEW.actor_id,'AI_BEHAVIOR_POLICY_CONFIGURED',NEW.scope,NEW.resource_id,
    jsonb_build_object('version',NEW.version,'scope',NEW.scope,'reason',NEW.reason) FROM branch b WHERE b.id=NEW.branch_id;RETURN NEW;END $$;
CREATE TRIGGER ai_behavior_policy_record AFTER INSERT OR UPDATE ON ai_behavior_policy FOR EACH ROW EXECUTE FUNCTION record_ai_behavior_policy();
