import type postgres from 'postgres';
import type { Principal } from '../security.js';
import { checkCurrentOutbound, lockAIOutboundPolicyScope, lockAIOutboundDispatchScope, lockOutboundScope, type LockedOutboundScope } from './outbound-policy.js';

// AI admission is a technical source capability, never a User/Role or a completed tool/send action.
export type OutboundPolicyAuthority = { kind: 'HUMAN'; principal: Principal } | { kind: 'AI_ADMISSION'; proposalId: string } | { kind: 'AI_ACTION'; actionId: string };

type LockedOutboundAuthority = LockedOutboundScope & { authority: OutboundPolicyAuthority };
export async function lockOutboundAuthority(tx: postgres.TransactionSql, authority: OutboundPolicyAuthority, conversationId: string): Promise<LockedOutboundAuthority> {
  const locked = await (authority.kind === 'HUMAN' ? lockOutboundScope(tx, authority.principal, conversationId)
    : authority.kind === 'AI_ADMISSION' ? lockAIOutboundPolicyScope(tx, authority.proposalId, conversationId)
    : lockAIOutboundDispatchScope(tx, authority.actionId, conversationId));
  return { ...locked, authority };
}

export function checkOutboundAuthorityPolicy(tx: postgres.TransactionSql, locked: LockedOutboundAuthority,
  excludeMessageId?: string, templateId?: string | null, mediaKind?: string) {
  const { authority } = locked;
  return checkCurrentOutbound(tx, locked, authority.kind === 'HUMAN' ? authority.principal : null,
    authority.kind === 'HUMAN' ? 'HUMAN' : 'AI', excludeMessageId, templateId, mediaKind);
}
