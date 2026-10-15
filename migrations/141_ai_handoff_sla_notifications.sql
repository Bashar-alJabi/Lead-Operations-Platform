ALTER TABLE notification_event DROP CONSTRAINT notification_event_event_type_check;
ALTER TABLE notification_event ADD CONSTRAINT notification_event_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_event_type_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED'));
ALTER TABLE notification_template DROP CONSTRAINT notification_template_event_type_check;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_event_type_check CHECK(event_type IN ('AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED'));
-- Version1 of two independent preferences must never collide or select the other event's current proof.
ALTER TABLE notification_user_history ADD COLUMN event_type text NOT NULL DEFAULT 'AI_HANDOFF_REQUESTED';
ALTER TABLE notification_user_history DROP CONSTRAINT notification_user_history_pkey;
ALTER TABLE notification_user_history ADD PRIMARY KEY(user_id,kind,resource_id,event_type,version);
CREATE OR REPLACE FUNCTION guard_notification_user_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s jsonb;x xid;ts timestamptz;evt text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE';END IF;
 IF NEW.kind='STATE' THEN
  SELECT to_jsonb(ns),ns.xmin,ns.updated_at,e.event_type INTO s,x,ts,evt FROM notification_state ns JOIN notification_event e ON e.id=ns.event_id
   WHERE ns.user_id=NEW.user_id AND ns.event_id=NEW.resource_id AND ns.version=NEW.version;
 ELSE
  SELECT to_jsonb(np),np.xmin,np.updated_at,np.event_type INTO s,x,ts,evt FROM notification_preference np WHERE np.user_id=NEW.user_id AND NEW.resource_id=NEW.user_id
   AND np.version=NEW.version AND np.event_type=NEW.snapshot->>'event_type' AND np.channel='IN_APP';
 END IF;
 IF s IS NULL OR NOT ai_row_inserted_here(x) OR NEW.snapshot IS DISTINCT FROM s THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_CURRENT_PROOF_REQUIRED';END IF;
 NEW.event_type=evt;NEW.created_at=ts;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION record_notification_user_write() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE k text;rid uuid;oid uuid;bid uuid;evt text;BEGIN
 k=CASE WHEN TG_TABLE_NAME='notification_state' THEN 'STATE' ELSE 'PREFERENCE' END;
 IF k='STATE' THEN rid=NEW.event_id;SELECT organization_id,branch_id,event_type INTO oid,bid,evt FROM notification_event WHERE id=rid;
 ELSE rid=NEW.user_id;evt=NEW.event_type;SELECT organization_id,branch_id INTO oid,bid FROM user_account WHERE id=NEW.user_id;END IF;
 INSERT INTO notification_user_history(user_id,kind,resource_id,version,snapshot,created_at) VALUES(NEW.user_id,k,rid,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(oid,bid,NEW.user_id,'IN_APP_NOTIFICATION_'||k||'_CHANGED','USER',NEW.user_id,jsonb_build_object('resourceId',rid,'version',NEW.version,'eventType',evt));RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_ai_handoff_sla_breach() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record;owner_id uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HANDOFF_SLA_BREACH_IMMUTABLE';END IF;
 SELECT st.*,st.xmin AS inserted_xid INTO t FROM ai_handoff_sla_timer st WHERE action_id=NEW.action_id AND state='EXPIRED';
 IF t IS NULL OR NOT ai_row_inserted_here(t.inserted_xid) THEN RAISE EXCEPTION 'HANDOFF_SLA_FRESH_EXPIRY_REQUIRED';END IF;
 SELECT assigned_agent_id INTO owner_id FROM lead WHERE id=t.lead_id;
 NEW.timer_version=t.version;NEW.snapshot=(to_jsonb(t)-'inserted_xid')||jsonb_build_object('ownerAtObservation',owner_id);NEW.observed_at=t.updated_at;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;r record;t record;br record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_EVENT_IMMUTABLE';END IF;
 SELECT re.*,re.xmin AS inserted_xid INTO r FROM ai_handoff_reception_event re WHERE action_id=NEW.source_id;
 SELECT ha.*,ha.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action ha WHERE id=NEW.source_id AND state='APPLIED';
 IF NEW.event_type='AI_HANDOFF_REQUESTED' THEN
  IF r IS NULL OR a IS NULL OR NOT ai_row_inserted_here(r.inserted_xid) OR NOT ai_row_inserted_here(a.inserted_xid)
   OR ai_handoff_reception(a.id,clock_timestamp()) IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_HANDOFF_REQUIRED';END IF;
  NEW.created_at=r.created_at;
 ELSIF NEW.event_type='AI_HANDOFF_SLA_EXCEEDED' THEN
  SELECT st.*,st.xmin AS inserted_xid INTO t FROM ai_handoff_sla_timer st WHERE action_id=NEW.source_id AND state='EXPIRED';
  SELECT sb.*,sb.xmin AS inserted_xid INTO br FROM ai_handoff_sla_breach sb WHERE action_id=NEW.source_id;
  IF a IS NULL OR r IS NULL OR t IS NULL OR br IS NULL OR NOT ai_row_inserted_here(t.inserted_xid) OR NOT ai_row_inserted_here(br.inserted_xid)
   OR br.timer_version<>t.version OR ai_handoff_reception(a.id,clock_timestamp()) IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_SLA_BREACH_REQUIRED';END IF;
  NEW.created_at=br.observed_at;
 ELSE RAISE EXCEPTION 'NOTIFICATION_EVENT_TYPE_REQUIRED';END IF;
 NEW.organization_id=(a.context->'scope'->>'organizationId')::uuid;NEW.branch_id=(a.context->'scope'->>'branchId')::uuid;
 NEW.lead_id=a.lead_id;NEW.campaign_id=a.campaign_id;NEW.conversation_id=a.conversation_id;RETURN NEW;
END $$;
CREATE FUNCTION notify_ai_handoff_sla() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n record;BEGIN
 INSERT INTO notification_event(event_type,source_id) VALUES('AI_HANDOFF_SLA_EXCEEDED',NEW.action_id) RETURNING * INTO n;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','CONVERSATION',n.conversation_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_sla_notification AFTER INSERT ON ai_handoff_sla_breach FOR EACH ROW EXECUTE FUNCTION notify_ai_handoff_sla();
