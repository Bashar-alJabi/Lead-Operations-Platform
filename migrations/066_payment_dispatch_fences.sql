-- Defense in depth for claims: resource snapshots and authorization must still be current.
CREATE FUNCTION payment_dispatch_authorized(intent uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM payment_link_intent i JOIN integration_connection c ON c.id=i.connection_id
    JOIN branch b ON b.id=i.branch_id JOIN payment_method m ON m.id=i.method_id JOIN payment_webhook w ON w.id=i.webhook_id
    JOIN lead l ON l.id=i.lead_id JOIN user_account u ON u.id=i.requester_id JOIN user_session s ON s.id=i.requester_session_id AND s.user_id=u.id
    WHERE i.id=intent AND b.active AND m.active AND m.version=i.method_version AND m.connection_id=i.connection_id
      AND m.branch_id=i.branch_id AND m.currencies ? i.currency AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
      AND c.kind='PAYMENT' AND c.organization_id=i.organization_id AND (c.branch_id IS NULL OR c.branch_id=i.branch_id)
      AND c.provider=i.provider AND c.version=i.connection_version AND c.config->>'mode'=i.mode AND c.status IN ('CONNECTED','WARNING')
      AND c.capabilities->>'authenticationVerified'='true' AND c.capabilities->>'paymentOptionsVersion'=i.connection_version::text
      AND c.capabilities->'paymentOptions'->>'accountRef'=i.account_ref AND c.capabilities->'paymentOptions'->>'chargesEnabled'='true'
      AND c.capabilities->'paymentOptions'->'currencies' ? i.currency
      AND w.state='CONFIGURED' AND w.version=i.webhook_version AND w.connection_version=i.connection_version AND w.last_signed_at IS NOT NULL
      AND (SELECT state FROM payment_webhook_probe WHERE webhook_id=w.id ORDER BY probe_number DESC LIMIT 1)='VERIFIED'
      AND (l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id) IS NOT DISTINCT FROM (i.organization_id,i.branch_id,i.campaign_id,i.assigned_agent_id)
      AND u.active AND u.organization_id=i.organization_id AND u.role=i.requester_role AND u.branch_id IS NOT DISTINCT FROM i.requester_branch_id
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (u.role='SUPER_ADMIN' OR (u.role='MANAGER' AND u.branch_id=l.branch_id) OR
        (u.role='AGENT' AND u.branch_id=l.branch_id AND l.assigned_agent_id=u.id AND (m.agent_mode='ALL' OR m.agent_ids ? u.id::text))))
$$;
CREATE FUNCTION fence_payment_dispatch_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d payment_dispatch;
BEGIN
  SELECT * INTO d FROM payment_dispatch WHERE intent_id=NEW.intent_id;
  IF NOT payment_dispatch_authorized(NEW.intent_id) OR NEW.number>(d.policy->>'maxAttempts')::integer
    OR floor(extract(epoch FROM clock_timestamp())*1000)+(d.policy->>'dispatchBudgetMs')::bigint>=d.first_dispatch_ms+(d.policy->>'retentionMs')::bigint
    THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_CURRENT_FENCE_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_dispatch_current_fence BEFORE INSERT ON payment_dispatch_attempt FOR EACH ROW EXECUTE FUNCTION fence_payment_dispatch_attempt();
