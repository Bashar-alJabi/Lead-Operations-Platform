import type postgres from 'postgres';
import { HttpError } from '../security.js';

export type BodyTemplateSnapshot = { externalTemplateId: string; name: string; language: string;
  category: string | null; components: TextTemplateComponent[];
  bodyParameters?: string[] };
export type TextTemplateComponent = { type:'HEADER';format:'TEXT';text:string } | { type:'BODY'|'FOOTER';text:string };

// One supported-format parser for creation, binding, preview, enqueue, dispatch, recovery and operational test sends.
export function parseTextTemplate(value:unknown): { components:TextTemplateComponent[];body:string;parameterCount:number;preview:string } | null {
  if (!Array.isArray(value) || !value.length || value.length>3) return null;
  const parts=new Map<string,TextTemplateComponent>();
  for (const raw of value) {
    if (!raw || typeof raw!=='object') return null;
    const item=raw as { type?:unknown;text?:unknown;format?:unknown };
    if (typeof item.type!=='string' || typeof item.text!=='string') return null;
    const type=item.type.toUpperCase();if (parts.has(type)) return null;
    if (type==='BODY') {
      if (bodyParameterCount(item.text)===null) return null;
      parts.set(type,{ type,text:item.text });
    } else if (type==='HEADER' || type==='FOOTER') {
      if (!item.text.trim() || item.text.length>60 || /\{\{|\}\}|[\x00-\x1f\x7f]/.test(item.text)) return null;
      if (type==='HEADER') {
        if (item.format!=='TEXT') return null;
        parts.set(type,{ type,format:'TEXT',text:item.text });
      } else parts.set(type,{ type,text:item.text });
    } else return null; // Never discard buttons/media/unknown components to make a template appear supported.
  }
  const body=parts.get('BODY')?.text;if (!body) return null;
  const components=['HEADER','BODY','FOOTER'].flatMap((type)=>parts.has(type) ? [parts.get(type)!] : []);
  return { components,body,parameterCount:bodyParameterCount(body)!,preview:components.map((part)=>part.text).join('\n\n') };
}

export function bodyParameterCount(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) return null;
  const references = [...value.matchAll(/\{\{([1-9]\d*)\}\}/g)];
  const remainder = value.replace(/\{\{[1-9]\d*\}\}/g, '');
  if (remainder.includes('{{') || remainder.includes('}}')) return null;
  if (!references.length) return 0;
  const numbers = references.map((match) => Number(match[1]));
  const max = Math.max(...numbers);
  if (max > 10 || max < 1 || numbers.some((number) => !Number.isInteger(number) || number < 1)
    || new Set(numbers).size !== max) return null;
  return max;
}

export async function approvedBodyTemplate(tx: postgres.TransactionSql,
  connectionId: string, campaignId: string, templateId: string,
  bodyParameters: string[] = []): Promise<{ body: string; snapshot: BodyTemplateSnapshot }> {
  const template = (await tx`SELECT external_template_id, name, language, category,
      status, active, components FROM provider_message_template
    WHERE id = ${templateId} AND connection_id = ${connectionId}
      AND EXISTS (SELECT 1 FROM campaign_message_template_binding b
        WHERE b.template_id = ${templateId} AND b.campaign_id = ${campaignId} AND b.active)
    FOR SHARE`)[0];
  if (!template) throw new HttpError(409, 'TEMPLATE_NOT_AVAILABLE');
  if (!template.active || template.status !== 'APPROVED') throw new HttpError(409, 'TEMPLATE_NOT_APPROVED');
  const parsed=parseTextTemplate(template.components);
  if (!parsed) throw new HttpError(409,'TEMPLATE_FORMAT_UNSUPPORTED');
  const count=parsed.parameterCount;
  if (!Array.isArray(bodyParameters) || bodyParameters.length !== count
    || bodyParameters.some((value) => typeof value !== 'string' || !value.trim()
      || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)))
    throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  const body = parsed.preview.replace(/\{\{([1-9]\d*)\}\}/g,
    (_match, index: string) => bodyParameters[Number(index) - 1]!);
  if (body.length > 20000) throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  return { body, snapshot: { externalTemplateId: template.external_template_id,
    name: template.name, language: template.language, category: template.category,
    components: parsed.components,
    ...(bodyParameters.length ? { bodyParameters } : {}) } };
}
