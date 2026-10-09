import type { CopilotContext } from './copilot-context.js';
import type { SimulationReference } from './simulation.js';
export const copilotSummaryPurpose='Select the important conversation excerpts for the employee. Statements remain attributed to their original speaker and delivery state; they are not verified commercial or payment facts.';
function sensitive(text:string):boolean {
  const normalized=text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c>='۰' ? 0x6f0 : 0x660)));
  return /(?:\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|authorization|bearer|cvv|cvc|iban|account[_ -]?number|card[_ -]?(?:number|details))\s*[:=]|sk-[a-z0-9_-]{12,}|\b[A-Z]{2}\d{2}[A-Z0-9 ]{11,32}\b|(?:\d[ -]?){13,19}|(?:كلمة\s*المرور|الرقم\s*السري|رقم\s*(?:البطاقة|الحساب))\s*[:=])/i.test(normalized);
}
export function copilotSafeReferences(references:SimulationReference[]) {
  // Conservative whole-excerpt omission. This is a test-stage minimization safeguard, not a live DLP guarantee.
  return references.filter(r=>!sensitive(r.text));
}
export function copilotProviderInput(context:CopilotContext,references:SimulationReference[]) {
  return { purpose:copilotSummaryPurpose,references:copilotSafeReferences(references),language:context.campaignContext.effective.language };
}
