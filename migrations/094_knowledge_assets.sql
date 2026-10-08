CREATE FUNCTION ai_knowledge_manager_access(cid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM campaign c JOIN branch b ON b.id=c.branch_id JOIN user_account u ON u.id=uid
    JOIN user_session s ON s.id=sid AND s.user_id=u.id WHERE c.id=cid AND b.active AND u.active AND u.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
$$;
CREATE TABLE ai_knowledge_asset (
  id uuid PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES campaign(id),uploaded_by uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),upload_key uuid NOT NULL,
  label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200 AND label !~ '[[:cntrl:]]'),mime_type text NOT NULL CHECK(mime_type IN ('text/plain','application/pdf','image/png','image/jpeg')),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
  storage_key text NOT NULL UNIQUE,storage_backend text NOT NULL CHECK(storage_backend IN ('LOCAL','S3')),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','REVIEW','REJECTED','FAILED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,
  scanner_version text CHECK(length(scanner_version) BETWEEN 1 AND 255),scanned_at timestamptz,extracted_text text CHECK(octet_length(extracted_text)<=32768),error_code text CHECK(error_code ~ '^[A-Z_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(campaign_id,uploaded_by,upload_key),UNIQUE(campaign_id,id),CHECK(storage_key=id::text||'-'||content_sha256),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((state='REVIEW')=(scanner_version IS NOT NULL AND scanned_at IS NOT NULL)),
  CHECK(extracted_text IS NULL OR (state='REVIEW' AND mime_type='text/plain'))
);
CREATE INDEX ai_knowledge_asset_queue ON ai_knowledge_asset(available_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX ai_knowledge_asset_campaign ON ai_knowledge_asset(campaign_id,id);
CREATE TABLE ai_knowledge_asset_history (
  asset_id uuid NOT NULL REFERENCES ai_knowledge_asset(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(asset_id,version)
);
CREATE FUNCTION guard_ai_knowledge_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_HISTORY_RETAINED';END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.error_code IS NOT NULL OR NEW.extracted_text IS NOT NULL
      OR NOT ai_knowledge_manager_access(NEW.campaign_id,NEW.uploaded_by,NEW.session_id) THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_CURRENT_UPLOAD_REQUIRED';END IF;
  ELSE
    IF (NEW.id,NEW.campaign_id,NEW.uploaded_by,NEW.session_id,NEW.upload_key,NEW.label,NEW.mime_type,NEW.content_sha256,NEW.size_bytes,NEW.storage_key,NEW.storage_backend,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.campaign_id,OLD.uploaded_by,OLD.session_id,OLD.upload_key,OLD.label,OLD.mime_type,OLD.content_sha256,OLD.size_bytes,OLD.storage_key,OLD.storage_backend,OLD.created_at)
      OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_IDENTITY_IMMUTABLE';END IF;
    IF OLD.state IN ('REVIEW','REJECTED','FAILED') OR NOT (
      NEW.state='RUNNING' AND (OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<clock_timestamp())
        AND NEW.attempt_count=OLD.attempt_count+1 AND NEW.lease_until>clock_timestamp() AND NEW.lease_until<=clock_timestamp()+interval '125 seconds'
      OR OLD.state='RUNNING' AND OLD.lease_until>clock_timestamp() AND NEW.state IN ('QUEUED','REVIEW','REJECTED','FAILED') AND NEW.attempt_count=OLD.attempt_count
      OR OLD.state='RUNNING' AND OLD.lease_until<clock_timestamp() AND OLD.attempt_count=5 AND NEW.state='FAILED' AND NEW.attempt_count=5
    ) THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_TRANSITION_INVALID';END IF;
    IF NEW.state='REVIEW' AND NOT EXISTS(SELECT 1 FROM campaign c JOIN branch b ON b.id=c.branch_id JOIN user_account u ON u.id=NEW.uploaded_by
      WHERE c.id=NEW.campaign_id AND b.active AND u.active AND u.organization_id=c.organization_id AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=c.branch_id))
      THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_CURRENT_REQUESTER_REQUIRED';END IF;
  END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_asset FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset();
CREATE FUNCTION guard_ai_knowledge_asset_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_knowledge_asset a WHERE a.id=NEW.asset_id AND a.version=NEW.version AND (to_jsonb(a)-'extracted_text')=NEW.snapshot)
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_asset_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_asset_history FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset_history();
CREATE FUNCTION record_ai_knowledge_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_knowledge_asset_history(asset_id,version,snapshot) VALUES(NEW.id,NEW.version,to_jsonb(NEW)-'extracted_text');
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,c.branch_id,CASE WHEN TG_OP='INSERT' THEN NEW.uploaded_by ELSE NULL END,'AI_KNOWLEDGE_ASSET_'||NEW.state,'AI_KNOWLEDGE_ASSET',NEW.id,
      jsonb_build_object('campaignId',NEW.campaign_id,'version',NEW.version,'state',NEW.state,'attempt',NEW.attempt_count,'errorCode',NEW.error_code) FROM campaign c WHERE c.id=NEW.campaign_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_asset_record AFTER INSERT OR UPDATE ON ai_knowledge_asset FOR EACH ROW EXECUTE FUNCTION record_ai_knowledge_asset();
CREATE TABLE ai_knowledge_asset_approval (
  asset_id uuid PRIMARY KEY REFERENCES ai_knowledge_asset(id),decision text NOT NULL CHECK(decision IN ('APPROVED','REJECTED')),actor_id uuid NOT NULL REFERENCES user_account(id),
  session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_knowledge_asset_approval() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a ai_knowledge_asset;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_APPROVAL_IMMUTABLE';END IF;
  SELECT * INTO a FROM ai_knowledge_asset WHERE id=NEW.asset_id FOR UPDATE;
  IF a.state<>'REVIEW' OR NOT ai_knowledge_manager_access(a.campaign_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_CURRENT_REVIEW_REQUIRED';END IF;
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,c.branch_id,NEW.actor_id,'AI_KNOWLEDGE_ASSET_REVIEWED','AI_KNOWLEDGE_ASSET',a.id,
      jsonb_build_object('campaignId',a.campaign_id,'decision',NEW.decision,'reason',NEW.reason,'hash',a.content_sha256) FROM campaign c WHERE c.id=a.campaign_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_asset_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_asset_approval FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset_approval();

-- Preserve old five-key versions verbatim. Only new versions may add explicit asset references.
ALTER FUNCTION ai_knowledge_content_valid(jsonb) RENAME TO ai_knowledge_content_v1_valid;
CREATE FUNCTION ai_knowledge_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
  IF NOT ai_knowledge_content_v1_valid(c-'assets') THEN RETURN false;END IF;
  IF NOT c ? 'assets' THEN RETURN true;END IF;
  IF jsonb_typeof(c->'assets')<>'array' OR jsonb_array_length(c->'assets')>10 THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'assets') a WHERE jsonb_typeof(a)<>'string' OR (a#>>'{}') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    OR (SELECT count(DISTINCT a) FROM jsonb_array_elements(c->'assets') a)<>jsonb_array_length(c->'assets') THEN RETURN false;END IF;
  RETURN octet_length(c::text)<=65536;EXCEPTION WHEN others THEN RETURN false;END $$;
ALTER TABLE ai_knowledge_draft DROP CONSTRAINT ai_knowledge_draft_content_check;
ALTER TABLE ai_knowledge_draft ADD CHECK(ai_knowledge_content_valid(content));
CREATE FUNCTION guard_ai_knowledge_asset_refs() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE aid text;BEGIN
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  FOR aid IN SELECT jsonb_array_elements_text(COALESCE(NEW.content->'assets','[]')) ORDER BY 1 LOOP
    PERFORM 1 FROM ai_knowledge_asset a JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id WHERE a.id=aid::uuid AND a.campaign_id=NEW.campaign_id AND a.state='REVIEW' AND p.decision='APPROVED' FOR SHARE OF a,p;
    IF NOT FOUND THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_APPROVAL_REQUIRED';END IF;
  END LOOP;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_draft_assets BEFORE INSERT OR UPDATE ON ai_knowledge_draft FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset_refs();
CREATE TABLE ai_knowledge_publication_asset (
  campaign_id uuid NOT NULL,version integer NOT NULL,asset_id uuid NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(campaign_id,version,asset_id),
  FOREIGN KEY(campaign_id,version) REFERENCES ai_knowledge_publication(campaign_id,version),FOREIGN KEY(campaign_id,asset_id) REFERENCES ai_knowledge_asset(campaign_id,id)
);
CREATE FUNCTION ai_knowledge_asset_manifest(a ai_knowledge_asset,p ai_knowledge_asset_approval) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id',a.id,'label',a.label,'mime',a.mime_type,'sizeBytes',a.size_bytes,'sha256',a.content_sha256,'scannerVersion',a.scanner_version,'scannedAt',a.scanned_at,
    'extractedText',a.extracted_text,'approvedBy',p.actor_id,'approvedAt',p.created_at,'approvalReason',p.reason)
$$;
CREATE FUNCTION guard_ai_knowledge_manifest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_knowledge_publication v JOIN ai_knowledge_asset a ON a.campaign_id=v.campaign_id JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id
    WHERE v.campaign_id=NEW.campaign_id AND v.version=NEW.version AND a.id=NEW.asset_id AND v.content->'assets' ? a.id::text AND p.decision='APPROVED' AND NEW.snapshot=ai_knowledge_asset_manifest(a,p))
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_MANIFEST_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_manifest_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_publication_asset FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_manifest();
CREATE FUNCTION record_ai_knowledge_manifest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_knowledge_publication_asset SELECT NEW.campaign_id,NEW.version,a.id,ai_knowledge_asset_manifest(a,p)
    FROM ai_knowledge_asset a JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id WHERE a.campaign_id=NEW.campaign_id AND NEW.content->'assets' ? a.id::text;
  RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_publication_assets BEFORE INSERT ON ai_knowledge_publication FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset_refs();
CREATE TRIGGER ai_knowledge_publication_assets_record AFTER INSERT ON ai_knowledge_publication FOR EACH ROW EXECUTE FUNCTION record_ai_knowledge_manifest();
CREATE OR REPLACE FUNCTION guard_ai_knowledge_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_KNOWLEDGE_PUBLICATION_IMMUTABLE';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF NEW.version<>(SELECT COALESCE(max(p.version),0)+1 FROM ai_knowledge_publication p WHERE p.campaign_id=NEW.campaign_id) OR
    NOT EXISTS(SELECT 1 FROM ai_knowledge_draft d JOIN campaign c ON c.id=d.campaign_id JOIN branch b ON b.id=c.branch_id JOIN user_account u ON u.id=NEW.published_by
      JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE d.campaign_id=NEW.campaign_id AND d.version=NEW.draft_version AND d.content=NEW.content
      AND b.active AND u.active AND u.organization_id=c.organization_id AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AI_KNOWLEDGE_CURRENT_PUBLICATION_REQUIRED';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(NEW.content->'sections') s WHERE length(trim(s.value))>0)
    AND jsonb_array_length(NEW.content->'faqs')=0 AND jsonb_array_length(NEW.content->'allowedClaims')=0 AND jsonb_array_length(NEW.content->'links')=0 AND jsonb_array_length(COALESCE(NEW.content->'assets','[]'))=0
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_EMPTY_PUBLICATION';END IF;RETURN NEW;END $$;
