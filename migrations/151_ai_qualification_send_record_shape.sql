-- Composite row types retain a known NULL shape on the non-Qualification branches.
CREATE OR REPLACE FUNCTION ai_customer_send_dispatch_context(aid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a record;p record;m record;s ai_qualification_send_source;expected jsonb;current_base jsonb;expected_base jsonb;consent jsonb;BEGIN
 SELECT * INTO a FROM ai_customer_send_action WHERE id=aid AND state='APPLIED';IF a IS NULL THEN RETURN NULL;END IF;
 SELECT qp.* INTO p FROM ai_customer_proposal qp JOIN ai_customer_send_admission adm ON adm.proposal_id=qp.id AND adm.context=qp.context AND adm.event_id=qp.event_id WHERE qp.id=a.proposal_id;
 expected=ai_customer_send_source_context(p.id);
 IF p IS NULL OR expected IS NULL OR expected IS DISTINCT FROM a.context OR p.state<>'PROPOSED' OR p.result->>'decision' NOT IN ('ANSWER','QUESTION','QUALIFICATION') THEN RETURN NULL;END IF;
 IF p.result->>'decision'='QUALIFICATION' THEN
   SELECT * INTO s FROM ai_qualification_send_source WHERE proposal_id=p.id AND qualification_action_id=a.qualification_action_id;
   IF s IS NULL OR expected IS DISTINCT FROM ai_qualification_handoff_expected(s.qualification_action_id) THEN RETURN NULL;END IF;
 ELSIF a.qualification_action_id IS NOT NULL THEN RETURN NULL;END IF;
 PERFORM 1 FROM branch WHERE id=p.branch_id FOR UPDATE;
 PERFORM 1 FROM campaign WHERE id=p.campaign_id AND branch_id=p.branch_id FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM lead WHERE id=p.lead_id AND organization_id=p.organization_id AND branch_id=p.branch_id AND campaign_id=p.campaign_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM contact WHERE id=(SELECT contact_id FROM lead WHERE id=p.lead_id) FOR SHARE;
 PERFORM 1 FROM conversation WHERE id=p.conversation_id AND lead_id=p.lead_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM ai_customer_proposal_locked_context(p.event_id);
 IF p.result->>'decision'='QUALIFICATION' AND (ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome
   OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question) THEN RETURN NULL;END IF;
 SELECT * INTO m FROM conversation_message WHERE id=a.message_id AND ai_send_action_id=a.id AND conversation_id=p.conversation_id;
 IF m IS NULL OR m.direction<>'OUTBOUND' OR m.author_type<>'AI' OR m.author_user_id IS NOT NULL OR m.body IS DISTINCT FROM a.content->>'body'
   OR m.sender_id IS DISTINCT FROM (expected->'conversation'->>'senderId')::uuid OR m.connection_id IS DISTINCT FROM (expected->'conversation'->>'connectionId')::uuid
   OR m.message_kind<>'TEXT' OR m.attachment_id IS NOT NULL OR m.template_id IS NOT NULL OR m.idempotency_key<>a.id::text
   OR EXISTS(SELECT 1 FROM conversation_message later,conversation_message source WHERE source.id=p.message_id AND later.conversation_id=p.conversation_id
     AND (later.created_at,later.id)>(source.created_at,source.id) AND later.id<>m.id) THEN RETURN NULL;END IF;
 current_base=ai_customer_inbound_context(p.event_id);
 IF current_base IS NULL OR current_base->'conversation'->>'latestMessageId' IS DISTINCT FROM m.id::text THEN RETURN NULL;END IF;
 expected_base=(expected-ARRAY['protocolVersion','toolPolicy','knowledgeData','references','messages','questions','operationalData','consent'])||jsonb_build_object('kind','CUSTOMER_INBOUND');
 IF jsonb_set(current_base,'{conversation,latestMessageId}',expected->'source'->'messageId') IS DISTINCT FROM expected_base
   OR ai_effective_tool_policy(p.branch_id,p.campaign_id) IS DISTINCT FROM expected->'toolPolicy' THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('status',COALESCE(co.status,'UNKNOWN'),'doNotContact',COALESCE(co.do_not_contact,false),'versionTime',co.updated_at) INTO consent
   FROM lead l LEFT JOIN messaging_consent co ON co.contact_id=l.contact_id AND co.channel='WHATSAPP' WHERE l.id=p.lead_id;
 IF consent IS DISTINCT FROM expected->'consent' OR consent->>'status'<>'GRANTED' OR consent->>'doNotContact'<>'false' THEN RETURN NULL;END IF;
 RETURN jsonb_set(expected,'{conversation,latestMessageId}',to_jsonb(m.id));
END $$;

CREATE OR REPLACE FUNCTION ai_local_action_context_current(pid uuid,k text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p record;ctx jsonb;expected jsonb;s ai_qualification_send_source;BEGIN
 SELECT * INTO p FROM ai_customer_proposal WHERE id=pid;
 IF p IS NULL OR p.state<>'PROPOSED' THEN RETURN false;END IF;
 ctx=ai_customer_proposal_context(p.event_id);IF ctx IS NULL THEN RETURN false;END IF;
 IF k='QUALIFICATION' THEN RETURN ai_qualification_admissible(ctx) AND ctx=p.context;
 ELSIF k='SEND' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT * INTO s FROM ai_qualification_send_source WHERE proposal_id=pid;
     IF s IS NULL OR s.context IS DISTINCT FROM ai_qualification_handoff_expected(s.qualification_action_id)
       OR ai_current_qualification_outcome(p.lead_id) IS DISTINCT FROM s.outcome OR ai_next_qualification_question(p.lead_id) IS DISTINCT FROM s.question THEN RETURN false;END IF;
     expected=s.context;
   ELSIF p.result->>'decision' NOT IN ('ANSWER','QUESTION') THEN RETURN false;END IF;
   RETURN ai_send_admissible(ctx) AND ctx=expected AND EXISTS(SELECT 1 FROM ai_customer_send_admission WHERE proposal_id=pid);
 ELSIF k='HANDOFF' THEN
   expected=p.context;
   IF p.result->>'decision'='QUALIFICATION' THEN
     SELECT s.context INTO expected FROM ai_qualification_handoff_source s WHERE s.proposal_id=pid;
     IF expected IS NULL OR (ai_current_qualification_outcome(p.lead_id)->>'handoff') IS DISTINCT FROM 'true' THEN RETURN false;END IF;
   ELSIF p.result->>'decision'<>'HANDOFF' THEN RETURN false;END IF;
   RETURN ai_handoff_admissible(ctx) AND ctx=expected;
 END IF;RETURN false;
END $$;
