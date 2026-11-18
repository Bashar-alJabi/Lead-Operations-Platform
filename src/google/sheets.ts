// HTTP boundary only. Callers own current scope, encrypted credentials, approved jobs and durable outcomes.
import {createHash} from 'node:crypto';
export const googleSheetsScopes=['openid','https://www.googleapis.com/auth/drive.file'] as const;
export class GoogleSheetsError extends Error{
 constructor(public code:'GOOGLE_INPUT_INVALID'|'GOOGLE_AUTH_FAILED'|'GOOGLE_RESOURCE_UNAVAILABLE'|'GOOGLE_RATE_LIMITED'|'GOOGLE_PROVIDER_UNAVAILABLE'|'GOOGLE_RESPONSE_INVALID'|'GOOGLE_RESULT_UNKNOWN',public retryable=false){super(code);}
}
type Fetcher=typeof fetch;
export type GoogleClient={clientId:string;clientSecret:string};
export type GoogleTokens={accessToken:string;refreshToken:string|null;expiresIn:number;scopes:string[]};
export type GoogleGrid={sheet:string;row:number;column:number;rows:number;columns:number};
export type GoogleSheetGrid={sheetId:number;row:number;column:number;rows:number;columns:number};
export type GoogleSpreadsheet={id:string;title:string;locale:string;timezone:string;sheets:{id:number;title:string;index:number;kind:string;rows:number|null;columns:number|null}[]};
function invalid():never{throw new GoogleSheetsError('GOOGLE_INPUT_INVALID');}
function malformed():never{throw new GoogleSheetsError('GOOGLE_RESPONSE_INVALID');}
function text(value:unknown,max:number):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);}
function object(value:unknown):value is Record<string,any>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function token(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9._~+/-]+=*$/.test(value)&&value.length<=8192;}
function positive(value:unknown,max=2147483647):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=max;}
function id(value:string){if(!/^[A-Za-z0-9_-]{1,200}$/.test(value))invalid();return value;}
function client(c:GoogleClient){if(!/^[A-Za-z0-9._-]{1,220}\.apps\.googleusercontent\.com$/.test(c.clientId)||!text(c.clientSecret,4096))invalid();}
function callback(uri:string,allowLoopback=false){let url:URL;try{url=new URL(uri);}catch{invalid();}
 if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'&&!(allowLoopback&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))invalid();return url.href;}
export function googlePkceChallenge(verifier:string){if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))invalid();return createHash('sha256').update(verifier).digest('base64url');}
export function googleAuthorizationUrl(input:{clientId:string;redirectUri:string;state:string;codeChallenge:string;allowLoopbackHttp?:boolean}){
 if(!/^[A-Za-z0-9._-]{1,220}\.apps\.googleusercontent\.com$/.test(input.clientId)||!/^[A-Za-z0-9_-]{32,512}$/.test(input.state)||!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))invalid();
 const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:input.clientId,redirect_uri:callback(input.redirectUri,input.allowLoopbackHttp),response_type:'code',
  scope:googleSheetsScopes.join(' '),state:input.state,access_type:'offline',prompt:'consent',include_granted_scopes:'false',code_challenge:input.codeChallenge,code_challenge_method:'S256'}).toString();return url.href;
}
function columnName(index:number){let result='';for(let n=index;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
export function googleGridRange(grid:GoogleGrid){
 if(!text(grid.sheet,256)||!positive(grid.row)||!positive(grid.column,18278)||!positive(grid.rows,1000)||!positive(grid.columns,64)
  ||grid.row+grid.rows-1>2147483647||grid.column+grid.columns-1>18278)invalid();
 return "'"+grid.sheet.replaceAll("'","''")+"'!"+columnName(grid.column)+grid.row+':'+columnName(grid.column+grid.columns-1)+(grid.row+grid.rows-1);
}
function rangeMatches(value:unknown,grid:GoogleGrid){
 if(!text(value,1024))return false;const split=value.lastIndexOf('!');if(split<0)return false;
 let sheet=value.slice(0,split);if(/^'(?:[^']|'')*'$/.test(sheet))sheet=sheet.slice(1,-1).replaceAll("''","'");
 if(sheet!==grid.sheet)return false;
 const start=columnName(grid.column)+grid.row,end=columnName(grid.column+grid.columns-1)+(grid.row+grid.rows-1),cells=value.slice(split+1);
 return cells===start+':'+end||start===end&&cells===start;
}
function tokens(value:unknown,previousScopes?:readonly string[]):GoogleTokens{
 if(!object(value)||!token(value.access_token)||typeof value.token_type!=='string'||value.token_type.toLowerCase()!=='bearer'||!positive(value.expires_in,86400)
  ||value.refresh_token!==undefined&&!token(value.refresh_token))malformed();
 const scope=value.scope??previousScopes?.join(' ');if(typeof scope!=='string'||scope.length>4096)malformed();
 const scopes=scope.split(' ').filter(Boolean);if(new Set(scopes).size!==scopes.length||googleSheetsScopes.some(s=>!scopes.includes(s)))malformed();
 return {accessToken:value.access_token,refreshToken:value.refresh_token??null,expiresIn:value.expires_in,scopes};
}
// Limits are defensive technical budgets, not claims about Google's provider capacity.
export function googleSheetsAdapter(fetcher:Fetcher=fetch,options:{timeoutMs?:number;maxResponseBytes?:number}={}){
 const timeout=options.timeoutMs??10000,maxBytes=options.maxResponseBytes??8388608;
 if(!positive(timeout,30000)||!positive(maxBytes,16777216))invalid();
 async function request(url:string,init:RequestInit,mutating=false):Promise<unknown>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
   const response=await fetcher(url,{...init,signal:controller.signal,redirect:'error'});
   if(!response.ok){await response.body?.cancel().catch(()=>{});
    if(response.status===401||response.status===400&&url==='https://oauth2.googleapis.com/token')throw new GoogleSheetsError('GOOGLE_AUTH_FAILED');
    if(response.status===403||response.status===404)throw new GoogleSheetsError('GOOGLE_RESOURCE_UNAVAILABLE');
    if(response.status===429)throw new GoogleSheetsError('GOOGLE_RATE_LIMITED',true);
    if(mutating&&response.status>=500)throw new GoogleSheetsError('GOOGLE_RESULT_UNKNOWN');
    throw new GoogleSheetsError('GOOGLE_PROVIDER_UNAVAILABLE',!mutating&&response.status>=500);
   }
   if(!response.body||!/^application\/(?:[a-z.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel().catch(()=>{});malformed();}
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){await response.body.cancel().catch(()=>{});malformed();}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
   try{for(;;){controller.signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)malformed();chunks.push(part.value);}controller.signal.throwIfAborted();}
   finally{controller.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
   try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{malformed();}
  }catch(e){
   if(e instanceof GoogleSheetsError){if(mutating&&e.code==='GOOGLE_RESPONSE_INVALID')throw new GoogleSheetsError('GOOGLE_RESULT_UNKNOWN');throw e;}
   throw new GoogleSheetsError(mutating?'GOOGLE_RESULT_UNKNOWN':'GOOGLE_PROVIDER_UNAVAILABLE',!mutating);
  }finally{clearTimeout(timer);}
 }
 async function authorized(accessToken:string,path:string,init:RequestInit={},mutating=false){
  if(!token(accessToken))invalid();return request('https://sheets.googleapis.com/v4/spreadsheets/'+path,{...init,headers:{authorization:'Bearer '+accessToken,...init.headers}},mutating);
 }
 async function tokenRequest(body:URLSearchParams,previousScopes?:readonly string[]){
  const value=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()},true);
  try{return tokens(value,previousScopes);}catch{throw new GoogleSheetsError('GOOGLE_RESULT_UNKNOWN');}
 }
 return {
  async readGrid(accessToken:string,spreadsheetId:string,grid:GoogleSheetGrid){
   if(!Number.isSafeInteger(grid.sheetId)||grid.sheetId<0||grid.sheetId>2147483647)invalid();
   googleGridRange({...grid,sheet:'validated-by-id'});
   const expected={sheetId:grid.sheetId,startRowIndex:grid.row-1,endRowIndex:grid.row+grid.rows-1,startColumnIndex:grid.column-1,endColumnIndex:grid.column+grid.columns-1};
   // POST is a read here. A failed transport can be retried without replaying a write.
   const value=await authorized(accessToken,id(spreadsheetId)+'/values:batchGetByDataFilter',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({dataFilters:[{gridRange:expected}],majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'})});
   if(!object(value)||value.spreadsheetId!==spreadsheetId||!Array.isArray(value.valueRanges)||value.valueRanges.length!==1)malformed();
   const match=value.valueRanges[0];if(!object(match)||!Array.isArray(match.dataFilters)||match.dataFilters.length!==1)malformed();
   const filter=match.dataFilters[0],range=object(filter)&&filter.gridRange;
   if(!object(filter)||Object.keys(filter).some(k=>k!=='gridRange')||!object(range)||Object.keys(range).some(k=>!(k in expected))
    ||Object.entries(expected).some(([k,v])=>(range[k]??0)!==v))malformed();
   const result=match.valueRange;if(!object(result)||result.majorDimension!=='ROWS'||result.values!==undefined&&!Array.isArray(result.values))malformed();
   const rows=result.values??[];if(rows.length>grid.rows)malformed();
   return Array.from({length:grid.rows},(_,index)=>{
    const row=rows[index]??[];if(!Array.isArray(row)||row.length>grid.columns)malformed();
    const cells=Array.from({length:grid.columns},(_,c)=>{const cell=row[c];if(cell===undefined||cell===null)return null;
     if(typeof cell!=='string'&&typeof cell!=='boolean'&&!(typeof cell==='number'&&Number.isFinite(cell)&&Math.abs(cell)<=Number.MAX_SAFE_INTEGER))malformed();
     const text=String(cell);if(text.length>20000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))malformed();return text;
    });return {rowNumber:grid.row+index,cells};
   });
  },
  async exchangeCode(c:GoogleClient,input:{code:string;redirectUri:string;verifier:string;allowLoopbackHttp?:boolean}){
   client(c);if(!text(input.code,8192))invalid();googlePkceChallenge(input.verifier);
   return tokenRequest(new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,code:input.code,code_verifier:input.verifier,redirect_uri:callback(input.redirectUri,input.allowLoopbackHttp),grant_type:'authorization_code'}));
  },
  async refresh(c:GoogleClient,refreshToken:string,previousVerifiedScopes?:readonly string[]){client(c);if(!token(refreshToken))invalid();
   return tokenRequest(new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}),previousVerifiedScopes);
  },
  async subject(accessToken:string){if(!token(accessToken))invalid();const value=await request('https://openidconnect.googleapis.com/v1/userinfo',{method:'GET',headers:{authorization:'Bearer '+accessToken}});
   if(!object(value)||!text(value.sub,255))malformed();return value.sub as string;},
  async metadata(accessToken:string,spreadsheetId:string):Promise<GoogleSpreadsheet>{
   const query=new URLSearchParams({includeGridData:'false',fields:'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount)))'});
   const value=await authorized(accessToken,id(spreadsheetId)+'?'+query,{method:'GET'});
   if(!object(value)||value.spreadsheetId!==spreadsheetId||!object(value.properties)||!text(value.properties.title,256)||!text(value.properties.locale,64)||!text(value.properties.timeZone,128)
    ||!Array.isArray(value.sheets)||value.sheets.length>2000)malformed();
   const sheets:GoogleSpreadsheet['sheets']=[],seen=new Set<number>(),titles=new Set<string>();
   for(const sheet of value.sheets){const p=object(sheet)&&sheet.properties;
    if(!object(p)||typeof p.sheetId!=='number'||!Number.isSafeInteger(p.sheetId)||p.sheetId<0||p.sheetId>2147483647||seen.has(p.sheetId)
     ||!text(p.title,256)||titles.has(p.title)||typeof p.index!=='number'||!Number.isSafeInteger(p.index)||p.index<0||!text(p.sheetType,50))malformed();
    if(p.sheetType==='GRID'&&(!object(p.gridProperties)||!positive(p.gridProperties.rowCount)||!positive(p.gridProperties.columnCount,18278)))malformed();
    seen.add(p.sheetId);titles.add(p.title);sheets.push({id:p.sheetId,title:p.title,index:p.index,kind:p.sheetType,rows:p.sheetType==='GRID'?p.gridProperties.rowCount:null,columns:p.sheetType==='GRID'?p.gridProperties.columnCount:null});
   }
   return {id:spreadsheetId,title:value.properties.title,locale:value.properties.locale,timezone:value.properties.timeZone,sheets:sheets.sort((a,b)=>a.index-b.index||a.id-b.id)};
  },
  async read(accessToken:string,spreadsheetId:string,grid:GoogleGrid){
   const range=googleGridRange(grid),q=new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'});
   const value=await authorized(accessToken,id(spreadsheetId)+'/values/'+encodeURIComponent(range)+'?'+q,{method:'GET'});
   if(!object(value)||value.majorDimension!=='ROWS'||!rangeMatches(value.range,grid)||value.values!==undefined&&!Array.isArray(value.values))malformed();
   const rows=value.values??[];if(rows.length>grid.rows)malformed();
   return rows.map((row:unknown,index:number)=>{
    if(!Array.isArray(row)||row.length>grid.columns)malformed();
    const cells:(string|null)[]=[];for(let c=0;c<grid.columns;c++){const cell=row[c];
     if(cell===undefined||cell===null){cells.push(null);continue;}
     if(typeof cell!=='string'&&typeof cell!=='boolean'&&!(typeof cell==='number'&&Number.isFinite(cell)&&Math.abs(cell)<=Number.MAX_SAFE_INTEGER))malformed();
     const formatted=String(cell);if(formatted.length>8192||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(formatted))malformed();cells.push(formatted);
    }
    return {rowNumber:grid.row+index,cells};
   });
  },
  async writeRaw(accessToken:string,spreadsheetId:string,grid:GoogleGrid,rows:(string|number|boolean|null)[][]){
   const range=googleGridRange(grid);if(rows.length!==grid.rows||rows.some(row=>!Array.isArray(row)||row.length!==grid.columns||row.some(v=>v!==null&&typeof v!=='boolean'&&
    !(typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER)&&!(typeof v==='string'&&v.length<=8192&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)))))invalid();
   let size=4096;for(const row of rows)for(const cell of row){size+=Buffer.byteLength(JSON.stringify(cell??''))+1;if(size>8388608)invalid();}
   const body=JSON.stringify({range,majorDimension:'ROWS',values:rows.map(r=>r.map(c=>c??''))});if(Buffer.byteLength(body)>8388608)invalid();
   const q=new URLSearchParams({valueInputOption:'RAW',includeValuesInResponse:'false'});
   const value=await authorized(accessToken,id(spreadsheetId)+'/values/'+encodeURIComponent(range)+'?'+q,{method:'PUT',headers:{'content-type':'application/json'},body},true);
   if(!object(value)||value.spreadsheetId!==spreadsheetId||!rangeMatches(value.updatedRange,grid)||value.updatedRows!==grid.rows||value.updatedColumns!==grid.columns||value.updatedCells!==grid.rows*grid.columns)
    throw new GoogleSheetsError('GOOGLE_RESULT_UNKNOWN');
   return {updatedRows:value.updatedRows as number,updatedColumns:value.updatedColumns as number,updatedCells:value.updatedCells as number};
  },
 };
}
export type GoogleSheetsAdapter=ReturnType<typeof googleSheetsAdapter>;
