CREATE FUNCTION ai_initial_campaign_sender(cid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT COALESCE(c.sender_override_id,b.default_sender_id,(SELECT CASE WHEN count(*)=1 THEN min(s.id::text)::uuid END
  FROM sender_branch_binding sb JOIN messaging_sender s ON s.id=sb.sender_id JOIN integration_connection ic ON ic.id=s.connection_id
  WHERE sb.branch_id=b.id AND sb.allow_shared_fallback AND ic.branch_id IS NULL AND ic.kind='MESSAGING' AND s.organization_id=c.organization_id))
 FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.id=cid
$$;
CREATE FUNCTION ai_initial_template_approval(cid uuid,tid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('senderId',s.id,'connectionId',ic.id,'template',jsonb_build_object('id',t.id,'externalTemplateId',t.external_template_id,'name',t.name,'language',t.language,'category',t.category,'components',t.components),
  'bindingVersion',tb.version,'knowledgeVersion',k.version,'knowledgeHash',encode(sha256(convert_to(k.content::text,'UTF8')),'hex'))
 FROM campaign c JOIN messaging_sender s ON s.id=ai_initial_campaign_sender(c.id) AND s.organization_id=c.organization_id
 JOIN integration_connection ic ON ic.id=s.connection_id AND ic.organization_id=c.organization_id AND ic.kind='MESSAGING'
 JOIN provider_message_template t ON t.id=tid AND t.connection_id=ic.id AND t.active AND t.status='APPROVED'
 JOIN campaign_message_template_binding tb ON tb.campaign_id=c.id AND tb.template_id=t.id AND tb.active
 JOIN LATERAL (SELECT version,content FROM ai_knowledge_publication WHERE campaign_id=c.id ORDER BY version DESC LIMIT 1) k ON true
 WHERE c.id=cid AND (ic.branch_id=c.branch_id OR ic.branch_id IS NULL AND EXISTS(SELECT 1 FROM sender_branch_binding sb WHERE sb.sender_id=s.id AND sb.branch_id=c.branch_id))
$$;
CREATE FUNCTION ai_initial_render_template(components jsonb,d jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb;part text;result text='';i integer;BEGIN
 FOR p IN SELECT value FROM jsonb_array_elements(components) LOOP
  IF p->>'type' NOT IN ('BODY','HEADER','FOOTER') THEN CONTINUE;END IF;
  IF p->>'type'='HEADER' AND p->>'format'<>'TEXT' THEN RETURN NULL;END IF;
  part=p->>'text';IF part IS NULL THEN RETURN NULL;END IF;
  IF p->>'type'='BODY' THEN FOR i IN 1..jsonb_array_length(d->'bodyParameters') LOOP part=replace(part,'{{'||i||'}}',d->'bodyParameters'->>(i-1));END LOOP;
  ELSIF p->>'type'='HEADER' AND d->>'headerParameter' IS NOT NULL THEN part=replace(part,'{{1}}',d->>'headerParameter');END IF;
  IF part ~ '\{\{|\}\}' THEN RETURN NULL;END IF;result=result||CASE WHEN result='' THEN '' ELSE E'\n\n' END||part;
 END LOOP;
 IF length(trim(result))=0 OR length(result)>20000 THEN RETURN NULL;END IF;RETURN result;
END $$;
CREATE FUNCTION ai_initial_message_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 RETURN jsonb_typeof(d)='object' AND (SELECT count(*) FROM jsonb_object_keys(d))=4 AND d ?& ARRAY['templateId','bodyParameters','headerParameter','urlParameter']
  AND (d->'templateId'='null' OR d->>'templateId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  AND jsonb_typeof(d->'bodyParameters')='array' AND jsonb_array_length(d->'bodyParameters')<=40
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'bodyParameters') v WHERE jsonb_typeof(v)<>'string' OR length(trim(v#>>'{}')) NOT BETWEEN 1 AND 512 OR v#>>'{}' ~ '[[:cntrl:]]')
  AND (d->'headerParameter'='null' OR jsonb_typeof(d->'headerParameter')='string' AND length(trim(d->>'headerParameter')) BETWEEN 1 AND 512 AND d->>'headerParameter' !~ '[[:cntrl:]]')
  AND (d->'urlParameter'='null' OR jsonb_typeof(d->'urlParameter')='string' AND length(trim(d->>'urlParameter')) BETWEEN 1 AND 2000 AND d->>'urlParameter' !~ '[[:cntrl:]]')
  AND (d->>'templateId' IS NOT NULL OR d->'bodyParameters'='[]' AND d->'headerParameter'='null' AND d->'urlParameter'='null');
 EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE TABLE ai_initial_message_policy (
 campaign_id uuid PRIMARY KEY REFERENCES campaign(id),version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(ai_initial_message_definition_valid(definition)),
 approval jsonb,actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_initial_message_history(campaign_id uuid NOT NULL REFERENCES ai_initial_message_policy(campaign_id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(campaign_id,version));
CREATE FUNCTION guard_ai_initial_message_policy() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c campaign;approval jsonb;body text;disclosure text;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_HISTORY_RETAINED';END IF;
 SELECT * INTO c FROM campaign WHERE id=NEW.campaign_id;
 PERFORM 1 FROM branch WHERE id=c.branch_id AND active FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_CURRENT_ACCESS_REQUIRED';END IF;
 PERFORM 1 FROM campaign WHERE id=c.id FOR SHARE;
 IF NOT lead_intake_human_allowed_scope(c.organization_id,c.branch_id,NEW.actor_id,NEW.session_id) THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_CURRENT_ACCESS_REQUIRED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND (NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_VERSION_REQUIRED';END IF;
 IF NOT ai_initial_message_definition_valid(NEW.definition) THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_INVALID';END IF;
 IF NEW.definition->>'templateId' IS NOT NULL THEN
  PERFORM 1 FROM provider_message_template WHERE id=(NEW.definition->>'templateId')::uuid FOR SHARE;
  PERFORM 1 FROM campaign_message_template_binding WHERE campaign_id=c.id AND template_id=(NEW.definition->>'templateId')::uuid FOR SHARE;
  approval=ai_initial_template_approval(c.id,(NEW.definition->>'templateId')::uuid);body=ai_initial_render_template(approval->'template'->'components',NEW.definition);
  SELECT COALESCE(cp.definition->'disclosure'->>'text',bp.definition->'disclosure'->>'text') INTO disclosure FROM campaign ca
   LEFT JOIN ai_behavior_policy cp ON cp.scope='CAMPAIGN' AND cp.resource_id=ca.id LEFT JOIN ai_behavior_policy bp ON bp.scope='BRANCH' AND bp.resource_id=ca.branch_id WHERE ca.id=c.id;
  IF approval IS NULL OR body IS NULL OR disclosure IS NULL OR position(disclosure IN body)=0 THEN RAISE EXCEPTION 'AI_INITIAL_APPROVED_TEMPLATE_DISCLOSURE_REQUIRED';END IF;
 END IF;
 NEW.approval=approval;NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION lead_intake_human_allowed_scope(oid uuid,bid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id WHERE u.id=uid AND u.organization_id=oid AND u.active AND ss.id=sid AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
  AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=bid))
$$;
CREATE TRIGGER ai_initial_message_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_message_policy FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_message_policy();
CREATE FUNCTION guard_ai_initial_message_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM ai_initial_message_policy p WHERE p.campaign_id=NEW.campaign_id AND p.version=NEW.version AND to_jsonb(p)=NEW.snapshot) THEN RAISE EXCEPTION 'AI_INITIAL_POLICY_HISTORY_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_initial_message_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_initial_message_history FOR EACH ROW EXECUTE FUNCTION guard_ai_initial_message_history();
CREATE FUNCTION record_ai_initial_message_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO ai_initial_message_history(campaign_id,version,snapshot) VALUES(NEW.campaign_id,NEW.version,to_jsonb(NEW));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT organization_id,branch_id,NEW.actor_id,'AI_INITIAL_MESSAGE_CONFIGURED','CAMPAIGN',id,jsonb_build_object('version',NEW.version,'reason',NEW.reason) FROM campaign WHERE id=NEW.campaign_id;RETURN NEW;END $$;
CREATE TRIGGER ai_initial_message_policy_record AFTER INSERT OR UPDATE ON ai_initial_message_policy FOR EACH ROW EXECUTE FUNCTION record_ai_initial_message_policy();
CREATE FUNCTION ai_initial_message_context(cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',p.version,'definition',p.definition,'approval',p.approval,'ready',p.approval IS NOT NULL AND p.approval=ai_initial_template_approval(cid,(p.definition->>'templateId')::uuid),
  'body',ai_initial_render_template(p.approval->'template'->'components',p.definition)) FROM ai_initial_message_policy p WHERE campaign_id=cid
$$;
ALTER FUNCTION ai_initial_intake_context(uuid,timestamptz) RENAME TO ai_initial_intake_scope_context;
CREATE FUNCTION ai_initial_intake_context(rid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT ctx||jsonb_build_object('initialMessage',ai_initial_message_context((ctx->'scope'->>'campaignId')::uuid)) FROM (SELECT ai_initial_intake_scope_context(rid,at_time) AS ctx) s WHERE ctx IS NOT NULL
$$;
