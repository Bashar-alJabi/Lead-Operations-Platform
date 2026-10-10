-- Match the shared typed Field contract, including CURRENCY {amount,currency}; still no Field/action authority.
CREATE OR REPLACE FUNCTION guard_ai_customer_proposal_exact_shape() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r jsonb;BEGIN
 IF NEW.state<>'PROPOSED' THEN RETURN NEW;END IF;r=NEW.result;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'decision') IS DISTINCT FROM 'string' OR r->>'decision' NOT IN ('ANSWER','QUESTION','QUALIFICATION','HANDOFF')
   OR jsonb_typeof(r->'referenceIds') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'referenceIds') v WHERE jsonb_typeof(v)<>'string')
   OR jsonb_typeof(r->'questionId') NOT IN ('string','null') OR jsonb_typeof(r->'sourceQuote') NOT IN ('string','null') OR jsonb_typeof(r->'handoffReason') NOT IN ('string','null')
   OR jsonb_typeof(r->'answerValue') NOT IN ('string','number','boolean','array','object','null')
   OR jsonb_typeof(r->'answerValue')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r->'answerValue') v WHERE jsonb_typeof(v)<>'string')
   OR jsonb_typeof(r->'answerValue')='object' AND ((SELECT count(*) FROM jsonb_object_keys(r->'answerValue'))<>2 OR NOT (r->'answerValue') ?& ARRAY['amount','currency']
     OR jsonb_typeof(r->'answerValue'->'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'answerValue'->'currency') IS DISTINCT FROM 'string')
   THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_RESULT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE FUNCTION ai_customer_currency_candidate_valid(r jsonb,ctx jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE q jsonb;v jsonb;BEGIN
 IF r->>'decision' IS DISTINCT FROM 'QUALIFICATION' OR jsonb_typeof(r->'answerValue') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 SELECT item INTO q FROM jsonb_array_elements(ctx->'questions') item WHERE item->>'id'=r->>'questionId';v=r->'answerValue';
 RETURN q->>'field_type'='CURRENCY' AND v->>'currency'=q->'validation'->>'currency' AND abs((v->>'amount')::numeric)<=1000000000000
   AND v->>'amount' ~ '^-?[0-9]+(\.[0-9]{1,6})?$' AND (q->'validation'->>'min' IS NULL OR (v->>'amount')::numeric>=(q->'validation'->>'min')::numeric)
   AND (q->'validation'->>'max' IS NULL OR (v->>'amount')::numeric<=(q->'validation'->>'max')::numeric);
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE OR REPLACE FUNCTION ai_customer_proposal_result_valid(r jsonb,ctx jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE q jsonb;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>10 OR NOT r ?& ARRAY['decision','referenceIds','questionId','answerValue','sourceQuote','handoffReason','protocolVersion','toolsExecuted','sendAllowed','mutationsAllowed']
   OR r->'protocolVersion'<>'1' OR r->'toolsExecuted'<>'[]' OR r->'sendAllowed'<>'false' OR r->'mutationsAllowed'<>'false'
   OR jsonb_typeof(r->'referenceIds')<>'array' OR jsonb_array_length(r->'referenceIds')>8 THEN RETURN false;END IF;
 IF (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(r->'referenceIds') id)<>jsonb_array_length(r->'referenceIds')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'referenceIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'references') ref WHERE ref->>'id'=id)) THEN RETURN false;END IF;
 IF r->>'decision'='HANDOFF' THEN RETURN jsonb_array_length(r->'referenceIds')=0 AND r->'questionId'='null' AND r->'answerValue'='null' AND r->'sourceQuote'='null'
   AND r->>'handoffReason' IN ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE');END IF;
 IF r->>'decision'='ANSWER' THEN RETURN jsonb_array_length(r->'referenceIds')>0 AND r->'questionId'='null' AND r->'answerValue'='null' AND r->'sourceQuote'='null' AND r->'handoffReason'='null';END IF;
 IF r->>'decision' NOT IN ('QUESTION','QUALIFICATION') OR jsonb_array_length(r->'referenceIds')<>0 OR r->'handoffReason'<>'null' THEN RETURN false;END IF;
 SELECT item INTO q FROM jsonb_array_elements(ctx->'questions') item WHERE item->>'id'=r->>'questionId';IF q IS NULL THEN RETURN false;END IF;
 IF r->>'decision'='QUESTION' THEN RETURN r->'answerValue'='null' AND r->'sourceQuote'='null';END IF;
 RETURN r->'answerValue'<>'null' AND (jsonb_typeof(r->'answerValue') IN ('string','boolean','number','array') OR ai_customer_currency_candidate_valid(r,ctx)) AND length(trim(r->>'sourceQuote')) BETWEEN 1 AND 500
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'messages') m WHERE m->>'id'=ctx->'source'->>'messageId' AND m->>'speaker'='CUSTOMER' AND strpos(m->>'text',r->>'sourceQuote')>0);
EXCEPTION WHEN others THEN RETURN false;END $$;

