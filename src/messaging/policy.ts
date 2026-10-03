export type SendAuthor = 'HUMAN' | 'AI' | 'AUTOMATION' | 'FOLLOW_UP';
export type Sender = {
  id: string;
  connectionId: string;
  active: boolean;
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  connectionStatus: string;
  branchIds: string[];
  sharedFallbackBranchIds: string[];
  supportsText: boolean;
  supportsTemplate?: boolean;
  requiresTemplate: boolean;
};
export type SenderSelection = { sender: Sender; reason: string } | { sender: null; reason: string };

function senderProblem(sender: Sender, branchId: string): string | null {
  if (!sender.branchIds.includes(branchId)) return 'SENDER_OUT_OF_SCOPE';
  if (!sender.active) return 'SENDER_DISABLED';
  if (sender.connectionStatus !== 'CONNECTED') return 'CONNECTION_NOT_READY';
  if (sender.health === 'UNHEALTHY' || sender.health === 'UNKNOWN') return 'SENDER_UNHEALTHY';
  if (!sender.supportsText) return 'TEXT_NOT_SUPPORTED';
  return null;
}

export function resolveSender(input: {
  branchId: string;
  pinnedSenderId?: string | null;
  campaignOverrideId?: string | null;
  branchDefaultId?: string | null;
  senders: Sender[];
}): SenderSelection {
  const byId = (id: string) => input.senders.find((sender) => sender.id === id);
  const configured = input.pinnedSenderId ?? input.campaignOverrideId ?? input.branchDefaultId;
  if (configured) {
    const sender = byId(configured);
    if (!sender) return { sender: null, reason: input.pinnedSenderId ? 'PINNED_SENDER_MISSING' : 'CONFIGURED_SENDER_MISSING' };
    const problem = senderProblem(sender, input.branchId);
    if (problem) return { sender: null, reason: input.pinnedSenderId ? `PINNED_${problem}` : problem };
    return { sender, reason: input.pinnedSenderId ? 'PINNED' : input.campaignOverrideId ? 'CAMPAIGN_OVERRIDE' : 'BRANCH_DEFAULT' };
  }
  const shared = input.senders.filter((sender) => sender.sharedFallbackBranchIds.includes(input.branchId));
  if (shared.length !== 1) return { sender: null, reason: shared.length ? 'SHARED_FALLBACK_AMBIGUOUS' : 'NO_SENDER' };
  const problem = senderProblem(shared[0]!, input.branchId);
  return problem ? { sender: null, reason: problem } : { sender: shared[0]!, reason: 'SHARED_FALLBACK' };
}

function localMinute(instant: Date, timezone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function parseMinute(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function allowedAt(instant: Date, timezone: string, window?: { start: string; end: string } | null): boolean {
  if (!window) return true;
  const start = parseMinute(window.start); const end = parseMinute(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const minute = localMinute(instant, timezone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function evaluateSend(input: {
  author: SendAuthor;
  actorUserId?: string;
  controllerType: 'AI' | 'HUMAN' | 'NONE';
  controllerUserId?: string | null;
  conversationState: string;
  consentStatus: 'GRANTED' | 'REVOKED' | 'UNKNOWN';
  doNotContact: boolean;
  consentRequired: boolean;
  sender: Sender;
  templateId?: string | null;
  timezone: string;
  sendingWindow?: { start: string; end: string } | null;
  attempts: number;
  maxAttempts?: number | null;
  lastSentAt?: Date | null;
  minIntervalSeconds?: number | null;
  now?: Date;
}): { allowed: boolean; reason?: string } {
  const now = input.now ?? new Date();
  if (input.conversationState === 'CLOSED') return { allowed: false, reason: 'CONVERSATION_CLOSED' };
  if (input.author === 'HUMAN') {
    if (input.controllerType !== 'HUMAN' || !input.actorUserId || input.controllerUserId !== input.actorUserId)
      return { allowed: false, reason: 'HUMAN_CONTROLLER_REQUIRED' };
  } else if (input.controllerType !== 'AI' || !['AI_ACTIVE','AI_WAITING_FOR_LEAD'].includes(input.conversationState)) {
    return { allowed: false, reason: 'AI_CONTROLLER_REQUIRED' };
  }
  if (input.doNotContact || input.consentStatus === 'REVOKED') return { allowed: false, reason: 'DO_NOT_CONTACT' };
  if (input.consentRequired && input.consentStatus !== 'GRANTED') return { allowed: false, reason: 'CONSENT_REQUIRED' };
  if (input.sender.requiresTemplate && !input.templateId) return { allowed: false, reason: 'TEMPLATE_REQUIRED' };
  if (input.templateId && !input.sender.supportsTemplate) return { allowed: false, reason: 'TEMPLATE_NOT_SUPPORTED' };
  if (!allowedAt(now, input.timezone, input.sendingWindow)) return { allowed: false, reason: 'OUTSIDE_SENDING_WINDOW' };
  if (input.maxAttempts != null && input.attempts >= input.maxAttempts) return { allowed: false, reason: 'MAX_ATTEMPTS' };
  if (input.minIntervalSeconds != null && input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < input.minIntervalSeconds * 1000)
    return { allowed: false, reason: 'FREQUENCY_LIMIT' };
  return { allowed: true };
}
