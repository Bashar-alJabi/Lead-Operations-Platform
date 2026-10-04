import type postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../security.js';

export type BodyTemplateSnapshot = { externalTemplateId: string; name: string; language: string;
  category: string | null; components: TemplateComponent[];
  bodyParameters?: string[]; headerParameter?: string;urlParameter?:string;quickReplyPayloads?:string[] };
export type TextTemplateComponent = { type:'HEADER';format:'TEXT';text:string } | { type:'BODY'|'FOOTER';text:string };
export type TemplateButton = { type:'URL';text:string;url:string } | { type:'PHONE_NUMBER';text:string;phone_number:string } | { type:'QUICK_REPLY';text:string };
export type TemplateComponent = TextTemplateComponent | { type:'BUTTONS';buttons:TemplateButton[] };

function safeHttpsUrl(value:unknown):URL|null {
  if (typeof value!=='string' || !value || value.length>2000
    || /[\x00-\x20\x7f\\]|\{\{|\}\}|%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try { const url=new URL(value);return url.protocol==='https:' && url.hostname && !url.username && !url.password ? url : null; }
  catch { return null; }
}

// A dynamic suffix cannot alter the approved scheme/authority or occur before the end of the URL.
export function urlParameterCount(value:unknown):0|1|null {
  if (typeof value!=='string' || value.length>2000) return null;
  if (!value.includes('{{') && !value.includes('}}')) return safeHttpsUrl(value) ? 0 : null;
  if (!value.endsWith('{{1}}')) return null;
  const prefix=value.slice(0,-5);const base=safeHttpsUrl(prefix);const sample=safeHttpsUrl(prefix+'0');
  return base && sample && base.origin===sample.origin ? 1 : null;
}

export function validUrlSuffix(value:unknown):value is string {
  return typeof value==='string' && !!value && value.length<=2000
    && !/[\x00-\x20\x7f\\]|\{\{|\}\}|%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
    && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

export function renderTemplateUrl(value:string,parameter?:unknown):string|null {
  const count=urlParameterCount(value);
  if (count===null || (!count && parameter!==undefined)) return null;
  if (!count) return value;
  if (!validUrlSuffix(parameter)) return null;
  const prefix=value.slice(0,-5);const rendered=prefix+parameter;const url=safeHttpsUrl(rendered);
  return url && url.origin===safeHttpsUrl(prefix)!.origin ? rendered : null;
}

// Supported profiles: two CTA buttons, or up to three Quick Replies, never a mixed group.
export function parseTemplateButtons(value:unknown):TemplateButton[]|null {
  if (!Array.isArray(value) || !value.length || value.length>3) return null;
  const types=new Set<string>();const buttons:TemplateButton[]=[];
  for (const raw of value) {
    if (!raw || typeof raw!=='object') return null;
    const item=raw as { type?:unknown;text?:unknown;url?:unknown;phone_number?:unknown };
    if (typeof item.text!=='string' || !item.text.trim() || item.text.length>25 || /\{\{|\}\}|[\x00-\x1f\x7f]/.test(item.text)
      || typeof item.type!=='string' || (types.has(item.type) && item.type!=='QUICK_REPLY')) return null;
    if (item.type==='URL') {
      if (urlParameterCount(item.url)===null) return null;
      buttons.push({ type:'URL',text:item.text,url:item.url as string });
    } else if (item.type==='PHONE_NUMBER') {
      if (typeof item.phone_number!=='string' || /[\x00-\x20\x7f]/.test(item.phone_number)
        || !/^\+[1-9][0-9]{7,14}$/.test(item.phone_number)) return null;
      buttons.push({ type:'PHONE_NUMBER',text:item.text,phone_number:item.phone_number });
    } else if (item.type==='QUICK_REPLY') buttons.push({ type:'QUICK_REPLY',text:item.text });
    else return null;
    types.add(item.type);
  }
  const quick=buttons.some((button)=>button.type==='QUICK_REPLY');
  return (quick && buttons.some((button)=>button.type!=='QUICK_REPLY')) || (!quick && buttons.length>2) ? null : buttons;
}

export function renderTemplateButtons(buttons:TemplateButton[],parameter?:unknown):TemplateButton[]|null {
  const dynamic=buttons.some((button)=>button.type==='URL' && urlParameterCount(button.url)===1);
  if (!dynamic && parameter!==undefined) return null;
  const rendered:TemplateButton[]=[];
  for (const button of buttons) {
    if (button.type!=='URL') { rendered.push(button);continue; }
    const url=renderTemplateUrl(button.url,urlParameterCount(button.url)===1 ? parameter : undefined);
    if (!url) return null;
    rendered.push({ ...button,url });
  }
  return rendered;
}

export function validUrlExample(buttons:TemplateButton[]|undefined,example?:unknown):boolean {
  return renderTemplateButtons(buttons ?? [],example)!==null;
}

export function buttonHistoryText(buttons:TemplateButton[]):string {
  return buttons.map((button)=>button.type==='QUICK_REPLY' ? button.text : `${button.text}: ${button.type==='URL' ? button.url : button.phone_number}`).join('\n');
}

export function parseQuickReplyPayload(value:unknown):{ messageId:string;index:number }|null {
  if (typeof value!=='string') return null;
  const match=/^qr\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([0-2])\.([0-9a-f]{32})$/.exec(value);
  return match ? { messageId:match[1]!,index:Number(match[2]) } : null;
}

export function quickReplyPayloadsFor(messageId:string,count:number,existing?:string[]):string[]|null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(messageId) || !Number.isInteger(count) || count<0 || count>3) return null;
  if (!count) return existing===undefined ? [] : null;
  if (existing!==undefined) return Array.isArray(existing) && existing.length===count && existing.every((payload,index)=> {
    const parsed=parseQuickReplyPayload(payload);return parsed?.messageId===messageId && parsed.index===index;
  }) ? existing : null;
  return Array.from({ length:count },(_,index)=>`qr.${messageId}.${index}.${randomBytes(16).toString('hex')}`);
}

// One supported-format parser for creation, binding, preview, enqueue, dispatch, recovery and operational test sends.
export function parseTextTemplate(value:unknown): { components:TemplateComponent[];buttons:TemplateButton[];body:string;parameterCount:number;headerParameterCount:0|1;urlParameterIndex:number|null;preview:string } | null {
  if (!Array.isArray(value) || !value.length || value.length>4) return null;
  const parts=new Map<string,TemplateComponent>();
  for (const raw of value) {
    if (!raw || typeof raw!=='object') return null;
    const item=raw as { type?:unknown;text?:unknown;format?:unknown;buttons?:unknown };
    if (typeof item.type!=='string') return null;
    const type=item.type.toUpperCase();if (parts.has(type)) return null;
    if (type==='BUTTONS') {
      const buttons=parseTemplateButtons(item.buttons);if (!buttons) return null;
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
  const buttons=cta?.type==='BUTTONS' ? cta.buttons : [];
  const urlIndex=buttons.findIndex((button)=>button.type==='URL' && urlParameterCount(button.url)===1);
  return { components,body,parameterCount:bodyParameterCount(body)!,buttons,urlParameterIndex:urlIndex===-1 ? null : urlIndex,
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
  bodyParameters: string[] = [], headerParameter?:string,urlParameter?:string,
  replyContext?:{ messageId:string;payloads?:string[] }): Promise<{ body: string; snapshot: BodyTemplateSnapshot }> {
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
  if (!renderTemplateButtons(parsed.buttons,urlParameter)) throw new HttpError(400,'TEMPLATE_URL_PARAMETER_INVALID');
  const quickCount=parsed.buttons.filter((button)=>button.type==='QUICK_REPLY').length;
  const quickPayloads=replyContext ? quickReplyPayloadsFor(replyContext.messageId,quickCount,replyContext.payloads) : quickCount ? null : [];
  if (!quickPayloads) throw new HttpError(400,'TEMPLATE_QUICK_REPLY_INVALID');
  const body = parsed.components.filter((part)=>part.type!=='BUTTONS').map((part)=>part.type==='HEADER' ? renderedHeader! : part.type==='BODY'
    ? part.text.replace(/\{\{([1-9]\d*)\}\}/g,(_match,index:string)=>bodyParameters[Number(index)-1]!) : part.text).join('\n\n');
  if (body.length > 20000) throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  return { body, snapshot: { externalTemplateId: template.external_template_id,
    name: template.name, language: template.language, category: template.category,
    components: parsed.components,
    ...(bodyParameters.length ? { bodyParameters } : {}),
    ...(headerParameter!==undefined ? { headerParameter } : {}),
    ...(urlParameter!==undefined ? { urlParameter } : {}),
    ...(quickPayloads.length ? { quickReplyPayloads:quickPayloads } : {}) } };
}
