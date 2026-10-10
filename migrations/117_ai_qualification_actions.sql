-- Actual tool admission is independent of diagnostic/readonly proposals and Human sessions.
CREATE FUNCTION ai_row_inserted_here(x xid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE low numeric;top numeric;BEGIN
 top=pg_current_xact_id()::text::numeric;low=mod(top,4294967296);
 RETURN pg_xact_status((top-low+x::text::numeric+CASE WHEN x::text::numeric<low THEN 4294967296 ELSE 0 END)::text::xid8)='in progress';
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION ai_qualification_admissible(ctx jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(ctx IS NOT NULL AND ctx->'conversation'->>'controller'='AI'
   AND ctx->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD')
   AND ctx->'conversation'->'attentionReason'='null'::jsonb
   AND ctx->'allowedTools' ? 'updateQualificationField' AND ctx->'qualification' IS NOT NULL
   AND jsonb_array_length(ctx->'questions')>0,false)
$$;
CREATE TABLE ai_customer_action_admission (
 proposal_id uuid PRIMARY KEY REFERENCES ai_customer_proposal(id),event_id uuid NOT NULL UNIQUE REFERENCES integration_event(id),
 context jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_action_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_ACTION_ADMISSION_IMMUTABLE';END IF;
 SELECT p.*,p.xmin AS inserted_xid INTO p FROM ai_customer_proposal p WHERE p.id=NEW.proposal_id;
 ctx=ai_customer_proposal_context(NEW.event_id);
 IF p IS NULL OR p.event_id<>NEW.event_id OR p.state<>'QUEUED' OR NOT ai_row_inserted_here(p.inserted_xid)
   OR NOT ai_qualification_admissible(ctx) OR ctx IS DISTINCT FROM NEW.context OR ctx IS DISTINCT FROM p.context
   THEN RAISE EXCEPTION 'AI_ACTION_NEW_ACTIVE_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_action_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_action_admission FOR EACH ROW EXECUTE FUNCTION guard_ai_action_admission();

CREATE TABLE ai_customer_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_id uuid NOT NULL UNIQUE REFERENCES ai_customer_action_admission(proposal_id),
 lead_id uuid NOT NULL REFERENCES lead(id),campaign_id uuid NOT NULL REFERENCES campaign(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 tool text NOT NULL DEFAULT 'updateQualificationField' CHECK(tool='updateQualificationField'),
 state text NOT NULL CHECK(state IN ('APPLIED','BLOCKED')),error_code text,
 context jsonb NOT NULL,question_id uuid,qualification_version integer,question_snapshot jsonb,value jsonb,field_id uuid REFERENCES field_definition(id),
 answer_version integer,previous_field_version integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state='APPLIED' AND error_code IS NULL OR state='BLOCKED' AND error_code IN ('AI_ACTION_CONTEXT_CHANGED','AI_ACTION_VALUE_INVALID'))
);
CREATE INDEX ai_customer_action_lead_history ON ai_customer_action(lead_id,created_at DESC,id DESC);

-- Own parent locks before the shared context assembler; none are held across provider HTTP.
CREATE FUNCTION ai_customer_action_context(pid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;BEGIN
 SELECT p.* INTO p FROM ai_customer_proposal p JOIN ai_customer_action_admission a ON a.proposal_id=p.id WHERE p.id=pid;
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

-- Native structural/current option/range checks accompany full shared Application Service validation.
CREATE FUNCTION ai_qualification_value_valid(v jsonb,f field_definition) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;n numeric;k text;mx integer;BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN false;END IF;
 IF f.id IS NULL THEN RETURN jsonb_typeof(v)='string' AND length(trim(v#>>'{}')) BETWEEN 1 AND 4000
   AND trim(v#>>'{}')=v#>>'{}' AND translate(v#>>'{}',E'\n\r\t','') !~ '[[:cntrl:]]';END IF;
 k=f.field_type;
 IF k IN ('TEXT','LONG_TEXT','PHONE','EMAIL','DATE','TIME','DATETIME','SINGLE_SELECT','STATUS','INTEREST','URL') THEN
   IF jsonb_typeof(v)<>'string' THEN RETURN false;END IF;s=v#>>'{}';mx=CASE k WHEN 'LONG_TEXT' THEN 20000 WHEN 'URL' THEN 2048 ELSE 500 END;
   IF s<>trim(s) OR length(s)<GREATEST(1,COALESCE((f.validation->>'minLength')::integer,0))
     OR length(s)>LEAST(mx,COALESCE((f.validation->>'maxLength')::integer,mx)) THEN RETURN false;END IF;
   IF k IN ('SINGLE_SELECT','STATUS','INTEREST') THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(f.options) o WHERE o->>'value'=s AND o->>'active'='true');END IF;
   IF k='PHONE' THEN RETURN s ~ '^\+[1-9][0-9]{7,14}$';END IF;
   IF k='EMAIL' THEN RETURN s=lower(normalize(s,NFKC)) AND length(s)<=320 AND s ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';END IF;
   IF k='DATE' THEN RETURN s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND to_char(s::date,'YYYY-MM-DD')=s;END IF;
   IF k='TIME' THEN RETURN s ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$';END IF;
   IF k='DATETIME' THEN RETURN s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND isfinite(s::timestamptz);END IF;
   IF k='URL' THEN RETURN s ~ '^https?://[^/[:space:]]+';END IF;RETURN true;
 ELSIF k IN ('NUMBER','PERCENTAGE','DURATION','CURRENCY') THEN
   IF k='CURRENCY' THEN
     IF jsonb_typeof(v)<>'object' OR NOT v ?& ARRAY['amount','currency'] OR (SELECT count(*) FROM jsonb_object_keys(v))<>2
       OR v->>'currency' IS DISTINCT FROM f.validation->>'currency' OR jsonb_typeof(v->'amount')<>'number' THEN RETURN false;END IF;
     n=(v->>'amount')::numeric;IF abs(n)>1000000000000 OR scale(n)>6 THEN RETURN false;END IF;
   ELSE IF jsonb_typeof(v)<>'number' THEN RETURN false;END IF;n=(v#>>'{}')::numeric;IF abs(n)>9007199254740991 THEN RETURN false;END IF;END IF;
   RETURN n>=COALESCE((f.validation->>'min')::numeric,CASE WHEN k='DURATION' THEN 0 ELSE '-Infinity'::numeric END) AND n<=COALESCE((f.validation->>'max')::numeric,'Infinity'::numeric);
 ELSIF k='BOOLEAN' THEN RETURN jsonb_typeof(v)='boolean';
 ELSIF k IN ('MULTI_SELECT','TAGS') THEN
   RETURN jsonb_typeof(v)='array' AND jsonb_array_length(v)<=50 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) x
     WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 100 OR k='MULTI_SELECT' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.options) o WHERE o->>'active'='true' AND o->>'value'=x#>>'{}'))
     AND (SELECT count(DISTINCT x) FROM jsonb_array_elements(v) x)=jsonb_array_length(v);
 END IF;RETURN false;
EXCEPTION WHEN others THEN RETURN false;END $$;

CREATE FUNCTION guard_ai_customer_action() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;ctx jsonb;q jsonb;f field_definition;v integer;valid boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_ACTION_IMMUTABLE';END IF;
 SELECT * INTO p FROM ai_customer_proposal WHERE id=NEW.proposal_id;
 IF p IS NULL OR p.state<>'PROPOSED' OR p.result->>'decision'<>'QUALIFICATION' THEN RAISE EXCEPTION 'AI_ACTION_QUALIFICATION_SOURCE_REQUIRED';END IF;
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
CREATE TRIGGER ai_customer_action_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_customer_action FOR EACH ROW EXECUTE FUNCTION guard_ai_customer_action();

ALTER TABLE lead_field_value ADD COLUMN ai_action_id uuid REFERENCES ai_customer_action(id);
ALTER TABLE field_value_history ADD COLUMN ai_action_id uuid REFERENCES ai_customer_action(id);
ALTER TABLE lead_qualification_answer DROP CONSTRAINT lead_qualification_answer_source_check;
ALTER TABLE lead_qualification_answer ALTER COLUMN actor_id DROP NOT NULL,ALTER COLUMN session_id DROP NOT NULL,ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE lead_qualification_answer ADD COLUMN ai_action_id uuid REFERENCES ai_customer_action(id);
ALTER TABLE lead_qualification_answer ADD CONSTRAINT qualification_source_authority CHECK(
 source='HUMAN' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND request_id IS NOT NULL AND ai_action_id IS NULL
 OR source='AI' AND actor_id IS NULL AND session_id IS NULL AND request_id IS NULL AND ai_action_id IS NOT NULL);

CREATE FUNCTION guard_ai_qualification_field() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;BEGIN
 IF NEW.source<>'AI' THEN NEW.ai_action_id=NULL;RETURN NEW;END IF;
 SELECT a.*,a.xmin AS inserted_xid INTO a FROM ai_customer_action a WHERE id=NEW.ai_action_id AND state='APPLIED';
 IF a IS NULL OR NOT ai_row_inserted_here(a.inserted_xid) OR a.lead_id<>NEW.lead_id OR a.field_id IS DISTINCT FROM NEW.field_id
   OR a.value IS DISTINCT FROM NEW.value OR NEW.updated_by IS NOT NULL OR NEW.version<>a.previous_field_version+1
   OR NEW.source_submission_id IS NOT NULL OR NEW.source_binding_id IS NOT NULL OR NEW.source_mapping_version IS NOT NULL
   OR TG_OP='INSERT' AND a.previous_field_version<>0 OR TG_OP='UPDATE' AND (OLD.version<>a.previous_field_version OR (NEW.lead_id,NEW.field_id) IS DISTINCT FROM (OLD.lead_id,OLD.field_id))
   THEN RAISE EXCEPTION 'AI_FIELD_CURRENT_ACTION_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_field_guard BEFORE INSERT OR UPDATE ON lead_field_value FOR EACH ROW EXECUTE FUNCTION guard_ai_qualification_field();
CREATE FUNCTION record_ai_qualification_field() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source='AI' THEN
   INSERT INTO field_value_history(lead_id,field_id,old_value,new_value,source,actor_user_id,ai_action_id)
     VALUES(NEW.lead_id,NEW.field_id,CASE WHEN TG_OP='UPDATE' THEN OLD.value ELSE NULL END,NEW.value,'AI',NULL,NEW.ai_action_id);
   INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(NEW.lead_id,'FIELD_VALUE_CHANGED',jsonb_build_object('fieldId',NEW.field_id,'source','AI','actionId',NEW.ai_action_id));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_qualification_field_record AFTER INSERT OR UPDATE ON lead_field_value FOR EACH ROW EXECUTE FUNCTION record_ai_qualification_field();

CREATE FUNCTION guard_ai_field_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' AND OLD.source<>'AI' AND OLD.ai_action_id IS NULL THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;
   IF NEW.source<>'AI' AND NEW.ai_action_id IS NULL THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.source<>'AI' AND NEW.ai_action_id IS NULL THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR NEW.source<>'AI' OR NEW.actor_user_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ai_customer_action a JOIN lead_field_value v ON v.ai_action_id=a.id
   WHERE a.id=NEW.ai_action_id AND ai_row_inserted_here(a.xmin) AND a.state='APPLIED' AND a.lead_id=NEW.lead_id AND a.field_id=NEW.field_id
     AND a.value=NEW.new_value AND v.lead_id=NEW.lead_id AND v.field_id=NEW.field_id AND v.value=NEW.new_value AND v.source='AI') THEN RAISE EXCEPTION 'AI_FIELD_HISTORY_PROOF_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON field_value_history FOR EACH ROW EXECUTE FUNCTION guard_ai_field_history();
CREATE UNIQUE INDEX ai_field_history_action_once ON field_value_history(ai_action_id) WHERE ai_action_id IS NOT NULL;

CREATE FUNCTION complete_ai_customer_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='APPLIED' AND NOT EXISTS(SELECT 1 FROM lead_qualification_answer_history h WHERE h.lead_id=NEW.lead_id AND h.question_id=NEW.question_id AND h.version=NEW.answer_version
   AND h.snapshot->>'ai_action_id'=NEW.id::text AND h.snapshot->>'source'='AI' AND h.snapshot->'value'=NEW.value AND h.snapshot->'question_snapshot'=NEW.question_snapshot)
   THEN RAISE EXCEPTION 'AI_ACTION_ATOMIC_ANSWER_REQUIRED';END IF;
 IF NEW.state='APPLIED' AND NEW.field_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM field_value_history h WHERE h.ai_action_id=NEW.id AND h.lead_id=NEW.lead_id AND h.field_id=NEW.field_id AND h.source='AI' AND h.new_value=NEW.value)
   THEN RAISE EXCEPTION 'AI_ACTION_ATOMIC_FIELD_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_customer_action_complete AFTER INSERT ON ai_customer_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_ai_customer_action();
CREATE FUNCTION record_ai_customer_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) SELECT p.organization_id,p.branch_id,'AI_CUSTOMER_TOOL_'||NEW.state,'AI_ACTION',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','tool',NEW.tool,'leadId',NEW.lead_id,'campaignId',NEW.campaign_id,'conversationId',NEW.conversation_id,
     'proposalId',p.id,'sourceEventId',p.event_id,'sourceMessageId',p.message_id,'knowledgeVersion',p.context->'knowledge'->'version','profileId',p.context->'profile'->'id',
     'contextHash',p.context_hash,'errorCode',NEW.error_code) FROM ai_customer_proposal p WHERE p.id=NEW.proposal_id;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_customer_action_record AFTER INSERT ON ai_customer_action FOR EACH ROW EXECUTE FUNCTION record_ai_customer_action();

-- Preserve the existing exact Human request/session checks; only the AI branch uses an autonomous receipt.
CREATE OR REPLACE FUNCTION guard_qualification_answer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r record;l record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.lead_id,NEW.campaign_id,NEW.question_id) IS DISTINCT FROM (OLD.lead_id,OLD.campaign_id,OLD.question_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'QUALIFICATION_ANSWER_VERSION_REQUIRED';END IF;
 IF NEW.source='AI' THEN
   SELECT a.*,a.xmin AS inserted_xid INTO r FROM ai_customer_action a WHERE a.id=NEW.ai_action_id AND a.state='APPLIED';
   IF r IS NULL OR NOT ai_row_inserted_here(r.inserted_xid) OR NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR NEW.request_id IS NOT NULL
     OR (r.lead_id,r.campaign_id,r.question_id,r.qualification_version,r.answer_version,r.value,r.question_snapshot,r.field_id) IS DISTINCT FROM
       (NEW.lead_id,NEW.campaign_id,NEW.question_id,NEW.qualification_version,NEW.version,NEW.value,NEW.question_snapshot,NEW.field_id)
     THEN RAISE EXCEPTION 'AI_QUALIFICATION_CURRENT_ACTION_REQUIRED';END IF;
   IF NEW.field_id IS NOT NULL THEN
     PERFORM 1 FROM lead_field_value v WHERE v.lead_id=NEW.lead_id AND v.field_id=NEW.field_id AND v.source='AI' AND v.updated_by IS NULL
       AND v.ai_action_id=NEW.ai_action_id AND v.value=NEW.value AND v.version=NEW.field_value_version AND v.version=r.previous_field_version+1;
     IF NOT FOUND THEN RAISE EXCEPTION 'AI_QUALIFICATION_FIELD_PROOF_REQUIRED';END IF;
   ELSIF NEW.field_value_version IS NOT NULL THEN RAISE EXCEPTION 'AI_QUALIFICATION_FIELD_PROOF_REQUIRED';END IF;
   NEW.updated_at=clock_timestamp();RETURN NEW;
 END IF;
 NEW.ai_action_id=NULL;
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
