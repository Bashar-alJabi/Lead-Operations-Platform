-- Arrival order does not authorize overwriting a newer customer answer with delayed provider input.
CREATE OR REPLACE FUNCTION ai_qualification_admissible(ctx jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(ctx IS NOT NULL AND ctx->'conversation'->>'controller'='AI'
   AND ctx->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD')
   AND ctx->'conversation'->'attentionReason'='null'::jsonb
   AND ctx->'toolPolicy'->'allowedTools' ? 'updateQualificationField' AND ctx->'qualification' IS NOT NULL
   AND jsonb_array_length(ctx->'questions')>0
   AND EXISTS(SELECT 1 FROM conversation_message source WHERE source.id=(ctx->'source'->>'messageId')::uuid
     AND source.conversation_id=(ctx->'scope'->>'conversationId')::uuid AND source.direction='INBOUND' AND source.author_type='CUSTOMER'
     AND NOT EXISTS(SELECT 1 FROM conversation_message later WHERE later.conversation_id=source.conversation_id
       AND later.direction='INBOUND' AND later.author_type='CUSTOMER' AND later.received_at>source.received_at)),false)
$$;
CREATE INDEX conversation_customer_provider_order ON conversation_message(conversation_id,received_at DESC,id DESC) WHERE direction='INBOUND' AND author_type='CUSTOMER';
