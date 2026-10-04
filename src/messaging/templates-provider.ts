import type { MessagingConnectionConfig, MessagingCredentials } from './providers.js';
import { parseTextTemplate, validHeaderExample, validUrlExample, renderTemplateUrl, urlParameterCount, type TemplateButton } from './approved-template.js';

export type ProviderTemplate = { externalId: string; name: string; language: string;
  status: string; category: string | null; components: unknown[] };
export type CreateTemplateInput = { name: string; language: string; category: 'MARKETING'|'UTILITY';
  body: string; examples?: string[];header?:string;footer?:string;headerExample?:string;buttons?:TemplateButton[];urlExample?:string };
export interface MessagingTemplateAdapter {
  list(config: MessagingConnectionConfig, credentials: MessagingCredentials): Promise<ProviderTemplate[]>;
  create(config: MessagingConnectionConfig, credentials: MessagingCredentials,
    input: CreateTemplateInput): Promise<ProviderTemplate>;
}

export class TemplateProviderError extends Error {
  constructor(public kind: 'REJECTED'|'UNKNOWN', public code: string) { super(code); }
}

function endpoint(config: MessagingConnectionConfig): string {
  if (!/^v\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !/^\d{1,30}$/.test(config.wabaId))
    throw new TemplateProviderError('REJECTED', 'TEMPLATE_PROVIDER_CONFIG_INVALID');
  return `https://graph.facebook.com/${config.graphVersion}/${config.wabaId}/message_templates`;
}

function parseTemplate(value: unknown): ProviderTemplate {
  if (!value || typeof value !== 'object') throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !/^\d{1,30}$/.test(item.id)
    || typeof item.name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(item.name)
    || typeof item.language !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(item.language)
    || typeof item.status !== 'string' || item.status.length > 40
    || (item.category != null && (typeof item.category !== 'string' || item.category.length > 40))
    || !Array.isArray(item.components) || item.components.length > 30)
    throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID');
  return { externalId: item.id, name: item.name, language: item.language,
    status: item.status, category: item.category as string | null ?? null, components: item.components };
}

async function request(url: string, token: string, body?: object): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { method: body ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) }); }
  catch { throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_OUTCOME_UNKNOWN'); }
  if (!response.ok) throw new TemplateProviderError(response.status >= 500 || response.status === 429 ? 'UNKNOWN' : 'REJECTED',
    response.status === 401 || response.status === 403 ? 'TEMPLATE_PROVIDER_AUTH_FAILED' : 'TEMPLATE_PROVIDER_REQUEST_FAILED');
  try { return await response.json(); }
  catch { throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID'); }
}

export const metaTemplateAdapter: MessagingTemplateAdapter = {
  async list(config, credentials) {
    const templates: ProviderTemplate[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const url = new URL(endpoint(config));
      url.searchParams.set('fields', 'id,name,language,status,category,components');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const payload = await request(url.toString(), credentials.accessToken) as {
        data?: unknown; paging?: { next?: unknown; cursors?: { after?: unknown } } };
      if (!Array.isArray(payload?.data) || payload.data.length > 100)
        throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID');
      for (const raw of payload.data) {
        const template = parseTemplate(raw);
        if (seen.has(template.externalId)) throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID');
        seen.add(template.externalId);
        templates.push(template);
      }
      if (!payload.paging?.next) return templates;
      const cursor = payload.paging.cursors?.after;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || cursor === after)
        throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_RESPONSE_INVALID');
      after = cursor;
    }
    throw new TemplateProviderError('UNKNOWN', 'TEMPLATE_PROVIDER_PAGE_LIMIT');
  },
  async create(config, credentials, input) {
    const body = { type: 'BODY', text: input.body,
      ...(input.examples?.length ? { example: { body_text: [input.examples] } } : {}) };
    const components=[...(input.header!==undefined ? [{ type:'HEADER',format:'TEXT',text:input.header,
      ...(input.headerExample!==undefined ? { example:{ header_text:[input.headerExample] } } : {}) }] : []),body,
      ...(input.footer!==undefined ? [{ type:'FOOTER',text:input.footer }] : []),
      ...(input.buttons!==undefined ? [{ type:'BUTTONS',buttons:input.buttons.map((button)=>button.type==='URL' && urlParameterCount(button.url)===1
        ? { ...button,example:[renderTemplateUrl(button.url,input.urlExample)] } : button) }] : [])];
    if (!parseTextTemplate(components) || !validHeaderExample(input.header,input.headerExample) || !validUrlExample(input.buttons,input.urlExample))
      throw new TemplateProviderError('REJECTED','TEMPLATE_INPUT_INVALID');
    const payload = await request(endpoint(config), credentials.accessToken, {
      name: input.name, language: input.language, category: input.category,
      components,
    }) as { id?: unknown; status?: unknown; category?: unknown };
    return parseTemplate({ id: payload?.id, name: input.name, language: input.language,
      status: payload?.status, category: payload?.category, components });
  },
};
