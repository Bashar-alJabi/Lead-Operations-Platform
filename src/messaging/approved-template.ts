import type postgres from 'postgres';
import { HttpError } from '../security.js';

export type BodyTemplateSnapshot = { externalTemplateId: string; name: string; language: string;
  category: string | null; components: TemplateComponent[];
  bodyParameters?: string[]; headerParameter?: string };
export type TextTemplateComponent = { type:'HEADER';format:'TEXT';text:string } | { type:'BODY'|'FOOTER';text:string };
export type CallToActionButton = { type:'URL';text:string;url:string } | { type:'PHONE_NUMBER';text:string;phone_number:string };
export type TemplateComponent = TextTemplateComponent | { type:'BUTTONS';buttons:CallToActionButton[] };

// Supported static CTA profile: two buttons, at most one URL and one phone, no runtime target parameters.
export function parseStaticButtons(value:unknown):CallToActionButton[]|null {
  if (!Array.isArray(value) || !value.length || value.length>2) return null;
  const types=new Set<string>();const buttons:CallToActionButton[]=[];
  for (const raw of value) {
    if (!raw || typeof raw!=='object') return null;
    const item=raw as { type?:unknown;text?:unknown;url?:unknown;phone_number?:unknown };
    if (typeof item.text!=='string' || !item.text.trim() || item.text.length>25 || /\{\{|\}\}|[\x00-\x1f\x7f]/.test(item.text)
      || typeof item.type!=='string' || types.has(item.type)) return null;
    if (item.type==='URL') {
      if (typeof item.url!=='string' || item.url.length>2000 || /\{\{|\}\}|[\x00-\x20\x7f]/.test(item.url)) return null;
      try { const url=new URL(item.url);if (url.protocol!=='https:' || !url.hostname || url.username || url.password) return null; }
      catch { return null; }
      buttons.push({ type:'URL',text:item.text,url:item.url });
    } else if (item.type==='PHONE_NUMBER') {
      if (typeof item.phone_number!=='string' || /[\x00-\x20\x7f]/.test(item.phone_number)
        || !/^\+[1-9][0-9]{7,14}$/.test(item.phone_number)) return null;
      buttons.push({ type:'PHONE_NUMBER',text:item.text,phone_number:item.phone_number });
    } else return null;
    types.add(item.type);
  }
  return buttons;
}

export function buttonHistoryText(buttons:CallToActionButton[]):string {
  return buttons.map((button)=>`${button.text}: ${button.type==='URL' ? button.url : button.phone_number}`).join('\n');
}

// One supported-format parser for creation, binding, preview, enqueue, dispatch, recovery and operational test sends.
export function parseTextTemplate(value:unknown): { components:TemplateComponent[];buttons:CallToActionButton[];body:string;parameterCount:number;headerParameterCount:0|1;preview:string } | null {
  if (!Array.isArray(value) || !value.length || value.length>4) return null;
  const parts=new Map<string,TemplateComponent>();
  for (const raw of value) {
    if (!raw || typeof raw!=='object') return null;
    const item=raw as { type?:unknown;text?:unknown;format?:unknown;buttons?:unknown };
    if (typeof item.type!=='string') return null;
    const type=item.type.toUpperCase();if (parts.has(type)) return null;
    if (type==='BUTTONS') {
      const buttons=parseStaticButtons(item.buttons);if (!buttons) return null;
      parts.set(type,{ type,buttons });continue;
    }
    if (typeof item.text!=='string') return null;
    if (type==='BODY') {
      if (bodyParameterCount(item.text)===null) return null;
      parts.set(type,{ type,text:item.text });
    } else if (type==='HEADER' || type==='FOOTER') {
      if (type==='HEADER') {
        if (item.format!=='TEXT' || textHeaderParameterCount(item.text)===null) return null;
        parts.set(type,{ type,format:'TEXT',text:item.text });
      } else {
        if (!item.text.trim() || item.text.length>60 || /\{\{|\}\}|[\x00-\x1f\x7f]/.test(item.text)) return null;
        parts.set(type,{ type,text:item.text });
      }
    } else return null; // Never discard buttons/media/unknown components to make a template appear supported.
  }
  const bodyPart=parts.get('BODY');if (!bodyPart || bodyPart.type!=='BODY') return null;
  const body=bodyPart.text;const header=parts.get('HEADER');const cta=parts.get('BUTTONS');
  const components=['HEADER','BODY','FOOTER','BUTTONS'].flatMap((type)=>parts.has(type) ? [parts.get(type)!] : []);
  return { components,body,parameterCount:bodyParameterCount(body)!,
    buttons:cta?.type==='BUTTONS' ? cta.buttons : [],
    headerParameterCount:header?.type==='HEADER' ? textHeaderParameterCount(header.text)! : 0,
    preview:components.map((part)=>part.type==='BUTTONS' ? buttonHistoryText(part.buttons) : part.text).join('\n\n') };
}

export function textHeaderParameterCount(value:unknown):0|1|null {
  if (typeof value!=='string' || !value.trim() || value.length>60 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const references=[...value.matchAll(/\{\{1\}\}/g)];
  const rest=value.replace(/\{\{1\}\}/g,'');
  if (references.length>1 || rest.includes('{{') || rest.includes('}}')) return null;
  return references.length ? 1 : 0;
}

export function renderTextHeader(text:string, parameter?:unknown):string|null {
  const count=textHeaderParameterCount(text);
  if (count===null || (count===0 && parameter!==undefined)) return null;
  if (!count) return text;
  if (typeof parameter!=='string' || !parameter.trim() || parameter.length>60 || /[\x00-\x1f\x7f]/.test(parameter)) return null;
  const rendered=text.replace(/\{\{1\}\}/g,()=>parameter);
  return rendered.length<=60 ? rendered : null;
}

export function validHeaderExample(header?:string, example?:string):boolean {
  return header===undefined ? example===undefined : renderTextHeader(header,example)!==null;
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
  bodyParameters: string[] = [], headerParameter?:string): Promise<{ body: string; snapshot: BodyTemplateSnapshot }> {
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
  if (!parsed.headerParameterCount && headerParameter!==undefined) throw new HttpError(400,'TEMPLATE_HEADER_PARAMETER_INVALID');
  const header=parsed.components.find((part)=>part.type==='HEADER');
  const renderedHeader=header ? renderTextHeader(header.text,headerParameter) : undefined;
  if (renderedHeader===null) throw new HttpError(400,'TEMPLATE_HEADER_PARAMETER_INVALID');
  const body = parsed.components.filter((part)=>part.type!=='BUTTONS').map((part)=>part.type==='HEADER' ? renderedHeader! : part.type==='BODY'
    ? part.text.replace(/\{\{([1-9]\d*)\}\}/g,(_match,index:string)=>bodyParameters[Number(index)-1]!) : part.text).join('\n\n');
  if (body.length > 20000) throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  return { body, snapshot: { externalTemplateId: template.external_template_id,
    name: template.name, language: template.language, category: template.category,
    components: parsed.components,
    ...(bodyParameters.length ? { bodyParameters } : {}),
    ...(headerParameter!==undefined ? { headerParameter } : {}) } };
}
