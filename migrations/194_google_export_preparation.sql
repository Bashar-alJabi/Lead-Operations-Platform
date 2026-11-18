-- Private transport-independent cells are prepared from an existing authorized export.
CREATE FUNCTION google_export_field_allowed(p lead_export_job,fid uuid,filtering boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM campaign c JOIN campaign_field cf ON cf.campaign_id=c.id JOIN field_definition fd ON fd.id=cf.field_id
  WHERE c.id=(p.filters->>'campaignId')::uuid AND c.organization_id=p.organization_id AND fd.id=fid AND fd.organization_id=c.organization_id
   AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id) AND cf.active AND fd.active
   AND (p.actor_role='SUPER_ADMIN' OR c.branch_id=p.branch_scope AND (p.actor_role='MANAGER' OR p.actor_role='AGENT'
    AND EXISTS(SELECT 1 FROM lead l WHERE l.campaign_id=c.id AND l.branch_id=c.branch_id AND l.assigned_agent_id=p.actor_id)))
   AND (p.actor_role='SUPER_ADMIN' OR p.actor_role='MANAGER' AND cf.visible_to_manager OR p.actor_role='AGENT' AND cf.visible_to_agent)
   AND (NOT filtering OR cf.filterable) AND (filtering OR p.actor_role='SUPER_ADMIN' OR cf.show_in_details OR cf.show_in_table))
$$;
CREATE FUNCTION google_export_fields(p lead_export_job) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN count(*)=cardinality(p.field_ids) AND COALESCE(bool_and(google_export_field_allowed(p,fid)),true)
   AND ((p.filters->>'fieldId') IS NULL OR google_export_field_allowed(p,(p.filters->>'fieldId')::uuid,true))
  THEN COALESCE(jsonb_agg(jsonb_build_object('id',fd.id,'key',fd.key,'label',fd.label,'field_type',fd.field_type,'calculation',fd.calculation,
   'definition_version',fd.version,'binding_version',cf.version) ORDER BY ord),'[]'::jsonb) END
 FROM unnest(p.field_ids) WITH ORDINALITY x(fid,ord) JOIN field_definition fd ON fd.id=fid
 JOIN campaign_field cf ON cf.field_id=fid AND cf.campaign_id=(p.filters->>'campaignId')::uuid
$$;
CREATE FUNCTION google_export_header(p lead_export_job) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(v ORDER BY major,minor),'[]'::jsonb) FROM (
  SELECT c.ord major,e.ord minor,e.v FROM jsonb_array_elements_text(p.columns) WITH ORDINALITY c(v,ord)
  CROSS JOIN LATERAL jsonb_array_elements(CASE c.v WHEN 'id' THEN '["Lead ID"]'::jsonb WHEN 'contact' THEN '["Contact name","Phone","Email"]'::jsonb
   WHEN 'campaign' THEN '["Campaign"]'::jsonb WHEN 'branch' THEN '["Branch"]'::jsonb WHEN 'lifecycle' THEN '["Lifecycle"]'::jsonb WHEN 'owner' THEN '["Owner"]'::jsonb
   WHEN 'source' THEN '["Source"]'::jsonb WHEN 'created_at' THEN '["Created at (UTC)"]'::jsonb WHEN 'followup' THEN '["Next follow-up (UTC)"]'::jsonb ELSE '[]'::jsonb END) WITH ORDINALITY e(v,ord)
  UNION ALL SELECT 1000+f.ord,1,to_jsonb((f.v->>'label')||' ('||(f.v->>'key')||')') FROM jsonb_array_elements(google_export_fields(p)) WITH ORDINALITY f(v,ord)
 ) cells
$$;
CREATE FUNCTION google_export_cells_valid(cells jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(cells)='array' AND jsonb_array_length(cells) BETWEEN 1 AND 64 AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(cells) v WHERE jsonb_typeof(v) NOT IN ('string','number','boolean')
   OR jsonb_typeof(v)='string' AND (length(v#>>'{}')>20000 OR translate(v#>>'{}',E'\n\r\t','') ~ E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]')
   OR CASE WHEN jsonb_typeof(v)='number' THEN abs((v#>>'{}')::numeric)>9007199254740991 ELSE false END)
$$;
CREATE FUNCTION google_export_cell_bytes(cells jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(sum(octet_length(v::text)+64),0)::integer FROM jsonb_array_elements(cells) v
$$;
CREATE FUNCTION google_export_target_allowed(p lead_export_job,rid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM google_available_resource a WHERE a.resource_id=rid AND a.organization_id=p.organization_id)
  AND NOT EXISTS(SELECT 1 FROM (
   SELECT branch_id FROM lead_export_member WHERE job_id=p.id
   UNION SELECT p.branch_scope WHERE p.branch_scope IS NOT NULL
   UNION SELECT (p.filters->>'branchId')::uuid WHERE p.filters->>'branchId' IS NOT NULL
   UNION SELECT c.branch_id FROM campaign c WHERE c.id=(p.filters->>'campaignId')::uuid
  ) b WHERE NOT google_resource_available(rid,p.organization_id,b.branch_id))
$$;
CREATE TABLE google_export_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),source_export_id uuid NOT NULL REFERENCES lead_export_job(id),
 actor_id uuid NOT NULL REFERENCES user_account(id),actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER','AGENT')),branch_scope uuid REFERENCES branch(id),
 approval_session_id uuid NOT NULL REFERENCES user_session(id),request_id uuid NOT NULL,request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 resource_id uuid NOT NULL REFERENCES google_resource(id),resource_version integer NOT NULL,connection_id uuid NOT NULL REFERENCES integration_connection(id),connection_version integer NOT NULL,
 spreadsheet_id text NOT NULL,sheet_id integer NOT NULL CHECK(sheet_id>=0),sheet_title text NOT NULL CHECK(length(sheet_title) BETWEEN 1 AND 100),
 fields_snapshot jsonb NOT NULL CHECK(jsonb_typeof(fields_snapshot)='array'),header_cells jsonb NOT NULL CHECK(google_export_cells_valid(header_cells)),
 expected_rows integer NOT NULL CHECK(expected_rows BETWEEN 0 AND 10000),prepared_rows integer NOT NULL DEFAULT 0 CHECK(prepared_rows>=0 AND prepared_rows<=expected_rows),
 payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 4096 AND 8388608),cursor_at timestamptz,cursor_id uuid,
 state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','READY','NEEDS_ATTENTION','DEAD_LETTER','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1,failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),error_code text,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id)
);
CREATE INDEX google_export_actor_idx ON google_export_job(actor_id,id DESC);
CREATE INDEX google_export_work_idx ON google_export_job(next_run_at,id) WHERE state='WAITING';
CREATE INDEX google_export_expiry_idx ON google_export_job(expires_at,id) WHERE state NOT IN ('EXPIRED','CANCELLED');
CREATE TABLE google_export_row (
 job_id uuid NOT NULL REFERENCES google_export_job(id),row_number integer NOT NULL CHECK(row_number BETWEEN 1 AND 10000),lead_id uuid NOT NULL REFERENCES lead(id),
 branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),cells jsonb NOT NULL CHECK(google_export_cells_valid(cells)),
 payload_bytes integer NOT NULL,page_version integer NOT NULL,recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(job_id,row_number),UNIQUE(job_id,lead_id)
);
CREATE INDEX google_export_row_page_idx ON google_export_row(job_id,page_version);
CREATE TABLE google_export_history (
 job_id uuid NOT NULL REFERENCES google_export_job(id),version integer NOT NULL,state text NOT NULL,prepared_rows integer NOT NULL,payload_bytes integer NOT NULL,
 failures integer NOT NULL,error_code text,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(job_id,version)
);
CREATE FUNCTION google_export_allowed(j google_export_job,approval boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p lead_export_job;r google_resource;c integration_connection;
BEGIN
 SELECT * INTO c FROM integration_connection WHERE id=j.connection_id FOR SHARE;
 SELECT * INTO r FROM google_resource WHERE id=j.resource_id FOR SHARE;
 SELECT * INTO p FROM lead_export_job WHERE id=j.source_export_id FOR SHARE;
 IF p.id IS NULL OR r.id IS NULL OR c.id IS NULL OR p.state<>'DONE' OR p.expires_at<=clock_timestamp() OR NOT lead_export_actor_current(p)
  OR (p.organization_id,p.actor_id,p.actor_role,p.branch_scope) IS DISTINCT FROM (j.organization_id,j.actor_id,j.actor_role,j.branch_scope)
  OR p.row_count<>j.expected_rows OR j.fields_snapshot IS DISTINCT FROM google_export_fields(p) OR j.header_cells IS DISTINCT FROM google_export_header(p)
  OR r.connection_id<>c.id OR r.spreadsheet_id<>j.spreadsheet_id OR r.version<>j.resource_version OR c.version<>j.connection_version
  OR r.connection_version<>c.version OR NOT google_export_target_allowed(p,r.id) THEN RETURN false;END IF;
 PERFORM id FROM user_account WHERE id=j.actor_id AND active AND role=j.actor_role AND branch_id IS NOT DISTINCT FROM j.branch_scope FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF approval THEN
  PERFORM id FROM user_session WHERE id=j.approval_session_id AND user_id=j.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
CREATE FUNCTION guard_google_export_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p lead_export_job;n integer;lo integer;hi integer;bytes integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_HISTORY_RETAINED';END IF;
 PERFORM id FROM integration_connection WHERE id=NEW.connection_id FOR UPDATE;
 SELECT * INTO p FROM lead_export_job WHERE id=NEW.source_export_id FOR SHARE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'WAITING' OR NEW.version<>1 OR NEW.prepared_rows<>0 OR NEW.failures<>0 OR NEW.error_code IS NOT NULL OR NEW.cursor_at IS NOT NULL OR NEW.cursor_id IS NOT NULL
   OR NEW.payload_bytes<>4096+google_export_cell_bytes(NEW.header_cells) OR NOT google_export_allowed(NEW,true) OR NOT lead_export_manifest_visible(p)
   OR NEW.expires_at<=statement_timestamp() OR NEW.expires_at>LEAST(p.expires_at,statement_timestamp()+interval '24 hours')
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action='GOOGLE_EXPORT_REQUESTED' AND a.target_type='GOOGLE_EXPORT' AND a.target_id=NEW.id::text
    AND a.organization_id=NEW.organization_id AND a.actor_user_id=NEW.actor_id AND a.detail->>'sessionId'=NEW.approval_session_id::text
    AND a.detail->>'requestId'=NEW.request_id::text AND a.detail->>'resourceId'=NEW.resource_id::text AND ai_row_inserted_here(a.xmin))
   THEN RAISE EXCEPTION 'GOOGLE_EXPORT_CURRENT_APPROVAL_REQUIRED';END IF;
  NEW.created_at=statement_timestamp();
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','prepared_rows','payload_bytes','cursor_at','cursor_id','failures','error_code','reason','next_run_at','updated_at','recorded_xid','approval_session_id'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','prepared_rows','payload_bytes','cursor_at','cursor_id','failures','error_code','reason','next_run_at','updated_at','recorded_xid','approval_session_id'])
   OR NEW.version<>OLD.version+1 OR OLD.state IN ('CANCELLED','EXPIRED') OR NEW.prepared_rows<OLD.prepared_rows
   THEN RAISE EXCEPTION 'GOOGLE_EXPORT_IDENTITY_IMMUTABLE';END IF;
  IF NEW.state='EXPIRED' THEN
   IF OLD.expires_at>clock_timestamp() OR NEW.approval_session_id<>OLD.approval_session_id THEN RAISE EXCEPTION 'GOOGLE_EXPORT_NOT_EXPIRED';END IF;
  ELSIF NEW.state='CANCELLED' OR OLD.state IN ('NEEDS_ATTENTION','DEAD_LETTER') AND NEW.state='WAITING' THEN
   PERFORM id FROM user_account WHERE id=NEW.actor_id AND organization_id=NEW.organization_id AND active AND role=NEW.actor_role AND branch_id IS NOT DISTINCT FROM NEW.branch_scope FOR SHARE;
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM user_session WHERE id=NEW.approval_session_id AND user_id=NEW.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.action=CASE WHEN NEW.state='CANCELLED' THEN 'GOOGLE_EXPORT_CANCELLED' ELSE 'GOOGLE_EXPORT_RECOVERED' END
     AND a.target_type='GOOGLE_EXPORT' AND a.organization_id=NEW.organization_id AND a.target_id=NEW.id::text AND a.actor_user_id=NEW.actor_id AND a.detail->>'sessionId'=NEW.approval_session_id::text AND ai_row_inserted_here(a.xmin)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_ACTION_APPROVAL_REQUIRED';END IF;
   IF NEW.state='WAITING' AND (NEW.failures<>0 OR NOT google_export_allowed(NEW,true) OR NOT lead_export_manifest_visible(p)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_CURRENT_APPROVAL_REQUIRED';END IF;
  ELSE
   IF NEW.approval_session_id<>OLD.approval_session_id OR OLD.state<>'WAITING' OR NEW.state NOT IN ('WAITING','READY','NEEDS_ATTENTION','DEAD_LETTER') THEN RAISE EXCEPTION 'GOOGLE_EXPORT_TRANSITION_INVALID';END IF;
  END IF;
  IF NEW.prepared_rows>OLD.prepared_rows THEN
   IF OLD.state<>'WAITING' OR NEW.state NOT IN ('WAITING','READY') OR NEW.prepared_rows-OLD.prepared_rows>100 OR NOT google_export_allowed(NEW) OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'GOOGLE_EXPORT_CURRENT_PAGE_REQUIRED';END IF;
   SELECT count(*),min(row_number),max(row_number),COALESCE(sum(payload_bytes),0) INTO n,lo,hi,bytes FROM google_export_row
    WHERE job_id=NEW.id AND page_version=NEW.version AND recorded_xid=pg_current_xact_id();
   IF n<>NEW.prepared_rows-OLD.prepared_rows OR lo<>OLD.prepared_rows+1 OR hi<>NEW.prepared_rows OR NEW.payload_bytes<>OLD.payload_bytes+bytes THEN RAISE EXCEPTION 'GOOGLE_EXPORT_COMPLETE_PAGE_REQUIRED';END IF;
   IF NOT EXISTS(SELECT 1 FROM google_export_row r JOIN lead l ON l.id=r.lead_id WHERE r.job_id=NEW.id AND r.row_number=NEW.prepared_rows
    AND r.lead_id=NEW.cursor_id AND l.created_at=NEW.cursor_at AND r.recorded_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_CURSOR_REQUIRED';END IF;
  ELSIF (NEW.payload_bytes,NEW.cursor_at,NEW.cursor_id) IS DISTINCT FROM (OLD.payload_bytes,OLD.cursor_at,OLD.cursor_id) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_COMPLETE_PAGE_REQUIRED';END IF;
  IF NEW.state='READY' AND (NEW.prepared_rows<>NEW.expected_rows OR NOT google_export_allowed(NEW) OR NOT lead_export_manifest_visible(p) OR NEW.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_COMPLETE_PAGE_REQUIRED';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_export_job_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_job FOR EACH ROW EXECUTE FUNCTION guard_google_export_job();
CREATE FUNCTION guard_google_export_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j google_export_job;p lead_export_job;l lead;
BEGIN
 SELECT * INTO j FROM google_export_job WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.job_id ELSE NEW.job_id END;
 IF TG_OP='DELETE' THEN IF j.state NOT IN ('CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'GOOGLE_EXPORT_ROWS_RETAINED';END IF;RETURN OLD;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GOOGLE_EXPORT_ROWS_IMMUTABLE';END IF;
 SELECT * INTO p FROM lead_export_job WHERE id=j.source_export_id;SELECT * INTO l FROM lead WHERE id=NEW.lead_id FOR SHARE;
 IF j.state<>'WAITING' OR j.expires_at<=clock_timestamp() OR NOT google_export_allowed(j) OR NOT lead_export_lead_visible(p,l)
  OR NOT EXISTS(SELECT 1 FROM lead_export_member m WHERE m.job_id=p.id AND m.lead_id=l.id AND (m.branch_id,m.campaign_id)=(NEW.branch_id,NEW.campaign_id) AND (l.branch_id,l.campaign_id)=(m.branch_id,m.campaign_id))
  OR NEW.page_version<>j.version+1 OR jsonb_array_length(NEW.cells)<>jsonb_array_length(j.header_cells) OR NEW.payload_bytes<>google_export_cell_bytes(NEW.cells)
  OR NEW.row_number NOT BETWEEN j.prepared_rows+1 AND j.prepared_rows+100 THEN RAISE EXCEPTION 'GOOGLE_EXPORT_CURRENT_ROW_REQUIRED';END IF;
 NEW.recorded_xid=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER google_export_row_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_row FOR EACH ROW EXECUTE FUNCTION guard_google_export_row();
CREATE FUNCTION record_google_export_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO google_export_history(job_id,version,state,prepared_rows,payload_bytes,failures,error_code,reason) VALUES(NEW.id,NEW.version,NEW.state,NEW.prepared_rows,NEW.payload_bytes,NEW.failures,NEW.error_code,NEW.reason);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_scope,NEW.actor_id,'GOOGLE_EXPORT_STATE','GOOGLE_EXPORT',NEW.id,
  jsonb_build_object('version',NEW.version,'state',NEW.state,'preparedRows',NEW.prepared_rows,'failures',NEW.failures,'errorCode',NEW.error_code));RETURN NEW;
END $$;
CREATE TRIGGER google_export_job_record AFTER INSERT OR UPDATE ON google_export_job FOR EACH ROW EXECUTE FUNCTION record_google_export_job();
CREATE FUNCTION guard_google_export_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM google_export_job j WHERE j.id=NEW.job_id AND j.version=NEW.version AND j.recorded_xid=pg_current_xact_id()
  AND (j.state,j.prepared_rows,j.payload_bytes,j.failures,j.error_code,j.reason) IS NOT DISTINCT FROM (NEW.state,NEW.prepared_rows,NEW.payload_bytes,NEW.failures,NEW.error_code,NEW.reason)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER google_export_history_guard BEFORE INSERT OR UPDATE OR DELETE ON google_export_history FOR EACH ROW EXECUTE FUNCTION guard_google_export_history();
CREATE FUNCTION require_google_export_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM google_export_history h WHERE h.job_id=NEW.job_id AND h.version=NEW.page_version AND h.prepared_rows>=NEW.row_number
  AND h.state IN ('WAITING','READY') AND ai_row_inserted_here(h.xmin)) THEN RAISE EXCEPTION 'GOOGLE_EXPORT_COMPLETE_PAGE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER google_export_page_complete AFTER INSERT ON google_export_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_google_export_page();
