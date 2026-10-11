CREATE INDEX conversation_ai_human_waiting ON conversation(ai_handoff_action_id,lead_id)
 WHERE state='WAITING_FOR_HUMAN' AND controller_type='NONE' AND ai_handoff_action_id IS NOT NULL;
