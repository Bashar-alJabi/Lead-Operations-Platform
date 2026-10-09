import { HttpError } from '../security.js';
export type AIBehaviorPolicy = {
  formality: string | null;
  disclosure: { mode: 'FIRST_AI_MESSAGE' | 'EVERY_AI_MESSAGE'; text: string } | null;
  handoff: { initialContactWithoutAgent: boolean; transitionMessage: string | null; misunderstandingLimit: number | null } | null;
  returningContact: { closedConversation: 'REVIEW' | 'REOPEN_EXISTING'; closedLead: 'REVIEW' | 'REOPEN_EXISTING' | 'CREATE_NEW' } | null;
};
export const emptyAIBehaviorPolicy = (): AIBehaviorPolicy => ({ formality: null, disclosure: null, handoff: null, returningContact: null });
export const aiMandatoryHandoffTriggers = Object.freeze(['CUSTOMER_REQUEST', 'UNKNOWN_ANSWER', 'OUT_OF_SCOPE', 'COMPLAINT', 'SENSITIVE_SCENARIO', 'PRICING_EXCEPTION', 'LEGAL_EXCEPTION', 'PAYMENT_ISSUE', 'LOW_CONFIDENCE', 'MANUAL_TAKEOVER'] as const);
const triggers = [...aiMandatoryHandoffTriggers, 'QUALIFICATION', 'REPEATED_MISUNDERSTANDING', 'CAMPAIGN_CONDITION'] as const;
function keys(v: unknown, names: string[]): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n)); }
function text(v: unknown, max: number, min = 0): v is string { return typeof v === 'string' && v.trim().length >= min && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && Buffer.from(v).toString() === v; }
export function normalizeAIBehaviorPolicy(raw: unknown): AIBehaviorPolicy {
  const invalid = () => { throw new HttpError(400, 'AI_BEHAVIOR_POLICY_INVALID'); };
  if (!keys(raw, ['formality', 'disclosure', 'handoff', 'returningContact']) || raw.formality !== null && !text(raw.formality, 1000)) return invalid();
  if (raw.disclosure !== null && (!keys(raw.disclosure, ['mode', 'text']) || !['FIRST_AI_MESSAGE', 'EVERY_AI_MESSAGE'].includes(raw.disclosure.mode as string) || !text(raw.disclosure.text, 2000, 3))) return invalid();
  if (raw.handoff !== null && (!keys(raw.handoff, ['initialContactWithoutAgent', 'transitionMessage', 'misunderstandingLimit']) || typeof raw.handoff.initialContactWithoutAgent !== 'boolean' ||
    raw.handoff.transitionMessage !== null && !text(raw.handoff.transitionMessage, 2000, 3) || raw.handoff.misunderstandingLimit !== null && (!Number.isInteger(raw.handoff.misunderstandingLimit) || (raw.handoff.misunderstandingLimit as number) < 1 || (raw.handoff.misunderstandingLimit as number) > 2147483647))) return invalid();
  if (raw.returningContact !== null && (!keys(raw.returningContact, ['closedConversation', 'closedLead']) || !['REVIEW', 'REOPEN_EXISTING'].includes(raw.returningContact.closedConversation as string) || !['REVIEW', 'REOPEN_EXISTING', 'CREATE_NEW'].includes(raw.returningContact.closedLead as string))) return invalid();
  return { formality: raw.formality === null ? null : (raw.formality as string).trim(),
    disclosure: raw.disclosure === null ? null : { ...(raw.disclosure as NonNullable<AIBehaviorPolicy['disclosure']>), text: (raw.disclosure.text as string).trim() },
    handoff: raw.handoff === null ? null : { ...(raw.handoff as NonNullable<AIBehaviorPolicy['handoff']>), transitionMessage: raw.handoff.transitionMessage === null ? null : (raw.handoff.transitionMessage as string).trim() },
    returningContact: raw.returningContact === null ? null : { ...(raw.returningContact as NonNullable<AIBehaviorPolicy['returningContact']>) } };
}
export function inheritAIBehaviorPolicy(branch: AIBehaviorPolicy, campaign: AIBehaviorPolicy) {
  const effective = emptyAIBehaviorPolicy(), sources: Record<string, 'BRANCH' | 'CAMPAIGN' | 'UNCONFIGURED'> = {};
  for (const key of ['formality', 'disclosure', 'handoff'] as const) { Object.assign(effective, { [key]: campaign[key] ?? branch[key] }); sources[key] = campaign[key] !== null ? 'CAMPAIGN' : branch[key] !== null ? 'BRANCH' : 'UNCONFIGURED'; }
  effective.returningContact = campaign.returningContact; sources.returningContact = campaign.returningContact !== null ? 'CAMPAIGN' : 'UNCONFIGURED';
  return { effective, sources };
}
export type AIBehaviorPreviewContext = {
  leadLifecycle: 'OPEN' | 'CLOSED' | 'ARCHIVED'; controllerType: 'AI' | 'HUMAN' | 'NONE';
  conversationState: 'AI_ACTIVE' | 'AI_WAITING_FOR_LEAD' | 'AI_HANDOFF_REQUIRED' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'CLOSED';
  resolution: 'UNIQUE' | 'AMBIGUOUS' | 'UNRESOLVED'; explicitCampaignReference: boolean; requiredLeadData: boolean;
  disclosureAlreadySent: boolean; humanAvailable: boolean; trigger: typeof triggers[number] | 'NONE'; misunderstandingCount: number; qualificationHandoffRequired: boolean;
};
export function evaluateAIBehaviorPolicy(policy: AIBehaviorPolicy, c: AIBehaviorPreviewContext) {
  const p = normalizeAIBehaviorPolicy(policy), result = (action: string, reason: string) => ({ action, reason, previewOnly: true, mutationsAllowed: false, sendAllowed: false });
  let returning;
  if (c.resolution !== 'UNIQUE') returning = result('REVIEW', 'RESOLUTION_NOT_UNIQUE');
  else if (c.leadLifecycle === 'ARCHIVED') returning = result('REVIEW', 'ARCHIVED_LEAD_REQUIRES_REVIEW');
  else if (c.leadLifecycle === 'CLOSED') {
    const action = p.returningContact?.closedLead ?? 'REVIEW';
    returning = action === 'CREATE_NEW' && (!c.explicitCampaignReference || !c.requiredLeadData) ? result('REVIEW', 'NEW_LEAD_TRUSTED_CONTEXT_REQUIRED') : result(action, p.returningContact ? 'EXPLICIT_CLOSED_LEAD_POLICY' : 'RETURNING_POLICY_UNCONFIGURED');
  } else if (c.conversationState === 'CLOSED') returning = result(p.returningContact?.closedConversation ?? 'REVIEW', p.returningContact ? 'EXPLICIT_CLOSED_CONVERSATION_POLICY' : 'RETURNING_POLICY_UNCONFIGURED');
  else if (['AI_HANDOFF_REQUIRED', 'WAITING_FOR_HUMAN'].includes(c.conversationState)) returning = result('HUMAN_REVIEW', 'HANDOFF_MUST_NOT_REACTIVATE_AI');
  else if (c.controllerType === 'HUMAN') returning = result('HUMAN', 'CURRENT_HUMAN_CONTROLLER');
  else if (c.controllerType === 'AI' && ['AI_ACTIVE', 'AI_WAITING_FOR_LEAD'].includes(c.conversationState)) returning = result('AI_ELIGIBLE', 'CURRENT_AI_CONTROL_REQUIRES_RUNTIME_AUTHORIZATION');
  else returning = result('REVIEW', 'CURRENT_CONTROL_NOT_ELIGIBLE');
  const required = (aiMandatoryHandoffTriggers as readonly string[]).includes(c.trigger) || c.trigger === 'CAMPAIGN_CONDITION' || c.trigger === 'QUALIFICATION' && c.qualificationHandoffRequired || c.trigger === 'REPEATED_MISUNDERSTANDING' && (p.handoff?.misunderstandingLimit == null || c.misunderstandingCount >= p.handoff.misunderstandingLimit);
  const handoff = required ? { ...result(c.humanAvailable ? 'REQUEST_HANDOFF' : 'WAITING_FOR_HUMAN', c.trigger), notifyManager: !c.humanAvailable, transitionMessage: p.handoff?.transitionMessage ?? null, aiMayContinueSensitiveTopic: false } : { ...result('NO_HANDOFF_TRIGGER', 'CURRENT_CRITERIA_NOT_MET'), notifyManager: false, transitionMessage: null, aiMayContinueSensitiveTopic: false };
  return { returning, handoff, disclosure: p.disclosure && (p.disclosure.mode === 'EVERY_AI_MESSAGE' || !c.disclosureAlreadySent) ? p.disclosure.text : null,
    initialContactWithoutAgent: p.handoff?.initialContactWithoutAgent === true, mandatoryHandoffTriggers: aiMandatoryHandoffTriggers, previewOnly: true, mutationsAllowed: false, sendAllowed: false };
}
const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength });
export const aiBehaviorPolicySchema = { type: 'object', additionalProperties: false, required: ['formality', 'disclosure', 'handoff', 'returningContact'], properties: {
  formality: nullableText(1000), disclosure: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['mode', 'text'], properties: { mode: { enum: ['FIRST_AI_MESSAGE', 'EVERY_AI_MESSAGE'] }, text: { type: 'string', minLength: 3, maxLength: 2000 } } }] },
  handoff: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['initialContactWithoutAgent', 'transitionMessage', 'misunderstandingLimit'], properties: { initialContactWithoutAgent: { type: 'boolean' }, transitionMessage: { ...nullableText(2000), minLength: 3 }, misunderstandingLimit: { type: ['integer', 'null'], minimum: 1, maximum: 2147483647 } } }] },
  returningContact: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['closedConversation', 'closedLead'], properties: { closedConversation: { enum: ['REVIEW', 'REOPEN_EXISTING'] }, closedLead: { enum: ['REVIEW', 'REOPEN_EXISTING', 'CREATE_NEW'] } } }] },
} } as const;
export const aiBehaviorPreviewContextSchema = { type: 'object', additionalProperties: false, required: ['leadLifecycle', 'controllerType', 'conversationState', 'resolution', 'explicitCampaignReference', 'requiredLeadData', 'disclosureAlreadySent', 'humanAvailable', 'trigger', 'misunderstandingCount', 'qualificationHandoffRequired'], properties: {
  leadLifecycle: { enum: ['OPEN', 'CLOSED', 'ARCHIVED'] }, controllerType: { enum: ['AI', 'HUMAN', 'NONE'] }, conversationState: { enum: ['AI_ACTIVE', 'AI_WAITING_FOR_LEAD', 'AI_HANDOFF_REQUIRED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'CLOSED'] }, resolution: { enum: ['UNIQUE', 'AMBIGUOUS', 'UNRESOLVED'] },
  explicitCampaignReference: { type: 'boolean' }, requiredLeadData: { type: 'boolean' }, disclosureAlreadySent: { type: 'boolean' }, humanAvailable: { type: 'boolean' }, trigger: { enum: [...triggers, 'NONE'] }, misunderstandingCount: { type: 'integer', minimum: 0, maximum: 2147483647 }, qualificationHandoffRequired: { type: 'boolean' },
} } as const;
