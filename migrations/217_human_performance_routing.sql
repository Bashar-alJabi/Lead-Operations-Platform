CREATE INDEX routing_human_outbound
 ON conversation_message(author_user_id,sent_at,conversation_id)
 WHERE direction='OUTBOUND' AND author_type='HUMAN' AND sent_at IS NOT NULL
   AND delivery_state IN ('SENT','DELIVERED','READ');

CREATE INDEX routing_human_follow_up
 ON follow_up(owner_user_id,due_at,lead_id)
 INCLUDE(completed_by,completed_at,status)
 WHERE kind='HUMAN' AND status IN ('OPEN','COMPLETED');

CREATE UNIQUE INDEX routing_performance_audit_lead ON audit_log(target_id)
 WHERE action='LEAD_PERFORMANCE_ROUTED' AND target_type='LEAD';

CREATE OR REPLACE FUNCTION guard_lead_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR (CASE h.method
     WHEN 'PERFORMANCE' THEN h.reason IS NULL OR h.reason NOT IN (
       'NO_ELIGIBLE_AGENT','PERFORMANCE_POLICY_REQUIRED','HUMAN_PERFORMANCE','INSUFFICIENT_HUMAN_SAMPLE_FALLBACK')
       OR NOT EXISTS (
        SELECT 1 FROM audit_log a WHERE a.action='LEAD_PERFORMANCE_ROUTED' AND a.target_type='LEAD'
         AND a.organization_id=l.organization_id AND a.branch_id=l.branch_id AND a.target_id=l.id::text
         AND ai_row_inserted_here(a.xmin)
         AND a.detail->>'assignmentHistoryId'=h.id::text AND a.detail->>'method'=h.method
         AND a.detail->>'reason'=h.reason AND a.detail->>'agentId' IS NOT DISTINCT FROM h.new_agent_id::text
       )
     ELSE h.reason IS NULL OR h.reason NOT IN ('NO_ELIGIBLE_AGENT','MANUAL_ROUTING','ROUND_ROBIN','WEIGHTED')
   END)
   OR s.state<>'PROCESSED' OR s.failure_code IS NOT NULL OR s.lead_id IS DISTINCT FROM l.id OR s.source_kind<>l.source_kind
   OR (s.organization_id,s.branch_id,s.campaign_id) IS DISTINCT FROM (l.organization_id,l.branch_id,l.campaign_id)
   OR s.resolution_contact_id IS NOT NULL AND s.resolution_contact_id IS DISTINCT FROM l.contact_id
   OR NOT EXISTS(SELECT 1 FROM branch WHERE id=l.branch_id AND active) OR NOT EXISTS(SELECT 1 FROM campaign WHERE id=l.campaign_id AND status='ACTIVE')
   THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_ROUTED_SOURCE_REQUIRED';END IF;
 IF NEW.origin_kind='HUMAN_MANUAL' THEN
   PERFORM 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=NEW.actor_id AND ss.id=NEW.session_id FOR SHARE OF u,ss;
   IF s.source_kind<>'MANUAL' OR NOT lead_intake_human_allowed(l.id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'LEAD_INTAKE_CURRENT_SESSION_REQUIRED';END IF;
 ELSIF NEW.origin_kind='APPROVED_IMPORT' THEN
   IF NEW.actor_id IS NOT NULL OR NEW.session_id IS NOT NULL OR NOT COALESCE(lead_import_effect_allowed(s.id,l.id),false)
    OR NOT EXISTS(SELECT 1 FROM lead_import_result rr WHERE rr.submission_id=s.id AND rr.state='IMPORTED' AND rr.lead_id=l.id AND ai_row_inserted_here(rr.xmin))
    THEN RAISE EXCEPTION 'LEAD_INTAKE_APPROVED_IMPORT_REQUIRED';END IF;
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
