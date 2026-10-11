-- Autonomous read-only Handoff evidence. No fabricated employee/session or tool authority.
CREATE FUNCTION ai_handoff_summary_context(aid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('kind','HANDOFF_SUMMARY','actionId',a.id,'sourceContext',ai_customer_inbound_context(p.event_id),
   'summaryContext',ai_copilot_summary_context(cv.id),'toolPolicy',ai_effective_tool_policy(l.branch_id,l.campaign_id),
   'consent',COALESCE((SELECT to_jsonb(mc)-'updated_by' FROM messaging_consent mc WHERE mc.contact_id=l.contact_id AND mc.channel=cv.channel),'null'),
   'language',COALESCE(NULLIF(cc.definition->'language','null'),NULLIF(bc.definition->'language','null')),
   'profile',jsonb_build_object('id',pr.id,'version',pr.version,'connectionId',ic.id,'connectionVersion',ic.version,'provider',ic.provider,
     'modelId',pr.model_id,'maxOutputTokens',pr.max_output_tokens,'catalogVersion',ic.capabilities->'catalogVersion',
     'grantVersion',(SELECT g.version FROM ai_connection_branch_use g WHERE g.connection_id=ic.id AND g.branch_id=l.branch_id AND g.active)))
 FROM ai_customer_handoff_action a JOIN ai_customer_proposal p ON p.id=a.proposal_id JOIN lead l ON l.id=a.lead_id
 JOIN campaign c ON c.id=l.campaign_id JOIN branch b ON b.id=l.branch_id JOIN conversation cv ON cv.id=a.conversation_id AND cv.lead_id=l.id
 LEFT JOIN ai_operational_config cc ON cc.scope='CAMPAIGN' AND cc.resource_id=c.id
 LEFT JOIN ai_operational_config bc ON bc.scope='BRANCH' AND bc.resource_id=b.id
 JOIN ai_model_profile pr ON pr.id=COALESCE((cc.definition->'profiles'->>'SUMMARIZATION')::uuid,(bc.definition->'profiles'->>'SUMMARIZATION')::uuid)
 JOIN integration_connection ic ON ic.id=pr.connection_id
 WHERE a.id=aid AND a.state='APPLIED' AND a.campaign_id=c.id AND cv.ai_handoff_action_id=a.id AND cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE'
   AND b.active AND c.branch_id=b.id AND c.organization_id=l.organization_id AND b.organization_id=l.organization_id
   AND l.lifecycle='OPEN' AND ai_customer_inbound_context(p.event_id) IS NOT NULL AND ai_operational_profile_usable(b.id,pr.id,'SUMMARIZATION')
$$;
CREATE FUNCTION ai_handoff_summary_locked_context(aid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE s record;BEGIN
 SELECT l.id AS lid,l.branch_id AS bid,l.campaign_id AS cid,l.contact_id,cv.id AS cvid,p.event_id
 INTO s FROM ai_customer_handoff_action a JOIN ai_customer_proposal p ON p.id=a.proposal_id JOIN lead l ON l.id=a.lead_id JOIN conversation cv ON cv.id=a.conversation_id WHERE a.id=aid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Parents also fence first config/consent/Field writes, not just existing child rows.
 PERFORM 1 FROM branch WHERE id=s.bid FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=s.cid FOR SHARE;
 PERFORM 1 FROM lead WHERE id=s.lid AND branch_id=s.bid AND campaign_id=s.cid FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM contact WHERE id=s.contact_id FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=s.cvid AND lead_id=s.lid FOR SHARE;
 PERFORM ai_customer_proposal_locked_context(s.event_id);
 PERFORM 1 FROM ai_tool_policy WHERE branch_id=s.bid AND (campaign_id IS NULL OR campaign_id=s.cid) ORDER BY scope FOR SHARE;
 PERFORM 1 FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id WHERE pa.campaign_id=s.cid
   AND pa.version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid) ORDER BY ka.id FOR SHARE OF ka;
 PERFORM 1 FROM ai_knowledge_asset_approval WHERE asset_id IN (SELECT asset_id FROM ai_knowledge_publication_asset WHERE campaign_id=s.cid
   AND version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid)) ORDER BY asset_id FOR SHARE;
 RETURN ai_handoff_summary_context(aid);
END $$;
CREATE TABLE ai_handoff_summary (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action_id uuid NOT NULL REFERENCES ai_customer_handoff_action(id),request_id uuid NOT NULL UNIQUE,
 organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),context_hash text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED','BLOCKED')),version integer NOT NULL DEFAULT 1,
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),references_json jsonb NOT NULL DEFAULT '[]',result jsonb,error_code text,
 lease_token uuid,lease_until timestamptz,completed_lease_token uuid,available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 CHECK((actor_id IS NULL)=(session_id IS NULL)),CHECK((state='COMPLETED')=(result IS NOT NULL)),
 CHECK(state='RUNNING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL OR state<>'RUNNING' AND lease_token IS NULL AND lease_until IS NULL),
 CHECK(state NOT IN ('FAILED','BLOCKED') OR error_code IS NOT NULL)
);
CREATE INDEX ai_handoff_summary_queue ON ai_handoff_summary(available_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX ai_handoff_summary_conversation_history ON ai_handoff_summary(conversation_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX ai_handoff_summary_pending ON ai_handoff_summary(action_id) WHERE state IN ('QUEUED','RUNNING');
CREATE TABLE ai_handoff_summary_history (
 summary_id uuid NOT NULL REFERENCES ai_handoff_summary(id),version integer NOT NULL,state text NOT NULL,attempt_count integer NOT NULL,error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(summary_id,version)
);
CREATE FUNCTION ai_handoff_summary_current(s ai_handoff_summary) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
 IF s.context IS DISTINCT FROM ai_handoff_summary_locked_context(s.action_id) THEN RETURN false;END IF;
 IF s.actor_id IS NOT NULL THEN
   PERFORM 1 FROM user_account u JOIN user_session us ON us.user_id=u.id WHERE u.id=s.actor_id AND us.id=s.session_id AND u.active
     AND u.organization_id=s.organization_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp()
     AND (u.role='SUPER_ADMIN' OR u.branch_id=s.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND u.id=(SELECT assigned_agent_id FROM lead WHERE id=s.lead_id))) FOR SHARE OF u,us;
   IF NOT FOUND THEN RETURN false;END IF;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION guard_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;a record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_HISTORY_RETAINED';END IF;
 IF TG_OP='INSERT' THEN
   ctx=ai_handoff_summary_locked_context(NEW.action_id);
   SELECT a.*,a.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action a WHERE id=NEW.action_id;
   IF ctx IS NULL OR NEW.context IS DISTINCT FROM ctx OR NEW.state<>'QUEUED' OR NEW.version<>1 OR NEW.attempt_count<>0 OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
     OR NEW.lease_token IS NOT NULL OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL
     OR NEW.actor_id IS NULL AND NOT ai_row_inserted_here(a.inserted_xid)
     OR (NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id) IS DISTINCT FROM
       ((ctx->'sourceContext'->'scope'->>'organizationId')::uuid,(ctx->'sourceContext'->'scope'->>'branchId')::uuid,a.campaign_id,a.lead_id,a.conversation_id)
     OR NOT ai_handoff_summary_current(NEW) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED';END IF;
   NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');NEW.references_json=ctx->'summaryContext'->'references';NEW.created_at=clock_timestamp();
 ELSE
   IF (NEW.id,NEW.action_id,NEW.request_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.lead_id,NEW.conversation_id,NEW.actor_id,NEW.session_id,NEW.context,NEW.context_hash,NEW.references_json,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.action_id,OLD.request_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.lead_id,OLD.conversation_id,OLD.actor_id,OLD.session_id,OLD.context,OLD.context_hash,OLD.references_json,OLD.created_at)
     OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_IMMUTABLE_CONTEXT';END IF;
   IF OLD.state IN ('COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TERMINAL';END IF;
   IF NEW.state='RUNNING' THEN
     IF NOT(OLD.state='QUEUED' AND OLD.available_at<=clock_timestamp() OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) OR NEW.attempt_count<>OLD.attempt_count+1
       OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '120 seconds'
       OR NEW.completed_lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
   ELSIF NEW.state='FAILED' AND NEW.error_code='AI_RETRY_EXHAUSTED' AND OLD.attempt_count=5 AND (OLD.state='QUEUED' OR OLD.state='RUNNING' AND OLD.lease_until<=clock_timestamp()) THEN
     IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
   ELSE
     IF OLD.state<>'RUNNING' OR OLD.lease_until<=clock_timestamp() OR NEW.completed_lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
       OR NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_LEASE_REQUIRED';END IF;
     IF NEW.state='COMPLETED' AND (NEW.error_code IS NOT NULL OR NOT ai_handoff_summary_current(NEW) OR NOT ai_simulation_result_valid(NEW.result,NEW.references_json)) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RESULT_PROOF_REQUIRED';END IF;
     IF NEW.state='QUEUED' AND (NEW.attempt_count>=5 OR NEW.error_code IS NULL OR NEW.available_at<clock_timestamp()-interval '1 second' OR NEW.available_at>clock_timestamp()+interval '301 seconds') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_RETRY_REQUIRED';END IF;
     IF NEW.state NOT IN ('QUEUED','COMPLETED','FAILED','BLOCKED') THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_TRANSITION_INVALID';END IF;
   END IF;
 END IF;
 NEW.updated_at=clock_timestamp();NEW.completed_at=CASE WHEN NEW.state IN ('COMPLETED','FAILED','BLOCKED') THEN clock_timestamp() ELSE NULL END;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_summary_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_summary FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_summary();
CREATE FUNCTION guard_ai_handoff_summary_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_handoff_summary s WHERE s.id=NEW.summary_id AND (s.version,s.state,s.attempt_count,s.error_code)
   IS NOT DISTINCT FROM (NEW.version,NEW.state,NEW.attempt_count,NEW.error_code)) THEN RAISE EXCEPTION 'AI_HANDOFF_SUMMARY_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_summary_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_summary_history FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_summary_history();
CREATE FUNCTION record_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_handoff_summary_history(summary_id,version,state,attempt_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'AI_HANDOFF_SUMMARY_'||NEW.state,'AI_HANDOFF_SUMMARY',NEW.id,
   jsonb_build_object('assistant','AI_LEAD_ASSISTANT','handoffActionId',NEW.action_id,'leadId',NEW.lead_id,'conversationId',NEW.conversation_id,'campaignId',NEW.campaign_id,'version',NEW.version,
     'attempt',NEW.attempt_count,'errorCode',NEW.error_code,'contextHash',NEW.context_hash,'knowledgeVersion',NEW.context->'sourceContext'->'knowledge'->'version','profileId',NEW.context->'profile'->'id'));
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_summary_record AFTER INSERT OR UPDATE ON ai_handoff_summary FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_summary();
CREATE FUNCTION enqueue_ai_handoff_summary() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ctx jsonb;BEGIN
 IF NEW.ai_action_id IS NULL THEN RETURN NEW;END IF;
 ctx=ai_handoff_summary_locked_context(NEW.ai_action_id);
 -- Missing/oversized summary configuration must never delay the safe Handoff stop.
 IF ctx IS NOT NULL AND octet_length(ctx::text)<=1048576 THEN
   INSERT INTO ai_handoff_summary(action_id,request_id,organization_id,branch_id,campaign_id,lead_id,conversation_id,context,context_hash)
     VALUES(NEW.ai_action_id,NEW.ai_action_id,(ctx->'sourceContext'->'scope'->>'organizationId')::uuid,(ctx->'sourceContext'->'scope'->>'branchId')::uuid,
       (ctx->'sourceContext'->'scope'->>'campaignId')::uuid,(ctx->'sourceContext'->'scope'->>'leadId')::uuid,NEW.conversation_id,ctx,'');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_summary_admit AFTER INSERT ON conversation_handoff FOR EACH ROW EXECUTE FUNCTION enqueue_ai_handoff_summary();
