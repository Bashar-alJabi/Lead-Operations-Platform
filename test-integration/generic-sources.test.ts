import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Generic Webhook setup isolates real sessions and preserves one current signed test across rotation, retries and failure', async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org]=await db`INSERT INTO organization(name) VALUES('Generic test scope') RETURNING id`;
  const [foreignOrg]=await db`INSERT INTO organization(name) VALUES('Generic foreign scope') RETURNING id`;
  const [branch,other]=await db`INSERT INTO branch(organization_id,name)
    VALUES(${org!.id},'Generic Branch'),(${org!.id},'Other Generic Branch') RETURNING id`;
  async function user(role:string,branchId:string|null,organizationId=org!.id) {
    const [actor]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},'Synthetic user',${randomUUID()+'@generic.test'},'fixture') RETURNING id`;
    const token=randomBytes(32).toString('hex');
    const [session]=await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES
      (${actor!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return {cookie:'lop_session='+token,session:session!.id};
  }
  const manager=await user('MANAGER',branch!.id), otherManager=await user('MANAGER',other!.id);
  const agent=await user('AGENT',branch!.id), foreign=await user('SUPER_ADMIN',null,foreignOrg!.id);
  const root='/api/sources/generic/connections';
  const api=(method:'GET'|'POST',suffix:string,payload?:object,actor=manager)=>app.inject({
    method,url:root+suffix,payload,headers:{cookie:actor.cookie,origin:process.env.APP_ORIGIN!},
  });
  const input={branchId:branch!.id,name:'Synthetic webhook',reason:'Authorize synthetic signing setup'};
  assert.equal((await api('POST','',input,agent)).statusCode,403);
  assert.equal((await api('POST','',{...input,branchId:other!.id})).statusCode,404);
  const created=await api('POST','',input);
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.headers['cache-control'],'no-store');
  const {id,signingSecret,callbackPath}=created.json() as {id:string;signingSecret:string;callbackPath:string};
  assert.match(signingSecret,/^[0-9a-f]{64}$/);
  const [encrypted]=await db`SELECT ciphertext,nonce,auth_tag FROM connection_secret WHERE connection_id=${id}`;
  assert.equal(encrypted!.ciphertext.equals(Buffer.from(signingSecret)),false);
  const listed=await api('GET','');
  assert.equal(listed.statusCode,200,listed.body);
  assert.ok(!listed.body.includes(signingSecret));
  assert.equal(listed.json().items[0].status,'NOT_CONFIGURED');
  assert.deepEqual((await api('GET','',undefined,otherManager)).json().items,[]);
  assert.deepEqual((await api('GET','',undefined,foreign)).json().items,[]);
  assert.equal((await api('GET','/'+id+'/tests',undefined,foreign)).statusCode,404);
  assert.equal((await api('POST','/'+id+'/rotate',{version:1,reason:'Foreign access'},otherManager)).statusCode,404);
  assert.equal((await api('GET','',undefined,agent)).statusCode,403);
  await assert.rejects(db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${id}`,/GENERIC_SOURCE_CONNECTION_PROOF_REQUIRED/);
  await assert.rejects(db`UPDATE connection_secret SET ciphertext=decode(repeat('00',64),'hex') WHERE connection_id=${id}`,
    /GENERIC_SOURCE_SECRET_ROTATION_REQUIRED/);

  const clock=async()=>(await db`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS seconds`)[0]!.seconds as string;
  async function probe(body:string,secret=signingSecret,timestamp?:string,replaceBody?:string) {
    const seconds=timestamp??await clock();
    const signature=createHmac('sha256',Buffer.from(secret,'hex'))
      .update(`lead-operations.generic-source:test:v1\n${id}\n${seconds}\n`).update(body).digest('hex');
    return app.inject({method:'POST',url:callbackPath,payload:replaceBody??body,
      headers:{'content-type':'application/json','x-source-timestamp':seconds,'x-source-signature':'v1='+signature}});
  }
  const testId=randomUUID(),sample=JSON.stringify({testId});
  assert.equal((await probe(sample,randomBytes(32).toString('hex'))).statusCode,401);
  assert.equal((await probe(sample,signingSecret,String(Number(await clock())-301))).statusCode,401);
  assert.equal((await probe(sample,signingSecret,undefined,sample+' ')).statusCode,401);
  assert.equal((await probe(JSON.stringify({testId,lead:{name:'Forbidden synthetic payload'}}))).statusCode,400);
  const duplicate=await Promise.all(Array.from({length:7},()=>probe(sample)));
  assert.deepEqual(duplicate.map(result=>result.statusCode).sort(),[200,200,200,200,200,200,202]);
  assert.equal((await probe(sample+' ')).statusCode,409);
  const history=await api('GET','/'+id+'/tests');
  assert.deepEqual(history.json().items.map((row:{testId:string;current:boolean})=>[row.testId,row.current]),[[testId,true]]);
  assert.ok(!history.body.includes(signingSecret));
  await assert.rejects(db`DELETE FROM generic_source_test_receipt WHERE connection_id=${id}`,/GENERIC_SOURCE_TEST_IMMUTABLE/);
  assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='GENERIC_SOURCE_TEST_VERIFIED'`)[0]!.n,1);

  const rotate='/'+id+'/rotate';
  const raced=await Promise.all(Array.from({length:4},()=>api('POST',rotate,{version:1,reason:'Rotate the key'})));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409]);
  const rotated=raced.find(result=>result.statusCode===200)!.json().signingSecret as string;
  assert.notEqual(rotated,signingSecret);
  assert.equal((await probe(JSON.stringify({testId:randomUUID()}))).statusCode,401);
  assert.equal((await probe(sample,rotated)).statusCode,409);
  assert.equal((await api('GET','/'+id+'/tests')).json().items[0].current,false);
  const fresh=JSON.stringify({testId:randomUUID()});
  await db`CREATE FUNCTION test_generic_probe_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='GENERIC_SOURCE_TEST_VERIFIED' THEN RAISE EXCEPTION 'Synthetic probe persistence failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_generic_probe_audit_failure BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION test_generic_probe_audit_failure()`;
  try {
    assert.equal((await probe(fresh,rotated)).statusCode,500);
    assert.equal((await api('GET','')).json().items[0].status,'NOT_CONFIGURED');
    assert.equal((await api('GET','/'+id+'/tests')).json().items.length,1);
  } finally {
    await db`DROP TRIGGER test_generic_probe_audit_failure ON audit_log`;
    await db`DROP FUNCTION test_generic_probe_audit_failure()`;
  }
  assert.equal((await probe(fresh,rotated)).statusCode,202);
  assert.equal((await api('POST','/'+id+'/disable',{version:2,reason:'Disable synthetic source'})).statusCode,200);
  assert.equal((await probe(JSON.stringify({testId:randomUUID()}),rotated)).statusCode,401);
  assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,0);
  assert.deepEqual((await db`SELECT operation FROM generic_source_setup_revision WHERE connection_id=${id} ORDER BY version`).map(row=>row.operation),
    ['CREATE','ROTATE','DISABLE']);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${manager.session}`;
  assert.equal((await api('POST',rotate,{version:3,reason:'Expired scope'})).statusCode,401);
});
