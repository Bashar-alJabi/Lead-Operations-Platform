-- Autonomous read-only Handoff evidence. No fabricated employee/session or tool authority.
CREATE OR REPLACE FUNCTION ai_handoff_summary_context(aid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('kind','HANDOFF_SUMMARY','actionId',a.id,'sourceContext',ai_customer_inbound_context(p.event_id),
   'summaryContext',ai_copilot_summary_context(cv.id),'toolPolicy',ai_effective_tool_policy(l.branch_id,l.campaign_id),
   'consent',COALESCE((SELECT jsonb_build_object('status',mc.status,'doNotContact',mc.do_not_contact,'version',mc.version) FROM messaging_consent mc WHERE mc.contact_id=l.contact_id AND mc.channel=cv.channel),'null'),
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
