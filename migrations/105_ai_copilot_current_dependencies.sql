-- Copilot remains a distinct read-only operation. Current Published/configuration provenance cannot be forged or replayed.
CREATE OR REPLACE FUNCTION ai_copilot_current(s ai_campaign_simulation) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b record;c record;l record;cv record;u record;p record;selected uuid;cfg jsonb;profile jsonb;k jsonb;g integer;item record;
BEGIN
  SELECT * INTO b FROM branch WHERE id=s.branch_id AND organization_id=s.organization_id AND active FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO c FROM campaign WHERE id=s.campaign_id AND branch_id=b.id AND organization_id=s.organization_id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO l FROM lead WHERE id=s.lead_id AND branch_id=b.id AND organization_id=s.organization_id AND campaign_id=c.id FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO cv FROM conversation WHERE id=s.conversation_id AND lead_id=l.id AND controller_type='HUMAN' AND state='HUMAN_ACTIVE' FOR SHARE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT a.* INTO u FROM user_account a JOIN user_session ss ON ss.user_id=a.id WHERE a.id=s.actor_id AND ss.id=s.session_id AND a.active AND a.organization_id=s.organization_id AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
    AND (a.role='SUPER_ADMIN' OR a.branch_id=b.id AND (a.role='MANAGER' OR a.role='AGENT' AND a.id=l.assigned_agent_id)) FOR SHARE OF a,ss;IF NOT FOUND THEN RETURN false;END IF;
  IF s.context->>'kind' IS DISTINCT FROM 'COPILOT_SUMMARY' OR s.context->'invoker'->>'id' IS DISTINCT FROM u.id::text OR s.context->'invoker'->>'role' IS DISTINCT FROM u.role::text
    OR s.context->'invoker'->>'branchId' IS DISTINCT FROM u.branch_id::text OR s.context->'summaryContext' IS DISTINCT FROM ai_copilot_summary_context(cv.id)
    OR s.references_json IS DISTINCT FROM s.context->'summaryContext'->'references' THEN RETURN false;END IF;
  cfg=s.context->'campaignContext';
  IF cfg->>'organizationId' IS DISTINCT FROM s.organization_id::text OR cfg->>'branchId' IS DISTINCT FROM b.id::text OR cfg->>'campaignId' IS DISTINCT FROM c.id::text
    OR (cfg->>'campaignVersion')::integer IS DISTINCT FROM c.version OR (cfg->'messaging'->>'branchPolicyVersion')::integer IS DISTINCT FROM b.messaging_policy_version
    OR cfg->'globalGuardrails'->>'version' IS DISTINCT FROM '1' OR EXISTS(SELECT 1 FROM jsonb_each(cfg->'globalGuardrails') e WHERE key<>'version' AND value<>'true'::jsonb) THEN RETURN false;END IF;
  FOR item IN SELECT scope,resource_id,version,definition FROM ai_operational_config WHERE branch_id=b.id AND (campaign_id IS NULL OR campaign_id=c.id) FOR SHARE LOOP
    profile=CASE WHEN item.scope='BRANCH' THEN cfg->'branchDefaults' ELSE cfg->'campaignOverrides' END;
    IF (profile->>'version')::integer IS DISTINCT FROM item.version OR profile->'definition' IS DISTINCT FROM item.definition THEN RETURN false;END IF;
  END LOOP;
  IF (cfg->'branchDefaults'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id),0)
    OR (cfg->'campaignOverrides'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),0) THEN RETURN false;END IF;
  selected=COALESCE((SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id),
    (SELECT (definition->'profiles'->>'SUMMARIZATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id));
  IF selected IS NULL OR NOT ai_operational_profile_usable(b.id,selected,'SUMMARIZATION') OR cfg->'profiles'->'SUMMARIZATION'->>'id' IS DISTINCT FROM selected::text THEN RETURN false;END IF;
  SELECT pr.*,ic.version AS cv,ic.provider,ic.id AS cid INTO p FROM ai_model_profile pr JOIN integration_connection ic ON ic.id=pr.connection_id WHERE pr.id=selected FOR SHARE OF pr,ic;
  profile=cfg->'profiles'->'SUMMARIZATION';g=CASE WHEN p.branch_id IS NULL THEN (SELECT version FROM ai_connection_branch_use WHERE connection_id=p.cid AND branch_id=b.id AND active FOR SHARE) ELSE NULL END;
  IF profile->>'model_id' IS DISTINCT FROM p.model_id OR (profile->>'profile_version')::integer IS DISTINCT FROM p.version OR (profile->>'max_output_tokens')::integer IS DISTINCT FROM p.max_output_tokens
    OR (profile->>'connection_version')::integer IS DISTINCT FROM p.cv OR profile->>'connection_id' IS DISTINCT FROM p.cid::text OR profile->>'provider' IS DISTINCT FROM p.provider OR (profile->>'grant_version')::integer IS DISTINCT FROM g THEN RETURN false;END IF;
  SELECT jsonb_build_object('version',version,'content',content,'assets',(SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=kp.campaign_id AND m.version=kp.version)) INTO k
    FROM ai_knowledge_publication kp WHERE campaign_id=c.id ORDER BY version DESC LIMIT 1;
  IF cfg->'knowledge' IS DISTINCT FROM COALESCE(k,'null'::jsonb)
    OR (cfg->'qualification'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_qualification_config WHERE campaign_id=c.id FOR SHARE),0)
    OR (cfg->'followup'->>'version')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_followup_policy WHERE campaign_id=c.id FOR SHARE),0)
    OR (cfg->'behavior'->>'branchVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='BRANCH' AND resource_id=b.id FOR SHARE),0)
    OR (cfg->'behavior'->>'campaignVersion')::integer IS DISTINCT FROM COALESCE((SELECT version FROM ai_behavior_policy WHERE scope='CAMPAIGN' AND resource_id=c.id FOR SHARE),0) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
