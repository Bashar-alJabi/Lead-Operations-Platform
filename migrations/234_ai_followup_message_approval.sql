CREATE TABLE ai_followup_message_policy (
 campaign_id uuid PRIMARY KEY REFERENCES campaign(id),
 version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(ai_initial_message_definition_valid(definition)),
 approval jsonb,
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),
 updated_at timestamptz NOT NULL
);

CREATE TABLE ai_followup_message_history (
 campaign_id uuid NOT NULL REFERENCES ai_followup_message_policy(campaign_id),
 version integer NOT NULL,
 snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(campaign_id,version)
);

CREATE FUNCTION ai_followup_message_approval(cid uuid,tid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT approval FROM campaign c
 LEFT JOIN ai_operational_config cp ON cp.scope='CAMPAIGN' AND cp.resource_id=c.id
 LEFT JOIN ai_operational_config bp ON bp.scope='BRANCH' AND bp.resource_id=c.branch_id
 CROSS JOIN LATERAL (SELECT ai_initial_template_approval(c.id,tid) AS approval) template
 WHERE c.id=cid AND approval IS NOT NULL AND EXISTS(
  SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(cp.definition->'language','null'),bp.definition->'language')->'supported') AS supported(tag)
  WHERE lower(split_part(supported.tag,'-',1))=lower(split_part(replace(approval->'template'->>'language','_','-'),'-',1))
 )
$$;

CREATE FUNCTION guard_ai_followup_message_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject campaign; selected_template_id uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_HISTORY_RETAINED'; END IF;
 SELECT * INTO subject FROM campaign WHERE id=NEW.campaign_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_CURRENT_ACCESS_REQUIRED'; END IF;
 PERFORM 1 FROM branch WHERE id=subject.branch_id AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_CURRENT_ACCESS_REQUIRED'; END IF;
 PERFORM 1 FROM campaign WHERE id=subject.id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=subject.organization_id
   AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=subject.branch_id)
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s)
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_CURRENT_ACCESS_REQUIRED'; END IF;
 IF (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1))
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_VERSION_REQUIRED'; END IF;
 IF NOT ai_initial_message_definition_valid(NEW.definition) THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_INVALID'; END IF;

 selected_template_id=(NEW.definition->>'templateId')::uuid;
 NEW.approval=NULL;
 IF selected_template_id IS NOT NULL THEN
  PERFORM 1 FROM provider_message_template WHERE id=selected_template_id FOR SHARE;
  PERFORM 1 FROM campaign_message_template_binding WHERE campaign_id=subject.id AND template_id=selected_template_id FOR SHARE;
  NEW.approval=ai_followup_message_approval(subject.id,selected_template_id);
  IF NEW.approval IS NULL OR ai_initial_render_template(NEW.approval->'template'->'components',NEW.definition) IS NULL
  THEN RAISE EXCEPTION 'AI_FOLLOWUP_PUBLISHED_TEMPLATE_REQUIRED'; END IF;
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_message_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_message_policy
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_message_policy();

CREATE FUNCTION guard_ai_followup_message_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM ai_followup_message_policy p
  WHERE p.campaign_id=NEW.campaign_id AND p.version=NEW.version AND to_jsonb(p)=NEW.snapshot AND ai_row_inserted_here(p.xmin))
 THEN RAISE EXCEPTION 'AI_FOLLOWUP_MESSAGE_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_message_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_followup_message_history
 FOR EACH ROW EXECUTE FUNCTION guard_ai_followup_message_history();

CREATE FUNCTION record_ai_followup_message_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO ai_followup_message_history(campaign_id,version,snapshot,created_at)
 VALUES(NEW.campaign_id,NEW.version,to_jsonb(NEW),NEW.updated_at);
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
 SELECT organization_id,branch_id,NEW.actor_id,'AI_FOLLOWUP_MESSAGE_CONFIGURED','CAMPAIGN',id,
   jsonb_build_object('version',NEW.version,'reason',NEW.reason,'templateId',NEW.definition->>'templateId')
 FROM campaign WHERE id=NEW.campaign_id;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_followup_message_policy_record AFTER INSERT OR UPDATE ON ai_followup_message_policy
 FOR EACH ROW EXECUTE FUNCTION record_ai_followup_message_policy();

CREATE FUNCTION ai_followup_message_context(cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',p.version,'definition',p.definition,'approval',p.approval,
  'ready',COALESCE(p.approval=ai_followup_message_approval(cid,(p.definition->>'templateId')::uuid),false),
  'body',CASE WHEN p.approval IS NOT NULL THEN ai_initial_render_template(p.approval->'template'->'components',p.definition) END)
 FROM ai_followup_message_policy p WHERE campaign_id=cid
$$;
