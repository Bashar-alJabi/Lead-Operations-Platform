import type postgres from 'postgres';
import { HttpError,type Principal } from '../security.js';
import { approvedConversationReadContext } from './copilot-context.js';
import { effectiveConfigHash } from './operational-config.js';
export async function approvedHumanCampaignKnowledge(tx:postgres.TransactionSql,actor:Principal,conversationId:string,sessionId:string) {
  const access=await approvedConversationReadContext(tx,actor,conversationId,sessionId);
  if(!access.b.active)throw new HttpError(409,'BRANCH_DISABLED');
  if(access.cv.controller_type!=='HUMAN' || access.cv.state!=='HUMAN_ACTIVE')throw new HttpError(409,'AI_COPILOT_HUMAN_CONTROL_REQUIRED');
  // Native Published business information remains readable without contacting or depending on an AI provider.
  const publication=(await tx`SELECT version,content,published_at FROM ai_knowledge_publication WHERE campaign_id=${access.c.id} ORDER BY version DESC LIMIT 1 FOR SHARE`)[0];
  if(!publication)throw new HttpError(409,'AI_PUBLISHED_KNOWLEDGE_REQUIRED');
  const assets=await tx`SELECT asset_id AS id,snapshot FROM ai_knowledge_publication_asset WHERE campaign_id=${access.c.id} AND version=${publication.version} ORDER BY asset_id`;
  return { access,publication,assets,hash:effectiveConfigHash({ campaignId:access.c.id,version:publication.version,content:publication.content,assets:assets.map(a=>a.snapshot) }) };
}
