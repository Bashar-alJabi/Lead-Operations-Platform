import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';import {setTimeout as pause} from 'node:timers/promises';
import {createDatabase} from '../src/db.js';import {buildApp} from '../src/app.js';import {sha256} from '../src/security.js';import {googleSheetsAdapter,googleSheetsScopes} from '../src/google/sheets.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test'||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('Isolated loopback test database required');
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function setup(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');const db=createDatabase(url);
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Shared Google') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES('Foreign Google') RETURNING id`)[0]!.id;
 const branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Shared A') RETURNING id`)[0]!.id,other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Shared B') RETURNING id`)[0]!.id,foreignBranch=(await db`INSERT INTO branch(organization_id,name) VALUES(${foreignOrg},'Foreign') RETURNING id`)[0]!.id;
 const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'Campaign A') RETURNING id`)[0]!.id,otherCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${other},'Campaign B') RETURNING id`)[0]!.id;
 const actors:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,b,o] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',other,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const){const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${o},${b},${name},${role},${name+'@google-access.test'},'synthetic') RETURNING id`)[0]!.id,raw=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(raw)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;actors[name]={id,session,cookie:'lop_session='+raw};}
 const raw=randomBytes(32).toString('hex');actors.alternate={id:actors.admin!.id,session:(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${actors.admin!.id},${sha256(raw)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id,cookie:'lop_session='+raw};
 let calls=0;const adapter=googleSheetsAdapter(async(target,init)=>{calls++;assert.equal(init?.redirect,'error');const u=new URL(String(target));
  if(u.href==='https://oauth2.googleapis.com/token')return json({access_token:'SyntheticSharedAccess',refresh_token:'SyntheticSharedRefresh',expires_in:3600,token_type:'Bearer',scope:googleSheetsScopes.join(' ')});
  if(u.href==='https://openidconnect.googleapis.com/v1/userinfo')return json({sub:'SyntheticSharedSubject'});
  assert.equal(u.origin,'https://sheets.googleapis.com');assert.equal(u.pathname,'/v4/spreadsheets/SyntheticSharedSpreadsheet');assert.equal(u.searchParams.get('includeGridData'),'false');
  return json({spreadsheetId:'SyntheticSharedSpreadsheet',properties:{title:'Scoped shared file',locale:'en_US',timeZone:'UTC'},sheets:[{properties:{sheetId:0,title:'Worksheet 0',index:0,sheetType:'GRID',gridProperties:{rowCount:10,columnCount:3}}}]});
 });
 const app=await buildApp(db,{logger:false,googleSheetsAdapter:adapter,globalRateLimitMax:10000,rateLimitKeyGenerator:r=>r.ip+':'+String(r.headers['x-test-actor']??'')});t.after(async()=>{await app.close();await db.end();});
 const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='admin')=>app.inject({method,url:path,payload,headers:{origin:process.env.APP_ORIGIN!,cookie:actors[actor]!.cookie,'x-test-actor':actor}});
 async function resource(branchId:string|null=null,actor='admin'){
  const c=await api('POST','/api/google/connections',{name:'Shared setup',branchId,clientId:'123-access.apps.googleusercontent.com',clientSecret:'SyntheticSharedClientSecret',reason:'Synthetic shared resource'},actor);assert.equal(c.statusCode,201,c.body);const cid=c.json().id,root='/api/google/connections/'+cid;
  assert.equal((await api('PUT',root+'/picker',{version:0,connectionVersion:1,projectNumber:'123456789012',apiKey:'SyntheticSharedPickerKey_123',reason:'Synthetic Picker setup'},actor)).statusCode,200);
  const consent=await api('POST',root+'/authorize',{version:1},actor);assert.equal(consent.statusCode,200,consent.body);const state=new URL(consent.json().url).searchParams.get('state')!;assert.equal((await api('GET','/api/google/callback?'+new URLSearchParams({state,code:'SyntheticSharedCode'}),undefined,actor)).statusCode,302);
  const start=await api('POST',root+'/picker/tickets',{connectionVersion:1,settingsVersion:1,requestId:randomUUID(),locale:'en'},actor);assert.equal(start.statusCode,200,start.body);const tr='/api/google/picker/tickets/'+start.json().id;
  assert.equal((await api('POST',tr+'/bootstrap',{},actor)).statusCode,200);const selected=await api('POST',tr+'/selection',{spreadsheetId:'SyntheticSharedSpreadsheet'},actor);assert.equal(selected.statusCode,200,selected.body);return {cid,rid:selected.json().resourceId as string,tr};
 }
 return {db,api,actors,org,branch,other,foreignBranch,campaign,otherCampaign,resource,calls:()=>calls};
}

test('Google explicit availability separates Manager operational use from Organization credentials, is concurrent/CAS/native/audited, and revocation, connection and resource changes immediately fence catalogs',async t=>{
 const f=await setup(t),{db,api}=f,r=await f.resource(),root='/api/google/resources/'+r.rid+'/access',catalog='/api/google/campaigns/'+f.campaign+'/resources',sheets=catalog+'/'+r.rid+'/sheets';
 const before=f.calls();assert.deepEqual((await api('GET',catalog,undefined,'manager')).json().items,[]);
 for(const actor of ['manager','other','agent','foreign'])assert.ok([403,404].includes((await api('GET',root,undefined,actor)).statusCode));
 const p={version:0,connectionVersion:1,resourceVersion:1,active:true,reason:'Explicit Branch availability'},path=root+'/'+f.branch;
 const responses=await Promise.all(Array.from({length:8},()=>api('PUT',path,p)));assert.equal(responses.filter(r=>r.statusCode===200).length,1,responses.map(r=>r.body).join());assert.ok(responses.every(r=>[200,409].includes(r.statusCode)));
 assert.equal((await db`SELECT count(*)::integer n FROM google_resource_access_history`)[0]!.n,1);assert.equal((await db`SELECT count(*)::integer n FROM audit_log WHERE action='GOOGLE_RESOURCE_ACCESS_CHANGED'`)[0]!.n,1);
 assert.equal((await api('PUT',root+'/'+f.foreignBranch,p)).statusCode,404);assert.equal((await api('PUT',path,{...p,version:1},'manager')).statusCode,403);
 const available=(await api('GET',catalog,undefined,'manager')).json();assert.equal(available.items.length,1);assert.equal(available.items[0].id,r.rid);assert.equal((await api('GET',sheets,undefined,'manager')).json().items[0].id,0);
 assert.equal((await api('GET','/api/google/connections/'+r.cid,undefined,'manager')).statusCode,404);assert.equal((await api('POST',r.tr+'/bootstrap',{},'manager')).statusCode,404);
 assert.equal((await api('GET','/api/google/campaigns/'+f.otherCampaign+'/resources',undefined,'manager')).statusCode,404);assert.equal((await api('GET',catalog,undefined,'agent')).statusCode,403);assert.equal((await api('GET',catalog,undefined,'foreign')).statusCode,404);
 assert.equal((await api('GET','/api/google/campaigns/'+f.otherCampaign+'/resources',undefined,'other')).json().items.length,0);
 for(let version=1;version<27;version++)assert.equal((await api('PUT',path,{...p,version,active:version%2===0,reason:'Availability history '+(version+1)})).statusCode,200);
 const h=(await api('GET',path+'/history?limit=20')).json();assert.equal(h.items.length,20);assert.equal((await api('GET',path+'/history?before='+h.nextBefore)).json().items.length,7);
 assert.equal((await api('PUT',path,{...p,version:27,active:false})).statusCode,200);assert.equal((await api('GET',catalog,undefined,'manager')).json().items.length,0);assert.equal((await api('GET',sheets,undefined,'manager')).statusCode,404);
 assert.equal((await api('PUT',path,{...p,version:28})).statusCode,200);
 for(let i=0;i<22;i++)await db`INSERT INTO branch(organization_id,name) VALUES(${f.org},${'Additional '+i})`;
 const branches=(await api('GET',root+'/branches?limit=20')).json();assert.equal(branches.items.length,20);assert.equal((await api('GET',root+'/branches?after='+branches.nextAfter)).json().items.length,4);
 assert.equal((await api('POST','/api/google/resources/'+r.rid+'/disable',{version:1,connectionVersion:1,reason:'Disable shared resource'})).statusCode,200);assert.equal((await api('GET',catalog,undefined,'manager')).json().items.length,0);assert.equal((await api('PUT',path,{...p,version:29,resourceVersion:2})).statusCode,409);
 assert.equal((await api('PUT',path,{...p,version:29,resourceVersion:2,active:false})).statusCode,200);
 const own=await f.resource(f.branch,'manager');assert.equal((await api('GET',catalog,undefined,'manager')).json().items[0].id,own.rid);assert.equal((await api('GET','/api/google/resources/'+own.rid+'/access')).statusCode,404);
 assert.equal((await api('POST','/api/google/connections/'+r.cid+'/disable',{version:1,reason:'Disable Organization connection'})).statusCode,200);
 assert.equal((await api('PUT',path,{...p,version:30,connectionVersion:2,resourceVersion:2,active:false})).statusCode,200);
 assert.equal(f.calls(),before+3,'sharing and catalog reads perform no Provider request');assert.equal((await db`SELECT count(*)::integer n FROM lead`)[0]!.n,0);
 const exposed=JSON.stringify([available,h,branches]);for(const secret of ['SyntheticSharedClientSecret','SyntheticSharedAccess','SyntheticSharedRefresh','SyntheticSharedPickerKey','SyntheticSharedSubject'])assert.ok(!exposed.includes(secret));
});

test('Google availability rechecks Session after Connection lock, recovers from a real new session and atomically rolls back native Audit/history failure',async t=>{
 const f=await setup(t),{api,db}=f,r=await f.resource(),root='/api/google/resources/'+r.rid+'/access',path=root+'/'+f.branch,p={version:0,connectionVersion:1,resourceVersion:1,active:true,reason:'Current Session availability'};
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const holder=db.begin(async tx=>{await tx`SELECT id FROM integration_connection WHERE id=${r.cid} FOR UPDATE`;entered();await gate;});await held;
 const pending=api('PUT',path,p);try{let blocked=false;for(let i=0;i<100;i++){blocked=(await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_connection%FOR UPDATE%'`).length>0;if(blocked)break;await pause(10);}assert.ok(blocked,'real request reached the held Connection lock');await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.admin!.session}`;}finally{release();await holder;}
 assert.equal((await pending).statusCode,403);assert.equal((await db`SELECT 1 FROM google_resource_access`).length,0);
 const created=await api('PUT',path,p,'alternate');assert.equal(created.statusCode,200,created.body);
 await db`CREATE FUNCTION synthetic_google_access_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_RESOURCE_ACCESS_CHANGED' THEN RAISE EXCEPTION 'Synthetic availability Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER synthetic_google_access_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_google_access_audit_failure()`;
 try{assert.equal((await api('PUT',path,{...p,version:1,active:false},'alternate')).statusCode,500);assert.equal((await db`SELECT version FROM google_resource_access`)[0]!.version,1);assert.equal((await db`SELECT count(*)::integer n FROM google_resource_access_history`)[0]!.n,1);}
 finally{await db`DROP TRIGGER synthetic_google_access_audit ON audit_log`;await db`DROP FUNCTION synthetic_google_access_audit_failure()`;}
 await assert.rejects(()=>db`UPDATE google_resource_access_history SET reason='Forged history'`,/GOOGLE_RESOURCE_ACCESS_HISTORY_IMMUTABLE/);
 await assert.rejects(()=>db`UPDATE google_resource_access SET version=version+1,actor_id=${f.actors.manager!.id},session_id=${f.actors.manager!.session}`,/GOOGLE_SHARED_RESOURCE_CURRENT_ACCESS_REQUIRED/);
 await assert.rejects(()=>db`UPDATE google_resource_access SET branch_id=${f.other},version=version+1`,/GOOGLE_RESOURCE_ACCESS_IDENTITY_IMMUTABLE/);
 await assert.rejects(()=>db`DELETE FROM google_resource_access`,/GOOGLE_RESOURCE_ACCESS_HISTORY_RETAINED/);
 assert.equal((await api('GET','/api/google/campaigns/'+f.campaign+'/resources',undefined,'manager')).json().items.length,1);
 await db`UPDATE branch SET active=false WHERE id=${f.branch}`;assert.equal((await api('GET','/api/google/campaigns/'+f.campaign+'/resources',undefined,'manager')).statusCode,404);
 assert.equal((await api('PUT',path,{...p,version:1,active:false},'alternate')).statusCode,200,'revocation stays possible for inactive Branch');
 assert.equal((await db`SELECT count(*)::integer n FROM lead`)[0]!.n,0);
});
