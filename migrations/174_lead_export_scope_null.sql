-- Authorization helpers must return false, never SQL NULL, before NOT/NOT EXISTS guards.
CREATE OR REPLACE FUNCTION lead_export_lead_visible(j lead_export_job,l lead) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(l.organization_id=j.organization_id AND (j.actor_role='SUPER_ADMIN' OR l.branch_id=j.branch_scope
  AND (j.actor_role='MANAGER' OR j.actor_role='AGENT' AND l.assigned_agent_id=j.actor_id))
  AND EXISTS(SELECT 1 FROM campaign c WHERE c.id=l.campaign_id AND c.organization_id=l.organization_id AND c.branch_id=l.branch_id),false)
$$;
