ALTER TABLE user_account ADD COLUMN operational_scope_version integer NOT NULL DEFAULT 0 CHECK(operational_scope_version>=0);

CREATE INDEX lead_staff_assignee_idx ON lead(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX conversation_staff_controller_idx ON conversation(controller_user_id) WHERE state<>'CLOSED' AND controller_user_id IS NOT NULL;
CREATE INDEX campaign_agent_staff_active_idx ON campaign_agent(agent_id) WHERE active;

CREATE TABLE staff_operational_scope_history (
 user_id uuid NOT NULL REFERENCES user_account(id),
 version integer NOT NULL CHECK(version>0),
 previous_branch_id uuid NOT NULL REFERENCES branch(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 previous_role text NOT NULL CHECK(previous_role IN ('AGENT','MANAGER')),
 role text NOT NULL CHECK(role IN ('AGENT','MANAGER')),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,version),
 CHECK((previous_branch_id,previous_role) IS DISTINCT FROM (branch_id,role))
);

CREATE FUNCTION guard_staff_scope_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STAFF_SCOPE_HISTORY_IMMUTABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account target JOIN user_account actor ON actor.organization_id=target.organization_id
  JOIN user_session s ON s.user_id=actor.id WHERE target.id=NEW.user_id AND target.branch_id=NEW.branch_id AND target.role=NEW.role
   AND target.operational_scope_version=NEW.version AND ai_row_inserted_here(target.xmin)
   AND actor.id=NEW.actor_id AND actor.active AND actor.role='SUPER_ADMIN' AND s.id=NEW.session_id
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF actor,s)
 THEN RAISE EXCEPTION 'STAFF_SCOPE_ACCESS_REVOKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_scope_history_guard BEFORE INSERT OR UPDATE OR DELETE ON staff_operational_scope_history
 FOR EACH ROW EXECUTE FUNCTION guard_staff_scope_history();

CREATE FUNCTION require_staff_scope_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operational_scope_version<>OLD.operational_scope_version+1 OR NOT EXISTS(SELECT 1 FROM staff_operational_scope_history h
  WHERE h.user_id=NEW.id AND h.version=NEW.operational_scope_version AND ai_row_inserted_here(h.xmin)
   AND (h.branch_id,h.role,h.previous_branch_id,h.previous_role)=(NEW.branch_id,NEW.role,OLD.branch_id,OLD.role))
 THEN RAISE EXCEPTION 'STAFF_SCOPE_HISTORY_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER staff_scope_history_required AFTER UPDATE ON user_account DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.operational_scope_version IS DISTINCT FROM OLD.operational_scope_version)
 EXECUTE FUNCTION require_staff_scope_history();

CREATE FUNCTION change_staff_operational_scope(
 target_id uuid, expected_version integer, destination_id uuid, destination_role text, operator_id uuid, operator_session uuid, change_reason text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE subject user_account; initial_branch uuid; org uuid; next_version integer; change_detail jsonb;
BEGIN
 SELECT u.organization_id INTO org FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=operator_id AND u.role='SUPER_ADMIN' AND u.active
   AND s.id=operator_session AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_SCOPE_ACCESS_REVOKED'; END IF;
 SELECT branch_id INTO initial_branch FROM user_account WHERE id=target_id AND organization_id=org AND role IN ('MANAGER','AGENT');
 IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

 PERFORM id FROM branch WHERE id IN(initial_branch,destination_id) AND organization_id=org ORDER BY id FOR NO KEY UPDATE;
 SELECT * INTO subject FROM user_account WHERE id=target_id AND organization_id=org AND role IN ('MANAGER','AGENT') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
 IF subject.operational_scope_version IS DISTINCT FROM expected_version OR subject.branch_id<>initial_branch
 THEN RAISE EXCEPTION 'STAFF_SCOPE_VERSION_CONFLICT'; END IF;
 IF destination_role IS NULL OR destination_role NOT IN ('AGENT','MANAGER') OR NOT EXISTS(
  SELECT 1 FROM branch WHERE id=destination_id AND organization_id=org AND active
 ) THEN RAISE EXCEPTION 'STAFF_SCOPE_DESTINATION_INVALID'; END IF;
 IF change_reason IS NULL OR length(btrim(change_reason)) NOT BETWEEN 3 AND 500 OR change_reason ~ '[[:cntrl:]]'
 THEN RAISE EXCEPTION 'STAFF_SCOPE_REASON_INVALID'; END IF;
 IF (subject.branch_id,subject.role)=(destination_id,destination_role) THEN RETURN subject.operational_scope_version; END IF;

 -- Explicit reassignment keeps the original Lead and its financial, messaging and task history in scope.
 IF EXISTS(SELECT 1 FROM lead WHERE assigned_agent_id=subject.id)
  OR EXISTS(SELECT 1 FROM follow_up WHERE owner_user_id=subject.id AND status='OPEN')
  OR EXISTS(SELECT 1 FROM conversation WHERE controller_user_id=subject.id AND state<>'CLOSED')
 THEN RAISE EXCEPTION 'STAFF_SCOPE_REASSIGN_WORK'; END IF;

 UPDATE user_account SET branch_id=destination_id,role=destination_role,operational_scope_version=operational_scope_version+1,
  updated_at=clock_timestamp() WHERE id=subject.id RETURNING operational_scope_version INTO next_version;
 UPDATE user_session SET revoked_at=clock_timestamp() WHERE user_id=subject.id AND revoked_at IS NULL;
 WITH disabled AS (
  UPDATE campaign_agent SET active=false WHERE agent_id=subject.id AND active RETURNING campaign_id
 ) UPDATE campaign c SET version=version+1,updated_at=clock_timestamp()
  FROM disabled WHERE c.id=disabled.campaign_id;
 INSERT INTO staff_operational_scope_history(user_id,version,previous_branch_id,branch_id,previous_role,role,actor_id,session_id,reason)
 VALUES(subject.id,next_version,subject.branch_id,destination_id,subject.role,destination_role,operator_id,operator_session,btrim(change_reason));

 change_detail=jsonb_build_object('version',next_version,'fromBranchId',subject.branch_id,'toBranchId',destination_id,
  'fromRole',subject.role,'toRole',destination_role,'reason',btrim(change_reason));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 SELECT org,id,operator_id,'STAFF_OPERATIONAL_SCOPE_CHANGED','USER',subject.id,change_detail
 FROM branch WHERE id IN(subject.branch_id,destination_id);
 RETURN next_version;
END $$;
