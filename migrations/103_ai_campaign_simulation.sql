-- Read-only Campaign simulation. Customer actions require separate approved execution proofs.
CREATE FUNCTION ai_simulation_references(k jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  WITH refs AS (
    SELECT 'section:'||key AS id,value#>>'{}' AS text FROM jsonb_each(k->'content'->'sections')
    UNION ALL SELECT 'faq:'||(n-1),v->>'question'||E'\n'||(v->>'answer') FROM jsonb_array_elements(k->'content'->'faqs') WITH ORDINALITY a(v,n)
    UNION ALL SELECT 'claim:'||(n-1),v#>>'{}' FROM jsonb_array_elements(k->'content'->'allowedClaims') WITH ORDINALITY a(v,n)
    UNION ALL SELECT 'link:'||(n-1),v->>'label'||E'\n'||(v->>'url') FROM jsonb_array_elements(k->'content'->'links') WITH ORDINALITY a(v,n)
    UNION ALL SELECT 'asset:'||(v->>'id'),v->>'extractedText' FROM jsonb_array_elements(k->'assets') a(v)
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'text',text) ORDER BY id),'[]') FROM refs
  WHERE length(trim(text))>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(k->'content'->'prohibitedClaims') p WHERE strpos(lower(text),lower(p))>0)
$$;
CREATE TABLE ai_campaign_simulation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  question text NOT NULL CHECK(length(trim(question)) BETWEEN 1 AND 4000 AND translate(question,E'\n\r\t','') !~ '[[:cntrl:]]'),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),references_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED','BLOCKED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,completed_lease_token uuid,
  result jsonb,error_code text CHECK(error_code ~ '^[A-Z_]{1,100}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(campaign_id,actor_id,request_id),CHECK(state='RUNNING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL OR state<>'RUNNING' AND lease_token IS NULL AND lease_until IS NULL),CHECK((state='COMPLETED')=(result IS NOT NULL)),
  CHECK(state NOT IN ('FAILED','BLOCKED') OR error_code IS NOT NULL)
);
CREATE INDEX ai_simulation_queue ON ai_campaign_simulation(available_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX ai_simulation_campaign_history ON ai_campaign_simulation(campaign_id,created_at DESC,id DESC);
CREATE TABLE ai_simulation_history (
  simulation_id uuid NOT NULL REFERENCES ai_campaign_simulation(id),version integer NOT NULL,state text NOT NULL,attempt_count integer NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(simulation_id,version)
);
CREATE FUNCTION ai_simulation_current(s ai_campaign_simulation) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE b record;c record;p record;cfg jsonb;selected uuid;k jsonb;v integer;g integer;item record;BEGIN
  SELECT * INTO b FROM branch WHERE id=s.branch_id AND organization_id=s.organization_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO c FROM campaign WHERE id=s.campaign_id AND branch_id=b.id AND organization_id=s.organization_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  PERFORM 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=s.actor_id AND ss.id=s.session_id AND u.organization_id=s.organization_id AND u.active
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp() FOR SHARE OF u,ss;IF NOT FOUND THEN RETURN false;END IF;
  IF s.context->>'organizationId' IS DISTINCT FROM s.organization_id::text OR s.context->>'branchId' IS DISTINCT FROM b.id::text OR s.context->>'campaignId' IS DISTINCT FROM c.id::text
    OR (s.context->>'campaignVersion')::integer IS DISTINCT FROM c.version OR (s.context->'messaging'->>'branchPolicyVersion')::integer IS DISTINCT FROM b.messaging_policy_version
    OR s.context->'globalGuardrails'->>'version' IS DISTINCT FROM '1' OR EXISTS(SELECT 1 FROM jsonb_each(s.context->'globalGuardrails') e WHERE key<>'version' AND value<>'true'::jsonb) THEN RETURN false;END IF;
  FOR item IN SELECT scope,resource_id,version,definition FROM ai_operational_config WHERE branch_id=b.id AND (campaign_id IS NULL OR campaign_id=c.id) FOR SHARE LOOP
    cfg=CASE WHEN item.scope='BRANCH' THEN s.context->'branchDefaults' ELSE s.context->'campaignOverrides' END;
    IF (cfg->>'version')::integer IS DISTINCT FROM item.version OR cfg->'definition' IS DISTINCT FROM item.definition THEN RETURN false;END IF;
  END LOOP;
  IF (s.context->'branchDefaults'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id),0)
    OR (s.context->'campaignOverrides'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),0) THEN RETURN false;END IF;
  selected=COALESCE((SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),
    (SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id));
  IF selected IS NULL OR s.context->'profiles'->'CONVERSATION'->>'id' IS DISTINCT FROM selected::text OR NOT ai_operational_profile_usable(b.id,selected,'CONVERSATION') THEN RETURN false;END IF;
  SELECT pr.*,ic.version AS cv,ic.provider,ic.id AS cid INTO p FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=selected FOR SHARE OF pr,ic;
  cfg=s.context->'profiles'->'CONVERSATION';
  g=CASE WHEN p.branch_id IS NULL THEN (SELECT version FROM ai_connection_branch_use WHERE connection_id=p.cid AND branch_id=b.id AND active FOR SHARE) ELSE NULL END;
  IF cfg->>'model_id' IS DISTINCT FROM p.model_id OR (cfg->>'max_output_tokens')::integer IS DISTINCT FROM p.max_output_tokens OR (cfg->>'profile_version')::integer IS DISTINCT FROM p.version
    OR cfg->>'connection_id' IS DISTINCT FROM p.cid::text OR cfg->>'provider' IS DISTINCT FROM p.provider OR (cfg->>'connection_version')::integer IS DISTINCT FROM p.cv OR (cfg->>'grant_version')::integer IS DISTINCT FROM g THEN RETURN false;END IF;
  SELECT jsonb_build_object('version',version,'content',content,'assets',(SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=kp.campaign_id AND m.version=kp.version)) INTO k
    FROM ai_knowledge_publication kp WHERE campaign_id=c.id ORDER BY version DESC LIMIT 1;
  IF k IS NULL OR s.context->'knowledge' IS DISTINCT FROM k OR s.references_json IS DISTINCT FROM ai_simulation_references(k) THEN RETURN false;END IF;
  IF (s.context->'qualification'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_qualification_config WHERE campaign_id=c.id FOR SHARE),0)
    OR (s.context->'followup'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_followup_policy WHERE campaign_id=c.id FOR SHARE),0)
    OR (s.context->'behavior'->>'branchVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='BRANCH' AND resource_id=b.id FOR SHARE),0)
    OR (s.context->'behavior'->>'campaignVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='CAMPAIGN' AND resource_id=c.id FOR SHARE),0) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
CREATE FUNCTION ai_simulation_result_valid(r jsonb,refs jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE selected jsonb;answer text;BEGIN
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>8 OR NOT r ?& ARRAY['decision','handoffReason','references','answer','expectedAction','toolsExecuted','sendAllowed','mutationsAllowed']
    OR r->'toolsExecuted'<>'[]'::jsonb OR r->'sendAllowed'<>'false'::jsonb OR r->'mutationsAllowed'<>'false'::jsonb OR jsonb_typeof(r->'references')<>'array' OR jsonb_array_length(r->'references')>8 THEN RETURN false;END IF;
  IF r->>'decision'='HANDOFF' THEN RETURN r->>'handoffReason' IN ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE') AND r->'references'='[]'::jsonb AND r->>'answer'='' AND r->>'expectedAction'='requestHumanHandoff';END IF;
  IF r->>'decision' IS DISTINCT FROM 'ANSWER' OR r->'handoffReason'<>'null'::jsonb OR r->'expectedAction'<>'null'::jsonb OR jsonb_array_length(r->'references')<1 THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'references') s WHERE NOT refs @> jsonb_build_array(s)) OR (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(r->'references') v)<>jsonb_array_length(r->'references') THEN RETURN false;END IF;
  SELECT string_agg(v->>'text',E'\n\n' ORDER BY n) INTO answer FROM jsonb_array_elements(r->'references') WITH ORDINALITY a(v,n);RETURN r->>'answer' IS NOT DISTINCT FROM answer;
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION guard_ai_campaign_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SIMULATION_HISTORY_RETAINED';END IF;
  IF TG_OP='INSERT' THEN
    NEW.references_json=ai_simulation_references(NEW.context->'knowledge');NEW.context_hash=encode(sha256(convert_to(NEW.context::text,'UTF8')),'hex');
    IF NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NOT ai_simulation_current(NEW) THEN RAISE EXCEPTION 'AI_SIMULATION_CURRENT_CONTEXT_REQUIRED';END IF;
  ELSE
    IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.actor_id,NEW.session_id,NEW.request_id,NEW.request_hash,NEW.question,NEW.context,NEW.context_hash,NEW.references_json,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.actor_id,OLD.session_id,OLD.request_id,OLD.request_hash,OLD.question,OLD.context,OLD.context_hash,OLD.references_json,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_SIMULATION_IMMUTABLE_CONTEXT_VERSION';END IF;
    IF OLD.state IN ('COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_SIMULATION_TERMINAL';END IF;
    IF NEW.state='RUNNING' THEN
      IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.completed_lease_token IS NOT NULL
        OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds' OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
    ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
      IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
    ELSE
      IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_SIMULATION_LEASE_REQUIRED';END IF;
      IF NEW.state='COMPLETED' AND (NEW.error_code IS NOT NULL OR NOT ai_simulation_current(NEW) OR NOT ai_simulation_result_valid(NEW.result,NEW.references_json)) THEN RAISE EXCEPTION 'AI_SIMULATION_RESULT_PROOF_REQUIRED';END IF;
      IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_SIMULATION_RETRY_REQUIRED';END IF;
      IF NEW.state NOT IN ('QUEUED','COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_SIMULATION_TRANSITION_INVALID';END IF;
    END IF;
  END IF;
  NEW.updated_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER ai_simulation_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_campaign_simulation FOR EACH ROW EXECUTE FUNCTION guard_ai_campaign_simulation();
CREATE FUNCTION guard_ai_simulation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_campaign_simulation s WHERE s.id=NEW.simulation_id AND (s.version,s.state,s.attempt_count,s.error_code) IS NOT DISTINCT FROM (NEW.version,NEW.state,NEW.attempt_count,NEW.error_code)) THEN RAISE EXCEPTION 'AI_SIMULATION_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_simulation_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_simulation_history FOR EACH ROW EXECUTE FUNCTION guard_ai_simulation_history();
CREATE FUNCTION record_ai_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_simulation_history(simulation_id,version,state,attempt_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'AI_SIMULATION_'||NEW.state,'AI_SIMULATION',NEW.id,
    jsonb_build_object('campaignId',NEW.campaign_id,'version',NEW.version,'attempt',NEW.attempt_count,'errorCode',NEW.error_code,'contextHash',NEW.context_hash,'knowledgeVersion',NEW.context->'knowledge'->'version','profileId',NEW.context->'profiles'->'CONVERSATION'->'id'));
  RETURN NEW;END $$;
CREATE TRIGGER ai_simulation_record AFTER INSERT OR UPDATE ON ai_campaign_simulation FOR EACH ROW EXECUTE FUNCTION record_ai_simulation();
