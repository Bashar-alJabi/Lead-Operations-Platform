-- In-App delivery uses a durable event and current authorized audience, without unbounded user fan-out.
CREATE TABLE notification_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_type text NOT NULL CHECK(event_type='AI_HANDOFF_REQUESTED'),
 source_id uuid NOT NULL REFERENCES ai_handoff_reception_event(action_id),
 organization_id uuid NOT NULL REFERENCES organization(id),branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),lead_id uuid NOT NULL REFERENCES lead(id),conversation_id uuid NOT NULL REFERENCES conversation(id),
 created_at timestamptz NOT NULL,
 UNIQUE(event_type,source_id)
);
CREATE INDEX notification_event_branch_page ON notification_event(organization_id,branch_id,created_at DESC,id DESC);
CREATE INDEX notification_event_org_page ON notification_event(organization_id,created_at DESC,id DESC);
CREATE INDEX notification_event_lead ON notification_event(lead_id,created_at DESC,id DESC);
CREATE FUNCTION guard_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record;r record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_EVENT_IMMUTABLE';END IF;
 SELECT re.*,re.xmin AS inserted_xid INTO r FROM ai_handoff_reception_event re WHERE action_id=NEW.source_id;
 SELECT ha.*,ha.xmin AS inserted_xid INTO a FROM ai_customer_handoff_action ha WHERE id=NEW.source_id AND state='APPLIED';
 IF r IS NULL OR a IS NULL OR NOT ai_row_inserted_here(r.inserted_xid) OR NOT ai_row_inserted_here(a.inserted_xid)
  OR ai_handoff_reception(a.id,clock_timestamp()) IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_FRESH_HANDOFF_REQUIRED';END IF;
 NEW.organization_id=(a.context->'scope'->>'organizationId')::uuid;NEW.branch_id=(a.context->'scope'->>'branchId')::uuid;
 NEW.lead_id=a.lead_id;NEW.campaign_id=a.campaign_id;NEW.conversation_id=a.conversation_id;NEW.created_at=r.created_at;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_event_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_event FOR EACH ROW EXECUTE FUNCTION guard_notification_event();
CREATE FUNCTION notify_ai_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n record;BEGIN
 INSERT INTO notification_event(event_type,source_id) VALUES('AI_HANDOFF_REQUESTED',NEW.action_id) RETURNING * INTO n;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  VALUES(n.organization_id,n.branch_id,'IN_APP_NOTIFICATION_RECORDED','CONVERSATION',n.conversation_id,jsonb_build_object('eventId',n.id,'eventType',n.event_type));
 RETURN NEW;
END $$;
CREATE TRIGGER ai_handoff_notification AFTER INSERT ON ai_handoff_reception_event FOR EACH ROW EXECUTE FUNCTION notify_ai_handoff();

CREATE FUNCTION notification_access(eid uuid,uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM notification_event e JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
  JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id
  JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
  JOIN user_account u ON u.id=uid AND u.active AND u.organization_id=e.organization_id
  WHERE e.id=eid AND (u.role='SUPER_ADMIN' OR u.branch_id=e.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id)))
$$;
CREATE FUNCTION notification_session(uid uuid,sid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=uid AND u.active AND s.id=sid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
$$;
CREATE TABLE notification_preference (
 user_id uuid NOT NULL REFERENCES user_account(id),event_type text NOT NULL CHECK(event_type='AI_HANDOFF_REQUESTED'),
 channel text NOT NULL CHECK(channel='IN_APP'),enabled boolean NOT NULL,version integer NOT NULL CHECK(version>0),
 session_id uuid NOT NULL REFERENCES user_session(id),updated_at timestamptz NOT NULL,PRIMARY KEY(user_id,event_type,channel)
);
CREATE TABLE notification_state (
 user_id uuid NOT NULL REFERENCES user_account(id),event_id uuid NOT NULL REFERENCES notification_event(id),is_read boolean NOT NULL,
 version integer NOT NULL CHECK(version>0),session_id uuid NOT NULL REFERENCES user_session(id),updated_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,event_id)
);
CREATE INDEX notification_state_user_read ON notification_state(user_id,is_read,event_id);
CREATE TABLE notification_user_history (
 user_id uuid NOT NULL REFERENCES user_account(id),kind text NOT NULL CHECK(kind IN ('PREFERENCE','STATE')),resource_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,kind,resource_id,version)
);
CREATE FUNCTION guard_notification_user_write() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOTIFICATION_USER_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR NEW.user_id<>OLD.user_id)
  THEN RAISE EXCEPTION 'NOTIFICATION_VERSION_REQUIRED';END IF;
 IF TG_TABLE_NAME='notification_state' THEN
  IF TG_OP='UPDATE' AND NEW.event_id<>OLD.event_id THEN RAISE EXCEPTION 'NOTIFICATION_IDENTITY_IMMUTABLE';END IF;
  SELECT * INTO n FROM notification_event WHERE id=NEW.event_id;
  PERFORM 1 FROM branch WHERE id=n.branch_id FOR SHARE;
  PERFORM 1 FROM lead WHERE id=n.lead_id FOR SHARE;
  PERFORM 1 FROM campaign WHERE id=n.campaign_id FOR SHARE;
  PERFORM 1 FROM conversation WHERE id=n.conversation_id FOR SHARE;
  IF NOT notification_access(NEW.event_id,NEW.user_id) THEN RAISE EXCEPTION 'NOTIFICATION_CURRENT_ACCESS_REQUIRED';END IF;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.event_type<>OLD.event_type OR NEW.channel<>OLD.channel) THEN RAISE EXCEPTION 'NOTIFICATION_IDENTITY_IMMUTABLE';END IF;
 END IF;
 IF NOT notification_session(NEW.user_id,NEW.session_id) THEN RAISE EXCEPTION 'NOTIFICATION_CURRENT_SESSION_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_state_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_state FOR EACH ROW EXECUTE FUNCTION guard_notification_user_write();
CREATE TRIGGER notification_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_preference FOR EACH ROW EXECUTE FUNCTION guard_notification_user_write();
CREATE FUNCTION guard_notification_user_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s jsonb;x xid;ts timestamptz;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE';END IF;
 IF NEW.kind='STATE' THEN SELECT to_jsonb(ns),ns.xmin,ns.updated_at INTO s,x,ts FROM notification_state ns WHERE user_id=NEW.user_id AND event_id=NEW.resource_id AND version=NEW.version;
 ELSE SELECT to_jsonb(np),np.xmin,np.updated_at INTO s,x,ts FROM notification_preference np WHERE user_id=NEW.user_id AND NEW.resource_id=NEW.user_id AND version=NEW.version;END IF;
 IF s IS NULL OR NOT ai_row_inserted_here(x) OR NEW.snapshot IS DISTINCT FROM s THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_CURRENT_PROOF_REQUIRED';END IF;
 NEW.created_at=ts;RETURN NEW;
END $$;
CREATE TRIGGER notification_user_history_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_user_history FOR EACH ROW EXECUTE FUNCTION guard_notification_user_history();
CREATE FUNCTION record_notification_user_write() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE k text;rid uuid;oid uuid;bid uuid;BEGIN
 k=CASE WHEN TG_TABLE_NAME='notification_state' THEN 'STATE' ELSE 'PREFERENCE' END;
 IF k='STATE' THEN rid=NEW.event_id;SELECT organization_id,branch_id INTO oid,bid FROM notification_event WHERE id=rid;
 ELSE rid=NEW.user_id;SELECT organization_id,branch_id INTO oid,bid FROM user_account WHERE id=NEW.user_id;END IF;
 INSERT INTO notification_user_history(user_id,kind,resource_id,version,snapshot,created_at) VALUES(NEW.user_id,k,rid,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(oid,bid,NEW.user_id,'IN_APP_NOTIFICATION_'||k||'_CHANGED','USER',NEW.user_id,jsonb_build_object('resourceId',rid,'version',NEW.version));
 RETURN NEW;
END $$;
CREATE TRIGGER notification_state_history AFTER INSERT OR UPDATE ON notification_state FOR EACH ROW EXECUTE FUNCTION record_notification_user_write();
CREATE TRIGGER notification_preference_history AFTER INSERT OR UPDATE ON notification_preference FOR EACH ROW EXECUTE FUNCTION record_notification_user_write();

CREATE FUNCTION notification_text_valid(v text,max_size integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v IS NOT NULL AND length(trim(v)) BETWEEN 1 AND max_size AND v !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
  AND replace(replace(v,'{{campaign}}',''),'{{owner}}','') !~ '[{}]'
$$;
CREATE TABLE notification_template (
 scope text NOT NULL CHECK(scope IN ('GLOBAL','BRANCH','CAMPAIGN')),resource_id uuid NOT NULL,organization_id uuid NOT NULL REFERENCES organization(id),
 branch_id uuid REFERENCES branch(id),campaign_id uuid REFERENCES campaign(id),event_type text NOT NULL CHECK(event_type='AI_HANDOFF_REQUESTED'),
 channel text NOT NULL CHECK(channel='IN_APP'),language text NOT NULL CHECK(language IN ('ar','en','fr')),
 title text NOT NULL CHECK(notification_text_valid(title,160)),body text NOT NULL CHECK(notification_text_valid(body,1000)),active boolean NOT NULL,
 version integer NOT NULL CHECK(version>0),actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[\x00-\x1f\x7f]'),updated_at timestamptz NOT NULL,
 PRIMARY KEY(scope,resource_id,event_type,channel,language),
 CHECK(scope='GLOBAL' AND resource_id=organization_id AND branch_id IS NULL AND campaign_id IS NULL OR
  scope='BRANCH' AND resource_id=branch_id AND campaign_id IS NULL OR scope='CAMPAIGN' AND resource_id=campaign_id AND branch_id IS NOT NULL)
);
CREATE TABLE notification_template_history (
 scope text NOT NULL,resource_id uuid NOT NULL,event_type text NOT NULL,channel text NOT NULL,language text NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(scope,resource_id,event_type,channel,language,version),
 FOREIGN KEY(scope,resource_id,event_type,channel,language) REFERENCES notification_template(scope,resource_id,event_type,channel,language)
);
CREATE FUNCTION guard_notification_template() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE u record;b record;c record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOTIFICATION_TEMPLATE_HISTORY_PRESERVED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'NOTIFICATION_VERSION_REQUIRED';END IF;
 IF TG_OP='UPDATE' AND (NEW.scope,NEW.resource_id,NEW.organization_id,NEW.branch_id,NEW.campaign_id,NEW.event_type,NEW.channel,NEW.language)
  IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.organization_id,OLD.branch_id,OLD.campaign_id,OLD.event_type,OLD.channel,OLD.language) THEN RAISE EXCEPTION 'NOTIFICATION_IDENTITY_IMMUTABLE';END IF;
 IF NEW.scope='GLOBAL' THEN PERFORM 1 FROM organization WHERE id=NEW.organization_id FOR UPDATE;
 ELSE
  SELECT * INTO b FROM branch WHERE id=NEW.branch_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF b IS NULL OR NOT b.active THEN RAISE EXCEPTION 'NOTIFICATION_TEMPLATE_CURRENT_SCOPE_REQUIRED';END IF;
  IF NEW.scope='CAMPAIGN' THEN
   SELECT * INTO c FROM campaign WHERE id=NEW.campaign_id AND branch_id=b.id AND organization_id=b.organization_id FOR SHARE;
   IF c IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_TEMPLATE_CURRENT_SCOPE_REQUIRED';END IF;
  END IF;
 END IF;
 IF NOT notification_session(NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'NOTIFICATION_CURRENT_SESSION_REQUIRED';END IF;
 SELECT * INTO u FROM user_account WHERE id=NEW.actor_id;
 IF u.organization_id<>NEW.organization_id OR NOT (u.role='SUPER_ADMIN' OR NEW.scope<>'GLOBAL' AND u.role='MANAGER' AND u.branch_id=NEW.branch_id)
  THEN RAISE EXCEPTION 'NOTIFICATION_TEMPLATE_CURRENT_ACCESS_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_template_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_template FOR EACH ROW EXECUTE FUNCTION guard_notification_template();
CREATE FUNCTION guard_notification_template_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE';END IF;
 SELECT nt.*,nt.xmin AS inserted_xid INTO p FROM notification_template nt WHERE (scope,resource_id,event_type,channel,language,version)=(NEW.scope,NEW.resource_id,NEW.event_type,NEW.channel,NEW.language,NEW.version);
 IF p IS NULL OR NOT ai_row_inserted_here(p.inserted_xid) OR NEW.snapshot IS DISTINCT FROM to_jsonb(p)-'inserted_xid' THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_CURRENT_PROOF_REQUIRED';END IF;
 NEW.created_at=p.updated_at;RETURN NEW;
END $$;
CREATE TRIGGER notification_template_history_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_template_history FOR EACH ROW EXECUTE FUNCTION guard_notification_template_history();
CREATE FUNCTION record_notification_template() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO notification_template_history(scope,resource_id,event_type,channel,language,version,snapshot,created_at)
  VALUES(NEW.scope,NEW.resource_id,NEW.event_type,NEW.channel,NEW.language,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,'IN_APP_NOTIFICATION_TEMPLATE_CONFIGURED','USER',NEW.actor_id,jsonb_build_object('scope',NEW.scope,'resourceId',NEW.resource_id,'language',NEW.language,'version',NEW.version,'reason',NEW.reason));
 RETURN NEW;
END $$;
CREATE TRIGGER notification_template_history_record AFTER INSERT OR UPDATE ON notification_template FOR EACH ROW EXECUTE FUNCTION record_notification_template();
