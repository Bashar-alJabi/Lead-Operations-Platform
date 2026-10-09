-- Human qualification capture uses current Field values; history preserves the actual collected answer.
CREATE TABLE lead_qualification_request (
  lead_id uuid NOT NULL REFERENCES lead(id), actor_id uuid NOT NULL REFERENCES user_account(id), session_id uuid NOT NULL REFERENCES user_session(id),
  request_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), question_id uuid NOT NULL,
  qualification_version integer NOT NULL CHECK(qualification_version>0), answer_version integer NOT NULL CHECK(answer_version>0),
  field_value_version integer CHECK(field_value_version>=0), question_snapshot jsonb NOT NULL, value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(lead_id,actor_id,request_id)
);
CREATE TABLE lead_qualification_answer (
  lead_id uuid NOT NULL REFERENCES lead(id), campaign_id uuid NOT NULL REFERENCES campaign(id), question_id uuid NOT NULL,
  qualification_version integer NOT NULL CHECK(qualification_version>0), version integer NOT NULL CHECK(version>0),
  value jsonb NOT NULL, source text NOT NULL CHECK(source='HUMAN'), field_id uuid REFERENCES field_definition(id), field_value_version integer,
  actor_id uuid NOT NULL REFERENCES user_account(id), session_id uuid NOT NULL REFERENCES user_session(id), request_id uuid NOT NULL,
  question_snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(lead_id,question_id),
  FOREIGN KEY(lead_id,actor_id,request_id) REFERENCES lead_qualification_request(lead_id,actor_id,request_id),
  CHECK(field_id IS NULL AND field_value_version IS NULL OR field_id IS NOT NULL AND field_value_version IS NOT NULL AND field_value_version>0)
);
CREATE TABLE lead_qualification_answer_history (
  lead_id uuid NOT NULL,question_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(lead_id,question_id,version),
  FOREIGN KEY(lead_id,question_id) REFERENCES lead_qualification_answer(lead_id,question_id)
);
CREATE INDEX lead_qualification_request_actor ON lead_qualification_request(actor_id,created_at DESC);

CREATE FUNCTION qualification_capture_access(lid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE l record;BEGIN
  SELECT id,branch_id,organization_id,assigned_agent_id INTO l FROM lead WHERE id=lid FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM 1 FROM branch b JOIN user_account u ON u.id=uid JOIN user_session s ON s.id=sid AND s.user_id=u.id
    WHERE b.id=l.branch_id AND b.active AND u.active AND u.organization_id=l.organization_id AND b.organization_id=l.organization_id
      AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=l.branch_id OR u.role='AGENT' AND u.branch_id=l.branch_id AND u.id=l.assigned_agent_id)
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF b,u,s;
  RETURN FOUND;
END $$;
CREATE FUNCTION guard_qualification_request() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE config_row record;q jsonb;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'QUALIFICATION_REQUEST_IMMUTABLE';END IF;
  IF NOT qualification_capture_access(NEW.lead_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
  SELECT cfg.version,cfg.definition INTO config_row FROM ai_qualification_config cfg JOIN lead l ON l.campaign_id=cfg.campaign_id WHERE l.id=NEW.lead_id FOR SHARE OF cfg;
  IF NOT FOUND OR config_row.version<>NEW.qualification_version OR config_row.definition->>'enabled'<>'true' THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_DEFINITION_REQUIRED';END IF;
  SELECT item INTO q FROM jsonb_array_elements(config_row.definition->'questions') item WHERE item->>'id'=NEW.question_id::text;
  IF q IS NULL OR q<>NEW.question_snapshot THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_QUESTION_REQUIRED';END IF;
  IF NEW.answer_version<>COALESCE((SELECT version FROM lead_qualification_answer WHERE lead_id=NEW.lead_id AND question_id=NEW.question_id),0)+1 THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_VERSION_REQUIRED';END IF;
  IF q->'fieldId'='null'::jsonb THEN
    IF NEW.field_value_version IS NOT NULL OR NEW.value<>'null'::jsonb AND (jsonb_typeof(NEW.value)<>'string' OR length(NEW.value#>>'{}')>4000 OR trim(NEW.value#>>'{}')='' OR translate(NEW.value#>>'{}',E'\n\r\t','') ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'QUALIFICATION_TEXT_INVALID';END IF;
  ELSE
    IF NEW.field_value_version IS NULL OR NOT EXISTS(SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id JOIN user_account u ON u.id=NEW.actor_id JOIN lead l ON l.id=NEW.lead_id
      WHERE cf.campaign_id=l.campaign_id AND fd.id=(q->>'fieldId')::uuid AND fd.organization_id=l.organization_id
        AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id)
        AND fd.active AND cf.active AND cf.usable_by_ai AND fd.value_mode='MANUAL'
        AND (u.role='SUPER_ADMIN' OR (cf.show_in_details OR cf.show_in_table) AND (u.role='MANAGER' AND cf.visible_to_manager AND cf.editable_by_manager OR u.role='AGENT' AND cf.visible_to_agent AND cf.editable_by_agent))
        AND COALESCE((SELECT version FROM lead_field_value WHERE lead_id=l.id AND field_id=fd.id),0)=NEW.field_value_version) THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_FIELD_REQUIRED';END IF;
  END IF;
  NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER qualification_request_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_qualification_request FOR EACH ROW EXECUTE FUNCTION guard_qualification_request();

CREATE FUNCTION guard_qualification_answer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r record;l record;BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_HISTORY_RETAINED';END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.lead_id,NEW.campaign_id,NEW.question_id) IS DISTINCT FROM (OLD.lead_id,OLD.campaign_id,OLD.question_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_VERSION_REQUIRED';END IF;
  IF NOT qualification_capture_access(NEW.lead_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
  SELECT * INTO r FROM lead_qualification_request WHERE lead_id=NEW.lead_id AND actor_id=NEW.actor_id AND request_id=NEW.request_id;
  SELECT id,campaign_id,branch_id,lifecycle INTO l FROM lead WHERE id=NEW.lead_id;
  IF r IS NULL OR l.campaign_id<>NEW.campaign_id OR (r.question_id,r.qualification_version,r.answer_version,r.value,r.session_id,r.question_snapshot) IS DISTINCT FROM
    (NEW.question_id,NEW.qualification_version,NEW.version,NEW.value,NEW.session_id,NEW.question_snapshot) OR NEW.source<>'HUMAN'
    OR NEW.field_id IS DISTINCT FROM (NEW.question_snapshot->>'fieldId')::uuid THEN RAISE EXCEPTION 'QUALIFICATION_REQUEST_PROOF_REQUIRED';END IF;
  PERFORM 1 FROM ai_qualification_config cfg WHERE cfg.campaign_id=l.campaign_id AND cfg.version=NEW.qualification_version AND cfg.definition->>'enabled'='true'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.definition->'questions') item WHERE item=NEW.question_snapshot) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUALIFICATION_CURRENT_DEFINITION_REQUIRED';END IF;
  IF NEW.field_id IS NOT NULL THEN
    PERFORM 1 FROM lead_field_value v JOIN field_definition fd ON fd.id=v.field_id JOIN campaign_field cf ON cf.campaign_id=l.campaign_id AND cf.field_id=fd.id JOIN user_account u ON u.id=NEW.actor_id
      WHERE v.lead_id=NEW.lead_id AND v.field_id=NEW.field_id AND v.value=NEW.value AND v.source='MANUAL' AND v.updated_by=NEW.actor_id
        AND v.version=NEW.field_value_version AND NEW.field_value_version=r.field_value_version+1 AND fd.organization_id=u.organization_id
        AND fd.active AND cf.active AND cf.usable_by_ai AND fd.value_mode='MANUAL'
        AND (u.role='SUPER_ADMIN' OR (cf.show_in_details OR cf.show_in_table) AND (u.role='MANAGER' AND cf.visible_to_manager AND cf.editable_by_manager OR u.role='AGENT' AND cf.visible_to_agent AND cf.editable_by_agent))
        AND NOT(NEW.value='null'::jsonb AND cf.required_stage='CLOSE' AND l.lifecycle='CLOSED') FOR SHARE OF v,fd,cf;
    IF NOT FOUND THEN RAISE EXCEPTION 'QUALIFICATION_FIELD_VALUE_PROOF_REQUIRED';END IF;
  ELSIF NEW.field_value_version IS NOT NULL THEN RAISE EXCEPTION 'QUALIFICATION_FIELD_VALUE_PROOF_REQUIRED';END IF;
  NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER qualification_answer_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_qualification_answer FOR EACH ROW EXECUTE FUNCTION guard_qualification_answer();
CREATE FUNCTION guard_qualification_answer_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM lead_qualification_answer a WHERE a.lead_id=NEW.lead_id AND a.question_id=NEW.question_id AND a.version=NEW.version AND to_jsonb(a)=NEW.snapshot) THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_HISTORY_IMMUTABLE';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qualification_answer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_qualification_answer_history FOR EACH ROW EXECUTE FUNCTION guard_qualification_answer_history();
CREATE FUNCTION record_qualification_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO lead_qualification_answer_history(lead_id,question_id,version,snapshot) VALUES(NEW.lead_id,NEW.question_id,NEW.version,to_jsonb(NEW));
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT l.organization_id,l.branch_id,NEW.actor_id,'QUALIFICATION_ANSWER_COLLECTED','LEAD',l.id,
    jsonb_build_object('questionId',NEW.question_id,'definitionVersion',NEW.qualification_version,'answerVersion',NEW.version,'source',NEW.source) FROM lead l WHERE l.id=NEW.lead_id;
  INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(NEW.lead_id,NEW.actor_id,'QUALIFICATION_ANSWER_COLLECTED',jsonb_build_object('questionId',NEW.question_id,'answerVersion',NEW.version,'source',NEW.source));
  RETURN NEW;
END $$;
CREATE TRIGGER qualification_answer_record AFTER INSERT OR UPDATE ON lead_qualification_answer FOR EACH ROW EXECUTE FUNCTION record_qualification_answer();
CREATE FUNCTION complete_qualification_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM lead_qualification_answer_history h WHERE h.lead_id=NEW.lead_id AND h.question_id=NEW.question_id AND h.version=NEW.answer_version
    AND h.snapshot->>'actor_id'=NEW.actor_id::text AND h.snapshot->>'request_id'=NEW.request_id::text AND h.snapshot->'value'=NEW.value AND h.snapshot->'question_snapshot'=NEW.question_snapshot) THEN RAISE EXCEPTION 'QUALIFICATION_CAPTURE_ATOMIC_PROOF_REQUIRED';END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER qualification_request_complete AFTER INSERT ON lead_qualification_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_qualification_request();
