import { HttpError } from '../security.js';

export type AIFollowupPolicy = { enabled: boolean; initialDelaySeconds: number; delaysSeconds: number[]; stopOnReply: boolean; finalAction: 'COMPLETE' | 'HANDOFF' };
export const emptyAIFollowupPolicy = (): AIFollowupPolicy => ({ enabled: false, initialDelaySeconds: 0, delaysSeconds: [], stopOnReply: true, finalAction: 'COMPLETE' });
export const aiFollowupMandatoryStops = Object.freeze({ humanTakeover: true, handoff: true, closedConversation: true, closedOrArchivedLead: true, centralMessagingPolicyRequired: true });
export function normalizeAIFollowupPolicy(raw: unknown): AIFollowupPolicy {
  const invalid = () => { throw new HttpError(400, 'AI_FOLLOWUP_POLICY_INVALID'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const p = raw as Record<string, unknown>, keys = ['enabled', 'initialDelaySeconds', 'delaysSeconds', 'stopOnReply', 'finalAction'];
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k)) || typeof p.enabled !== 'boolean' || typeof p.stopOnReply !== 'boolean' ||
    !Number.isInteger(p.initialDelaySeconds) || (p.initialDelaySeconds as number) < 0 || (p.initialDelaySeconds as number) > 2147483647 ||
    !Array.isArray(p.delaysSeconds) || p.delaysSeconds.length > 40 || p.delaysSeconds.some(v => !Number.isInteger(v) || v < 1 || v > 2147483647) ||
    p.enabled && p.delaysSeconds.length === 0 || !['COMPLETE', 'HANDOFF'].includes(p.finalAction as string)) return invalid();
  return { enabled: p.enabled, initialDelaySeconds: p.initialDelaySeconds as number, delaysSeconds: [...p.delaysSeconds] as number[], stopOnReply: p.stopOnReply, finalAction: p.finalAction as AIFollowupPolicy['finalAction'] };
}

export type AIFollowupTimingContext = { now: Date; anchorAt: Date; attemptsSent: number; hasInboundReply: boolean;
  leadLifecycle: 'OPEN' | 'CLOSED' | 'ARCHIVED'; controllerType: 'AI' | 'HUMAN' | 'NONE'; conversationState: string };
// This is a timing decision. The runtime must separately authorize and pass Central Messaging Policy immediately before send.
export function evaluateAIFollowupTiming(policy: AIFollowupPolicy, context: AIFollowupTimingContext) {
  const p = normalizeAIFollowupPolicy(policy), c = context;
  if (!Number.isFinite(c.now.getTime()) || !Number.isFinite(c.anchorAt.getTime()) || !Number.isInteger(c.attemptsSent) || c.attemptsSent < 0) throw new HttpError(400, 'AI_FOLLOWUP_CONTEXT_INVALID');
  const outcome = (decision: string, reason: string, eligibleAt: string | null = null) => ({ decision, reason, eligibleAt, maxAttempts: p.delaysSeconds.length, timingOnly: true, sendAllowed: false });
  if (!p.enabled) return outcome('DISABLED', 'POLICY_DISABLED');
  if (c.leadLifecycle !== 'OPEN') return outcome('STOPPED', 'LEAD_NOT_OPEN');
  if (c.controllerType !== 'AI') return outcome('STOPPED', 'AI_CONTROLLER_REQUIRED');
  if (!['AI_ACTIVE', 'AI_WAITING_FOR_LEAD'].includes(c.conversationState)) return outcome('STOPPED', 'ACTIVE_AI_CONVERSATION_REQUIRED');
  if (p.stopOnReply && c.hasInboundReply) return outcome('STOPPED', 'CUSTOMER_REPLIED');
  if (c.attemptsSent >= p.delaysSeconds.length) return outcome(p.finalAction, 'ATTEMPTS_EXHAUSTED');
  const eligible = c.anchorAt.getTime() + p.delaysSeconds[c.attemptsSent]! * 1000;
  if (!Number.isFinite(eligible) || Math.abs(eligible) > 8.64e15) throw new HttpError(400, 'AI_FOLLOWUP_CONTEXT_INVALID');
  return outcome(c.now.getTime() >= eligible ? 'DUE' : 'WAIT', 'CONFIGURED_DELAY', new Date(eligible).toISOString());
}

export const aiFollowupPolicySchema = { type: 'object', additionalProperties: false, required: ['enabled', 'initialDelaySeconds', 'delaysSeconds', 'stopOnReply', 'finalAction'], properties: {
  enabled: { type: 'boolean' }, initialDelaySeconds: { type: 'integer', minimum: 0, maximum: 2147483647 },
  delaysSeconds: { type: 'array', maxItems: 40, items: { type: 'integer', minimum: 1, maximum: 2147483647 } }, stopOnReply: { type: 'boolean' }, finalAction: { enum: ['COMPLETE', 'HANDOFF'] },
} } as const;
