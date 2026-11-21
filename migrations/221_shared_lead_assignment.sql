CREATE FUNCTION apply_human_lead_assignment(
 lid uuid, expected_version integer, target uuid, uid uuid, sid uuid, assignment_reason text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE current_lead lead; next_version integer;
BEGIN
 SELECT * INTO current_lead FROM lead WHERE id=lid FOR UPDATE;
 IF current_lead.id IS NULL THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
   WHERE u.id=uid AND u.organization_id=current_lead.organization_id AND u.active
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=current_lead.branch_id)
    AND s.id=sid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   FOR SHARE OF u,s
 ) THEN RAISE EXCEPTION 'LEAD_ASSIGNMENT_ACCESS_REVOKED'; END IF;
 IF current_lead.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'LEAD_VERSION_CONFLICT'; END IF;
 IF length(assignment_reason)>500 THEN RAISE EXCEPTION 'LEAD_ASSIGNMENT_REASON_INVALID'; END IF;
 IF target IS NOT DISTINCT FROM current_lead.assigned_agent_id THEN RETURN current_lead.version; END IF;
 IF target IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM user_account u WHERE u.id=target AND u.organization_id=current_lead.organization_id
   AND u.branch_id=current_lead.branch_id AND u.role='AGENT' AND u.active FOR SHARE
 ) THEN RAISE EXCEPTION 'AGENT_NOT_ELIGIBLE'; END IF;

 UPDATE lead SET assigned_agent_id=target,version=version+1,
  needs_attention_reason=CASE WHEN target IS NULL THEN 'UNASSIGNED_BY_MANAGER'
   WHEN needs_attention_reason IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER','PERFORMANCE_POLICY_REQUIRED',
    'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK') THEN NULL ELSE needs_attention_reason END,
  updated_at=now() WHERE id=lid RETURNING version INTO next_version;
 INSERT INTO assignment_history(lead_id,old_branch_id,old_agent_id,new_branch_id,new_agent_id,actor_user_id,method,reason)
  VALUES(lid,current_lead.branch_id,current_lead.assigned_agent_id,current_lead.branch_id,target,uid,'MANUAL',assignment_reason);

 WITH moved AS (
  UPDATE follow_up SET owner_user_id=target,version=version+1,updated_at=now()
   WHERE lead_id=lid AND status='OPEN' AND owner_user_id=current_lead.assigned_agent_id RETURNING id
 )
 INSERT INTO follow_up_history(follow_up_id,actor_user_id,event_type,detail)
  SELECT id,uid,'OWNER_CHANGED_BY_REASSIGNMENT',jsonb_build_object('from',current_lead.assigned_agent_id,'to',target)
  FROM moved;

 WITH moved AS (
  UPDATE conversation SET controller_user_id=target,
   controller_type=CASE WHEN target IS NULL THEN 'NONE' ELSE 'HUMAN' END,
   state=CASE WHEN target IS NULL THEN 'WAITING_FOR_HUMAN' ELSE 'HUMAN_ACTIVE' END,
   version=version+1,needs_attention_reason=CASE WHEN target IS NULL THEN 'LEAD_UNASSIGNED' END
   WHERE lead_id=lid AND controller_type='HUMAN' AND controller_user_id=current_lead.assigned_agent_id
    AND state='HUMAN_ACTIVE' RETURNING id
 )
 INSERT INTO conversation_handoff(conversation_id,from_controller,from_user_id,to_controller,to_user_id,reason,requested_by)
  SELECT id,'HUMAN',current_lead.assigned_agent_id,CASE WHEN target IS NULL THEN 'NONE' ELSE 'HUMAN' END,
   target,'LEAD_REASSIGNED',uid FROM moved;

 INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(lid,uid,'LEAD_REASSIGNED',
  jsonb_build_object('from',current_lead.assigned_agent_id,'to',target,'reason',assignment_reason));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(current_lead.organization_id,current_lead.branch_id,uid,'LEAD_REASSIGNED','LEAD',lid,
   jsonb_build_object('from',current_lead.assigned_agent_id,'to',target));
 RETURN next_version;
END $$;
