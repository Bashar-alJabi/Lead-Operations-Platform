CREATE TABLE ai_initial_job_recovery (
 admission_id uuid NOT NULL REFERENCES ai_initial_job(admission_id),
 job_version integer NOT NULL CHECK(job_version>1),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500 AND reason=btrim(reason) AND reason !~ '[[:cntrl:]]'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(admission_id,job_version)
);

CREATE FUNCTION guard_ai_initial_job_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE initial_branch uuid; current_job record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_HISTORY_RETAINED'; END IF;
 SELECT l.branch_id INTO initial_branch FROM ai_initial_admission a
 JOIN lead_intake_receipt i ON i.id=a.receipt_id JOIN lead l ON l.id=i.lead_id
 WHERE a.id=NEW.admission_id;
 IF initial_branch IS NULL THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_UNAVAILABLE'; END IF;
 PERFORM 1 FROM branch WHERE id=initial_branch AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_CONTEXT_CHANGED'; END IF;
 SELECT j.state,j.version,j.error_code,l.id AS lead_id,l.organization_id,l.branch_id,l.campaign_id,l.lifecycle,
   a.context->'scope' AS approved_scope
 INTO current_job FROM ai_initial_job j JOIN ai_initial_admission a ON a.id=j.admission_id
 JOIN lead_intake_receipt i ON i.id=a.receipt_id JOIN lead l ON l.id=i.lead_id
 WHERE j.admission_id=NEW.admission_id FOR UPDATE OF j;
 IF current_job IS NULL OR current_job.state<>'DEAD_LETTER' OR current_job.error_code IS DISTINCT FROM 'AI_INITIAL_LOCAL_ACTION_FAILED'
  OR EXISTS(SELECT 1 FROM ai_initial_send_action WHERE admission_id=NEW.admission_id) THEN
  RAISE EXCEPTION 'AI_INITIAL_RECOVERY_UNAVAILABLE';
 END IF;
 IF current_job.version<>NEW.job_version THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_VERSION_CONFLICT'; END IF;
 IF current_job.branch_id<>initial_branch OR current_job.lifecycle<>'OPEN'
  OR (current_job.organization_id::text,current_job.branch_id::text,current_job.campaign_id::text,current_job.lead_id::text)
    IS DISTINCT FROM (current_job.approved_scope->>'organizationId',current_job.approved_scope->>'branchId',
                      current_job.approved_scope->>'campaignId',current_job.approved_scope->>'leadId') THEN
  RAISE EXCEPTION 'AI_INITIAL_RECOVERY_CONTEXT_CHANGED';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.active AND u.credential_state='READY' AND u.organization_id=current_job.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=initial_branch))
    AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  FOR SHARE OF u,s
 ) THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_ACCESS_REVOKED'; END IF;
 IF ai_initial_execution_context(NEW.admission_id) IS NULL THEN
  RAISE EXCEPTION 'AI_INITIAL_RECOVERY_CONTEXT_CHANGED';
 END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER ai_initial_job_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_job_recovery
 FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_job_recovery();

CREATE OR REPLACE FUNCTION guard_ai_initial_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a ai_initial_admission;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_INITIAL_JOB_HISTORY_RETAINED'; END IF;
 SELECT * INTO a FROM ai_initial_admission WHERE id=NEW.admission_id;
 IF TG_OP='INSERT' THEN
  IF a IS NULL OR a.state<>'ADMITTED' OR NOT EXISTS(SELECT 1 FROM ai_initial_admission WHERE id=a.id AND ai_row_inserted_here(xmin))
   OR a.context->'initialMessage'->>'ready' IS DISTINCT FROM 'true'
   OR NEW.state<>'WAITING' OR NEW.failure_count<>0 OR NEW.version<>1 THEN
   RAISE EXCEPTION 'AI_INITIAL_FRESH_JOB_SOURCE_REQUIRED';
  END IF;
  NEW.available_at=clock_timestamp(); NEW.error_code=NULL;
 ELSE
  IF NEW.admission_id<>OLD.admission_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_INITIAL_JOB_TRANSITION_REQUIRED'; END IF;
  IF OLD.state='DEAD_LETTER' THEN
   IF NEW.state<>'WAITING' OR NEW.failure_count<>0 OR pg_trigger_depth()<2 OR NOT EXISTS(
    SELECT 1 FROM ai_initial_job_recovery
    WHERE admission_id=OLD.admission_id AND job_version=OLD.version AND ai_row_inserted_here(xmin)
   ) THEN RAISE EXCEPTION 'AI_INITIAL_JOB_RECOVERY_PROOF_REQUIRED'; END IF;
   NEW.available_at=clock_timestamp(); NEW.error_code=NULL;
  ELSIF OLD.state<>'WAITING' THEN RAISE EXCEPTION 'AI_INITIAL_JOB_TRANSITION_REQUIRED';
  ELSIF NEW.state='DONE' THEN
   IF NOT EXISTS(SELECT 1 FROM ai_initial_send_action WHERE admission_id=NEW.admission_id) THEN
    RAISE EXCEPTION 'AI_INITIAL_JOB_ACTION_REQUIRED';
   END IF;
  ELSE
   IF OLD.available_at>clock_timestamp() OR NEW.failure_count<>OLD.failure_count+1
    OR NEW.state IS DISTINCT FROM (CASE WHEN NEW.failure_count=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END)
    OR NEW.error_code IS DISTINCT FROM 'AI_INITIAL_LOCAL_ACTION_FAILED' THEN
    RAISE EXCEPTION 'AI_INITIAL_JOB_FAILURE_REQUIRED';
   END IF;
   NEW.available_at=clock_timestamp()+make_interval(secs=>power(2,NEW.failure_count)::integer);
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE FUNCTION record_ai_initial_job_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE ai_initial_job SET state='WAITING',failure_count=0,version=version+1
 WHERE admission_id=NEW.admission_id AND version=NEW.job_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_INITIAL_RECOVERY_VERSION_CONFLICT'; END IF;
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 SELECT l.organization_id,l.branch_id,NEW.actor_id,'AI_INITIAL_JOB_RECOVERED','LEAD',l.id,
   jsonb_build_object('admissionId',NEW.admission_id,'jobVersion',NEW.job_version,'reason',NEW.reason)
 FROM ai_initial_admission a JOIN lead_intake_receipt i ON i.id=a.receipt_id JOIN lead l ON l.id=i.lead_id
 WHERE a.id=NEW.admission_id;
 RETURN NULL;
END $$;
CREATE TRIGGER ai_initial_job_recovery_record AFTER INSERT ON ai_initial_job_recovery
 FOR EACH ROW EXECUTE FUNCTION record_ai_initial_job_recovery();
