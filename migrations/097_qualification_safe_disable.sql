CREATE OR REPLACE FUNCTION guard_ai_qualification_config() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q jsonb;BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'QUALIFICATION_HISTORY_RETAINED';END IF;
  PERFORM 1 FROM campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'QUALIFICATION_VERSION_CONFLICT';END IF;
  IF NOT ai_knowledge_manager_access(NEW.campaign_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND NEW.definition=jsonb_set(OLD.definition,'{enabled}','false'::jsonb) THEN RETURN NEW;END IF;
  FOR q IN SELECT jsonb_array_elements(NEW.definition->'questions') LOOP
    IF q->'fieldId'<>'null'::jsonb THEN
      PERFORM 1 FROM campaign c JOIN campaign_field cf ON cf.campaign_id=c.id JOIN field_definition f ON f.id=cf.field_id JOIN user_account u ON u.id=NEW.actor_id
        WHERE c.id=NEW.campaign_id AND f.id=(q->>'fieldId')::uuid AND f.organization_id=c.organization_id AND cf.active AND f.active AND cf.usable_by_ai AND f.value_mode='MANUAL'
        AND (f.branch_id IS NULL OR f.branch_id=c.branch_id) AND (f.campaign_id IS NULL OR f.campaign_id=c.id) AND (u.role='SUPER_ADMIN' OR cf.visible_to_manager) FOR SHARE OF cf,f;
      IF NOT FOUND THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_FIELD_REQUIRED';END IF;
    END IF;
  END LOOP;RETURN NEW;END $$;