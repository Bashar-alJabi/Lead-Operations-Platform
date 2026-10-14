-- Operational response clock, independent of messaging windows, provider health and employee capacity.
CREATE FUNCTION ai_handoff_clock_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['mode','timezone','calendar'] OR (SELECT count(*) FROM jsonb_object_keys(d))<>3 THEN RETURN false;END IF;
 IF d->'mode'<>'null' AND (jsonb_typeof(d->'mode')<>'string' OR d->>'mode' NOT IN ('ELAPSED','WORKING_HOURS')) THEN RETURN false;END IF;
 IF d->'timezone'<>'null' AND (jsonb_typeof(d->'timezone')<>'string' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timezone')) THEN RETURN false;END IF;
 RETURN d->'calendar'='null' OR operational_hours_valid(d->'calendar');
END $$;
CREATE TABLE ai_handoff_clock_policy (
 scope text NOT NULL CHECK(scope IN ('BRANCH','CAMPAIGN')),resource_id uuid NOT NULL,organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid REFERENCES campaign(id),
 version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_handoff_clock_valid(definition)),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[\x00-\x1f\x7f]'),updated_at timestamptz NOT NULL,
 PRIMARY KEY(scope,resource_id),CHECK(scope='BRANCH' AND resource_id=branch_id AND campaign_id IS NULL OR scope='CAMPAIGN' AND resource_id=campaign_id)
);
CREATE TABLE ai_handoff_clock_history (
 scope text NOT NULL,resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(scope,resource_id,version),FOREIGN KEY(scope,resource_id) REFERENCES ai_handoff_clock_policy(scope,resource_id)
);
CREATE FUNCTION guard_ai_handoff_clock_policy() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE b record;c record;u record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_CLOCK_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'HANDOFF_CLOCK_VERSION_REQUIRED';END IF;
 IF TG_OP='UPDATE' AND (NEW.scope,NEW.resource_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id) IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id) THEN RAISE EXCEPTION 'HANDOFF_CLOCK_IDENTITY_IMMUTABLE';END IF;
 SELECT * INTO b FROM branch WHERE id=NEW.branch_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF b IS NULL OR NOT b.active THEN RAISE EXCEPTION 'HANDOFF_CLOCK_CURRENT_SCOPE_REQUIRED';END IF;
 IF NEW.scope='CAMPAIGN' THEN SELECT * INTO c FROM campaign WHERE id=NEW.campaign_id AND branch_id=b.id AND organization_id=b.organization_id FOR SHARE;
  IF c IS NULL THEN RAISE EXCEPTION 'HANDOFF_CLOCK_CURRENT_SCOPE_REQUIRED';END IF;END IF;
 -- Reuse the native current real-user session proof introduced in135; this never uses AI authority.
 IF NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'HANDOFF_CLOCK_CURRENT_SESSION_REQUIRED';END IF;
 SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
 IF u.organization_id<>NEW.organization_id OR NOT(u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id) THEN RAISE EXCEPTION 'HANDOFF_CLOCK_CURRENT_ACCESS_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_clock_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_clock_policy FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_clock_policy();
CREATE FUNCTION guard_ai_handoff_clock_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HANDOFF_CLOCK_HISTORY_IMMUTABLE';END IF;
 SELECT hp.*,hp.xmin AS inserted_xid INTO p FROM ai_handoff_clock_policy hp WHERE (scope,resource_id,version)=(NEW.scope,NEW.resource_id,NEW.version);
 IF p IS NULL OR NOT ai_row_inserted_here(p.inserted_xid) OR NEW.snapshot IS DISTINCT FROM to_jsonb(p)-'inserted_xid' THEN RAISE EXCEPTION 'HANDOFF_CLOCK_HISTORY_CURRENT_PROOF_REQUIRED';END IF;
 NEW.created_at=p.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_clock_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_clock_history FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_clock_history();
CREATE FUNCTION record_ai_handoff_clock_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_handoff_clock_history(scope,resource_id,version,snapshot,created_at) VALUES(NEW.scope,NEW.resource_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'AI_HANDOFF_CLOCK_CONFIGURED',NEW.scope,NEW.resource_id,jsonb_build_object('version',NEW.version,'reason',NEW.reason));RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_clock_policy_history AFTER INSERT OR UPDATE ON ai_handoff_clock_policy FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_clock_policy();
CREATE FUNCTION ai_effective_handoff_clock(bid uuid,cid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE b record;c record;bc record;cc record;bo record;co record;mode text;zone text;hours jsonb;minutes integer;BEGIN
 SELECT * INTO b FROM branch WHERE id=bid;IF b IS NULL THEN RETURN NULL;END IF;
 IF cid IS NOT NULL THEN SELECT * INTO c FROM campaign WHERE id=cid AND branch_id=b.id AND organization_id=b.organization_id;IF c IS NULL THEN RETURN NULL;END IF;END IF;
 SELECT * INTO bc FROM ai_handoff_clock_policy WHERE scope='BRANCH' AND resource_id=b.id AND branch_id=b.id AND organization_id=b.organization_id;
 SELECT * INTO cc FROM ai_handoff_clock_policy WHERE scope='CAMPAIGN' AND resource_id=cid AND branch_id=b.id AND organization_id=b.organization_id;
 SELECT * INTO bo FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id AND branch_id=b.id;
 SELECT * INTO co FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=cid AND branch_id=b.id;
 mode=COALESCE(cc.definition->>'mode',bc.definition->>'mode','ELAPSED');zone=COALESCE(cc.definition->>'timezone',bc.definition->>'timezone',b.timezone);
 hours=COALESCE(NULLIF(cc.definition->'calendar','null'),NULLIF(bc.definition->'calendar','null'),b.business_hours);
 minutes=COALESCE(co.definition->>'handoffSlaMinutes',bo.definition->>'handoffSlaMinutes')::integer;
 RETURN jsonb_build_object('mode',mode,'timezone',zone,'calendar',hours,'targetMinutes',minutes,'branchClockVersion',COALESCE(bc.version,0),'campaignClockVersion',COALESCE(cc.version,0),
  'branchConfigVersion',COALESCE(bo.version,0),'campaignConfigVersion',COALESCE(co.version,0),'branchHoursVersion',COALESCE((SELECT version FROM operational_hours_policy WHERE scope='BRANCH' AND resource_id=b.id),0),
  'sources',jsonb_build_object('mode',CASE WHEN cc.definition->>'mode' IS NOT NULL THEN 'CAMPAIGN' WHEN bc.definition->>'mode' IS NOT NULL THEN 'BRANCH' ELSE 'ELAPSED_DEFAULT' END,
   'timezone',CASE WHEN cc.definition->>'timezone' IS NOT NULL THEN 'CAMPAIGN' WHEN bc.definition->>'timezone' IS NOT NULL THEN 'BRANCH' ELSE 'BRANCH_TIMEZONE' END,
   'calendar',CASE WHEN cc.definition->'calendar'<>'null' THEN 'CAMPAIGN' WHEN bc.definition->'calendar'<>'null' THEN 'BRANCH' ELSE 'BRANCH_WORKING_HOURS' END,
   'targetMinutes',CASE WHEN co.definition->>'handoffSlaMinutes' IS NOT NULL THEN 'CAMPAIGN' WHEN bo.definition->>'handoffSlaMinutes' IS NOT NULL THEN 'BRANCH' ELSE 'UNCONFIGURED' END),
  'calendarOpenAtEvaluation',operational_hours_open(hours,zone,at_time),'evaluatedAt',at_time,'previewOnly',true,'runtimeReady',false);
END $$;
