import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {openOpaque} from '../src/credentials.js';
import {googleSheetsAdapter} from '../src/google/sheets.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test'||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('Isolated loopback TEST_DATABASE_URL required');
test('Google Picker prerequisites enforce real current scope and both CAS versions, encrypt and rotate keys with atomic native history/Audit and never claim provider verification or read a file',async t=>{
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url);let providerCalls=0;const app=await buildApp(db,{logger:false,globalRateLimitMax:10000,googleSheetsAdapter:googleSheetsAdapter(async()=>{providerCalls++;throw Error('Picker configuration must not contact a provider');})});t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Picker settings') RETURNING id`)[0]!.id,foreign=(await db`INSERT INTO organization(name) VALUES('Other Picker') RETURNING id`)[0]!.id;
 const a=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,b=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,branch,o] of [['manager','MANAGER',a,org],['other','MANAGER',b,org],['agent','AGENT',a,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${o},${branch},${name},${role},${name+'@picker.test'},'synthetic-only') RETURNING id`)[0]!.id;
  const token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={id,session,cookie:'lop_session='+token};
 }
 const api=(method:'GET'|'PUT'|'POST',path:string,payload?:object,actor='manager')=>app.inject({method,url:path,payload,headers:{origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie}});
 const create=async(actor='manager',branchId:string|null=a)=>{const r=await api('POST','/api/google/connections',{name:'Picker connection',branchId,clientId:'123-picker.apps.googleusercontent.com',clientSecret:'SyntheticGoogleClientSecret',reason:'Synthetic setup'},actor);assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 const id=await create(),shared=await create('admin',null),root='/api/google/connections/'+id+'/picker',key='SyntheticPickerKey_123456789';
 const input={version:0,connectionVersion:1,projectNumber:'123456789012',apiKey:key,reason:'Synthetic Picker setup <img literal>'};
 const empty=await api('GET',root);assert.equal(empty.json().configured,false);assert.equal(empty.json().verification,'NOT_CONFIGURED');assert.match(empty.headers['cache-control'] as string,/no-store/);
 for(const actor of ['other','foreign']){assert.equal((await api('GET',root,undefined,actor)).statusCode,404);assert.equal((await api('PUT',root,input,actor)).statusCode,404);assert.equal((await api('GET',root+'/history',undefined,actor)).statusCode,404);}
 assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);assert.equal((await api('PUT',root,input,'agent')).statusCode,403);
 assert.equal((await api('PUT','/api/google/connections/'+shared+'/picker',input)).statusCode,404);
 assert.equal((await api('PUT',root,{...input,apiKey:undefined})).statusCode,400);assert.equal((await api('PUT',root,{...input,projectNumber:'project-id'})).statusCode,400);assert.equal((await api('PUT',root,{...input,apiKey:'short'})).statusCode,400);
 assert.equal((await api('PUT',root,{...input,connectionVersion:2})).statusCode,409);
 const saved=await api('PUT',root,input);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().verification,'CONFIGURED_NOT_VERIFIED');assert.equal(saved.json().keyRevision,1);
 const read=()=>db`SELECT * FROM google_picker_settings WHERE connection_id=${id}`;
 const original=(await read())[0]!;assert.ok(!original.ciphertext.toString().includes(key));
 assert.equal(openOpaque('google-picker:'+id,{ciphertext:original.ciphertext,nonce:original.nonce,authTag:original.auth_tag,keyVersion:original.key_version}),key);
 const updates=await Promise.all(Array.from({length:8},(_,i)=>api('PUT',root,{...input,apiKey:undefined,version:1,projectNumber:String(223456789012+i),reason:'Concurrent scoped project update'})));
 assert.deepEqual(updates.map(r=>r.statusCode).sort(),[200,409,409,409,409,409,409,409]);const retained=(await read())[0]!;assert.deepEqual(retained.ciphertext,original.ciphertext);assert.equal(retained.key_revision,1);assert.equal(retained.version,2);
 const rotated='SyntheticPickerRotatedKey_123456';assert.equal((await api('PUT',root,{...input,version:2,apiKey:rotated,reason:'Rotate dedicated Picker key'})).statusCode,200);
 const current=(await read())[0]!;assert.equal(current.version,3);assert.equal(current.key_revision,3);assert.notDeepEqual(current.ciphertext,original.ciphertext);
 assert.equal(openOpaque('google-picker:'+id,{ciphertext:current.ciphertext,nonce:current.nonce,authTag:current.auth_tag,keyVersion:current.key_version}),rotated);
 const history=(await api('GET',root+'/history?limit=1')).json();assert.equal(history.nextVersion,3);const older=(await api('GET',root+'/history?before=3')).json();assert.equal(older.items[0].secret_changed,false);assert.equal(older.items[1].secret_changed,true);
 const publicData=JSON.stringify([(await api('GET',root)).json(),history,older,await db`SELECT detail FROM audit_log WHERE action='GOOGLE_PICKER_CONFIGURED'`]);for(const secret of [key,rotated,'ciphertext','nonce','auth_tag'])assert.ok(!publicData.includes(secret));
 await assert.rejects(()=>db`UPDATE google_picker_settings_history SET project_number='1' WHERE connection_id=${id}`,/GOOGLE_PICKER_HISTORY_IMMUTABLE/);
 await assert.rejects(()=>db`DELETE FROM google_picker_settings WHERE connection_id=${id}`,/GOOGLE_PICKER_HISTORY_RETAINED/);
 await assert.rejects(()=>db`UPDATE google_picker_settings SET version=version+1,actor_role='AGENT' WHERE connection_id=${id}`,/GOOGLE_PICKER_CURRENT_ACCESS_REQUIRED/);
 await assert.rejects(()=>db`UPDATE google_picker_settings SET version=version+1,key_revision=1,nonce=${randomBytes(12)} WHERE connection_id=${id}`,/GOOGLE_PICKER_REVISION_INVALID/);
 await db`CREATE FUNCTION synthetic_picker_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_PICKER_CONFIGURED' THEN RAISE EXCEPTION 'Synthetic Picker Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER synthetic_picker_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_picker_audit_fail()`;
 try{assert.equal((await api('PUT',root,{...input,version:3,apiKey:'SyntheticPickerUncommittedKey_123',reason:'Atomic key rotation failure'})).statusCode,500);assert.equal((await read())[0]!.version,3);assert.deepEqual((await read())[0]!.ciphertext,current.ciphertext);assert.equal((await api('GET',root+'/history')).json().items.length,3);}
 finally{await db`DROP TRIGGER synthetic_picker_audit ON audit_log`;await db`DROP FUNCTION synthetic_picker_audit_fail()`;}
 const changed=await api('PUT','/api/google/connections/'+id,{version:1,name:'Renamed Google',reason:'Current connection version fence'});assert.equal(changed.statusCode,200);
 assert.equal((await api('PUT',root,{...input,version:3})).statusCode,409);
 assert.equal((await api('PUT',root,{...input,version:3,connectionVersion:2,apiKey:undefined})).statusCode,200);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET',root)).statusCode,401);
 await assert.rejects(()=>db`UPDATE google_picker_settings SET version=version+1 WHERE connection_id=${id}`,/GOOGLE_PICKER_CURRENT_ACCESS_REQUIRED/);await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
 assert.equal((await api('POST','/api/google/connections/'+id+'/disable',{version:2,reason:'Disable all local connection use'})).statusCode,200);
 assert.equal((await api('PUT',root,{...input,version:4,connectionVersion:3})).statusCode,409);
 assert.equal((await api('GET','/api/google/connections/'+id)).json().status,'DISABLED');assert.equal(providerCalls,0);
 assert.equal((await db`SELECT count(*)::integer AS n FROM google_oauth_operation`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);
});
