import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { openOpaque, sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { localMediaStorage } from '../src/media/storage.js';
import { MediaError } from '../src/media/validation.js';
import { processOneTemplateSample } from '../src/media/template-sample-worker.js';
import type { TemplateSampleAdapter } from '../src/media/template-sample-provider.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('approval samples isolate managed connections, scanned assets, encrypted handles, retries and concurrent workers',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const root=await mkdtemp(resolve('.local/template-sample-'));const storage=localMediaStorage(root);
  let clean=true;let scanError=false;let scanHold:Promise<void>|undefined;let scanStarted:(()=>void)|undefined;
  const scanner={ scan:async()=> { scanStarted?.();if (scanHold) await scanHold;if (scanError) throw new Error('Private scanner secret');return { clean,version:'SyntheticScanner/test-only' }; } };
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,mediaStorage:storage,mediaScanner:scanner });
  t.after(async()=> { await app.close();await db.end();await rm(root,{ recursive:true,force:true }); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Sample test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['manager','MANAGER',branch],['second','MANAGER',branch],['other','MANAGER',other],['agent','AGENT',branch],['admin','SUPER_ADMIN',null]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@sample.test'},'synthetic-non-login-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  const connection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Approval samples','CONNECTED','{"graphVersion":"v25.0","wabaId":"123"}'::jsonb) RETURNING id`)[0]!.id;
  const secret=sealSecret(connection,JSON.stringify({ accessToken:'synthetic-sample-token-not-live' }));
  await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag) VALUES (${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
  const headers=(actor='manager')=>({ origin:process.env.APP_ORIGIN!,...(actor ? { cookie:users[actor]!.cookie } : {}) });
  const api=(method:'GET'|'POST',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,headers:headers(actor) });
  let requestNumber=1;const base=`/api/messaging/connections/${connection}/template-samples`;
  const pdf=Buffer.from('%PDF-1.7\nSample only\n%%EOF\n');const clip=await readFile('test-fixtures/media/clip.mp4');
  const upload=(key:string,bytes=pdf,mime='application/pdf',kind='document',actor='manager')=>app.inject({ method:'POST',
    url:base+'?'+new URLSearchParams({ key,mime,kind }),payload:bytes,remoteAddress:`127.0.0.${requestNumber++}`,
    headers:{ ...headers(actor),'content-type':'application/octet-stream' } });
  assert.equal((await upload('anonymous-test',pdf,'application/pdf','document','')).statusCode,401);
  assert.equal((await upload('agent-denied',pdf,'application/pdf','document','agent')).statusCode,403);
  assert.equal((await upload('other-denied',pdf,'application/pdf','document','other')).statusCode,404);
  assert.equal((await upload('bad-type-test',clip)).json().error,'MEDIA_TYPE_MISMATCH');
  assert.equal((await upload('unsupported-audio',pdf,'audio/ogg','audio')).statusCode,400);
  assert.equal((await upload('bad-codec-test',await readFile('test-fixtures/media/mpeg4.mp4'),'video/mp4','video')).json().error,'MEDIA_CODEC_NOT_SUPPORTED');
  assert.equal((await upload('large-image-test',Buffer.alloc(5*1024*1024+1),'image/jpeg','image')).json().error,'MEDIA_PROVIDER_SIZE_INVALID');
  clean=false;assert.equal((await upload('malware-rejected')).statusCode,422);clean=true;
  scanError=true;assert.equal((await upload('scanner-offline')).statusCode,503);scanError=false;
  const concurrent=await Promise.all([upload('same-sample-key'),upload('same-sample-key')]);
  assert.deepEqual(concurrent.map((response)=>response.statusCode).sort(),[200,201]);const sample=concurrent[0]!.json();
  assert.equal(concurrent[1]!.json().id,sample.id);assert.equal(sample.state,'QUEUED');assert.equal(sample.usable,false);
  assert.equal((await upload('same-sample-key',Buffer.from('%PDF-1.7\nChanged\n%%EOF'))).statusCode,409);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='TEMPLATE_SAMPLE_UPLOADED' AND target_id=${sample.id}`)[0]!.n,1);
  const downloadPath=`/api/messaging/template-samples/${sample.id}/download`;
  const downloaded=await api('GET',downloadPath);assert.deepEqual(downloaded.rawPayload,pdf);assert.match(downloaded.headers['content-disposition']!,/^attachment;/);
  for (const [actor,status] of [['agent',403],['other',404]] as const) {
    assert.equal((await api('GET',base,undefined,actor)).statusCode,status);assert.equal((await api('GET',downloadPath,undefined,actor)).statusCode,status);
    assert.equal((await api('GET',`/api/messaging/template-samples/${sample.id}/attempts`,undefined,actor)).statusCode,status);
  }
  let uploads=0;let behavior:'ok'|'retry'|'reject'|'bad-handle'='ok';let hold:Promise<void>|undefined;let started:(()=>void)|undefined;
  const handle='2:synthetic:private-sample-handle';const adapter:TemplateSampleAdapter={ upload:async(input)=> {
    uploads++;started?.();if (hold) await hold;assert.equal(input.credentials.accessToken,'synthetic-sample-token-not-live');
    assert.equal(createHash('sha256').update(input.bytes).digest('hex'),(await db`SELECT content_sha256 FROM messaging_template_sample WHERE id=${sample.id}`)[0]!.content_sha256);
    if (behavior==='retry') throw new MediaError('SAMPLE_PROVIDER_UNAVAILABLE',true);
    if (behavior==='reject') throw new MediaError('SAMPLE_PROVIDER_AUTH_FAILED');
    return { handle:behavior==='bad-handle' ? 'invalid\nsecret' : handle };
  } };
  const work=()=>processOneTemplateSample(db,{ adapter,storage,scanner });
  behavior='retry';assert.equal(await work(),true);assert.equal(uploads,1);
  let row=(await db`SELECT * FROM messaging_template_sample WHERE id=${sample.id}`)[0]!;assert.equal(row.state,'QUEUED');assert.equal(row.retry_count,1);
  assert.equal(await work(),false); // Backoff is enforced, not a hot retry loop.
  await db`UPDATE messaging_template_sample SET available_at=now() WHERE id=${sample.id}`;behavior='reject';await work();
  row=(await db`SELECT * FROM messaging_template_sample WHERE id=${sample.id}`)[0]!;assert.equal(row.state,'FAILED');
  const retryPath=`/api/messaging/template-samples/${sample.id}/retry`;const retryBody={ version:row.version,reason:'Fixed test provider authentication' };
  assert.equal((await api('POST',retryPath,retryBody,'agent')).statusCode,403);assert.equal((await api('POST',retryPath,retryBody,'other')).statusCode,404);
  const retries=await Promise.all([api('POST',retryPath,retryBody),api('POST',retryPath,retryBody)]);assert.deepEqual(retries.map((r)=>r.statusCode).sort(),[200,409]);
  behavior='ok';const workers=await Promise.all([work(),work()]);assert.deepEqual(workers.sort(),[false,true]);assert.equal(uploads,3);
  row=(await db`SELECT * FROM messaging_template_sample WHERE id=${sample.id}`)[0]!;assert.equal(row.state,'READY');assert.equal(row.attempt_count,3);
  assert.equal(openOpaque(`template-sample:${row.id}`,{ ciphertext:row.handle_ciphertext,nonce:row.handle_nonce,authTag:row.handle_auth_tag,keyVersion:row.handle_key_version }),handle);
  assert.ok(!row.handle_ciphertext.toString().includes(handle));assert.equal((await api('POST',retryPath,{ ...retryBody,version:row.version })).statusCode,409);
  const list=(await api('GET',base)).json();assert.equal(list.items[0].usable,true);assert.ok(!JSON.stringify(list).includes(handle));
  const history=(await api('GET',`/api/messaging/template-samples/${sample.id}/attempts?limit=1`)).json();assert.equal(history.items.length,1);assert.ok(history.nextAfter);
  assert.equal((await api('GET',`/api/messaging/template-samples/${sample.id}/attempts?after=${history.nextAfter}&limit=1`)).json().items[0].outcome,'FAILED');
  await assert.rejects(db`UPDATE messaging_template_sample SET content_sha256=${'0'.repeat(64)} WHERE id=${sample.id}`,/TEMPLATE_SAMPLE_IMMUTABLE/);
  await assert.rejects(db`UPDATE messaging_template_sample SET state='QUEUED',handle_ciphertext=NULL,handle_nonce=NULL,handle_auth_tag=NULL,handle_key_version=NULL WHERE id=${sample.id}`,/TEMPLATE_SAMPLE_IMMUTABLE/);
  await db`UPDATE integration_connection SET version=version+1 WHERE id=${connection}`;
  assert.equal((await api('GET',base)).json().items[0].usable,false);
  // Role and connection changes during slow scan/provider I/O are checked again before committing.
  let releaseScan!:()=>void;scanHold=new Promise<void>((resolve)=> { releaseScan=resolve; });
  const scanSeen=new Promise<void>((resolve)=> { scanStarted=resolve; });const uploading=upload('scan-version-race');await scanSeen;
  await db`UPDATE integration_connection SET version=version+1 WHERE id=${connection}`;releaseScan();assert.equal((await uploading).statusCode,409);
  scanHold=undefined;scanStarted=undefined;
  const pending=(await upload('provider-version-race')).json();let release!:()=>void;hold=new Promise<void>((resolve)=> { release=resolve; });
  const seen=new Promise<void>((resolve)=> { started=resolve; });const working=work();await seen;
  await db`UPDATE integration_connection SET version=version+1 WHERE id=${connection}`;release();await working;hold=undefined;started=undefined;
  let pendingRow=(await db`SELECT * FROM messaging_template_sample WHERE id=${pending.id}`)[0]!;assert.equal(pendingRow.state,'FAILED');assert.equal(pendingRow.last_error_code,'SAMPLE_CONNECTION_CHANGED');
  assert.equal(pendingRow.handle_ciphertext,null);
  await api('POST',`/api/messaging/template-samples/${pending.id}/retry`,{ version:pendingRow.version,reason:'Current connection reauthorized for samples' },'second');
  await db`UPDATE user_account SET active=false WHERE id=${users.second!.id}`;const beforeUploads=uploads;await work();assert.equal(uploads,beforeUploads);
  pendingRow=(await db`SELECT * FROM messaging_template_sample WHERE id=${pending.id}`)[0]!;assert.equal(pendingRow.last_error_code,'SAMPLE_REQUESTER_UNAUTHORIZED');
  // Expired leases cannot strand assets and retain attempt numbers.
  await api('POST',`/api/messaging/template-samples/${pending.id}/retry`,{ version:pendingRow.version,reason:'Manager resumes sample processing after review' });
  const lease=randomBytes(16).toString('hex');const leaseId=lease.slice(0,8)+'-'+lease.slice(8,12)+'-'+lease.slice(12,16)+'-'+lease.slice(16,20)+'-'+lease.slice(20);
  await db.begin(async(tx)=> { await tx`UPDATE messaging_template_sample SET state='RUNNING',lease_token=${leaseId},lease_until=now()-interval '1 second',attempt_count=attempt_count+1,retry_count=retry_count+1 WHERE id=${pending.id}`;
    const current=(await tx`SELECT attempt_count,connection_version FROM messaging_template_sample WHERE id=${pending.id}`)[0]!;
    await tx`INSERT INTO template_sample_processing_attempt (sample_id,lease_token,attempt_number,connection_version,outcome)
      VALUES (${pending.id},${leaseId},${current.attempt_count},${current.connection_version},'STARTED')`; });
  await work();assert.equal((await db`SELECT outcome FROM template_sample_processing_attempt WHERE lease_token=${leaseId}`)[0]!.outcome,'LEASE_EXPIRED');
  const exhausted=(await upload('bounded-sample-retry')).json();
  await db`UPDATE messaging_template_sample SET retry_count=4 WHERE id=${exhausted.id}`;behavior='retry';await work();behavior='ok';
  const exhaustedRow=(await db`SELECT state,retry_count,attempt_count FROM messaging_template_sample WHERE id=${exhausted.id}`)[0]!;
  assert.equal(exhaustedRow.state,'FAILED');assert.equal(exhaustedRow.retry_count,5);assert.equal(await work(),false);
  const rescan=(await upload('worker-rescan-rejected')).json();clean=false;const priorUploads=uploads;await work();clean=true;
  assert.equal(uploads,priorUploads);assert.equal((await api('GET',`/api/messaging/template-samples/${rescan.id}/download`)).statusCode,422);
  const tampered=(await upload('storage-integrity-test')).json();const tamperedRow=(await db`SELECT storage_key FROM messaging_template_sample WHERE id=${tampered.id}`)[0]!;
  // Simulate external corruption directly inside this isolated temporary fixture.
  // Production put is idempotent and may correctly reject overwriting different bytes on Windows.
  await writeFile(resolve(root,tamperedRow.storage_key),Buffer.from('%PDF-1.7\nDifferent private bytes\n%%EOF\n'));await work();
  assert.equal(uploads,priorUploads);assert.equal((await db`SELECT last_error_code FROM messaging_template_sample WHERE id=${tampered.id}`)[0]!.last_error_code,'MEDIA_STORAGE_INTEGRITY_FAILED');
  assert.equal((await api('GET',`/api/messaging/template-samples/${tampered.id}/download`)).statusCode,503);
  const shared=(await db`INSERT INTO integration_connection (organization_id,kind,provider,name,status,config)
    VALUES (${org},'MESSAGING','META_WHATSAPP_CLOUD','Shared sample','DISABLED','{"graphVersion":"v25.0","wabaId":"456"}'::jsonb) RETURNING id`)[0]!.id;
  assert.equal((await api('GET',`/api/messaging/connections/${shared}/template-samples`)).statusCode,404);
  assert.equal((await api('GET',`/api/messaging/connections/${shared}/template-samples`,undefined,'admin')).statusCode,200);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5C6WQAAAAASUVORK5CYII=','base64');
  assert.equal((await upload('image-valid-test',png,'image/png','image','admin')).statusCode,201);
  assert.equal((await upload('video-valid-test',clip,'video/mp4','video')).statusCode,201);
  const firstPage=(await api('GET',base+'?limit=1')).json();assert.equal(firstPage.items.length,1);assert.ok(firstPage.nextAfter);
  assert.equal((await api('GET',base+'?limit=1&after='+firstPage.nextAfter)).json().items.length,1);
  await db`UPDATE integration_connection SET status='DISABLED',version=version+1 WHERE id=${connection}`;
  assert.equal((await upload('disabled-connection')).statusCode,409);assert.equal(await work(),false);
  const audit=JSON.stringify(await db`SELECT detail FROM audit_log WHERE action LIKE 'TEMPLATE_SAMPLE%'`);
  assert.ok(!audit.includes(handle));assert.ok(!audit.includes('synthetic-sample-token'));
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM message_attachment`)[0]!.n,0);
});
