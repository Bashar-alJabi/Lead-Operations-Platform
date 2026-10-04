import { boundedResponse } from '../media/meta-provider.js';
import { SourceProviderError,type SourceConfig } from './meta-provider.js';
export type SourceLeadInput={ config:SourceConfig;page:{ externalId:string;accessToken:string };leadId:string;formId:string };
export type RetrievedSourceLead={ raw:Record<string,unknown>;createdAt:string;values:{ key:string;values:string[] }[] };
export interface LeadSourceRetrievalAdapter { retrieve(input:SourceLeadInput):Promise<unknown> }
export function validateRetrievedLead(value:unknown,input:Pick<SourceLeadInput,'leadId'|'formId'>):RetrievedSourceLead {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const raw=value as Record<string,unknown>;
  if (raw.error || raw.id!==input.leadId || raw.form_id!==input.formId || !Array.isArray(raw.field_data) || raw.field_data.length>100
    || Buffer.byteLength(JSON.stringify(raw))>512*1024) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const time=raw.created_time;
  if (typeof time!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(time)
    || !Number.isFinite(Date.parse(time)) || Date.parse(time)<946684800000 || Date.parse(time)>4102444800000
    || new Date(time.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==time.slice(0,10)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  for (const key of ['ad_id','adset_id','campaign_id']) if (raw[key]!=null && (typeof raw[key]!=='string' || !/^\d{1,30}$/.test(raw[key] as string)))
    throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const values=raw.field_data.map((field)=> {
    if (!field || typeof field!=='object' || Array.isArray(field)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    const item=field as Record<string,unknown>;
    if (typeof item.name!=='string' || !item.name.trim() || item.name.length>200 || /[\x00-\x1f\x7f]/.test(item.name)
      || !Array.isArray(item.values) || item.values.length>50 || item.values.some((v)=>typeof v!=='string' || v.length>20000))
      throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    return { key:item.name,values:item.values as string[] }; // Preserve repeated names for explicit mapping ambiguity handling.
  });
  return { raw,createdAt:new Date(time).toISOString(),values };
}
export const metaLeadSourceRetrievalAdapter:LeadSourceRetrievalAdapter={
  async retrieve(input) {
    if (!/^v\d{1,2}\.\d{1,2}$/.test(input.config.graphVersion) || !/^\d{1,30}$/.test(input.leadId)
      || !/^\d{1,30}$/.test(input.formId) || !/^\d{1,30}$/.test(input.page.externalId) || !input.page.accessToken
      || input.page.accessToken.length>4096 || /[\x00-\x1f\x7f]/.test(input.page.accessToken)) throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
    const url=new URL(`https://graph.facebook.com/${input.config.graphVersion}/${input.leadId}`);
    url.searchParams.set('fields','id,form_id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,field_data,is_organic,platform,custom_disclaimer_responses');
    let response:Response;
    try { response=await fetch(url,{ headers:{ Authorization:'Bearer '+input.page.accessToken },redirect:'error',signal:AbortSignal.timeout(8000) }); }
    catch { throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true); }
    if (!response.ok) {
      await response.body?.cancel();throw new SourceProviderError(response.status===401 || response.status===403 ? 'SOURCE_PROVIDER_AUTH_FAILED'
        : response.status===429 ? 'SOURCE_PROVIDER_RATE_LIMITED' : response.status>=500 ? 'SOURCE_PROVIDER_UNAVAILABLE' : 'SOURCE_PROVIDER_REJECTED',
        response.status===429 || response.status>=500);
    }
    let raw:unknown;try { raw=JSON.parse((await boundedResponse(response,512*1024)).toString('utf8')); }
    catch { throw new SourceProviderError('SOURCE_RESPONSE_INVALID'); }
    return validateRetrievedLead(raw,input).raw;
  },
};
