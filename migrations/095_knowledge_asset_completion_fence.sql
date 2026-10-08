ALTER TABLE ai_knowledge_asset ADD COLUMN completed_lease_token uuid;
CREATE FUNCTION guard_ai_knowledge_asset_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.completed_lease_token IS NOT NULL THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_COMPLETION_FENCE_REQUIRED';END IF;
  ELSIF NEW.state='RUNNING' THEN
    IF NEW.completed_lease_token IS NOT NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_COMPLETION_FENCE_REQUIRED';END IF;
  ELSIF OLD.state='RUNNING' THEN
    IF NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token THEN RAISE EXCEPTION 'AI_KNOWLEDGE_ASSET_COMPLETION_FENCE_REQUIRED';END IF;
  END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_knowledge_asset_completion_fence BEFORE INSERT OR UPDATE ON ai_knowledge_asset FOR EACH ROW EXECUTE FUNCTION guard_ai_knowledge_asset_completion();
