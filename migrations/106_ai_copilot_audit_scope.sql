CREATE OR REPLACE FUNCTION record_ai_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO ai_simulation_history(simulation_id,version,state,attempt_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.attempt_count,NEW.error_code);
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(NEW.organization_id,NEW.branch_id,NEW.actor_id,
    CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN 'AI_COPILOT_SUMMARY_' ELSE 'AI_SIMULATION_' END||NEW.state,
    CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN 'AI_COPILOT_SUMMARY' ELSE 'AI_SIMULATION' END,NEW.id,
    jsonb_build_object('campaignId',NEW.campaign_id,'leadId',NEW.lead_id,'conversationId',NEW.conversation_id,'version',NEW.version,'attempt',NEW.attempt_count,'errorCode',NEW.error_code,'contextHash',NEW.context_hash,
      'knowledgeVersion',CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN NEW.context->'campaignContext'->'knowledge'->'version' ELSE NEW.context->'knowledge'->'version' END,
      'profileId',CASE WHEN NEW.kind='COPILOT_SUMMARY' THEN NEW.context->'campaignContext'->'profiles'->'SUMMARIZATION'->'id' ELSE NEW.context->'profiles'->'CONVERSATION'->'id' END));
  RETURN NEW;END $$;
