export type InboundConversation = {
  id: string;
  leadId: string;
  connectionId: string;
  senderId: string;
  participantRef: string;
  threadRef?: string | null;
  state: string;
};
export type InboundLead = { id: string; campaignId: string; contactParticipantRefs: string[]; lifecycle: 'OPEN' | 'CLOSED' | 'ARCHIVED' };
export type InboundResolution =
  | { kind: 'CONVERSATION'; conversationId: string; leadId: string }
  | { kind: 'LEAD'; leadId: string }
  | { kind: 'NEEDS_ATTENTION'; reason: string };

export function resolveInbound(input: {
  connectionId: string;
  senderId: string;
  participantRef: string;
  threadRef?: string | null;
  campaignRef?: string | null;
  conversations: InboundConversation[];
  leads: InboundLead[];
}): InboundResolution {
  const scoped = input.conversations.filter((candidate) => candidate.connectionId === input.connectionId
    && candidate.senderId === input.senderId && candidate.participantRef === input.participantRef);
  if (input.threadRef) {
    const exact = scoped.filter((candidate) => candidate.threadRef === input.threadRef);
    if (exact.length === 1) return { kind: 'CONVERSATION', conversationId: exact[0]!.id, leadId: exact[0]!.leadId };
    if (exact.length > 1) return { kind: 'NEEDS_ATTENTION', reason: 'DUPLICATE_THREAD' };
  }
  const active = scoped.filter((candidate) => candidate.state !== 'CLOSED');
  if (active.length === 1) return { kind: 'CONVERSATION', conversationId: active[0]!.id, leadId: active[0]!.leadId };
  if (active.length > 1) return { kind: 'NEEDS_ATTENTION', reason: 'MULTIPLE_ACTIVE_CONVERSATIONS' };
  const leads = input.leads.filter((candidate) => candidate.lifecycle === 'OPEN'
    && candidate.contactParticipantRefs.includes(input.participantRef)
    && (!input.campaignRef || candidate.campaignId === input.campaignRef));
  if (leads.length === 1) return { kind: 'LEAD', leadId: leads[0]!.id };
  return { kind: 'NEEDS_ATTENTION', reason: leads.length > 1 ? 'MULTIPLE_ACTIVE_LEADS' : 'NO_UNIQUE_LEAD' };
}
