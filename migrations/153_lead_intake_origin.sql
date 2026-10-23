-- Separate actual INSERT provenance from a mutable Lead's xmin. No historical backfill or AI authority.
CREATE TABLE lead_intake_birth (
 lead_id uuid PRIMARY KEY REFERENCES lead(id),organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),contact_id uuid REFERENCES contact(id),
 source_kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_lead_intake_birth() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE l record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LEAD_INTAKE_BIRTH_IMMUTABLE';END IF;
 -- Only the nested Lead INSERT trigger creates a birth; a direct INSERT or an old Lead UPDATE is insufficient.
 SELECT ld.*,ld.xmin AS row_xid INTO l FROM lead ld WHERE ld.id=NEW.lead_id;
 IF pg_trigger_depth()<2 OR l IS NULL OR NOT ai_row_inserted_here(l.row_xid) THEN RAISE EXCEPTION 'LEAD_INTAKE_INSERT_REQUIRED';END IF;
 NEW.organization_id=l.organization_id;NEW.branch_id=l.branch_id;NEW.campaign_id=l.campaign_id;NEW.contact_id=l.contact_id;NEW.source_kind=l.source_kind;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER lead_intake_birth_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_intake_birth FOR EACH ROW EXECUTE FUNCTION guard_lead_intake_birth();
CREATE FUNCTION record_lead_intake_birth() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO lead_intake_birth(lead_id) VALUES(NEW.id);RETURN NEW;
END $$;
CREATE TRIGGER lead_intake_birth_record AFTER INSERT ON lead FOR EACH ROW EXECUTE FUNCTION record_lead_intake_birth();

CREATE TABLE lead_intake_receipt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid NOT NULL UNIQUE REFERENCES lead_intake_birth(lead_id),
 origin_kind text NOT NULL CHECK(origin_kind IN ('HUMAN_MANUAL','SOURCE')),
 submission_id uuid NOT NULL UNIQUE REFERENCES source_submission(id),routing_history_id bigint NOT NULL UNIQUE REFERENCES assignment_history(id),
 actor_id uuid REFERENCES user_account(id),session_id uuid REFERENCES user_session(id),
 context jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((origin_kind='HUMAN_MANUAL')=(actor_id IS NOT NULL)),CHECK((origin_kind='HUMAN_MANUAL')=(session_id IS NOT NULL))
);
CREATE FUNCTION lead_intake_human_allowed(lid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM lead l JOIN user_account u ON u.organization_id=l.organization_id JOIN user_session ss ON ss.user_id=u.id
   WHERE l.id=lid AND u.id=uid AND ss.id=sid AND u.active AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
     AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=l.branch_id))
$$;
CREATE FUNCTION lead_intake_receipt_context(lid uuid,subid uuid,rid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('schema',1,'kind','LEAD_INTAKE','scope',jsonb_build_object('organizationId',l.organization_id,'branchId',l.branch_id,'campaignId',l.campaign_id,'leadId',l.id),
   'lead',jsonb_build_object('version',l.version,'lifecycle',l.lifecycle,'contactId',l.contact_id,'ownerId',l.assigned_agent_id,'attentionReason',l.needs_attention_reason),
   'branch',jsonb_build_object('active',b.active),'campaign',jsonb_build_object('version',c.version,'status',c.status,'routingMethod',c.routing_method),
   'source',jsonb_build_object('submissionId',s.id,'kind',s.source_kind,'connectionId',s.connection_id,'processingVersion',p.version,'bindingId',p.binding_id,'mappingVersion',p.mapping_version),
   'routing',jsonb_build_object('historyId',h.id,'method',h.method,'reason',h.reason,'ownerId',h.new_agent_id,'branchId',h.new_branch_id))
 FROM lead l JOIN branch b ON b.id=l.branch_id AND b.organization_id=l.organization_id
 JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=b.id AND c.organization_id=l.organization_id
 JOIN source_submission s ON s.id=subid AND s.lead_id=l.id AND s.organization_id=l.organization_id AND s.branch_id=b.id AND s.campaign_id=c.id
 JOIN assignment_history h ON h.id=rid AND h.lead_id=l.id LEFT JOIN source_processing p ON p.submission_id=s.id WHERE l.id=lid
$$;
CREATE FUNCTION guard_lead_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE birth lead_intake_birth;l lead;s source_submission;h assignment_history;p source_processing;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LEAD_INTAKE_RECEIPT_IMMUTABLE';END IF;
 SELECT bi.* INTO birth FROM lead_intake_birth bi WHERE bi.lead_id=NEW.lead_id AND ai_row_inserted_here(bi.xmin);
 IF birth IS NULL THEN RAISE EXCEPTION 'LEAD_INTAKE_FRESH_BIRTH_REQUIRED';END IF;
 -- Intake already holds these parents; this ordering also fences independently invoked application services.
 PERFORM 1 FROM branch WHERE id=birth.branch_id FOR SHARE;
 PERFORM 1 FROM campaign WHERE id=birth.campaign_id FOR SHARE;
 SELECT * INTO l FROM lead WHERE id=NEW.lead_id FOR UPDATE;
 SELECT * INTO s FROM source_submission WHERE id=NEW.submission_id FOR SHARE;
 SELECT ah.* INTO h FROM assignment_history ah WHERE ah.id=NEW.routing_history_id AND ai_row_inserted_here(ah.xmin) FOR SHARE;
 IF l IS NULL OR s IS NULL OR h IS NULL OR (l.organization_id,l.branch_id,l.campaign_id,l.contact_id,l.source_kind)
   IS DISTINCT FROM (birth.organization_id,birth.branch_id,birth.campaign_id,birth.contact_id,birth.source_kind)
   OR l.lifecycle<>'OPEN' OR h.lead_id<>l.id OR h.new_branch_id<>l.branch_id OR h.new_agent_id IS DISTINCT FROM l.assigned_agent_id
   OR h.old_branch_id IS NOT NULL OR h.old_agent_id IS NOT NULL OR h.actor_user_id IS NOT NULL
   OR h.method IS DISTINCT FROM (SELECT routing_method FROM campaign WHERE id=l.campaign_id)
   OR h.reason NOT IN ('NO_ELIGIBLE_AGENT','MANUAL_ROUTING','ROUND_ROBIN','WEIGHTED','INSUFFICIENT_HUMAN_SAMPLE_FALLBACK') OR h.reason IS NULL
   OR s.state<>'PROCESSED' OR s.failure_code IS NOT NULL OR s.lead_id IS DISTINCT FROM l.id OR s.source_kind<>l.source_kind
   OR (s.organization_id,s.branch_id,s.campaign_id) IS DISTINCT FROM (l.organization_id,l.branch_id,l.campaign_id)
   OR s.resolution_contact_id IS NOT NULL AND s.resolution_contact_id IS DISTINCT FROM l.contact_id
   OR NOT EXISTS(SELECT 1 FROM branch WHERE id=l.branch_id AND active) OR NOT EXISTS(SELECT 1 FROM campaign WHERE id=l.campaign_id AND status='ACTIVE')
   THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 IF NEW.origin_kind='HUMAN_MANUAL' THEN
   PERFORM 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=NEW.actor_id AND ss.id=NEW.session_id FOR SHARE OF u,ss;
   IF s.source_kind<>'MANUAL' OR NOT lead_intake_human_allowed(l.id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_SESSION_REQUIRED';END IF;
 ELSE
   SELECT * INTO p FROM source_processing WHERE submission_id=s.id AND state='PROCESSED' FOR SHARE;
   IF s.source_kind<>'META' OR NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR p IS NULL
     OR (p.connection_id,p.branch_id,p.campaign_id) IS DISTINCT FROM (s.connection_id,l.branch_id,l.campaign_id)
     OR NOT EXISTS(SELECT 1 FROM source_processing_history ph WHERE ph.submission_id=s.id AND ph.version=p.version AND ph.state='PROCESSED'
       AND ph.snapshot->>'leadId'=l.id::text AND ai_row_inserted_here(ph.xmin)) THEN RAISE EXCEPTION 'LEAD_INTAKE_PROCESSED_SOURCE_REQUIRED';END IF;
 END IF;
 ctx=lead_intake_receipt_context(l.id,s.id,h.id);IF ctx IS NULL THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 NEW.context=ctx;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER lead_intake_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_intake_receipt FOR EACH ROW EXECUTE FUNCTION guard_lead_intake_receipt();
CREATE FUNCTION prove_lead_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF lead_intake_receipt_context(NEW.lead_id,NEW.submission_id,NEW.routing_history_id) IS DISTINCT FROM NEW.context
   OR NEW.origin_kind='HUMAN_MANUAL' AND NOT lead_intake_human_allowed(NEW.lead_id,NEW.actor_id,NEW.session_id)
   THEN RAISE EXCEPTION 'LEAD_INTAKE_ATOMIC_CONTEXT_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lead_intake_receipt_proof AFTER INSERT ON lead_intake_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prove_lead_intake_receipt();
CREATE FUNCTION record_lead_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 VALUES((NEW.context->'scope'->>'organizationId')::uuid,(NEW.context->'scope'->>'branchId')::uuid,NEW.actor_id,'LEAD_INTAKE_RECORDED','LEAD',NEW.lead_id,
   jsonb_build_object('receiptId',NEW.id,'originKind',NEW.origin_kind,'submissionId',NEW.submission_id,'routingHistoryId',NEW.routing_history_id));
 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(NEW.lead_id,NEW.actor_id,'LEAD_INTAKE_RECORDED',
   jsonb_build_object('receiptId',NEW.id,'originKind',NEW.origin_kind,'submissionId',NEW.submission_id,'routingHistoryId',NEW.routing_history_id));
 RETURN NEW;
END $$;
CREATE TRIGGER lead_intake_receipt_record AFTER INSERT ON lead_intake_receipt FOR EACH ROW EXECUTE FUNCTION record_lead_intake_receipt();
-- No initial AI admission, job, conversation, message, backfill, activation or provider call.
