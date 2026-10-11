-- Reception is deterministic operational routing, never a grant of Lead access or Human control.
CREATE FUNCTION ai_handoff_reception(aid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE a record;b record;l record;c record;cv record;cfg_target uuid;target record;owner_record record;
 bd jsonb;cd jsonb;bv integer;cvv integer;receiver uuid;reason_code text;eligible boolean;available boolean;BEGIN
 SELECT * INTO a FROM ai_customer_handoff_action WHERE id=aid AND state='APPLIED';IF a IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO cv FROM conversation WHERE id=a.conversation_id AND ai_handoff_action_id=a.id AND state='WAITING_FOR_HUMAN' AND controller_type='NONE';IF cv IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO l FROM lead WHERE id=cv.lead_id AND id=a.lead_id AND campaign_id=a.campaign_id
  AND organization_id=(a.context->'scope'->>'organizationId')::uuid AND branch_id=(a.context->'scope'->>'branchId')::uuid;IF l IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO b FROM branch WHERE id=l.branch_id AND organization_id=l.organization_id;
 SELECT * INTO c FROM campaign WHERE id=l.campaign_id AND branch_id=b.id AND organization_id=b.organization_id;IF c IS NULL THEN RETURN NULL;END IF;
 SELECT definition,version INTO bd,bv FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=b.id;
 SELECT definition,version INTO cd,cvv FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=c.id;
 cfg_target=COALESCE(cd->>'handoffTargetId',bd->>'handoffTargetId')::uuid;
 SELECT id,name,role,active,working_hours INTO owner_record FROM user_account WHERE id=l.assigned_agent_id AND branch_id=b.id AND organization_id=b.organization_id;
 SELECT id,name,role,active,working_hours INTO target FROM user_account WHERE id=COALESCE(cfg_target,l.assigned_agent_id) AND branch_id=b.id AND organization_id=b.organization_id;
 eligible=target IS NOT NULL AND target.active AND (target.role='MANAGER' OR target.role='AGENT' AND EXISTS(SELECT 1 FROM campaign_agent ca WHERE ca.campaign_id=c.id AND ca.agent_id=target.id AND ca.active));
 available=eligible AND operational_hours_open(b.business_hours,b.timezone,at_time) AND operational_hours_open(target.working_hours,b.timezone,at_time);
 IF NOT b.active THEN reason_code='BRANCH_DISABLED';
 ELSIF l.lifecycle<>'OPEN' THEN reason_code='LEAD_NOT_OPEN';
 ELSIF cfg_target IS NULL AND l.assigned_agent_id IS NULL THEN reason_code='UNASSIGNED_MANAGER_ATTENTION';
 ELSIF target IS NULL OR NOT target.active OR target.role NOT IN ('AGENT','MANAGER') THEN reason_code='TARGET_UNAVAILABLE';
 ELSIF NOT eligible THEN reason_code='AGENT_NOT_CAMPAIGN_ELIGIBLE';
 ELSIF target.role='AGENT' AND target.id IS DISTINCT FROM l.assigned_agent_id THEN reason_code='TARGET_REQUIRES_AUTHORIZED_ASSIGNMENT';
 ELSIF NOT available THEN reason_code='OUTSIDE_WORKING_HOURS';
 ELSE receiver=target.id;reason_code=CASE WHEN cfg_target IS NOT NULL THEN 'CONFIGURED_TARGET_READY' ELSE 'CURRENT_OWNER_READY' END;END IF;
 RETURN jsonb_build_object('actionId',a.id,'ownerId',l.assigned_agent_id,'ownerName',owner_record.name,'configuredTargetId',cfg_target,
  'targetSource',CASE WHEN cd->>'handoffTargetId' IS NOT NULL THEN 'CAMPAIGN' WHEN bd->>'handoffTargetId' IS NOT NULL THEN 'BRANCH' ELSE 'CURRENT_OWNER' END,
  'targetId',target.id,'targetName',target.name,'targetRole',target.role,'receiverId',receiver,'reason',reason_code,'managerAttentionRequired',receiver IS NULL,
  'timezone',b.timezone,'branchConfigVersion',COALESCE(bv,0),'campaignConfigVersion',COALESCE(cvv,0),
  'branchHoursVersion',COALESCE((SELECT version FROM operational_hours_policy WHERE scope='BRANCH' AND resource_id=b.id),0),
  'targetHoursVersion',COALESCE((SELECT version FROM operational_hours_policy WHERE scope='USER' AND resource_id=target.id),0));
END $$;
CREATE TABLE ai_handoff_reception_event (
 action_id uuid PRIMARY KEY REFERENCES ai_customer_handoff_action(id),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ai_handoff_reception_event() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;decision jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_HANDOFF_RECEPTION_HISTORY_IMMUTABLE';END IF;
 SELECT ha.*,ha.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action ha WHERE ha.id=NEW.action_id;
 IF a IS NULL OR NOT ai_row_inserted_here(a.inserted_xid) THEN RAISE EXCEPTION 'AI_HANDOFF_RECEPTION_FRESH_ACTION_REQUIRED';END IF;
 PERFORM 1 FROM branch WHERE id=(a.context->'scope'->>'branchId')::uuid FOR UPDATE;
 PERFORM 1 FROM ai_operational_config WHERE branch_id=(a.context->'scope'->>'branchId')::uuid
  AND (scope='BRANCH' OR campaign_id=a.campaign_id) ORDER BY scope,resource_id FOR SHARE;
 PERFORM 1 FROM user_account WHERE id IN ((a.context->'lead'->>'ownerId')::uuid,
  (SELECT COALESCE((SELECT definition->>'handoffTargetId' FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=a.campaign_id),
   (SELECT definition->>'handoffTargetId' FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=(a.context->'scope'->>'branchId')::uuid))::uuid)) ORDER BY id FOR SHARE;
 PERFORM 1 FROM campaign_agent ca WHERE ca.campaign_id=a.campaign_id AND ca.agent_id IN
  (SELECT u.id FROM user_account u WHERE u.id=(a.context->'lead'->>'ownerId')::uuid OR u.id IN
   (SELECT (definition->>'handoffTargetId')::uuid FROM ai_operational_config WHERE branch_id=(a.context->'scope'->>'branchId')::uuid
    AND (scope='BRANCH' OR campaign_id=a.campaign_id))) ORDER BY ca.agent_id FOR SHARE;
 NEW.created_at=clock_timestamp();decision=ai_handoff_reception(NEW.action_id,NEW.created_at);
 IF decision IS NULL THEN RAISE EXCEPTION 'AI_HANDOFF_RECEPTION_CURRENT_WAITING_REQUIRED';END IF;NEW.snapshot=decision;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_reception_event_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_handoff_reception_event FOR EACH ROW EXECUTE FUNCTION guard_ai_handoff_reception_event();
CREATE FUNCTION record_ai_handoff_reception() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;BEGIN
 IF NEW.ai_action_id IS NOT NULL THEN
  INSERT INTO ai_handoff_reception_event(action_id,snapshot) VALUES(NEW.ai_action_id,'{}') RETURNING * INTO a;
  INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
   SELECT (ha.context->'scope'->>'organizationId')::uuid,(ha.context->'scope'->>'branchId')::uuid,'AI_HANDOFF_RECEPTION_RESOLVED','CONVERSATION',ha.conversation_id,
    jsonb_build_object('actionId',ha.id,'receiverId',a.snapshot->'receiverId','reason',a.snapshot->'reason','managerAttentionRequired',a.snapshot->'managerAttentionRequired')
    FROM ai_customer_handoff_action ha WHERE ha.id=NEW.ai_action_id;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_reception_record AFTER INSERT ON conversation_handoff FOR EACH ROW EXECUTE FUNCTION record_ai_handoff_reception();
