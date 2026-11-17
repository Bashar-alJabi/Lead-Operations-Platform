-- Explicit durable execution is independent of the expired private quarantine and original login.
CREATE TABLE lead_import_execution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dataset_id uuid NOT NULL UNIQUE REFERENCES lead_import_dataset(id),
 request_key uuid NOT NULL,session_id uuid NOT NULL REFERENCES user_session(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lead_import_result (
 submission_id uuid PRIMARY KEY REFERENCES lead_import_dataset_row(submission_id),execution_id uuid NOT NULL REFERENCES lead_import_execution(id),
 state text NOT NULL CHECK(state IN ('WAITING','IMPORTED','SKIPPED','INVALID','NEEDS_ATTENTION','FAILED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),error_code text,lead_id uuid UNIQUE REFERENCES lead(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK((state='IMPORTED')=(lead_id IS NOT NULL))
);
CREATE INDEX lead_import_result_due ON lead_import_result(next_run_at,submission_id) WHERE state='WAITING';
CREATE INDEX lead_import_result_execution ON lead_import_result(execution_id,submission_id);
CREATE TABLE lead_import_attempt (
 submission_id uuid NOT NULL REFERENCES lead_import_result(submission_id),result_version integer NOT NULL,
 lead_id uuid NOT NULL UNIQUE REFERENCES lead(id) DEFERRABLE INITIALLY DEFERRED,contact_id uuid REFERENCES contact(id),
 configuration_hash text NOT NULL CHECK(configuration_hash~'^[a-f0-9]{64}$'),
 resolver_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),request_key uuid,reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(submission_id,result_version),
 UNIQUE(submission_id,request_key),CHECK((resolver_id IS NULL)=(session_id IS NULL)),CHECK((resolver_id IS NULL)=(request_key IS NULL)),
 CHECK(resolver_id IS NULL AND reason IS NULL OR resolver_id IS NOT NULL AND length(trim(reason)) BETWEEN 1 AND 500)
);
CREATE TABLE lead_import_retry (
 submission_id uuid NOT NULL REFERENCES lead_import_result(submission_id),request_key uuid NOT NULL,result_version integer NOT NULL,
 session_id uuid NOT NULL REFERENCES user_session(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(submission_id,request_key)
);
CREATE TABLE lead_import_result_history (
 submission_id uuid NOT NULL REFERENCES lead_import_result(submission_id),version integer NOT NULL,state text NOT NULL,
 failure_count integer NOT NULL,error_code text,lead_id uuid REFERENCES lead(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(submission_id,version)
);
CREATE FUNCTION lead_import_execution_allowed(dataset_arg uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT lead_import_authority(j) AND c.status='ACTIVE' FROM lead_import_dataset d JOIN lead_import_file j ON j.id=d.file_id
 JOIN campaign c ON c.id=j.campaign_id WHERE d.id=dataset_arg
$$;
CREATE FUNCTION lead_import_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE j lead_import_file;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_EXECUTION_IMMUTABLE';END IF;
 SELECT f.* INTO j FROM lead_import_dataset d JOIN lead_import_file f ON f.id=d.file_id WHERE d.id=NEW.dataset_id;
 IF NOT COALESCE(lead_import_execution_allowed(NEW.dataset_id),false)
 OR NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=NEW.session_id AND s.user_id=j.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='IMPORT_EXECUTION_STARTED' AND a.target_type='LEAD_IMPORT_EXECUTION' AND a.target_id=NEW.id::text
  AND a.organization_id=j.organization_id AND a.branch_id=j.branch_id AND a.actor_user_id=j.actor_id AND ai_row_inserted_here(a.xmin)
  AND a.detail->>'datasetId'=NEW.dataset_id::text AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text)
 THEN RAISE EXCEPTION 'IMPORT_EXECUTION_CURRENT_APPROVAL_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_execution FOR EACH ROW EXECUTE FUNCTION lead_import_execution_guard();
CREATE FUNCTION lead_import_execution_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT COALESCE(lead_import_execution_allowed(NEW.dataset_id),false) OR (SELECT count(*) FROM lead_import_result WHERE execution_id=NEW.id)
  IS DISTINCT FROM (SELECT total::bigint FROM lead_import_dataset WHERE id=NEW.dataset_id)
  OR NOT EXISTS(SELECT 1 FROM user_session s JOIN lead_import_dataset d ON d.id=NEW.dataset_id JOIN lead_import_file f ON f.id=d.file_id
   WHERE s.id=NEW.session_id AND s.user_id=f.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'IMPORT_EXECUTION_ROWS_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lead_import_execution_complete AFTER INSERT ON lead_import_execution DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lead_import_execution_complete();
CREATE FUNCTION lead_import_retry_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE j lead_import_file;r lead_import_result;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_RETRY_IMMUTABLE';END IF;
 SELECT * INTO r FROM lead_import_result WHERE submission_id=NEW.submission_id FOR UPDATE;
 SELECT f.* INTO j FROM lead_import_dataset_row dr JOIN lead_import_file f ON f.id=dr.file_id WHERE dr.submission_id=r.submission_id;
 IF r.state NOT IN ('FAILED','NEEDS_ATTENTION') OR NEW.result_version<>r.version OR NOT lead_import_authority(j)
 OR NOT EXISTS(SELECT 1 FROM user_session s WHERE s.id=NEW.session_id AND s.user_id=j.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='IMPORT_ROW_RETRY' AND a.target_type='SOURCE_SUBMISSION' AND a.target_id=r.submission_id::text
  AND ai_row_inserted_here(a.xmin) AND a.actor_user_id=j.actor_id AND a.organization_id=j.organization_id AND a.branch_id=j.branch_id
  AND a.detail->>'version'=NEW.result_version::text AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text)
 THEN RAISE EXCEPTION 'IMPORT_RETRY_CURRENT_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_retry_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_retry FOR EACH ROW EXECUTE FUNCTION lead_import_retry_guard();
CREATE FUNCTION lead_import_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;dr lead_import_dataset_row;r lead_import_result;ct record;role_arg text;candidate_count integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_ATTEMPT_IMMUTABLE';END IF;
 SELECT * INTO r FROM lead_import_result WHERE submission_id=NEW.submission_id FOR UPDATE;
 SELECT * INTO dr FROM lead_import_dataset_row WHERE submission_id=NEW.submission_id;
 SELECT * INTO j FROM lead_import_file WHERE id=dr.file_id;role_arg=j.actor_role;
 IF dr.disposition<>'READY_FOR_INTAKE' OR r.version+1<>NEW.result_version OR r.state NOT IN ('WAITING','NEEDS_ATTENTION')
  OR r.state='NEEDS_ATTENTION' AND (NEW.resolver_id IS NULL OR r.error_code NOT IN ('CONTACT_AMBIGUOUS','CONTACT_REVIEW_REQUIRES_ADMIN'))
  OR NOT COALESCE(lead_import_execution_allowed(dr.dataset_id),false) OR NEW.configuration_hash IS DISTINCT FROM lead_import_mapping_config(j)
  THEN RAISE EXCEPTION 'IMPORT_ATTEMPT_CURRENT_PROOF';END IF;
 IF NEW.resolver_id IS NOT NULL THEN
  SELECT u.role INTO role_arg FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=NEW.resolver_id AND u.active AND u.organization_id=j.organization_id AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=j.branch_id)
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
  IF role_arg IS NULL THEN RAISE EXCEPTION 'IMPORT_RESOLUTION_CURRENT_SESSION';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='IMPORT_ATTEMPT_STARTED' AND a.target_type='SOURCE_SUBMISSION' AND a.target_id=dr.submission_id::text
  AND a.organization_id=j.organization_id AND a.branch_id=j.branch_id AND a.actor_user_id IS NOT DISTINCT FROM NEW.resolver_id AND ai_row_inserted_here(a.xmin)
  AND a.detail->>'version'=NEW.result_version::text AND a.detail->>'configurationHash'=NEW.configuration_hash
  AND a.detail->>'sessionId' IS NOT DISTINCT FROM NEW.session_id::text AND a.detail->>'requestId' IS NOT DISTINCT FROM NEW.request_key::text)
 THEN RAISE EXCEPTION 'IMPORT_ATTEMPT_AUDIT_REQUIRED';END IF;
 IF dr.contact IS NULL THEN
  IF NEW.contact_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_CONTACT_PROOF';END IF;
 ELSE
  SELECT c.*,ai_row_inserted_here(c.xmin) AND EXISTS(SELECT 1 FROM audit_log ca WHERE ca.action='CONTACT_CREATED' AND ca.target_type='CONTACT' AND ca.target_id=c.id::text
   AND ca.organization_id=j.organization_id AND ca.branch_id=j.branch_id AND ca.detail->>'sourceSubmissionId'=NEW.submission_id::text AND ai_row_inserted_here(ca.xmin)) fresh
   INTO ct FROM contact c WHERE c.id=NEW.contact_id AND c.organization_id=j.organization_id FOR SHARE;
  IF ct IS NULL THEN RAISE EXCEPTION 'IMPORT_CONTACT_PROOF';END IF;
  IF dr.contact->>'phoneNormalized' IS NULL AND dr.contact->>'emailNormalized' IS NULL THEN
   IF NOT ct.fresh OR (ct.name,ct.phone_normalized,ct.email_normalized) IS DISTINCT FROM (dr.contact->>'name',NULL::text,NULL::text)
    OR NEW.resolver_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORT_CONTACT_PROOF';END IF;
  ELSE
   IF NOT (COALESCE(ct.phone_normalized=dr.contact->>'phoneNormalized',false) OR COALESCE(ct.email_normalized=dr.contact->>'emailNormalized',false)) THEN RAISE EXCEPTION 'IMPORT_CONTACT_PROOF';END IF;
   SELECT count(*)::int INTO candidate_count FROM contact c WHERE c.organization_id=j.organization_id AND
    (c.phone_normalized=dr.contact->>'phoneNormalized' OR c.email_normalized=dr.contact->>'emailNormalized');
   IF NEW.resolver_id IS NULL AND candidate_count<>1 THEN RAISE EXCEPTION 'IMPORT_CONTACT_REVIEW_REQUIRED';END IF;
   IF role_arg<>'SUPER_ADMIN' AND EXISTS(SELECT 1 FROM contact c WHERE c.organization_id=j.organization_id AND
    (c.phone_normalized=dr.contact->>'phoneNormalized' OR c.email_normalized=dr.contact->>'emailNormalized') AND NOT(c.id=ct.id AND ct.fresh) AND
    (NOT EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id=j.branch_id) OR EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id<>j.branch_id)))
    THEN RAISE EXCEPTION 'CONTACT_REVIEW_REQUIRES_ADMIN';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_attempt FOR EACH ROW EXECUTE FUNCTION lead_import_attempt_guard();
CREATE FUNCTION lead_import_effect_allowed(subid uuid,lid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM lead_import_attempt a JOIN lead_import_dataset_row dr ON dr.submission_id=a.submission_id
  JOIN lead_import_file f ON f.id=dr.file_id JOIN lead_intake_birth bi ON bi.lead_id=a.lead_id JOIN lead l ON l.id=bi.lead_id
  WHERE a.submission_id=subid AND a.lead_id=lid AND ai_row_inserted_here(a.xmin) AND ai_row_inserted_here(bi.xmin)
   AND lead_import_execution_allowed(dr.dataset_id) AND a.configuration_hash=lead_import_mapping_config(f)
   AND (bi.organization_id,bi.branch_id,bi.campaign_id,bi.contact_id,bi.source_kind) IS NOT DISTINCT FROM
    (f.organization_id,f.branch_id,f.campaign_id,a.contact_id,CASE WHEN f.format='CSV' THEN 'IMPORT_CSV' ELSE 'IMPORT_EXCEL' END)
   AND (l.organization_id,l.branch_id,l.campaign_id,l.contact_id,l.source_kind) IS NOT DISTINCT FROM
    (bi.organization_id,bi.branch_id,bi.campaign_id,bi.contact_id,bi.source_kind))
$$;
CREATE FUNCTION lead_import_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE dr lead_import_dataset_row;ex lead_import_execution;j lead_import_file;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMPORT_RESULT_RETAINED';END IF;
 SELECT * INTO dr FROM lead_import_dataset_row WHERE submission_id=NEW.submission_id;
 SELECT * INTO ex FROM lead_import_execution WHERE id=NEW.execution_id;
 IF dr.dataset_id IS DISTINCT FROM ex.dataset_id THEN RAISE EXCEPTION 'IMPORT_RESULT_CONTEXT';END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM lead_import_execution e WHERE e.id=ex.id AND ai_row_inserted_here(e.xmin)) OR NEW.version<>1 OR NEW.failure_count<>0 OR NEW.error_code IS NOT NULL
   OR NEW.state IS DISTINCT FROM (CASE dr.disposition WHEN 'READY_FOR_INTAKE' THEN 'WAITING' ELSE dr.disposition END) THEN RAISE EXCEPTION 'IMPORT_RESULT_SEED_PROOF';END IF;
 ELSE
  IF (NEW.submission_id,NEW.execution_id) IS DISTINCT FROM (OLD.submission_id,OLD.execution_id) OR NEW.version<>OLD.version+1
   OR OLD.state IN ('IMPORTED','SKIPPED','INVALID') THEN RAISE EXCEPTION 'IMPORT_RESULT_IMMUTABLE';END IF;
  SELECT * INTO j FROM lead_import_file WHERE id=dr.file_id;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='IMPORT_ROW_STATE' AND a.target_type='SOURCE_SUBMISSION' AND a.target_id=NEW.submission_id::text
   AND a.organization_id=j.organization_id AND a.branch_id=j.branch_id AND ai_row_inserted_here(a.xmin) AND a.detail->>'version'=NEW.version::text AND a.detail->>'state'=NEW.state)
   THEN RAISE EXCEPTION 'IMPORT_RESULT_AUDIT_REQUIRED';END IF;
  IF NEW.state='IMPORTED' THEN
   IF NOT lead_import_effect_allowed(NEW.submission_id,NEW.lead_id) OR NEW.failure_count<>0 OR NEW.error_code IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM lead_import_attempt a WHERE a.submission_id=NEW.submission_id AND a.result_version=NEW.version AND a.lead_id=NEW.lead_id AND ai_row_inserted_here(a.xmin))
    THEN RAISE EXCEPTION 'IMPORT_RESULT_EFFECT_PROOF';END IF;
  ELSIF OLD.state IN ('FAILED','NEEDS_ATTENTION') THEN
   IF NEW.state<>'WAITING' OR NEW.failure_count<>0 OR NEW.error_code IS NOT NULL OR NOT EXISTS(SELECT 1 FROM lead_import_retry rt
    WHERE rt.submission_id=NEW.submission_id AND rt.result_version=OLD.version AND ai_row_inserted_here(rt.xmin)) THEN RAISE EXCEPTION 'IMPORT_RESULT_RETRY_PROOF';END IF;
  ELSIF NEW.state='NEEDS_ATTENTION' THEN
   IF NEW.error_code IS NULL OR NEW.failure_count<>OLD.failure_count THEN RAISE EXCEPTION 'IMPORT_RESULT_ATTENTION_PROOF';END IF;
  ELSIF NEW.state IN ('WAITING','FAILED') THEN
   IF NEW.failure_count<>OLD.failure_count+1 OR NEW.state IS DISTINCT FROM (CASE WHEN NEW.failure_count=5 THEN 'FAILED' ELSE 'WAITING' END)
    OR NEW.error_code<>'IMPORT_INTAKE_UNAVAILABLE' THEN RAISE EXCEPTION 'IMPORT_RESULT_FAILURE_PROOF';END IF;
  ELSE RAISE EXCEPTION 'IMPORT_RESULT_TRANSITION';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER lead_import_result_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_result FOR EACH ROW EXECUTE FUNCTION lead_import_result_guard();
CREATE FUNCTION lead_import_result_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM lead_import_result r WHERE r.submission_id=NEW.submission_id AND r.version=NEW.version
  AND (r.state,r.failure_count,r.error_code,r.lead_id) IS NOT DISTINCT FROM (NEW.state,NEW.failure_count,NEW.error_code,NEW.lead_id) AND ai_row_inserted_here(r.xmin))
  THEN RAISE EXCEPTION 'IMPORT_RESULT_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_result_history_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_result_history FOR EACH ROW EXECUTE FUNCTION lead_import_result_history_guard();
CREATE FUNCTION lead_import_result_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO lead_import_result_history(submission_id,version,state,failure_count,error_code,lead_id) VALUES(NEW.submission_id,NEW.version,NEW.state,NEW.failure_count,NEW.error_code,NEW.lead_id);RETURN NEW;
END $$;
CREATE TRIGGER lead_import_result_record AFTER INSERT OR UPDATE ON lead_import_result FOR EACH ROW EXECUTE FUNCTION lead_import_result_record();
