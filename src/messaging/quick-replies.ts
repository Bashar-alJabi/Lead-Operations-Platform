import { parseQuickReplyPayload } from './approved-template.js';

export function parseInboundQuickReply(message:Record<string,unknown>):{
  body:string;payload:string;messageId:string;index:number;
}|null {
  if (message.type!=='button' || !message.button || typeof message.button!=='object' || Array.isArray(message.button)) return null;
  const button=message.button as { payload?:unknown;text?:unknown };
  const reference=parseQuickReplyPayload(button.payload);
  if (!reference || typeof button.text!=='string' || !button.text.trim() || button.text.length>25 || /[\x00-\x1f\x7f]/.test(button.text)) return null;
  return { body:button.text,payload:button.payload as string,...reference };
}
