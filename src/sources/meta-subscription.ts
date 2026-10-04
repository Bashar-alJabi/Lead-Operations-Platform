import { boundedResponse } from '../media/meta-provider.js';
import { SourceProviderError,type SourceConfig } from './meta-provider.js';

export type SourceSubscriptionInput={ config:SourceConfig;page:{ externalId:string;accessToken:string };appSecret:string;subscribe:boolean };
export interface LeadSourceSubscriptionAdapter { check(input:SourceSubscriptionInput):Promise<{ subscribed:boolean }> }
function record(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  return value as Record<string,unknown>;
}
async function graph(url:URL,token:string,deadline:AbortSignal,body?:URLSearchParams):Promise<Record<string,unknown>> {
  let response:Response;
  try { response=await fetch(url,{ method:body ? 'POST' : 'GET',headers:{ Authorization:'Bearer '+token },body,redirect:'error',
    signal:AbortSignal.any([deadline,AbortSignal.timeout(8000)]) }); }
  catch { throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true); }
  if (!response.ok) {
    await response.body?.cancel();throw new SourceProviderError(response.status===401 || response.status===403 ? 'SOURCE_PROVIDER_AUTH_FAILED'
      : response.status===429 ? 'SOURCE_PROVIDER_RATE_LIMITED' : response.status>=500 ? 'SOURCE_PROVIDER_UNAVAILABLE' : 'SOURCE_PROVIDER_REJECTED',
      response.status===429 || response.status>=500);
  }
  let payload:Record<string,unknown>;
  try { payload=record(JSON.parse((await boundedResponse(response,256*1024)).toString('utf8'))); }
  catch { throw new SourceProviderError('SOURCE_RESPONSE_INVALID'); }
  if (payload.error) throw new SourceProviderError('SOURCE_PROVIDER_REJECTED');return payload;
}
async function fieldsFor(config:SourceConfig,page:SourceSubscriptionInput['page'],deadline:AbortSignal):Promise<string[]> {
  const seen=new Set<string>();let after:string|undefined;let found:string[]=[];let appFound=false;
  for (let i=0;i<10;i++) {
    const url=new URL(`https://graph.facebook.com/${config.graphVersion}/${page.externalId}/subscribed_apps`);
    url.searchParams.set('fields','id,subscribed_fields');url.searchParams.set('limit','100');if (after) url.searchParams.set('after',after);
    const payload=await graph(url,page.accessToken,deadline);
    if (!Array.isArray(payload.data) || payload.data.length>100) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    for (const value of payload.data) {
      const app=record(value);
      if (typeof app.id!=='string' || !/^\d{1,30}$/.test(app.id) || !Array.isArray(app.subscribed_fields)
        || app.subscribed_fields.length>100 || app.subscribed_fields.some((f)=>typeof f!=='string' || !/^[a-z_]{1,100}$/.test(f)))
        throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
      if (app.id===config.appId) {
        if (appFound) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');appFound=true;found=app.subscribed_fields as string[];
      }
    }
    if (payload.paging==null) return found;
    const paging=record(payload.paging);if (paging.next==null) return found;
    const cursor=record(paging.cursors).after;
    if (typeof cursor!=='string' || !cursor || cursor.length>1024 || /[\x00-\x1f\x7f]/.test(cursor) || seen.has(cursor))
      throw new SourceProviderError('SOURCE_RESPONSE_INVALID');seen.add(cursor);after=cursor;
  }
  throw new SourceProviderError('SOURCE_CATALOG_TOO_LARGE');
}
export const metaLeadSourceSubscriptionAdapter:LeadSourceSubscriptionAdapter={
  async check({ config,page,appSecret,subscribe }) {
    if (!/^v\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !/^\d{1,30}$/.test(config.appId ?? '')
      || !/^\d{1,30}$/.test(page.externalId) || !page.accessToken || page.accessToken.length>4096
      || !appSecret || appSecret.length>512 || /[\x00-\x1f\x7f]/.test(page.accessToken+appSecret))
      throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
    const deadline=AbortSignal.timeout(90000);
    // The Page token selects the app to subscribe. Verify that identity before any mutation.
    const debug=new URL(`https://graph.facebook.com/${config.graphVersion}/debug_token`);
    debug.searchParams.set('input_token',page.accessToken);
    const metadata=record((await graph(debug,config.appId+'|'+appSecret,deadline)).data);
    if (metadata.is_valid!==true || metadata.app_id!==config.appId
      || (metadata.profile_id!=null && metadata.profile_id!==page.externalId)) throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');
    const existing=await fieldsFor(config,page,deadline);
    if (!subscribe || existing.includes('leadgen')) return { subscribed:existing.includes('leadgen') };
    const url=new URL(`https://graph.facebook.com/${config.graphVersion}/${page.externalId}/subscribed_apps`);
    const body=new URLSearchParams({ subscribed_fields:[...new Set([...existing,'leadgen'])].join(',') });
    if ((await graph(url,page.accessToken,deadline,body)).success!==true) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    if (!(await fieldsFor(config,page,deadline)).includes('leadgen')) throw new SourceProviderError('SOURCE_PROVIDER_REJECTED');
    return { subscribed:true };
  },
};
