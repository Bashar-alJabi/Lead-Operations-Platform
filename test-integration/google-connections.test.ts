import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase} from '../src/db.js';
import {sha256} from '../src/security.js';
import {openOpaque} from '../src/credentials.js';
import {googleSheetsAdapter,googleSheetsScopes} from '../src/google/sheets.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test'||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('Isolated loopback TEST_DATABASE_URL required');
const clientId='123-synthetic-managed.apps.googleusercontent.com',clientSecret='SyntheticManagedGoogleSecret_123';
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url);await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES ('Synthetic Google') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign Google') RETURNING id`)[0]!.id;
 const a=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,b=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,branch,o] of [['manager','MANAGER',a,org],['other','MANAGER',b,org],['agent','AGENT',a,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${o},${branch},${name},${role},${name+'@google.test'},'synthetic-only') RETURNING id`)[0]!.id;
  const token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES(${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 let calls=0,codeCalls=0,refreshCalls=0,account='Synthetic-google-account',mode='GOOD',hold:Promise<void>|null=null,entered:(()=>void)|null=null;
 const adapter=googleSheetsAdapter(async(input,init)=>{
  calls++;assert.equal(init?.redirect,'error');const target=String(input);assert.ok(!target.includes(clientSecret));
  if(target==='https://oauth2.googleapis.com/token'){
   assert.equal(init!.method,'POST');const body=new URLSearchParams(String(init!.body));assert.equal(body.get('client_id'),clientId);assert.ok(body.get('client_secret')?.startsWith('Synthetic'));
   const grant=body.get('grant_type');if(grant==='authorization_code'){codeCalls++;assert.ok(body.get('code_verifier')!.length>=43);assert.equal(body.get('redirect_uri'),process.env.APP_ORIGIN+'/api/google/callback');}else{assert.equal(grant,'refresh_token');refreshCalls++;assert.ok(body.get('refresh_token')?.startsWith('Synthetic-refresh'));}
   const running=(await db`SELECT state FROM google_oauth_operation ORDER BY created_at DESC LIMIT 1`)[0];assert.equal(running?.state,'RUNNING','durable claim must commit before HTTP');
   entered?.();if(hold)await hold;if(mode==='UNKNOWN')throw Error('Synthetic lost OAuth ACK '+clientSecret);if(mode==='AUTH')return json({secret:clientSecret},400);
   return json({access_token:'Synthetic-access-'+calls,refresh_token:grant==='authorization_code'?'Synthetic-refresh-initial':undefined,expires_in:3600,token_type:'Bearer',scope:grant==='authorization_code'?googleSheetsScopes.join(' '):undefined});
  }
  assert.equal(target,'https://openidconnect.googleapis.com/v1/userinfo');assert.ok(new Headers(init!.headers).get('authorization')?.startsWith('Bearer Synthetic-access-'));
  return json({sub:account,email:'unused-private@example.test',name:'Unused private profile'});
 });
 const app=await buildApp(db,{logger:false,googleSheetsAdapter:adapter,globalRateLimitMax:10000});t.after(async()=>{await app.close();await db.end();});
 const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({method,url:path,payload,headers:{origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie}});
 const create=async(actor='manager',branch:string|null=a)=>{const r=await api('POST','/api/google/connections',{name:'Google <img literal>',branchId:branch,clientId,clientSecret,reason:'Synthetic managed setup'},actor);assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 const start=async(id:string,version=1,actor='manager')=>{const r=await api('POST','/api/google/connections/'+id+'/authorize',{version},actor);assert.equal(r.statusCode,200,r.body);return {...r.json(),state:new URL(r.json().url).searchParams.get('state')!};};
 const callback=(state:string,actor='manager',code='Synthetic-code')=>api('GET','/api/google/callback?'+new URLSearchParams({state,code}),undefined,actor);
 return {db,app,org,a,b,users,api,create,start,callback,setMode:(v:string)=>{mode=v;},setAccount:(v:string)=>{account=v;},pause:()=>{let release!:()=>void;hold=new Promise<void>(r=>release=r);const called=new Promise<void>(r=>entered=r);return {called,release:()=>{hold=null;entered=null;release();}};},counts:()=>({calls,codeCalls,refreshCalls})};
}
test('Google managed OAuth confines scope/session, encrypts secrets, uses a durable one-time PKCE exchange and refresh, pins identity and retains native audit/history',async t=>{
 const f=await fixture(t),{db,app,api,users}=f;
 assert.equal((await api('POST','/api/google/connections',{name:'Denied',branchId:f.a,clientId,clientSecret,reason:'Synthetic setup'},'agent')).statusCode,403);
 for(const branchId of [null,f.b])assert.equal((await api('POST','/api/google/connections',{name:'Denied',branchId,clientId,clientSecret,reason:'Synthetic setup'})).statusCode,403);
 assert.equal((await api('POST','/api/google/connections',{name:'Bad',branchId:f.a,clientId:'not-google',clientSecret,reason:'Synthetic setup'})).statusCode,400);
 const id=await f.create(),root='/api/google/connections/'+id;await f.create('admin',null);
 assert.equal((await api('GET','/api/google/setup',undefined,'agent')).statusCode,403);
 const setup=await api('GET','/api/google/setup');assert.equal(setup.json().redirectUri,process.env.APP_ORIGIN+'/api/google/callback');assert.deepEqual(setup.json().scopes,googleSheetsScopes);assert.match(setup.headers['cache-control'] as string,/no-store/);
 for(const actor of ['other','foreign']){assert.equal((await api('GET',root,undefined,actor)).statusCode,404);assert.equal((await api('GET','/api/google/connections',undefined,actor)).json().items.length,0);}
 assert.equal((await api('POST',root+'/test',{version:1})).statusCode,409);
 const secret=(await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext as Buffer;assert.equal(secret.toString().includes(clientSecret),false);
 const auth=await f.start(id),authUrl=new URL(auth.url);assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');assert.equal(authUrl.searchParams.get('scope'),googleSheetsScopes.join(' '));assert.equal(f.counts().calls,0);
 assert.equal((await f.callback(auth.state,'other')).statusCode,404);assert.equal((await f.callback(auth.state,'agent')).statusCode,403);
 assert.equal((await app.inject({method:'GET',url:'/api/google/callback?state='+auth.state+'&code=Synthetic-code'})).statusCode,401);
 assert.equal((await f.callback('x'.repeat(43))).statusCode,400);
 const secondToken=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(secondToken)},now()+interval '1 hour')`;
 assert.equal((await app.inject({method:'GET',url:'/api/google/callback?state='+auth.state+'&code=Synthetic-code',headers:{cookie:'lop_session='+secondToken}})).statusCode,403);
 assert.equal(f.counts().calls,0);
 const gate=f.pause(),pending=f.callback(auth.state);await gate.called;
 const duplicate=await Promise.all(Array.from({length:7},()=>f.callback(auth.state)));assert.ok(duplicate.every(r=>r.statusCode===409));assert.equal(f.counts().codeCalls,1);gate.release();
 const completed=await pending;assert.equal(completed.statusCode,302,completed.body);assert.equal(completed.headers.location,process.env.APP_ORIGIN+'/?google='+id);
 assert.match(completed.headers['cache-control'] as string,/no-store/);assert.equal((await f.callback(auth.state)).statusCode,302);assert.equal(f.counts().codeCalls,1);
 const c=(await api('GET',root)).json();assert.equal(c.status,'CONNECTED');assert.equal(c.account_pinned,true);
 const checked=await api('POST',root+'/test',{version:1});assert.equal(checked.statusCode,200,checked.body);assert.equal(checked.json().state,'VERIFIED');assert.equal(f.counts().refreshCalls,1);
 const grant=(await db`SELECT o.* FROM google_oauth_operation o JOIN integration_connection c ON c.capabilities->>'grantId'=o.id::text WHERE c.id=${id}`)[0]!;
 const result=grant.result,plain=JSON.parse(openOpaque('google-result:'+grant.id,{ciphertext:Buffer.from(result.ciphertext,'base64'),nonce:Buffer.from(result.nonce,'base64'),authTag:Buffer.from(result.authTag,'base64'),keyVersion:result.keyVersion}));
 assert.equal(plain.refreshToken,'Synthetic-refresh-initial');assert.deepEqual(plain.scopes,googleSheetsScopes);
 const opPage=(await api('GET',root+'/operations?limit=1')).json();assert.ok(opPage.nextCursor);assert.equal((await api('GET',root+'/operations?cursor='+encodeURIComponent(opPage.nextCursor))).json().items[0].kind,'AUTHORIZE');
 const safe=JSON.stringify([(await api('GET',root)).json(),opPage,(await api('GET',root+'/history')).json(),await db`SELECT detail FROM audit_log WHERE action LIKE 'GOOGLE_%'`,await db`SELECT result,verifier FROM google_oauth_operation`]);
 for(const privateValue of [clientSecret,'Synthetic-refresh','Synthetic-access','Synthetic-google-account','unused-private@example.test','Unused private profile'])assert.ok(!safe.includes(privateValue),privateValue);
 assert.equal((await api('GET',root+'/history',undefined,'agent')).statusCode,403);
 await assert.rejects(()=>db`UPDATE google_oauth_operation SET state='FAILED',version=version+1 WHERE id=${grant.id}`,/GOOGLE_OPERATION_TRANSITION_INVALID/);
 await assert.rejects(()=>db`UPDATE google_operation_history SET state='FAILED' WHERE operation_id=${grant.id}`,/GOOGLE_HISTORY_IMMUTABLE/);
 await assert.rejects(()=>db`UPDATE google_connection_revision SET name='Forged' WHERE connection_id=${id}`,/GOOGLE_HISTORY_IMMUTABLE/);
 await assert.rejects(()=>db`UPDATE google_connection_subject SET subject_hash=${randomBytes(32)} WHERE connection_id=${id}`,/GOOGLE_ACCOUNT_IDENTITY_IMMUTABLE/);
 await assert.rejects(()=>db`UPDATE integration_connection SET branch_id=${f.b} WHERE id=${id}`,/GOOGLE_CONNECTION_IDENTITY_IMMUTABLE/);
 await assert.rejects(()=>db`UPDATE connection_secret SET ciphertext=${randomBytes(40)} WHERE connection_id=${id}`,/GOOGLE_CREDENTIAL_REVISION_REQUIRED/);
 const other=await f.create();await assert.rejects(()=>db`UPDATE integration_connection SET status='CONNECTED',capabilities=${db.json({grantId:randomUUID()})} WHERE id=${other}`,/GOOGLE_CURRENT_OUTCOME_REQUIRED/);
 await assert.rejects(()=>db`INSERT INTO google_oauth_operation(connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,state,state_hash,verifier)
 VALUES(${other},1,'AUTHORIZE',${users.agent!.id},${users.agent!.session},'AGENT',${f.a},'WAITING',${randomBytes(32)},'{}')`,/GOOGLE_CURRENT_ACCESS_REQUIRED/);
});
test('Google late exchanges cannot activate after rotation, revocation, branch disable or changed account; unknown code outcomes never replay and reconnect is explicit',async t=>{
 const f=await fixture(t),{db,api,users}=f,id=await f.create(),root='/api/google/connections/'+id;
 let auth=await f.start(id);f.setMode('UNKNOWN');assert.equal((await f.callback(auth.state)).statusCode,302);
 assert.equal((await api('GET',root+'/operations')).json().items[0].state,'UNKNOWN');const count=f.counts().codeCalls;
 assert.equal((await f.callback(auth.state)).statusCode,302);assert.equal(f.counts().codeCalls,count);assert.equal((await api('POST',root+'/test',{version:1})).statusCode,409);
 f.setMode('GOOD');auth=await f.start(id);assert.equal((await f.callback(auth.state)).statusCode,302);assert.equal((await api('GET',root)).json().status,'CONNECTED');
 auth=await f.start(id);f.setAccount('Other synthetic Google account');assert.equal((await f.callback(auth.state)).statusCode,302);
 assert.equal((await api('GET',root)).json().last_error_code,'GOOGLE_ACCOUNT_MISMATCH');assert.equal((await api('GET',root+'/operations')).json().items[0].state,'FAILED');f.setAccount('Synthetic-google-account');
 auth=await f.start(id);const hold=f.pause(),running=f.callback(auth.state);await hold.called;
 const edits=await Promise.all(Array.from({length:4},(_,i)=>api('PUT',root,{name:'Rotated '+i,clientSecret:'SyntheticRotatedGoogleSecret',version:1,reason:'Rotate synthetic Google key'})));
 assert.deepEqual(edits.map(r=>r.statusCode).sort(),[200,409,409,409]);hold.release();assert.equal((await running).statusCode,302);
 assert.equal((await api('GET',root)).json().status,'NOT_CONFIGURED');assert.equal((await api('GET',root+'/operations')).json().items[0].state,'SUPERSEDED');
 auth=await f.start(id,2);const revoked=f.pause(),runningRevoked=f.callback(auth.state);await revoked.called;await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 revoked.release();assert.equal((await runningRevoked).statusCode,403);await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
 assert.equal((await api('GET',root+'/operations')).json().items[0].state,'SUPERSEDED');assert.equal((await api('GET',root)).json().status,'NOT_CONFIGURED');
 auth=await f.start(id,2);await db`UPDATE branch SET active=false WHERE id=${f.a}`;const before=f.counts().calls;assert.equal((await f.callback(auth.state)).statusCode,302);assert.equal(f.counts().calls,before);
 assert.equal((await api('POST',root+'/authorize',{version:2})).statusCode,409);await db`UPDATE branch SET active=true WHERE id=${f.a}`;
 auth=await f.start(id,2);const changedRole=f.pause(),runningChangedRole=f.callback(auth.state);await changedRole.called;
 await db`UPDATE user_account SET role='AGENT' WHERE id=${users.manager!.id}`;changedRole.release();assert.equal((await runningChangedRole).statusCode,403);
 await db`UPDATE user_account SET role='MANAGER' WHERE id=${users.manager!.id}`;assert.equal((await api('GET',root+'/operations')).json().items[0].state,'SUPERSEDED');
 assert.equal((await api('GET',root)).json().status,'NOT_CONFIGURED');
 assert.equal((await api('POST',root+'/disable',{version:2,reason:'Disable synthetic connection'})).statusCode,200);assert.equal((await api('POST',root+'/authorize',{version:3})).statusCode,409);
 assert.equal((await api('POST',root+'/reconnect',{version:3,reason:'Explicit reconnect'})).statusCode,200);auth=await f.start(id,4);assert.equal((await f.callback(auth.state)).statusCode,302);
 assert.equal((await api('GET',root)).json().status,'CONNECTED');const history=(await api('GET',root+'/history?limit=1')).json();assert.equal(history.nextVersion,4);assert.equal((await api('GET',root+'/history?before=4')).json().items[0].status,'DISABLED');
});
test('Google claim and configuration require atomic Audit; failed final persistence leaves a durable non-replayable running exchange and expires safely before new consent',async t=>{
 const f=await fixture(t),{db,api}=f;
 await db`CREATE FUNCTION synthetic_google_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_CONNECTION_CONFIGURED' THEN RAISE EXCEPTION 'Synthetic Google Audit unavailable';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER synthetic_google_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_google_audit_fail()`;
 try{assert.equal((await api('POST','/api/google/connections',{name:'Rolled back',branchId:f.a,clientId,clientSecret,reason:'Audit rollback'})).statusCode,500);assert.equal((await db`SELECT 1 FROM integration_connection WHERE kind='GOOGLE'`).length,0);assert.equal((await db`SELECT 1 FROM connection_secret`).length,0);}
 finally{await db`DROP TRIGGER synthetic_google_audit ON audit_log`;await db`DROP FUNCTION synthetic_google_audit_fail()`;}
 const id=await f.create(),root='/api/google/connections/'+id,auth=await f.start(id);
 await db`CREATE FUNCTION synthetic_google_finish_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_AUTHORIZATION_STATE' AND NEW.detail->>'state'='VERIFIED' THEN RAISE EXCEPTION 'Synthetic Google final Audit unavailable';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER synthetic_google_finish BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_google_finish_fail()`;
 try{assert.equal((await f.callback(auth.state)).statusCode,500);assert.equal((await api('GET',root)).json().status,'NOT_CONFIGURED');assert.equal((await db`SELECT 1 FROM google_connection_subject WHERE connection_id=${id}`).length,0);assert.equal((await api('GET',root+'/operations')).json().items[0].state,'RUNNING');}
 finally{await db`DROP TRIGGER synthetic_google_finish ON audit_log`;await db`DROP FUNCTION synthetic_google_finish_fail()`;}
 const count=f.counts().codeCalls;assert.equal((await f.callback(auth.state)).statusCode,409);assert.equal(f.counts().codeCalls,count);
 // Real DB-clock deadline, without disabling production guards or modifying historical expiration.
 const remaining=Number((await db`SELECT GREATEST(0,EXTRACT(epoch FROM (expires_at-clock_timestamp()))*1000)::integer AS ms FROM google_oauth_operation WHERE id=${auth.operationId}`)[0]!.ms);
 await new Promise(r=>setTimeout(r,remaining+100));
 const fresh=await f.start(id);assert.equal((await api('GET',root+'/operations')).json().items.find((o:{id:string})=>o.id===auth.operationId).state,'UNKNOWN');
 assert.equal((await f.callback(auth.state)).statusCode,302);assert.equal(f.counts().codeCalls,count);assert.equal((await f.callback(fresh.state)).statusCode,302);assert.equal((await api('GET',root)).json().status,'CONNECTED');
});
