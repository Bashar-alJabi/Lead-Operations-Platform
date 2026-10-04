import { boundedResponse } from '../media/meta-provider.js';

export type SourceConfig={ graphVersion:string };
export type SourceCredentials={ accessToken:string;appSecret:string;verifyToken:string };
export type SourceQuestion={ key:string|null;externalId:string|null;label:string|null;type:string;
  options:{ key:string|null;value:string|null }[] };
export type SourcePage={ externalId:string;name:string;accessToken:string };
export type SourceForm={ externalId:string;name:string;status:string|null;questions:SourceQuestion[] };
export interface LeadSourceCatalogAdapter {
  discoverPages(config:SourceConfig,credentials:SourceCredentials):Promise<SourcePage[]>;
  discoverForms(config:SourceConfig,page:{ externalId:string;accessToken:string }):Promise<SourceForm[]>;
}
export class SourceProviderError extends Error {
  constructor(public code:'SOURCE_PROVIDER_UNAVAILABLE'|'SOURCE_PROVIDER_AUTH_FAILED'|'SOURCE_PROVIDER_RATE_LIMITED'
    |'SOURCE_PROVIDER_REJECTED'|'SOURCE_RESPONSE_INVALID'|'SOURCE_CATALOG_TOO_LARGE'|'SOURCE_PROVIDER_INPUT_INVALID',
    public retryable=false) { super(code); }
}
function record(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  return value as Record<string,unknown>;
}
function text(value:unknown,max:number,nullable=false):string|null {
  if (nullable && value==null) return null;
  if (typeof value!=='string' || !value.trim() || value.length>max || /[\x00-\x1f\x7f]/.test(value))
    throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  return value;
}
function identity(value:unknown):string {
  if (typeof value!=='string' || !/^\d{1,30}$/.test(value)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  return value;
}
export function validateSourcePages(value:unknown):SourcePage[] {
  if (!Array.isArray(value) || value.length>1000) throw new SourceProviderError('SOURCE_CATALOG_TOO_LARGE');
  const seen=new Set<string>();
  return value.map((raw)=> {
    const item=record(raw);const externalId=identity(item.externalId);
    if (seen.has(externalId)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');seen.add(externalId);
    return { externalId,name:text(item.name,200)!,accessToken:text(item.accessToken,4096)! };
  });
}
export function validateSourceForms(value:unknown):SourceForm[] {
  if (!Array.isArray(value) || value.length>1000) throw new SourceProviderError('SOURCE_CATALOG_TOO_LARGE');
  const seen=new Set<string>();
  return value.map((raw)=> {
    const item=record(raw);const externalId=identity(item.externalId);
    if (seen.has(externalId)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');seen.add(externalId);
    if (!Array.isArray(item.questions) || item.questions.length>100) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    const questions=item.questions.map((value):SourceQuestion=> {
      const question=record(value);const options=question.options ?? [];
      if (!Array.isArray(options) || options.length>100) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
      return { key:text(question.key,200,true),externalId:text(question.externalId,200,true),
        label:text(question.label,2000,true),type:text(question.type,80)!,options:options.map((value)=> {
          const option=record(value);return { key:text(option.key,200,true),value:text(option.value,512,true) };
        }) };
    });
    return { externalId,name:text(item.name,200)!,status:text(item.status,80,true),questions };
  });
}
async function graphCatalog(config:SourceConfig,path:string,token:string,fields:string):Promise<unknown[]> {
  if (!/^v\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !/^(me\/accounts|\d{1,30}\/leadgen_forms)$/.test(path)
    || !token || token.length>4096 || /[\x00-\x1f\x7f]/.test(token)) throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
  const output:unknown[]=[];const seen=new Set<string>();let after:string|undefined;
  const deadline=AbortSignal.timeout(90000);
  for (let page=0;page<10;page++) {
    const url=new URL(`https://graph.facebook.com/${config.graphVersion}/${path}`);
    url.searchParams.set('fields',fields);url.searchParams.set('limit','100');if (after) url.searchParams.set('after',after);
    let response:Response;
    try { response=await fetch(url,{ headers:{ Authorization:'Bearer '+token },redirect:'error',
      signal:AbortSignal.any([deadline,AbortSignal.timeout(8000)]) }); }
    catch { throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceProviderError(response.status===401 || response.status===403 ? 'SOURCE_PROVIDER_AUTH_FAILED'
        : response.status===429 ? 'SOURCE_PROVIDER_RATE_LIMITED' : response.status>=500 ? 'SOURCE_PROVIDER_UNAVAILABLE'
          : 'SOURCE_PROVIDER_REJECTED',response.status===429 || response.status>=500);
    }
    let payload:Record<string,unknown>;
    try { payload=record(JSON.parse((await boundedResponse(response,512*1024)).toString('utf8'))); }
    catch { throw new SourceProviderError('SOURCE_RESPONSE_INVALID'); }
    if (payload.error || !Array.isArray(payload.data) || payload.data.length>100) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    output.push(...payload.data);
    if (payload.paging==null) return output;
    const paging=record(payload.paging);if (paging.next==null) return output;
    // Never follow a provider URL that may contain a token or an arbitrary host.
    const cursors=record(paging.cursors);const next=text(cursors.after,1024)!;
    if (seen.has(next)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');seen.add(next);after=next;
  }
  throw new SourceProviderError('SOURCE_CATALOG_TOO_LARGE');
}
export const metaLeadSourceCatalogAdapter:LeadSourceCatalogAdapter={
  async discoverPages(config,credentials) {
    const items=await graphCatalog(config,'me/accounts',credentials.accessToken,'id,name,access_token');
    return validateSourcePages(items.map((value)=> { const item=record(value);return { externalId:item.id,name:item.name,accessToken:item.access_token }; }));
  },
  async discoverForms(config,page) {
    if (!/^\d{1,30}$/.test(page.externalId)) throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
    const items=await graphCatalog(config,`${page.externalId}/leadgen_forms`,page.accessToken,'id,name,status,questions');
    return validateSourceForms(items.map((value)=> {
      const item=record(value);if (item.questions!=null && !Array.isArray(item.questions)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
      return { externalId:item.id,name:item.name,status:item.status,questions:((item.questions ?? []) as unknown[]).map((value)=> {
        const q=record(value);return { key:q.key,externalId:q.id,label:q.label,type:q.type,options:q.options }; }) };
    }));
  },
};
