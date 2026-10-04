import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source bindings preserve scoped shared access, deterministic contexts, concurrency, versioned history and recovery without enabling intake',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Bindings') RETURNING id`)[0]!.id;
  const alienOrg=(await db`INSERT INTO organization (name) VALUES ('Other organization') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const alienBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${alienOrg},'Alien') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@source-binding.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  async function connection(scope:string|null,name:string) {
    const id=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status)
      VALUES (${org},${scope},'META','META_LEAD_ADS',${name},'WARNING') RETURNING id`)[0]!.id;
    const page=(await db`INSERT INTO source_resource (connection_id,resource_kind,external_id,name,connection_version)
      VALUES (${id},'PAGE','10',${name+' Page'},1) RETURNING id`)[0]!.id;
    const forms:string[]=[];
    for (const external of ['11','12']) forms.push((await db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version,questions)
      VALUES (${id},'FORM',${page},${external},${name+' Form '+external},1,'[{"key":"interest","label":"<b>literal</b>","type":"CUSTOM","options":[]}]'::jsonb) RETURNING id`)[0]!.id);
    return { id,page,forms };
  }
  const local=await connection(branch,'A source');const remote=await connection(otherBranch,'B source');const shared=await connection(null,'Organization source');
  async function campaign(scope:string,name:string,kind='META') {
    return (await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind) VALUES (${org},${scope},${name},${kind}) RETURNING id`)[0]!.id;
  }
  const camp=await campaign(branch,'A');const second=await campaign(branch,'A second');const other=await campaign(otherBranch,'B');const manual=await campaign(branch,'Manual','MANUAL');
  const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const base='/api/sources/campaigns/'+camp;const sharedRoot='/api/sources/meta/connections/'+shared.id;
  const access=(resource:string,scope:string)=>sharedRoot+'/resources/'+resource+'/access/'+scope;
  const input=(conn=local,form=conn.forms[0]!)=>({ connectionId:conn.id,formId:form,requestId:randomUUID(),connectionVersion:1,
    externalCampaignId:null as string|null,externalAdSetId:null as string|null,externalAdId:null as string|null,active:true,reason:'Configure trusted source' });
  const resources=(path:string,conn=shared,kind='FORM')=>`${path}/connections/${conn.id}/resources?kind=${kind}`;
  assert.equal((await api('GET',base+'/connections',undefined,'agent')).statusCode,403);
  assert.equal((await api('GET',base+'/connections',undefined,'other')).statusCode,404);
  const ownList=(await api('GET',base+'/connections')).json();assert.equal(ownList.items.length,1);assert.equal(ownList.items[0].id,local.id);
  assert.equal((await api('GET',resources(base))).statusCode,404);
  assert.equal((await api('GET',resources(base,remote))).statusCode,404);
  assert.equal((await api('POST',base+'/bindings',input(shared))).statusCode,404);
  for (const who of ['manager','other','agent']) {
    assert.equal((await api('PUT',access(shared.forms[0]!,branch),{ version:0,active:true,reason:'grant' },who)).statusCode,403);
    assert.equal((await api('GET',sharedRoot+'/resources/'+shared.forms[0]+'/access',undefined,who)).statusCode,403);
  }
  assert.equal((await api('PUT',access(shared.page,branch),{ version:0,active:true,reason:'grant' },'admin')).statusCode,404);
  assert.equal((await api('PUT',access(shared.forms[0]!,alienBranch),{ version:0,active:true,reason:'grant' },'admin')).statusCode,404);
  assert.equal((await api('PUT',access(shared.forms[0]!,branch),{ version:0,active:true,reason:' ' },'admin')).statusCode,400);
  assert.equal((await api('PUT',access(shared.forms[0]!,branch),{ version:0,active:true,reason:'Allow A' },'admin')).statusCode,200);
  assert.equal((await api('PUT',access(shared.forms[0]!,branch),{ version:0,active:true,reason:'stale' },'admin')).statusCode,409);
  assert.equal((await api('PUT',access(shared.forms[1]!,otherBranch),{ version:0,active:true,reason:'Allow B' },'admin')).statusCode,200);
  const visible=await api('GET',resources(base));assert.equal(visible.json().items.length,1);assert.equal(visible.json().items[0].id,shared.forms[0]);
  assert.ok(visible.body.includes('<b>literal</b>'));assert.ok(!visible.body.includes('ciphertext'));assert.ok(!visible.body.includes('accessToken'));
  assert.equal((await api('GET',resources(base,shared,'PAGE'))).json().items.length,1);
  assert.equal((await api('GET',sharedRoot+'/resources?kind=PAGE')).statusCode,404);
  assert.equal((await api('POST',sharedRoot+'/discover',{ version:1 })).statusCode,404);
  assert.equal((await api('PUT',sharedRoot,{ version:1,name:'attack',config:{ graphVersion:'v25.0' } })).statusCode,404);
  const otherBase='/api/sources/campaigns/'+other;
  assert.equal((await api('GET',resources(otherBase),undefined,'other')).json().items[0].id,shared.forms[1]);
  assert.equal((await api('POST',base+'/bindings',input(shared,shared.forms[1]))).statusCode,404);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),formId:local.page })).statusCode,404);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),formId:remote.forms[0] })).statusCode,404);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),connectionVersion:2 })).statusCode,409);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),externalAdId:'untrusted' })).statusCode,400);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),reason:' ' })).statusCode,400);
  assert.equal((await api('POST','/api/sources/campaigns/'+manual+'/bindings',input())).json().error,'SOURCE_CAMPAIGN_KIND_MISMATCH');
  const firstInput=input();const first=await api('POST',base+'/bindings',firstInput);assert.equal(first.statusCode,201);const firstId=first.json().id;
  assert.equal((await api('POST',base+'/bindings',firstInput)).json().id,firstId);
  assert.equal((await api('POST',base+'/bindings',{ ...firstInput,externalAdId:'99' })).json().error,'SOURCE_BINDING_IDEMPOTENCY_CONFLICT');
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_campaign_binding WHERE request_key=${firstInput.requestId}`)[0]!.n,1);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),externalCampaignId:'30' })).json().error,'SOURCE_BINDING_CONTEXT_CONFLICT');
  const edit={ connectionVersion:1,externalCampaignId:'30',externalAdSetId:null,externalAdId:null,active:true,reason:'Narrow context',version:1 };
  assert.equal((await api('PUT',base+'/bindings/'+firstId,edit)).statusCode,200);
  assert.equal((await api('PUT',base+'/bindings/'+firstId,edit)).json().error,'SOURCE_BINDING_VERSION_CONFLICT');
  assert.equal((await api('POST',base+'/bindings',firstInput)).json().id,firstId,'retries refer to the original creation snapshot after later edits');
  const disjoint=await api('POST','/api/sources/campaigns/'+second+'/bindings',{ ...input(),externalCampaignId:'31' });assert.equal(disjoint.statusCode,201);
  assert.equal((await api('POST',base+'/bindings',{ ...input(),externalAdId:'700' })).statusCode,409,'dimensions combine as conjunction, not an invented precedence');
  const concurrent=await Promise.all([api('POST',base+'/bindings',{ ...input(local,local.forms[1]),externalAdId:'900' }),
    api('POST','/api/sources/campaigns/'+second+'/bindings',{ ...input(local,local.forms[1]),externalAdId:'900' })]);
  assert.deepEqual(concurrent.map((r)=>r.statusCode).sort(),[201,409]);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_campaign_binding WHERE resource_id=${local.forms[1]!} AND active`)[0]!.n,1);
  const rawForm=(await db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version)
    VALUES (${local.id},'FORM',${local.page},'13','DB concurrency Form',1) RETURNING id`)[0]!.id;
  const rawRace=await Promise.allSettled([camp,second].map((campaignId)=>db`INSERT INTO source_campaign_binding
    (connection_id,resource_id,campaign_id,request_key,external_ad_id,active,connection_version,updated_by,change_reason)
    VALUES (${local.id},${rawForm},${campaignId},${randomUUID()},'1000',true,1,${users.manager!.id},'Direct database concurrency')`));
  assert.equal(rawRace.filter((r)=>r.status==='fulfilled').length,1,'DB trigger independently serializes active context conflicts');
  assert.equal(rawRace.filter((r)=>r.status==='rejected').length,1);
  const rawRejection=rawRace.find((r)=>r.status==='rejected');assert.ok(rawRejection?.status==='rejected' && rawRejection.reason.message==='SOURCE_BINDING_CONTEXT_CONFLICT');
  const page1=(await api('GET',base+'/bindings?limit=1')).json();assert.equal(page1.items.length,1);assert.ok(page1.nextAfter);
  assert.notEqual((await api('GET',base+'/bindings?limit=1&after='+page1.nextAfter)).json().items[0].id,page1.items[0].id);
  const bound=(await api('GET',base+'/bindings')).json().items.find((b:{ id:string })=>b.id===firstId);
  assert.equal(bound.ready,false);assert.ok(bound.issues.includes('SOURCE_MAPPING_NOT_CONFIGURED'));assert.ok(bound.issues.includes('SOURCE_INTAKE_NOT_CONFIGURED'));
  assert.equal((await api('POST','/api/campaigns/'+camp+'/activate',{})).statusCode,409);
  const history=(await api('GET',base+'/bindings/'+firstId+'/history?limit=1')).json();assert.equal(history.items[0].version,2);assert.equal(history.nextBefore,2);
  assert.equal((await api('GET',base+'/bindings/'+firstId+'/history?beforeVersion=2')).json().items[0].snapshot.externalCampaignId,null);
  assert.equal((await api('GET',base+'/bindings/'+firstId+'/history',undefined,'other')).statusCode,404);
  assert.equal((await api('GET',otherBase+'/bindings/'+firstId+'/history',undefined,'other')).statusCode,404);
  assert.equal((await api('PUT',base+'/bindings/'+firstId,edit,'agent')).statusCode,403);
  await assert.rejects(db`UPDATE source_binding_history SET reason='rewrite' WHERE binding_id=${firstId}`);
  await assert.rejects(db`DELETE FROM source_binding_history WHERE binding_id=${firstId}`);
  await assert.rejects(db`DELETE FROM source_campaign_binding WHERE id=${firstId}`);
  await assert.rejects(db`UPDATE source_campaign_binding SET external_ad_id='500' WHERE id=${firstId}`);
  await assert.rejects(db`UPDATE source_campaign_binding SET campaign_id=${second},version=version+1 WHERE id=${firstId}`);
  const sharedInput={ ...input(shared),externalCampaignId:'40' };
  const sharedId=(await api('POST',base+'/bindings',sharedInput)).json().id;assert.ok(sharedId);
  assert.equal((await api('PUT',access(shared.forms[0]!,otherBranch),{ version:0,active:true,reason:'Allow B same Form' },'admin')).statusCode,200);
  const conflict=await api('POST',otherBase+'/bindings',{ ...input(shared),externalCampaignId:'40' },'other');assert.equal(conflict.statusCode,409);
  assert.ok(!conflict.body.includes(sharedId));assert.ok(!conflict.body.includes(camp));
  const sharedB=await api('POST',otherBase+'/bindings',{ ...input(shared),externalCampaignId:'41' },'other');assert.equal(sharedB.statusCode,201);
  const grants=(await api('GET',sharedRoot+'/resources/'+shared.forms[0]+'/access?limit=1',undefined,'admin')).json();assert.ok(grants.nextAfter);
  assert.equal((await api('GET',sharedRoot+'/resources/'+shared.forms[0]+'/access?after='+grants.nextAfter,undefined,'admin')).json().items.length,1);
  const revoked=await api('PUT',access(shared.forms[0]!,branch),{ version:1,active:false,reason:'Revoke A' },'admin');assert.equal(revoked.statusCode,200);
  assert.equal((await db`SELECT active,version FROM source_campaign_binding WHERE id=${sharedId}`)[0]!.active,false);
  assert.equal((await api('GET',resources(base))).statusCode,404);
  assert.equal((await api('PUT',base+'/bindings/'+sharedId,{ ...edit,externalCampaignId:'40',version:2 })).statusCode,404);
  assert.equal((await api('GET',base+'/bindings/'+sharedId+'/history')).json().items[0].reason,'SOURCE_RESOURCE_ACCESS_REVOKED');
  assert.equal((await db`SELECT active FROM source_campaign_binding WHERE id=${sharedB.json().id}`)[0]!.active,true,'another branch is unaffected');
  await assert.rejects(db`UPDATE source_resource_access_history SET reason='rewrite' WHERE resource_id=${shared.forms[0]!}`);
  await assert.rejects(db`UPDATE source_resource_access SET active=true,version=version+1,updated_by=${users.manager!.id} WHERE resource_id=${shared.forms[0]!} AND branch_id=${branch}`);
  assert.equal((await api('PUT',access(shared.forms[0]!,branch),{ version:2,active:true,reason:'Restore A' },'admin')).statusCode,200);
  assert.equal((await db`SELECT active FROM source_campaign_binding WHERE id=${sharedId}`)[0]!.active,false,'grant restoration never reactivates a historical binding');
  const accessHistory=(await api('GET',access(shared.forms[0]!,branch)+'/history?limit=1',undefined,'admin')).json();assert.equal(accessHistory.items[0].version,3);assert.equal(accessHistory.nextBefore,3);
  assert.equal((await api('GET',access(shared.forms[0]!,branch)+'/history?beforeVersion=3',undefined,'admin')).json().items.length,2);
  assert.equal((await api('PUT',base+'/bindings/'+sharedId,{ ...edit,externalCampaignId:'40',version:2 })).statusCode,200);
  // Concurrent revoke vs creation shares one connection lock: either create is denied, or its active state is atomically revoked.
  const race=await Promise.all([api('POST','/api/sources/campaigns/'+second+'/bindings',{ ...input(shared),externalCampaignId:'42' }),
    api('PUT',access(shared.forms[0]!,branch),{ version:3,active:false,reason:'Concurrent revoke' },'admin')]);
  assert.ok([201,404].includes(race[0]!.statusCode));assert.equal(race[1]!.statusCode,200);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_campaign_binding b JOIN campaign c ON c.id=b.campaign_id
    WHERE b.resource_id=${shared.forms[0]!} AND c.branch_id=${branch} AND b.active`)[0]!.n,0);
  await db`UPDATE integration_connection SET version=version+1 WHERE id=${local.id}`;
  const stale=(await api('GET',base+'/bindings')).json().items.find((b:{ id:string })=>b.id===firstId);assert.ok(stale.issues.includes('SOURCE_CONFIGURATION_CHANGED'));
  assert.equal((await api('PUT',base+'/bindings/'+firstId,{ ...edit,version:2,connectionVersion:2 })).json().error,'SOURCE_BINDING_NOT_AVAILABLE');
  assert.equal((await api('PUT',base+'/bindings/'+firstId,{ ...edit,version:2,active:false })).statusCode,200,'disabling survives connection invalidation');
  await db`UPDATE source_resource SET connection_version=2 WHERE connection_id=${local.id}`;
  assert.equal((await api('PUT',base+'/bindings/'+firstId,{ ...edit,version:3,connectionVersion:2 })).statusCode,200);
  await db`UPDATE integration_connection SET status='AUTH_EXPIRED' WHERE id=${local.id}`;
  assert.equal((await api('POST',base+'/bindings',{ ...input(),externalCampaignId:'50',connectionVersion:2 })).statusCode,409);
  await db`UPDATE integration_connection SET status='WARNING' WHERE id=${local.id}`;
  // Requests waiting on configuration recheck the user's active role after the lock is obtained.
  let release!:()=>void;let entered!:()=>void;const locked=new Promise<void>((r)=> { entered=r; });
  const holder=db.begin(async(tx)=> { await tx`SELECT id FROM integration_connection WHERE id=${local.id} FOR UPDATE`;entered();await new Promise<void>((r)=> { release=r; }); });await locked;
  const pending=api('POST',base+'/bindings',{ ...input(),externalCampaignId:'51',connectionVersion:2 });
  const deadline=Date.now()+3000;let waiting=false;
  while (Date.now()<deadline) {
    waiting=(await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_connection%'`).length>0;
    if (waiting) break;await new Promise<void>((r)=>setTimeout(r,10));
  }
  if (!waiting) { release();await holder;assert.fail('Request did not reach the held connection lock'); }
  await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;release();await holder;
  assert.equal((await pending).statusCode,403);await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM source_submission`)[0]!.n,0);
  const audit=await db`SELECT action,detail FROM audit_log WHERE action LIKE 'SOURCE_%'`;
  assert.ok(audit.some((a)=>a.action==='SOURCE_BINDING_CREATED'));assert.ok(audit.some((a)=>a.action==='SOURCE_BINDING_UPDATED'));assert.ok(audit.some((a)=>a.action==='SOURCE_RESOURCE_ACCESS_UPDATED'));
  assert.ok(!JSON.stringify(audit).includes('accessToken'));
});
