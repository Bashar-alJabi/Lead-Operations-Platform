-- Reject misrouted caller scope before deriving the current native action target.
CREATE OR REPLACE FUNCTION guard_ai_customer_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;q jsonb;f field_definition;v integer;valid boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_ACTION_IMMUTABLE';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' THEN RAISE EXCEPTION 'AI_ACTION_QUALIFICATION_SOURCE_REQUIRED';END IF;
 IF (NEW.lead_id,NEW.campaign_id,NEW.conversation_id) IS DISTINCT FROM (p.lead_id,p.campaign_id,p.conversation_id) OR NEW.context IS DISTINCT FROM p.context THEN RAISE EXCEPTION 'AI_ACTION_SCOPE_REQUIRED';END IF;
 ctx=ai_customer_action_context(p.id);
 IF ctx IS NOT NULL THEN
   SELECT cfg.version,item INTO v,q FROM ai_qualification_config cfg CROSS JOIN LATERAL jsonb_array_elements(cfg.definition->'questions') item
     WHERE cfg.campaign_id=p.campaign_id AND cfg.definition->>'enabled'='true' AND item->>'id'=p.result->>'questionId';
   IF q->>'fieldId' IS NOT NULL THEN SELECT * INTO f FROM field_definition WHERE id=(q->>'fieldId')::uuid;END IF;
   valid=q IS NOT NULL AND ai_qualification_value_valid(p.result->'answerValue',f);
 END IF;
 IF NEW.state='APPLIED' AND (ctx IS NULL OR NOT COALESCE(valid,false)) OR NEW.state='BLOCKED' AND
   (NEW.error_code='AI_ACTION_CONTEXT_CHANGED' AND ctx IS NOT NULL OR NEW.error_code='AI_ACTION_VALUE_INVALID' AND (ctx IS NULL OR COALESCE(valid,false)))
   THEN RAISE EXCEPTION 'AI_ACTION_CURRENT_AUTHORITY_REQUIRED';END IF;
 NEW.lead_id=p.lead_id;NEW.campaign_id=p.campaign_id;NEW.conversation_id=p.conversation_id;NEW.context=p.context;
 NEW.question_id=(p.result->>'questionId')::uuid;NEW.qualification_version=v;NEW.question_snapshot=q;NEW.value=p.result->'answerValue';NEW.field_id=(q->>'fieldId')::uuid;
 NEW.answer_version=COALESCE((SELECT version FROM lead_qualification_answer WHERE lead_id=p.lead_id AND question_id=NEW.question_id),0)+1;
 NEW.previous_field_version=CASE WHEN NEW.field_id IS NULL THEN NULL ELSE COALESCE((SELECT version FROM lead_field_value WHERE lead_id=p.lead_id AND field_id=NEW.field_id),0) END;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
