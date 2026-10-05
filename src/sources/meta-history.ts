import { boundedResponse } from '../media/meta-provider.js';
import { SourceProviderError,type SourceConfig } from './meta-provider.js';
import { validateRetrievedLead,type RetrievedSourceLead } from './meta-lead.js';
export type HistoricalPageInput={ config:SourceConfig;page:{ externalId:string;accessToken:string };formId:string;after:string|null };
export interface LeadSourceHistoryAdapter { page(input:HistoricalPageInput):Promise<unknown> }
export function validateHistoricalPage(value:unknown,formId:string):{ leads:RetrievedSourceLead[];after:string|null } {
  if (!value || typeof value!=='object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value))>512*1024)
    throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const raw=value as Record<string,any>;
  if (raw.error || !Array.isArray(raw.data) || raw.data.length>100) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const leads=raw.data.map((item:any)=> {
    if (!item || typeof item.id!=='string' || !/^\d{1,30}$/.test(item.id)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    return validateRetrievedLead(item,{ leadId:item.id,formId });
  });
  let after:string|null=null;
  if (raw.paging?.next!=null) {
    after=raw.paging?.cursors?.after;
    if (typeof after!=='string' || !after.length || after.length>4096 || /[\x00-\x20\x7f]/.test(after))
      throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  }
  // next is only an availability signal. Never fetch or persist a provider supplied URL.
  return { leads,after };
}
export const metaLeadSourceHistoryAdapter:LeadSourceHistoryAdapter={ async page(input) {
  if (!/^v\d{1,2}\.\d{1,2}$/.test(input.config.graphVersion) || !/^\d{1,30}$/.test(input.formId)
    || !/^\d{1,30}$/.test(input.page.externalId) || !input.page.accessToken || input.page.accessToken.length>4096
    || /[\x00-\x1f\x7f]/.test(input.page.accessToken) || (input.after!=null && (!input.after.length || input.after.length>4096 || /[\x00-\x20\x7f]/.test(input.after))))
    throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
  const url=new URL(`https://graph.facebook.com/${input.config.graphVersion}/${input.formId}/leads`);
  url.searchParams.set('fields','id,form_id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,field_data,is_organic,platform,custom_disclaimer_responses');
  url.searchParams.set('limit','100');if (input.after) url.searchParams.set('after',input.after);
  let response:Response;
  try { response=await fetch(url,{ headers:{ Authorization:'Bearer '+input.page.accessToken },redirect:'error',signal:AbortSignal.timeout(8000) }); }
  catch { throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true); }
  if (!response.ok) {
    await response.body?.cancel();throw new SourceProviderError(response.status===401 || response.status===403 ? 'SOURCE_PROVIDER_AUTH_FAILED'
      : response.status===429 ? 'SOURCE_PROVIDER_RATE_LIMITED' : response.status>=500 ? 'SOURCE_PROVIDER_UNAVAILABLE' : 'SOURCE_PROVIDER_REJECTED',response.status===429 || response.status>=500);
  }
  let raw:unknown;try { raw=JSON.parse((await boundedResponse(response,512*1024)).toString('utf8')); }
  catch { throw new SourceProviderError('SOURCE_RESPONSE_INVALID'); }
  validateHistoricalPage(raw,input.formId);return raw;
} };
