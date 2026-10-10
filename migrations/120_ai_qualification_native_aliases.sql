-- Keep record variables separate from SQL aliases.
CREATE OR REPLACE FUNCTION guard_ai_action_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_ACTION_ADMISSION_IMMUTABLE';END IF;
 SELECT qp.*,qp.xmin AS inserted_xid INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 ctx=ai_customer_proposal_context(NEW.event_id);
 IF p IS NULL OR p.event_id<>NEW.event_id OR p.state<>'QUEUED' OR NOT ai_row_inserted_here(p.inserted_xid)
   OR NOT ai_qualification_admissible(ctx) OR ctx IS DISTINCT FROM NEW.context OR ctx IS DISTINCT FROM p.context
   THEN RAISE EXCEPTION 'AI_ACTION_NEW_ACTIVE_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ai_customer_action_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_action_admission a ON a.proposal_id=qp.id WHERE qp.id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id FOR SHARE;
 PERFORM 1 FROM lead WHERE id=p.lead_id FOR UPDATE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id FOR UPDATE;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF NOT ai_qualification_admissible(ctx) OR ctx IS DISTINCT FROM p.context
   OR ctx IS DISTINCT FROM (SELECT context FROM ai_customer_action_admission WHERE proposal_id=pid) THEN RETURN NULL;END IF;
 RETURN ctx;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_qualification_field() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;BEGIN
 IF NEW.source<>'AI' THEN NEW.ai_action_id=NULL;RETURN NEW;END IF;
 SELECT act.*,act.xmin AS inserted_xid INTO a FROM ai_customer_action act WHERE act.id=NEW.ai_action_id AND act.state='APPLIED';
 IF a IS NULL OR NOT ai_row_inserted_here(a.inserted_xid) OR a.lead_id<>NEW.lead_id OR a.field_id IS DISTINCT FROM NEW.field_id
   OR a.value IS DISTINCT FROM NEW.value OR NEW.updated_by IS NOT NULL OR NEW.version<>a.previous_field_version+1
   OR NEW.source_submission_id IS NOT NULL OR NEW.source_binding_id IS NOT NULL OR NEW.source_mapping_version IS NOT NULL
   OR TG_OP='INSERT' AND a.previous_field_version<>0 OR TG_OP='UPDATE' AND (OLD.version<>a.previous_field_version OR (NEW.lead_id,NEW.field_id) IS DISTINCT FROM (OLD.lead_id,OLD.field_id))
   THEN RAISE EXCEPTION 'AI_FIELD_CURRENT_ACTION_REQUIRED';END IF;
 RETURN NEW;
END $$;
