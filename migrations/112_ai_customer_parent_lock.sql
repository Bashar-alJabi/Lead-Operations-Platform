CREATE OR REPLACE FUNCTION ai_customer_proposal_locked_context(eid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s record;selected uuid;BEGIN
 SELECT l.id AS lid,l.branch_id AS bid,l.campaign_id AS cid,l.contact_id AS contact,cv.id AS cvid,cv.sender_id,cv.connection_id
 INTO s FROM integration_event e JOIN conversation cv ON cv.id=e.conversation_id JOIN lead l ON l.id=cv.lead_id WHERE e.id=eid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Choose the first parent lock before acquiring SHARE, avoiding concurrent lock upgrades.
 IF NOT EXISTS(SELECT 1 FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=s.bid) THEN
   PERFORM 1 FROM branch WHERE id=s.bid FOR UPDATE;
 ELSE PERFORM 1 FROM branch WHERE id=s.bid FOR SHARE;END IF;
 PERFORM 1 FROM campaign WHERE id=s.cid FOR SHARE;
 PERFORM 1 FROM lead WHERE id=s.lid AND branch_id=s.bid AND campaign_id=s.cid FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM conversation WHERE id=s.cvid AND lead_id=s.lid AND sender_id=s.sender_id AND connection_id=s.connection_id FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM messaging_sender WHERE id=s.sender_id FOR SHARE;
 PERFORM 1 FROM integration_connection WHERE id=s.connection_id FOR SHARE;
 PERFORM 1 FROM sender_branch_binding WHERE sender_id=s.sender_id AND branch_id=s.bid FOR SHARE;
 PERFORM 1 FROM messaging_consent WHERE contact_id=s.contact AND channel='WHATSAPP' FOR SHARE;
 PERFORM 1 FROM ai_operational_config WHERE branch_id=s.bid AND (campaign_id IS NULL OR campaign_id=s.cid) ORDER BY scope FOR SHARE;
 PERFORM 1 FROM ai_behavior_policy WHERE branch_id=s.bid AND (campaign_id IS NULL OR campaign_id=s.cid) ORDER BY scope FOR SHARE;
 PERFORM 1 FROM ai_followup_policy WHERE campaign_id=s.cid FOR SHARE;
 PERFORM 1 FROM ai_qualification_config WHERE campaign_id=s.cid FOR SHARE;
 PERFORM 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=s.cid ORDER BY fd.id FOR SHARE OF cf,fd;
 PERFORM 1 FROM lead_field_value WHERE lead_id=s.lid ORDER BY field_id FOR SHARE;
 PERFORM 1 FROM lead_qualification_answer WHERE lead_id=s.lid ORDER BY question_id FOR SHARE;
 SELECT COALESCE((SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='CAMPAIGN' AND resource_id=s.cid),
   (SELECT (definition->'profiles'->>'CONVERSATION')::uuid FROM ai_operational_config WHERE scope='BRANCH' AND resource_id=s.bid)) INTO selected;
 IF selected IS NULL OR NOT ai_operational_profile_usable(s.bid,selected,'CONVERSATION') THEN RETURN NULL;END IF;
 PERFORM 1 FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id LEFT JOIN ai_knowledge_asset_approval ap ON ap.asset_id=ka.id
   WHERE pa.campaign_id=s.cid AND pa.version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid) ORDER BY ka.id FOR SHARE OF ka;
 PERFORM 1 FROM ai_knowledge_asset_approval WHERE asset_id IN (SELECT asset_id FROM ai_knowledge_publication_asset WHERE campaign_id=s.cid AND version=(SELECT max(version) FROM ai_knowledge_publication WHERE campaign_id=s.cid)) ORDER BY asset_id FOR SHARE;
 RETURN ai_customer_proposal_context(eid);
END $$;


