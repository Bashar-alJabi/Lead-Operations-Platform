CREATE TABLE lead_export_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),actor_id uuid NOT NULL REFERENCES user_account(id),
 actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER','AGENT')),branch_scope uuid REFERENCES branch(id),
 approved_session_id uuid NOT NULL REFERENCES user_session(id),request_key uuid NOT NULL,request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object'),columns jsonb NOT NULL CHECK(jsonb_typeof(columns)='array' AND jsonb_array_length(columns) BETWEEN 0 AND 12),
 field_ids uuid[] NOT NULL DEFAULT '{}',selected_ids uuid[] NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','DONE','DEAD_LETTER','REVOKED','CANCELLED','EXPIRED')),
 row_count integer NOT NULL DEFAULT 0 CHECK(row_count>=0),cursor_at timestamptz,cursor_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
 error_code text,next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cardinality(field_ids)<=24 AND cardinality(selected_ids)<=50 AND jsonb_array_length(columns)+cardinality(field_ids)>0),UNIQUE(actor_id,request_key)
);
CREATE INDEX lead_export_work ON lead_export_job(next_run_at,id) WHERE state='WAITING';
CREATE INDEX lead_export_expiry ON lead_export_job(expires_at,id) WHERE state<>'EXPIRED';
CREATE INDEX lead_export_actor ON lead_export_job(actor_id,created_at DESC,id DESC);
CREATE TABLE lead_export_member (
 job_id uuid NOT NULL REFERENCES lead_export_job(id),lead_id uuid NOT NULL REFERENCES lead(id),
 branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_created_at timestamptz NOT NULL,page_version integer NOT NULL CHECK(page_version>1),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,lead_id)
);
CREATE INDEX lead_export_member_page ON lead_export_member(job_id,lead_created_at,lead_id);
CREATE INDEX lead_export_member_proof ON lead_export_member(job_id,page_version);
CREATE TABLE lead_export_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id uuid NOT NULL REFERENCES lead_export_job(id),version integer NOT NULL,
 state text NOT NULL,row_count integer NOT NULL,failure_count integer NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(job_id,version)
);
CREATE FUNCTION lead_export_actor_current(j lead_export_job) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u WHERE u.id=j.actor_id AND u.organization_id=j.organization_id AND u.active
  AND u.role=j.actor_role AND u.branch_id IS NOT DISTINCT FROM j.branch_scope)
$$;
CREATE FUNCTION lead_export_lead_visible(j lead_export_job,l lead) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT l.organization_id=j.organization_id AND (j.actor_role='SUPER_ADMIN' OR l.branch_id=j.branch_scope
  AND (j.actor_role='MANAGER' OR j.actor_role='AGENT' AND l.assigned_agent_id=j.actor_id))
  AND EXISTS(SELECT 1 FROM campaign c WHERE c.id=l.campaign_id AND c.organization_id=l.organization_id AND c.branch_id=l.branch_id)
$$;
CREATE FUNCTION lead_export_manifest_visible(j lead_export_job) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM lead_export_member m JOIN lead l ON l.id=m.lead_id
  WHERE m.job_id=j.id AND (NOT lead_export_lead_visible(j,l) OR l.branch_id<>m.branch_id OR l.campaign_id<>m.campaign_id))
$$;
CREATE FUNCTION lead_export_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EXPORT_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.row_count<>0 OR NEW.failure_count<>0 OR NEW.cursor_id IS NOT NULL OR NEW.cursor_at IS NOT NULL
   OR NEW.error_code IS NOT NULL OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
   OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+interval '7 days' OR NOT lead_export_actor_current(NEW)
   OR NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=NEW.approved_session_id AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='LEAD_EXPORT_REQUESTED' AND a.target_type='LEAD_EXPORT' AND a.target_id=NEW.id::text AND a.actor_user_id=NEW.actor_id
    AND a.organization_id=NEW.organization_id AND a.detail->>'sessionId'=NEW.approved_session_id::text AND ai_row_inserted_here(a.xmin))
   THEN RAISE EXCEPTION 'EXPORT_APPROVAL_REQUIRED';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','row_count','cursor_at','cursor_id','version','failure_count','error_code','next_run_at','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','row_count','cursor_at','cursor_id','version','failure_count','error_code','next_run_at','updated_at'])
   OR NEW.version<>OLD.version+1 OR OLD.state IN ('CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'EXPORT_ENVELOPE_IMMUTABLE';END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='LEAD_EXPORT_STATE_CHANGED' AND a.target_type='LEAD_EXPORT' AND a.target_id=NEW.id::text AND a.actor_user_id IS NULL
   AND a.organization_id=NEW.organization_id AND a.detail->>'version'=NEW.version::text AND a.detail->>'state'=NEW.state
   AND a.detail->>'count'=NEW.row_count::text AND ai_row_inserted_here(a.xmin)) THEN RAISE EXCEPTION 'EXPORT_AUDIT_PROOF';END IF;
  IF NEW.cursor_at IS DISTINCT FROM OLD.cursor_at OR NEW.cursor_id IS DISTINCT FROM OLD.cursor_id THEN
   IF NOT EXISTS(SELECT 1 FROM lead_export_member m WHERE m.job_id=NEW.id AND m.lead_id=NEW.cursor_id AND m.lead_created_at=NEW.cursor_at
    AND ai_row_inserted_here(m.xmin)) THEN RAISE EXCEPTION 'EXPORT_CURSOR_PROOF';END IF;
  END IF;
  IF NEW.state='EXPIRED' THEN
   IF clock_timestamp()<OLD.expires_at THEN RAISE EXCEPTION 'EXPORT_NOT_EXPIRED';END IF;
  ELSIF NEW.state<>'REVOKED' AND NOT lead_export_actor_current(NEW) THEN RAISE EXCEPTION 'EXPORT_AUTHORITY_REVOKED';END IF;
  IF NEW.row_count<OLD.row_count OR NEW.row_count-OLD.row_count>100 OR NEW.row_count<>OLD.row_count AND OLD.state<>'WAITING'
   OR NEW.row_count<>OLD.row_count+(SELECT count(*) FROM lead_export_member m WHERE job_id=NEW.id AND page_version=NEW.version AND ai_row_inserted_here(m.xmin)) THEN RAISE EXCEPTION 'EXPORT_COUNT_PROOF';END IF;
  IF NEW.state='DONE' AND (OLD.state<>'WAITING' OR NOT lead_export_manifest_visible(NEW)) THEN RAISE EXCEPTION 'EXPORT_SCOPE_PROOF';END IF;
  IF OLD.state='DONE' AND NEW.state NOT IN ('DONE','CANCELLED','EXPIRED','REVOKED') THEN RAISE EXCEPTION 'EXPORT_NO_REPLAY';END IF;
  IF NEW.state='CANCELLED' AND NOT EXISTS(SELECT 1 FROM audit_log a JOIN user_session s ON s.id=(a.detail->>'sessionId')::uuid
   WHERE a.action='LEAD_EXPORT_CANCELLED' AND a.target_type='LEAD_EXPORT' AND a.target_id=NEW.id::text AND a.actor_user_id=NEW.actor_id
    AND a.organization_id=NEW.organization_id AND ai_row_inserted_here(a.xmin) AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  ) THEN RAISE EXCEPTION 'EXPORT_CANCEL_SESSION_REQUIRED';END IF;
  IF NEW.state='WAITING' AND OLD.state IN ('DEAD_LETTER','REVOKED') AND NOT EXISTS(
   SELECT 1 FROM audit_log a JOIN user_session s ON s.id=(a.detail->>'sessionId')::uuid WHERE a.action='LEAD_EXPORT_RECOVERED'
    AND a.target_id=NEW.id::text AND a.organization_id=NEW.organization_id AND a.actor_user_id=NEW.actor_id AND ai_row_inserted_here(a.xmin)
    AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  ) THEN RAISE EXCEPTION 'EXPORT_RECOVERY_SESSION_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER lead_export_job_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_export_job FOR EACH ROW EXECUTE FUNCTION lead_export_job_guard();
CREATE FUNCTION lead_export_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_export_job;l lead;
BEGIN
 SELECT * INTO j FROM lead_export_job WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.job_id ELSE NEW.job_id END;
 IF TG_OP='DELETE' THEN
  IF j.state NOT IN ('EXPIRED','CANCELLED') THEN RAISE EXCEPTION 'EXPORT_MEMBERSHIP_IMMUTABLE';END IF;RETURN OLD;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EXPORT_MEMBERSHIP_IMMUTABLE';END IF;
 SELECT * INTO l FROM lead WHERE id=NEW.lead_id;
 IF j.state<>'WAITING' OR NEW.page_version<>j.version+1 OR j.expires_at<=clock_timestamp() OR NOT lead_export_actor_current(j) OR NOT lead_export_lead_visible(j,l)
  OR NEW.branch_id<>l.branch_id OR NEW.campaign_id<>l.campaign_id OR NEW.lead_created_at<>l.created_at OR l.created_at>j.created_at
  OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
  THEN RAISE EXCEPTION 'EXPORT_CURRENT_MEMBER_PROOF';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_export_member_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_export_member FOR EACH ROW EXECUTE FUNCTION lead_export_member_guard();
CREATE FUNCTION lead_export_member_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM lead_export_history h WHERE h.job_id=NEW.job_id AND h.version=NEW.page_version AND h.state IN ('WAITING','DONE')
  AND ai_row_inserted_here(h.xmin)) THEN RAISE EXCEPTION 'EXPORT_PAGE_COMMIT_PROOF';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lead_export_member_complete AFTER INSERT ON lead_export_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lead_export_member_complete();
CREATE FUNCTION lead_export_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM lead_export_job j WHERE j.id=NEW.job_id AND j.version=NEW.version
  AND j.state=NEW.state AND j.row_count=NEW.row_count AND j.failure_count=NEW.failure_count AND j.error_code IS NOT DISTINCT FROM NEW.error_code
  AND ai_row_inserted_here(j.xmin)) THEN RAISE EXCEPTION 'EXPORT_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_export_history_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_export_history FOR EACH ROW EXECUTE FUNCTION lead_export_history_guard();
CREATE FUNCTION lead_export_record_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO lead_export_history(job_id,version,state,row_count,failure_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.row_count,NEW.failure_count,NEW.error_code);
 RETURN NEW;
END $$;
CREATE TRIGGER lead_export_record_history AFTER INSERT OR UPDATE ON lead_export_job FOR EACH ROW EXECUTE FUNCTION lead_export_record_history();
