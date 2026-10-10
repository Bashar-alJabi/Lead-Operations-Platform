import type postgres from 'postgres';
import { HttpError } from '../security.js';

// Technical names implement the documented customer-facing tool boundaries, not new business permissions.
export const aiCustomerTools = ['createFollowUp', 'getCampaignKnowledge', 'getLeadContext', 'requestHumanHandoff', 'sendConversationMessage', 'updateQualificationField'] as const;
export type AICustomerTool = typeof aiCustomerTools[number];
export type AIToolPolicy = { allowedTools: AICustomerTool[] | null };
export const aiCustomerToolCatalog = aiCustomerTools.map(name => ({ name, category: name === 'sendConversationMessage' ? 'SEND' : name.startsWith('get') ? 'READ' : 'WRITE', customerRuntimeImplemented: name === 'updateQualificationField' }));
export const emptyAIToolPolicy = (): AIToolPolicy => ({ allowedTools: null });
export function normalizeAIToolPolicy(raw: unknown): AIToolPolicy {
  const invalid = () => { throw new HttpError(400, 'AI_TOOL_POLICY_INVALID'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'allowedTools')) return invalid();
  const value = (raw as Record<string, unknown>).allowedTools;
  if (value === null) return emptyAIToolPolicy();
  if (!Array.isArray(value) || value.length > aiCustomerTools.length || value.some(v => typeof v !== 'string' || !(aiCustomerTools as readonly string[]).includes(v)) || new Set(value).size !== value.length) return invalid();
  return { allowedTools: [...value].sort() as AICustomerTool[] };
}
export function inheritAIToolPolicy(branch: AIToolPolicy, campaign: AIToolPolicy) {
  const b = normalizeAIToolPolicy(branch), c = normalizeAIToolPolicy(campaign);
  return { allowedTools: [...(c.allowedTools ?? b.allowedTools ?? [])], source: c.allowedTools !== null ? 'CAMPAIGN' : b.allowedTools !== null ? 'BRANCH' : 'UNCONFIGURED' };
}
export async function currentAIToolPolicy(tx: postgres.TransactionSql, scope: 'BRANCH' | 'CAMPAIGN', id: string) {
  return (await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_tool_policy WHERE scope=${scope} AND resource_id=${id} FOR SHARE`)[0] ?? { version: 0, definition: emptyAIToolPolicy(), actor_id: null, reason: null, updated_at: null };
}
export type EffectiveAIToolPolicy = { catalogVersion: number; branchVersion: number; campaignVersion: number; branchDefinition: AIToolPolicy; campaignDefinition: AIToolPolicy; allowedTools: AICustomerTool[]; source: 'CAMPAIGN' | 'BRANCH' | 'UNCONFIGURED' };
export async function effectiveAIToolPolicy(tx: postgres.TransactionSql, branchId: string, campaignId: string): Promise<EffectiveAIToolPolicy> {
  // Native context is shared by previews, source snapshots and completion guards.
  const row = (await tx`SELECT ai_effective_tool_policy(${branchId},${campaignId}) AS policy`)[0];
  if (!row?.policy) throw new HttpError(404, 'AI_TOOL_POLICY_SCOPE_NOT_FOUND');
  return row.policy as EffectiveAIToolPolicy;
}
export const aiToolPolicySchema = { type: 'object', additionalProperties: false, required: ['allowedTools'], properties: {
  allowedTools: { anyOf: [{ type: 'null' }, { type: 'array', maxItems: aiCustomerTools.length, uniqueItems: true, items: { enum: aiCustomerTools } }] },
} } as const;
