CREATE FUNCTION ai_knowledge_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;entry record;BEGIN
  IF jsonb_typeof(c)<>'object' OR octet_length(c::text)>65536 OR
    (SELECT count(*) FROM jsonb_object_keys(c))<>5 OR NOT c ?& ARRAY['sections','faqs','allowedClaims','prohibitedClaims','links'] THEN RETURN false;END IF;
  IF jsonb_typeof(c->'sections')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c->'sections'))<>9 OR
    NOT (c->'sections') ?& ARRAY['description','product','prices','locations','schedules','availability','requirements','registration','policies'] THEN RETURN false;END IF;
  FOR entry IN SELECT * FROM jsonb_each(c->'sections') LOOP
    IF jsonb_typeof(entry.value)<>'string' OR length(entry.value#>>'{}')>8000 THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_typeof(c->'faqs')<>'array' OR jsonb_array_length(c->'faqs')>40 THEN RETURN false;END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(c->'faqs') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR NOT item ?& ARRAY['question','answer']
      OR jsonb_typeof(item->'question')<>'string' OR jsonb_typeof(item->'answer')<>'string' OR
      length(trim(item->>'question')) NOT BETWEEN 1 AND 500 OR length(trim(item->>'answer')) NOT BETWEEN 1 AND 4000 THEN RETURN false;END IF;
  END LOOP;
  FOR entry IN SELECT key,value FROM jsonb_each(c) WHERE key IN ('allowedClaims','prohibitedClaims') LOOP
    IF jsonb_typeof(entry.value)<>'array' OR jsonb_array_length(entry.value)>80 THEN RETURN false;END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(entry.value) LOOP
      IF jsonb_typeof(item)<>'string' OR length(trim(item#>>'{}')) NOT BETWEEN 1 AND 500 THEN RETURN false;END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(c->'links')<>'array' OR jsonb_array_length(c->'links')>30 THEN RETURN false;END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(c->'links') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR NOT item ?& ARRAY['label','url']
      OR jsonb_typeof(item->'label')<>'string' OR jsonb_typeof(item->'url')<>'string' OR length(trim(item->>'label')) NOT BETWEEN 1 AND 200
      OR length(item->>'url')>2048 OR (item->>'url') !~ '^https://[^/@[:space:]]+([/?#]|$)' THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_knowledge_draft (
  campaign_id uuid PRIMARY KEY REFERENCES campaign(id),version integer NOT NULL CHECK(version>0),content jsonb NOT NULL CHECK(ai_knowledge_content_valid(content)),
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_knowledge_revision (
  campaign_id uuid NOT NULL REFERENCES campaign(id),version integer NOT NULL,content jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),reason text NOT NULL,created_at timestamptz NOT NULL,
  PRIMARY KEY(campaign_id,version)
);
CREATE FUNCTION guard_ai_knowledge_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_KNOWLEDGE_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1)
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_VERSION_CONFLICT';END IF;
  IF NOT EXISTS(SELECT 1 FROM campaign c JOIN branch b ON b.id=c.branch_id JOIN user_account u ON u.id=NEW.actor_id
    JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE c.id=NEW.campaign_id AND b.active AND u.active AND u.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id)) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_CURRENT_ACCESS_REQUIRED';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_draft FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_draft();
CREATE FUNCTION guard_ai_knowledge_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_knowledge_draft d WHERE d.campaign_id=NEW.campaign_id AND
    (d.version,d.content,d.actor_id,d.session_id,d.reason,d.updated_at) IS NOT DISTINCT FROM (NEW.version,NEW.content,NEW.actor_id,NEW.session_id,NEW.reason,NEW.created_at))
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_REVISION_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_revision FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_revision();
CREATE FUNCTION record_ai_knowledge_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_knowledge_revision VALUES(NEW.campaign_id,NEW.version,NEW.content,NEW.actor_id,NEW.session_id,NEW.reason,NEW.updated_at);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,c.branch_id,NEW.actor_id,'AI_KNOWLEDGE_DRAFT_SAVED','CAMPAIGN',c.id,jsonb_build_object('draftVersion',NEW.version,'reason',NEW.reason) FROM campaign c WHERE c.id=NEW.campaign_id;
  RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_draft_record AFTER INSERT OR UPDATE ON ai_knowledge_draft FOR EACH ROW EXECUTE FUNCTION record_ai_knowledge_draft();
CREATE TABLE ai_knowledge_publication (
  campaign_id uuid NOT NULL REFERENCES campaign(id),version integer NOT NULL CHECK(version>0),draft_version integer NOT NULL,content jsonb NOT NULL,
  request_id uuid NOT NULL,published_by uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(campaign_id,version),UNIQUE(campaign_id,draft_version),UNIQUE(campaign_id,request_id),
  FOREIGN KEY(campaign_id,draft_version) REFERENCES ai_knowledge_revision(campaign_id,version)
);
CREATE FUNCTION guard_ai_knowledge_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_KNOWLEDGE_PUBLICATION_IMMUTABLE';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF NEW.version<>(SELECT COALESCE(max(p.version),0)+1 FROM ai_knowledge_publication p WHERE p.campaign_id=NEW.campaign_id) OR
    NOT EXISTS(SELECT 1 FROM ai_knowledge_draft d JOIN campaign c ON c.id=d.campaign_id JOIN branch b ON b.id=c.branch_id JOIN user_account u ON u.id=NEW.published_by
      JOIN user_session s ON s.id=NEW.session_id AND s.user_id=u.id WHERE d.campaign_id=NEW.campaign_id AND d.version=NEW.draft_version AND d.content=NEW.content
      AND b.active AND u.active AND u.organization_id=c.organization_id AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=c.branch_id))
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AI_KNOWLEDGE_CURRENT_PUBLICATION_REQUIRED';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(NEW.content->'sections') s WHERE length(trim(s.value))>0)
    AND jsonb_array_length(NEW.content->'faqs')=0 AND jsonb_array_length(NEW.content->'allowedClaims')=0 AND jsonb_array_length(NEW.content->'links')=0
    THEN RAISE EXCEPTION 'AI_KNOWLEDGE_EMPTY_PUBLICATION';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_knowledge_publication FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_publication();
CREATE FUNCTION record_ai_knowledge_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT c.organization_id,c.branch_id,NEW.published_by,'AI_KNOWLEDGE_PUBLISHED','CAMPAIGN',c.id,jsonb_build_object('version',NEW.version,'draftVersion',NEW.draft_version,'requestId',NEW.request_id,'reason',NEW.reason)
      FROM campaign c WHERE c.id=NEW.campaign_id;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_publication_record AFTER INSERT ON ai_knowledge_publication FOR EACH ROW EXECUTE FUNCTION record_ai_knowledge_publication();
