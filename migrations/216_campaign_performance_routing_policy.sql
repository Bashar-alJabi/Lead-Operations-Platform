CREATE TABLE campaign_performance_routing_policy (
 campaign_id uuid PRIMARY KEY REFERENCES campaign(id),
 version integer NOT NULL CHECK(version>0),
 lookback_days integer NOT NULL CHECK(lookback_days BETWEEN 1 AND 90),
 minimum_samples integer NOT NULL CHECK(minimum_samples BETWEEN 1 AND 100),
 response_weight integer NOT NULL CHECK(response_weight BETWEEN 0 AND 100),
 follow_up_weight integer NOT NULL CHECK(follow_up_weight BETWEEN 0 AND 100),
 fallback_method text NOT NULL CHECK(fallback_method IN ('MANUAL','ROUND_ROBIN','WEIGHTED')),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 changed_at timestamptz NOT NULL,
 CHECK(response_weight+follow_up_weight=100)
);

CREATE TABLE campaign_performance_routing_policy_history (
 campaign_id uuid NOT NULL REFERENCES campaign_performance_routing_policy(campaign_id),
 version integer NOT NULL CHECK(version>0),
 snapshot jsonb NOT NULL,
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(campaign_id,version)
);

CREATE FUNCTION guard_campaign_performance_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope campaign;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_RETAINED'; END IF;
 IF (TG_OP='INSERT' AND NEW.version<>1) OR
  (TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1))
 THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_VERSION_CONFLICT'; END IF;
 SELECT * INTO scope FROM campaign WHERE id=NEW.campaign_id FOR SHARE;
 IF NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=scope.organization_id
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=scope.branch_id)
    AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   FOR SHARE OF u,s)
 THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_ACCESS_DENIED'; END IF;
 IF scope.status='ACTIVE' THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_CAMPAIGN_ACTIVE'; END IF;
 NEW.reason=trim(NEW.reason); NEW.changed_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_performance_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON campaign_performance_routing_policy
 FOR EACH ROW EXECUTE FUNCTION guard_campaign_performance_policy();

CREATE FUNCTION guard_campaign_performance_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy campaign_performance_routing_policy;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO policy FROM campaign_performance_routing_policy
  WHERE campaign_id=NEW.campaign_id AND version=NEW.version AND ai_row_inserted_here(xmin);
 IF pg_trigger_depth()<2 OR policy.campaign_id IS NULL OR NEW.snapshot IS DISTINCT FROM (to_jsonb(policy)-'session_id')
 THEN RAISE EXCEPTION 'PERFORMANCE_POLICY_HISTORY_PROOF_REQUIRED'; END IF;
 NEW.changed_at=policy.changed_at;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_performance_policy_history_guard BEFORE INSERT OR UPDATE OR DELETE ON campaign_performance_routing_policy_history
 FOR EACH ROW EXECUTE FUNCTION guard_campaign_performance_policy_history();

CREATE FUNCTION record_campaign_performance_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO campaign_performance_routing_policy_history(campaign_id,version,snapshot,changed_at)
  VALUES(NEW.campaign_id,NEW.version,to_jsonb(NEW)-'session_id',NEW.changed_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  SELECT organization_id,branch_id,NEW.actor_id,'CAMPAIGN_PERFORMANCE_POLICY_SAVED','CAMPAIGN',id,
   jsonb_build_object('version',NEW.version,'lookbackDays',NEW.lookback_days,'minimumSamples',NEW.minimum_samples,
    'responseWeight',NEW.response_weight,'followUpWeight',NEW.follow_up_weight,'fallback',NEW.fallback_method)
  FROM campaign WHERE id=NEW.campaign_id;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_performance_policy_record AFTER INSERT OR UPDATE ON campaign_performance_routing_policy
 FOR EACH ROW EXECUTE FUNCTION record_campaign_performance_policy();
