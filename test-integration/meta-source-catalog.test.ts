import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openSecret,openOpaque } from '../src/credentials.js';
import { SourceProviderError,type SourcePage,type SourceForm } from '../src/sources/meta-provider.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Meta source catalog encrypts resource tokens, isolates scopes and fences failure, concurrency, configuration and expired leases',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const credentials={ accessToken:'synthetic-root-access-token',appSecret:'synthetic-source-app-secret',verifyToken:'synthetic-source-verify-token' };
  let pages:SourcePage[]=[{ externalId:'11',name:'Page A',accessToken:'synthetic-page-a-token' },{ externalId:'12',name:'Page B',accessToken:'synthetic-page-b-token' }];
  const forms:SourceForm[]=[{ externalId:'101',name:'Form A',status:'ACTIVE',questions:[{ key:'interest',externalId:null,label:'<b>literal</b>',type:'CUSTOM',options:[{ key:'yes',value:'Yes' }] }] },
    { externalId:'102',name:'Form B',status:'ARCHIVED',questions:[] }];
  let mode='ok';let calls=0;let wait:Promise<void>|undefined;let entered:(()=>void)|undefined;
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,leadSourceCatalogAdapter:{
    discoverPages:async(_config,secret)=> {
      calls++;assert.deepEqual(secret,credentials);entered?.();await wait;
      if (mode==='fail') throw new Error('Untrusted secret '+credentials.accessToken);
      if (mode==='auth') throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');
      return mode==='duplicate' ? [pages[0]!,pages[0]!] : pages;
    },
    discoverForms:async(_config,page)=> { calls++;assert.equal(page.externalId,'11');assert.equal(page.accessToken,'synthetic-page-a-token');return forms; },
  } });t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Source catalog') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@catalog.test'},'synthetic-non-login-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  let address=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.0.${address++}` });
  const root='/api/sources/meta/connections';const input={ name:'Source A',config:{ graphVersion:'v25.0' },credentials };
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);assert.equal((await api('POST',root,{ ...input,branchId:otherBranch })).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,credentials:{ ...credentials,accessToken:'bad\nheader-token-12345' } })).statusCode,400);
  const created=await api('POST',root,input);assert.equal(created.statusCode,201);const id=created.json().id;const base=root+'/'+id;
  const shared=(await api('POST',root,{ ...input,name:'Shared' },'admin')).json().id;
  assert.equal((await api('GET',root+'/'+shared+'/resources?kind=PAGE')).statusCode,404);
  assert.equal((await api('POST',root+'/'+shared+'/discover',{ version:1 })).statusCode,404);
  assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);assert.equal((await api('GET',root,undefined,'other')).json().items.length,0);
  const list=await api('GET',root);assert.equal(list.json().items.length,1);assert.equal(list.json().items[0].branch_id,branch);
  assert.ok(!list.body.includes(credentials.accessToken));assert.ok(!list.body.includes('ciphertext'));
  const secret=(await db`SELECT * FROM connection_secret WHERE connection_id=${id}`)[0]!;
  assert.equal(JSON.parse(openSecret(id,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version })).accessToken,credentials.accessToken);
  for (const [method,path,body] of [['POST','/discover',{ version:1 }],['GET','/resources?kind=PAGE',undefined],['GET','/sync-history',undefined],
    ['POST','/disable',{ version:1 }],['PUT','',{ ...input,version:1 }]] as const) {
    assert.equal((await api(method,base+path,body,'agent')).statusCode,403);assert.equal((await api(method,base+path,body,'other')).statusCode,404);
  }
  assert.equal(calls,0);assert.equal((await api('POST',base+'/discover',{ version:2 })).statusCode,409);
  assert.equal((await api('POST',base+'/discover',{ version:1 })).statusCode,200);
  const first=(await api('GET',base+'/resources?kind=PAGE&limit=1')).json();assert.equal(first.items.length,1);assert.ok(first.nextAfter);
  const second=(await api('GET',base+'/resources?kind=PAGE&limit=1&after='+first.nextAfter)).json();assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);
  const resources=(await api('GET',base+'/resources?kind=PAGE')).json().items;const pageId=resources.find((item:{ external_id:string })=>item.external_id==='11').id;
  assert.ok(!JSON.stringify(resources).includes('synthetic-page'));assert.ok(!JSON.stringify(resources).includes('ciphertext'));
  const pageSecret=(await db`SELECT * FROM source_resource_secret WHERE resource_id=${pageId}`)[0]!;
  assert.ok(!pageSecret.ciphertext.toString().includes('synthetic-page'));
  assert.equal(openOpaque(`source-resource:${pageId}`,{ ciphertext:pageSecret.ciphertext,nonce:pageSecret.nonce,authTag:pageSecret.auth_tag,keyVersion:pageSecret.key_version }),'synthetic-page-a-token');
  assert.throws(()=>openOpaque('source-resource:wrong',{ ciphertext:pageSecret.ciphertext,nonce:pageSecret.nonce,authTag:pageSecret.auth_tag,keyVersion:pageSecret.key_version }));
  assert.equal((await api('POST',base+'/discover',{ version:1,pageId:randomBytes(16).toString('hex') })).statusCode,400);
  assert.equal((await api('POST',base+'/discover',{ version:1,pageId:'00000000-0000-4000-8000-000000000000' })).statusCode,404);
  assert.equal((await api('POST',base+'/discover',{ version:1,pageId })).statusCode,200);
  const visible=(await api('GET',base+'/resources?kind=FORM&pageId='+pageId)).json().items;
  assert.equal(visible.length,2);assert.equal(visible[0].questions.length+visible[1].questions.length,1);
  const formId=visible.find((item:{ external_id:string })=>item.external_id==='101').id;
  await assert.rejects(db`UPDATE source_resource SET parent_id=${formId} WHERE id=${pageId}`);
  await assert.rejects(db`INSERT INTO source_resource_secret (resource_id,ciphertext,nonce,auth_tag)
    VALUES (${formId},${pageSecret.ciphertext},${pageSecret.nonce},${pageSecret.auth_tag})`);
  assert.equal((await api('GET',base+'/resources?kind=PAGE&pageId='+pageId)).statusCode,400);
  mode='fail';const failed=await api('POST',base+'/discover',{ version:1 });assert.equal(failed.statusCode,502);assert.equal(failed.json().error,'SOURCE_CATALOG_SYNC_FAILED');
  assert.ok(!failed.body.includes(credentials.accessToken));assert.equal((await db`SELECT count(*)::integer AS n FROM source_resource WHERE connection_id=${id} AND active`)[0]!.n,4);
  mode='duplicate';assert.equal((await api('POST',base+'/discover',{ version:1 })).statusCode,502);
  mode='auth';assert.equal((await api('POST',base+'/discover',{ version:1 })).statusCode,502);assert.equal((await db`SELECT status FROM integration_connection WHERE id=${id}`)[0]!.status,'AUTH_EXPIRED');
  mode='ok';assert.equal((await api('POST',base+'/discover',{ version:1 })).statusCode,200);
  const hist=(await api('GET',base+'/sync-history?limit=1')).json();assert.equal(hist.items[0].state,'SUCCEEDED');assert.ok(hist.nextCursor);
  await assert.rejects(db`UPDATE source_resource_sync SET resource_count=999 WHERE id=${hist.items[0].id}`);
  await assert.rejects(db`DELETE FROM source_resource_sync WHERE id=${hist.items[0].id}`);
  assert.notEqual((await api('GET',base+'/sync-history?limit=1&cursor='+encodeURIComponent(hist.nextCursor))).json().items[0].id,hist.items[0].id);
  const connection=(await api('GET',root)).json().items[0];assert.equal(connection.status,'WARNING');assert.equal(connection.capabilities.intakeReady,false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);
  let release!:()=>void;let ready!:()=>void;wait=new Promise<void>((resolve)=> { release=resolve; });const started=new Promise<void>((resolve)=> { ready=resolve; });entered=ready;
  const running=api('POST',base+'/discover',{ version:1 });await started;
  assert.equal((await api('POST',base+'/discover',{ version:1 })).json().error,'SOURCE_SYNC_RUNNING');
  assert.equal((await api('POST',base+'/disable',{ version:1 })).statusCode,200);release();assert.equal((await running).statusCode,409);wait=undefined;entered=undefined;
  assert.equal((await db`SELECT status,version FROM integration_connection WHERE id=${id}`)[0]!.status,'DISABLED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_resource WHERE connection_id=${id} AND active`)[0]!.n,0);
  await assert.rejects(db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version)
    VALUES (${shared},'FORM',${pageId},'500','Cross connection',1)`);
  assert.equal((await api('POST',base+'/discover',{ version:2 })).statusCode,409);
  assert.equal((await api('POST',base+'/enable',{ version:2 })).statusCode,200);
  assert.equal((await api('POST',base+'/discover',{ version:3,pageId })).json().error,'SOURCE_PAGE_NOT_READY');
  assert.equal((await api('PUT',base,{ name:'Renamed',config:{ graphVersion:'v25.0' },version:3 })).statusCode,200);
  assert.equal((await api('PUT',base,{ ...input,version:3 })).statusCode,409);
  assert.equal((await api('POST',base+'/discover',{ version:4 })).statusCode,200);
  // A crash leaves a bounded lease. A later operation fences it before accepting a fresh catalog.
  await db`INSERT INTO source_resource_sync (id,connection_id,connection_version,resource_kind,actor_user_id,lease_until)
    VALUES (gen_random_uuid(),${id},4,'PAGE',${users.manager!.id},now()-interval '1 second')`;
  assert.equal((await api('POST',base+'/discover',{ version:4 })).statusCode,200);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_resource_sync WHERE error_code='SOURCE_SYNC_LEASE_EXPIRED'`)[0]!.n,1);
  // Disabled requester cannot publish a provider result even though the token was valid at request start.
  wait=new Promise<void>((resolve)=> { release=resolve; });const began=new Promise<void>((resolve)=> { entered=resolve; });
  const revoked=api('POST',base+'/discover',{ version:4 });await began;await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;
  release();assert.equal((await revoked).statusCode,403);wait=undefined;entered=undefined;await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  pages=[];assert.equal((await api('POST',base+'/discover',{ version:4 })).statusCode,200);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_resource WHERE connection_id=${id} AND active`)[0]!.n,0);
  assert.equal((await db`SELECT last_error_code FROM integration_connection WHERE id=${id}`)[0]!.last_error_code,'SOURCE_NO_RESOURCES');
  const audit=await db`SELECT action,detail FROM audit_log WHERE target_id=${id}`;
  assert.ok(audit.some((item)=>item.action==='SOURCE_CATALOG_SYNC_FAILED'));assert.ok(audit.some((item)=>item.action==='SOURCE_CONNECTION_DISABLED'));
  assert.ok(!JSON.stringify(audit).includes(credentials.accessToken));assert.ok(!JSON.stringify(audit).includes('synthetic-page'));
  assert.equal((await api('GET',root+'?limit=1',undefined,'admin')).json().items.length,1);
});
