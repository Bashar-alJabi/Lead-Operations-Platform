-- Evidence classification is not a model-supplied count, tool admission or financial fact.
CREATE OR REPLACE FUNCTION ai_customer_proposal_result_valid(r jsonb,ctx jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE q jsonb;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>10 OR NOT r ?& ARRAY['decision','referenceIds','questionId','answerValue','sourceQuote','handoffReason','protocolVersion','toolsExecuted','sendAllowed','mutationsAllowed']
   OR r->'protocolVersion'<>'1' OR r->'toolsExecuted'<>'[]' OR r->'sendAllowed'<>'false' OR r->'mutationsAllowed'<>'false'
   OR jsonb_typeof(r->'referenceIds')<>'array' OR jsonb_array_length(r->'referenceIds')>8 THEN RETURN false;END IF;
 IF (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(r->'referenceIds') id)<>jsonb_array_length(r->'referenceIds')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'referenceIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'references') ref WHERE ref->>'id'=id)) THEN RETURN false;END IF;
 IF r->>'decision'='HANDOFF' THEN
   IF jsonb_array_length(r->'referenceIds')<>0 OR r->'questionId'<>'null' OR r->'answerValue'<>'null' THEN RETURN false;END IF;
   IF r->>'handoffReason'='REPEATED_MISUNDERSTANDING' THEN RETURN jsonb_typeof(r->'sourceQuote')='string' AND length(trim(r->>'sourceQuote')) BETWEEN 1 AND 500
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'messages') m WHERE m->>'id'=ctx->'source'->>'messageId' AND m->>'speaker'='CUSTOMER' AND strpos(m->>'text',r->>'sourceQuote')>0);END IF;
   RETURN r->'sourceQuote'='null' AND r->>'handoffReason' IN ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE');
 END IF;
 IF r->>'decision'='ANSWER' THEN RETURN jsonb_array_length(r->'referenceIds')>0 AND r->'questionId'='null' AND r->'answerValue'='null' AND r->'sourceQuote'='null' AND r->'handoffReason'='null';END IF;
 IF r->>'decision' NOT IN ('QUESTION','QUALIFICATION') OR jsonb_array_length(r->'referenceIds')<>0 OR r->'handoffReason'<>'null' THEN RETURN false;END IF;
 SELECT item INTO q FROM jsonb_array_elements(ctx->'questions') item WHERE item->>'id'=r->>'questionId';IF q IS NULL THEN RETURN false;END IF;
 IF r->>'decision'='QUESTION' THEN RETURN r->'answerValue'='null' AND r->'sourceQuote'='null';END IF;
 RETURN r->'answerValue'<>'null' AND (jsonb_typeof(r->'answerValue') IN ('string','boolean','number','array') OR ai_customer_currency_candidate_valid(r,ctx)) AND length(trim(r->>'sourceQuote')) BETWEEN 1 AND 500
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(ctx->'messages') m WHERE m->>'id'=ctx->'source'->>'messageId' AND m->>'speaker'='CUSTOMER' AND strpos(m->>'text',r->>'sourceQuote')>0);
EXCEPTION WHEN others THEN RETURN false;END $$;

CREATE TABLE ai_misunderstanding_observation (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_proposal(id),
 organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),message_id uuid NOT NULL UNIQUE REFERENCES conversation_message(id),
 conversation_version integer NOT NULL CHECK(conversation_version>0),ordinal bigint NOT NULL CHECK(ordinal>0),
 threshold integer CHECK(threshold>0),handoff_required boolean NOT NULL,behavior_versions jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(conversation_id,conversation_version,branch_id,campaign_id,ordinal)
);
CREATE FUNCTION guard_ai_misunderstanding_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;ctx jsonb;handoff jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_MISUNDERSTANDING_HISTORY_IMMUTABLE';END IF;
 SELECT qp.*,qp.xmin AS written_xid INTO p FROM ai_customer_proposal qp WHERE qp.id=NEW.proposal_id;
 IF p IS NULL OR p.state<>'PROPOSED' OR NOT ai_row_inserted_here(p.written_xid) OR p.result->>'decision'<>'HANDOFF'
   OR p.result->>'handoffReason'<>'REPEATED_MISUNDERSTANDING' OR p.context->'conversation'->>'state' NOT IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD')
   OR p.context->'conversation'->'attentionReason'<>'null' THEN RAISE EXCEPTION 'AI_MISUNDERSTANDING_FRESH_SOURCE_REQUIRED';END IF;
 ctx=ai_customer_proposal_locked_context(p.event_id);
 IF ctx IS NULL OR ctx IS DISTINCT FROM p.context THEN RAISE EXCEPTION 'AI_MISUNDERSTANDING_CURRENT_SOURCE_REQUIRED';END IF;
 IF NEW.organization_id IS NOT NULL AND NEW.organization_id<>p.organization_id OR NEW.branch_id IS NOT NULL AND NEW.branch_id<>p.branch_id
   OR NEW.campaign_id IS NOT NULL AND NEW.campaign_id<>p.campaign_id OR NEW.lead_id IS NOT NULL AND NEW.lead_id<>p.lead_id
   OR NEW.conversation_id IS NOT NULL AND NEW.conversation_id<>p.conversation_id OR NEW.message_id IS NOT NULL AND NEW.message_id<>p.message_id
   THEN RAISE EXCEPTION 'AI_MISUNDERSTANDING_SCOPE_REQUIRED';END IF;
 NEW.organization_id=p.organization_id;NEW.branch_id=p.branch_id;NEW.campaign_id=p.campaign_id;NEW.lead_id=p.lead_id;NEW.conversation_id=p.conversation_id;NEW.message_id=p.message_id;
 NEW.conversation_version=(ctx->'conversation'->>'version')::integer;
 -- A technical per-Conversation lock serializes the indexed ordinal; it grants no Domain authority.
 PERFORM pg_advisory_xact_lock(hashtextextended('ai-misunderstanding:'||p.conversation_id::text,0));
 SELECT COALESCE((SELECT ordinal FROM ai_misunderstanding_observation WHERE conversation_id=p.conversation_id AND conversation_version=NEW.conversation_version
   AND branch_id=p.branch_id AND campaign_id=p.campaign_id ORDER BY ordinal DESC LIMIT 1),0)+1 INTO NEW.ordinal;
 SELECT COALESCE(NULLIF(c.definition->'handoff','null'),NULLIF(b.definition->'handoff','null')) INTO handoff
   FROM (SELECT 1) anchor LEFT JOIN ai_behavior_policy b ON b.scope='BRANCH' AND b.resource_id=p.branch_id
   LEFT JOIN ai_behavior_policy c ON c.scope='CAMPAIGN' AND c.resource_id=p.campaign_id;
 NEW.threshold=(handoff->>'misunderstandingLimit')::integer;
 -- Matches existing Behavior Preview: an unset limit does not delay an evidenced repeated-misunderstanding handoff.
 NEW.handoff_required=NEW.threshold IS NULL OR NEW.ordinal>=NEW.threshold;NEW.behavior_versions=ctx->'behavior';NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_misunderstanding_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_misunderstanding_observation FOR EACH ROW EXECUTE FUNCTION guard_ai_misunderstanding_observation();
CREATE FUNCTION record_ai_misunderstanding_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
 VALUES(NEW.organization_id,NEW.branch_id,'AI_MISUNDERSTANDING_OBSERVED','AI_CUSTOMER_PROPOSAL',NEW.proposal_id,
   jsonb_build_object('conversationId',NEW.conversation_id,'sourceMessageId',NEW.message_id,'conversationVersion',NEW.conversation_version,
     'ordinal',NEW.ordinal::text,'threshold',NEW.threshold,'handoffRequired',NEW.handoff_required,'behaviorVersions',NEW.behavior_versions));RETURN NEW;
END $$;
CREATE TRIGGER ai_misunderstanding_observation_record AFTER INSERT ON ai_misunderstanding_observation FOR EACH ROW EXECUTE FUNCTION record_ai_misunderstanding_observation();
CREATE FUNCTION observe_ai_customer_misunderstanding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision'='HANDOFF' AND NEW.result->>'handoffReason'='REPEATED_MISUNDERSTANDING' THEN
   INSERT INTO ai_misunderstanding_observation(proposal_id) VALUES(NEW.id);
 END IF;RETURN NEW;
END $$;
-- Runs before the existing Handoff enqueue trigger, in the same fresh inference-completion transaction.
CREATE TRIGGER aa_ai_customer_misunderstanding_observe AFTER UPDATE ON ai_customer_proposal FOR EACH ROW EXECUTE FUNCTION observe_ai_customer_misunderstanding();
CREATE FUNCTION ai_misunderstanding_handoff_ready(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM ai_misunderstanding_observation WHERE proposal_id=pid AND handoff_required)
$$;
CREATE OR REPLACE FUNCTION enqueue_ai_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='PROPOSED' AND NEW.result->>'decision'='HANDOFF' AND EXISTS(SELECT 1 FROM ai_customer_handoff_admission WHERE proposal_id=NEW.id)
   AND (NEW.result->>'handoffReason'<>'REPEATED_MISUNDERSTANDING' OR ai_misunderstanding_handoff_ready(NEW.id)) THEN
   INSERT INTO ai_customer_handoff_job(proposal_id) VALUES(NEW.id);
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_ai_handoff_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM ai_customer_proposal qp JOIN ai_customer_handoff_admission adm ON adm.proposal_id=qp.id
     WHERE qp.id=NEW.proposal_id AND qp.state='PROPOSED' AND (qp.result->>'decision'='HANDOFF'
       AND (qp.result->>'handoffReason'<>'REPEATED_MISUNDERSTANDING' OR EXISTS(SELECT 1 FROM ai_misunderstanding_observation o WHERE o.proposal_id=qp.id AND o.handoff_required AND ai_row_inserted_here(o.xmin)))
       OR qp.result->>'decision'='QUALIFICATION' AND EXISTS(SELECT 1 FROM ai_qualification_handoff_source s WHERE s.proposal_id=qp.id AND ai_row_inserted_here(s.xmin))))
     OR EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_SOURCE_REQUIRED';END IF;
   NEW.created_at=clock_timestamp();NEW.completed_at=NULL;
 ELSE
   IF (NEW.proposal_id,NEW.created_at) IS DISTINCT FROM (OLD.proposal_id,OLD.created_at) OR OLD.state<>'QUEUED' OR NEW.state<>'DONE'
     OR NOT EXISTS(SELECT 1 FROM ai_customer_handoff_action WHERE proposal_id=NEW.proposal_id) THEN RAISE EXCEPTION 'AI_HANDOFF_JOB_RECEIPT_REQUIRED';END IF;
   NEW.completed_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
ALTER TABLE ai_customer_handoff_action DROP CONSTRAINT ai_handoff_reason;
ALTER TABLE ai_customer_handoff_action ADD CONSTRAINT ai_handoff_reason CHECK(handoff_reason IN
 ('UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE','QUALIFICATION','REPEATED_MISUNDERSTANDING'));
-- No migration replay/backfill. Existing source admission and current full-context action fences remain mandatory.
