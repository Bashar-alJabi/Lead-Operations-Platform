ALTER TABLE ai_initial_send_action ADD CONSTRAINT ai_initial_action_error_shape CHECK(error_code IS NULL OR error_code ~ '^[A-Z_]{1,100}$');
CREATE FUNCTION guard_ai_initial_fresh_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.ai_initial_action_id IS NOT NULL AND (NEW.delivery_rank<>0 OR NEW.delivery_provider_at IS NOT NULL) THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_MESSAGE_PROOF_REQUIRED';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_initial_fresh_delivery_guard BEFORE INSERT ON conversation_message FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_fresh_delivery();
ALTER FUNCTION ai_initial_execution_context(uuid,uuid,uuid) RENAME TO ai_initial_base_execution_context;
CREATE FUNCTION ai_initial_execution_context(aid uuid,cvid uuid DEFAULT NULL,mid uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;lang text;BEGIN
 ctx=ai_initial_base_execution_context(aid,cvid,mid);IF ctx IS NULL THEN RETURN NULL;END IF;
 lang=lower(split_part(replace(ctx->'initialMessage'->'approval'->'template'->>'language','_','-'),'-',1));
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(ctx->'effective'->'language'->'supported') item WHERE lower(split_part(item,'-',1))=lang) THEN RETURN NULL;END IF;RETURN ctx;
END $$;
