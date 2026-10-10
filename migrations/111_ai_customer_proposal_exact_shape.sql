-- Reject SQL NULL/JSON null ambiguities and non-schema value shapes even for direct database callers.
CREATE FUNCTION guard_ai_customer_proposal_exact_shape() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r jsonb;BEGIN
 IF NEW.state<>'PROPOSED' THEN RETURN NEW;END IF;r=NEW.result;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'decision') IS DISTINCT FROM 'string' OR r->>'decision' NOT IN ('ANSWER','QUESTION','QUALIFICATION','HANDOFF')
   OR jsonb_typeof(r->'referenceIds') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'referenceIds') v WHERE jsonb_typeof(v)<>'string')
   OR jsonb_typeof(r->'questionId') NOT IN ('string','null') OR jsonb_typeof(r->'sourceQuote') NOT IN ('string','null') OR jsonb_typeof(r->'handoffReason') NOT IN ('string','null')
   OR jsonb_typeof(r->'answerValue') NOT IN ('string','number','boolean','array','null')
   OR jsonb_typeof(r->'answerValue')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r->'answerValue') v WHERE jsonb_typeof(v)<>'string')
   THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_RESULT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_proposal_exact_shape_guard BEFORE INSERT OR UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_proposal_exact_shape();
