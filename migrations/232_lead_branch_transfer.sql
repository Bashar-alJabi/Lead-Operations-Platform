CREATE TABLE lead_branch_transfer (
 lead_id uuid NOT NULL REFERENCES lead(id),
 source_version integer NOT NULL CHECK(source_version>0),
 organization_id uuid NOT NULL REFERENCES organization(id),
 source_branch_id uuid NOT NULL REFERENCES branch(id),
 source_campaign_id uuid NOT NULL REFERENCES campaign(id),
 source_agent_id uuid REFERENCES user_account(id),
 destination_branch_id uuid NOT NULL REFERENCES branch(id),
 destination_campaign_id uuid NOT NULL REFERENCES campaign(id),
 destination_agent_id uuid REFERENCES user_account(id),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(lead_id,source_version),
 CHECK(source_branch_id<>destination_branch_id)
);

CREATE FUNCTION validate_lead_branch_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject lead;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LEAD_TRANSFER_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO subject FROM lead WHERE id=NEW.lead_id AND organization_id=NEW.organization_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
 IF subject.version<>NEW.source_version THEN RAISE EXCEPTION 'LEAD_VERSION_CONFLICT'; END IF;

 -- Workers and configuration changes lock Branch before Lead. Lock both Branches in stable order.
 PERFORM id FROM branch WHERE id IN(subject.branch_id,NEW.destination_branch_id)
  AND organization_id=subject.organization_id ORDER BY id FOR UPDATE;
 SELECT * INTO subject FROM lead WHERE id=NEW.lead_id FOR UPDATE;
 IF subject.version<>NEW.source_version THEN RAISE EXCEPTION 'LEAD_VERSION_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.organization_id=subject.organization_id AND u.role='SUPER_ADMIN' AND u.active
    AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
 THEN RAISE EXCEPTION 'LEAD_TRANSFER_ACCESS_REVOKED'; END IF;

 IF NOT EXISTS(SELECT 1 FROM campaign c JOIN branch b ON b.id=c.branch_id
  WHERE c.id=NEW.destination_campaign_id AND c.branch_id=NEW.destination_branch_id AND c.organization_id=subject.organization_id
   AND c.status='ACTIVE' AND b.active AND b.id<>subject.branch_id FOR SHARE OF c)
 THEN RAISE EXCEPTION 'LEAD_TRANSFER_DESTINATION_INVALID'; END IF;
 IF NEW.destination_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM user_account u
  WHERE u.id=NEW.destination_agent_id AND u.organization_id=subject.organization_id
   AND u.branch_id=NEW.destination_branch_id AND u.role='AGENT' AND u.active FOR SHARE OF u)
 THEN RAISE EXCEPTION 'AGENT_NOT_ELIGIBLE'; END IF;

 -- These resources retain the scope that authorized their thread, provider proof, or human review.
 IF EXISTS(SELECT 1 FROM conversation WHERE lead_id=subject.id) THEN RAISE EXCEPTION 'LEAD_TRANSFER_CONVERSATION_REVIEW'; END IF;
 IF EXISTS(SELECT 1 FROM payment_link_intent WHERE lead_id=subject.id)
  OR EXISTS(SELECT 1 FROM bank_transfer_request WHERE lead_id=subject.id)
 THEN RAISE EXCEPTION 'LEAD_TRANSFER_PAYMENT_REVIEW'; END IF;
 IF automation_review_pending(subject.id,subject.branch_id,subject.campaign_id)
 THEN RAISE EXCEPTION 'LEAD_TRANSFER_HUMAN_REVIEW_PENDING'; END IF;

 NEW.source_branch_id=subject.branch_id;
 NEW.source_campaign_id=subject.campaign_id;
 NEW.source_agent_id=subject.assigned_agent_id;
 NEW.reason=btrim(NEW.reason);
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER lead_branch_transfer_validate BEFORE INSERT OR UPDATE OR DELETE ON lead_branch_transfer
 FOR EACH ROW EXECUTE FUNCTION validate_lead_branch_transfer();

CREATE FUNCTION require_lead_branch_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.organization_id<>OLD.organization_id OR NEW.version<>OLD.version+1 OR NOT EXISTS(
  SELECT 1 FROM lead_branch_transfer t WHERE t.lead_id=OLD.id AND t.source_version=OLD.version
   AND (t.source_branch_id,t.source_campaign_id,t.source_agent_id) IS NOT DISTINCT FROM
     (OLD.branch_id,OLD.campaign_id,OLD.assigned_agent_id)
   AND (t.destination_branch_id,t.destination_campaign_id,t.destination_agent_id) IS NOT DISTINCT FROM
     (NEW.branch_id,NEW.campaign_id,NEW.assigned_agent_id)
   AND ai_row_inserted_here(t.xmin)
 ) THEN RAISE EXCEPTION 'LEAD_TRANSFER_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_branch_transfer_required BEFORE UPDATE ON lead FOR EACH ROW
 WHEN((OLD.organization_id,OLD.branch_id) IS DISTINCT FROM (NEW.organization_id,NEW.branch_id))
 EXECUTE FUNCTION require_lead_branch_transfer();

CREATE FUNCTION apply_lead_branch_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement jsonb;
BEGIN
 UPDATE lead SET branch_id=NEW.destination_branch_id,campaign_id=NEW.destination_campaign_id,
  assigned_agent_id=NEW.destination_agent_id,version=version+1,updated_at=clock_timestamp(),
  needs_attention_reason=CASE WHEN NEW.destination_agent_id IS NULL AND lifecycle='OPEN' AND
    (needs_attention_reason IS NULL OR needs_attention_reason IN ('NO_ELIGIBLE_AGENT','PERFORMANCE_POLICY_REQUIRED',
      'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK')) THEN 'UNASSIGNED_BY_MANAGER'
   WHEN NEW.destination_agent_id IS NOT NULL AND needs_attention_reason IN ('UNASSIGNED_BY_MANAGER','NO_ELIGIBLE_AGENT',
      'PERFORMANCE_POLICY_REQUIRED','INSUFFICIENT_HUMAN_SAMPLE_FALLBACK') THEN NULL ELSE needs_attention_reason END
 WHERE id=NEW.lead_id;

 INSERT INTO assignment_history(lead_id,old_branch_id,old_agent_id,new_branch_id,new_agent_id,actor_user_id,method,reason)
 VALUES(NEW.lead_id,NEW.source_branch_id,NEW.source_agent_id,NEW.destination_branch_id,NEW.destination_agent_id,
  NEW.actor_id,'MANUAL',NEW.reason);

 WITH prior AS MATERIALIZED (
  SELECT id,owner_user_id FROM follow_up WHERE lead_id=NEW.lead_id AND status='OPEN'
   AND owner_user_id IS DISTINCT FROM NEW.destination_agent_id FOR UPDATE
 ), moved AS (
  UPDATE follow_up f SET owner_user_id=NEW.destination_agent_id,version=version+1,updated_at=clock_timestamp()
   FROM prior WHERE f.id=prior.id RETURNING f.id,prior.owner_user_id
 )
 INSERT INTO follow_up_history(follow_up_id,actor_user_id,event_type,detail)
 SELECT id,NEW.actor_id,'OWNER_CHANGED_BY_REASSIGNMENT',jsonb_build_object('from',owner_user_id,'to',NEW.destination_agent_id)
 FROM moved;

 movement=jsonb_build_object('sourceBranchId',NEW.source_branch_id,'sourceCampaignId',NEW.source_campaign_id,
  'sourceAgentId',NEW.source_agent_id,'destinationBranchId',NEW.destination_branch_id,
  'destinationCampaignId',NEW.destination_campaign_id,'destinationAgentId',NEW.destination_agent_id,'version',NEW.source_version+1);
 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail)
 VALUES(NEW.lead_id,NEW.actor_id,'LEAD_BRANCH_TRANSFERRED',jsonb_build_object('version',NEW.source_version+1));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 SELECT NEW.organization_id,scope.branch,NEW.actor_id,'LEAD_BRANCH_TRANSFERRED','LEAD',NEW.lead_id,
   movement || jsonb_build_object('direction',scope.direction,'reason',NEW.reason)
 FROM (VALUES(NEW.source_branch_id,'OUT'),(NEW.destination_branch_id,'IN')) AS scope(branch,direction);
 RETURN NULL;
END $$;
CREATE TRIGGER lead_branch_transfer_apply AFTER INSERT ON lead_branch_transfer
 FOR EACH ROW EXECUTE FUNCTION apply_lead_branch_transfer();
