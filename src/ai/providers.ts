export class AIProviderError extends Error { constructor(public code:'AI_AUTH_FAILED'|'AI_RATE_LIMITED'|'AI_PROVIDER_UNAVAILABLE'|'AI_RESPONSE_INVALID') { super(code); } }
export type AIConnectionAdapter={ listModels:(credential:string)=>Promise<string[]> };
export function aiCredential(value:string) {
  if(typeof value!=='string' || !/^[A-Za-z0-9_-]{16,512}$/.test(value))throw new AIProviderError('AI_AUTH_FAILED');return value;
}
export function normalizeAIModels(value:unknown):string[] {
  if(!Array.isArray(value) || value.length>2000 || value.some((id)=>typeof id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)))throw new AIProviderError('AI_RESPONSE_INVALID');
  if(new Set(value).size!==value.length)throw new AIProviderError('AI_RESPONSE_INVALID');return [...value].sort();
}
export const openAIConnectionAdapter:AIConnectionAdapter={ listModels:async(credential)=> {
  aiCredential(credential);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch('https://api.openai.com/v1/models',{ method:'GET',redirect:'error',signal:controller.signal,headers:{ authorization:'Bearer '+credential } });
    if(response.status===401 || response.status===403)throw new AIProviderError('AI_AUTH_FAILED');if(response.status===429)throw new AIProviderError('AI_RATE_LIMITED');
    if(!response.ok)throw new AIProviderError('AI_PROVIDER_UNAVAILABLE');if(!response.body)throw new AIProviderError('AI_RESPONSE_INVALID');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try { for(;;) { const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1048576)throw new AIProviderError('AI_RESPONSE_INVALID');chunks.push(part.value); } }
    finally { await reader.cancel().catch(()=>{}); }
    let body:unknown;try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); }catch { throw new AIProviderError('AI_RESPONSE_INVALID'); }
    if(!body || typeof body!=='object' || !('object' in body) || body.object!=='list' || !('data' in body) || !Array.isArray(body.data))throw new AIProviderError('AI_RESPONSE_INVALID');
    return normalizeAIModels(body.data.map((m:unknown)=> { if(!m || typeof m!=='object' || !('object' in m) || m.object!=='model' || !('id' in m))throw new AIProviderError('AI_RESPONSE_INVALID');return m.id; }));
  }catch(e) { if(e instanceof AIProviderError)throw e;throw new AIProviderError('AI_PROVIDER_UNAVAILABLE'); }finally { clearTimeout(timer); }
} };
export type AIAdapterRegistry=Record<string,AIConnectionAdapter>;
export const aiConnectionAdapters:AIAdapterRegistry={ OPENAI:openAIConnectionAdapter };
