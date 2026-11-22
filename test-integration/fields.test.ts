import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('TEST_DATABASE_URL must target lead_operations_test');

test('dynamic field definitions, bindings, values, history, and role scope', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE organization CASCADE`; });
  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, payload?: Record<string, unknown>, cookie?: string) => app.inject({
    method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const login = async (email: string) => {
    const response = await send('POST', '/api/auth/login', { email, password: 'Field test password 123!' });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie'];
    return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';')[0]!;
  };
  const bootstrap = await send('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Fields',
    name: 'Owner', email: 'owner@example.test', password: 'Field test password 123!' });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  const admin = await login('owner@example.test');
  const branchA = (await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const branchB = (await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hashed = await passwordHash('Field test password 123!');
  await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${organizationId}, ${branchA}, 'MANAGER', 'Manager A', 'manager-a@example.test', ${hashed}),
      (${organizationId}, ${branchB}, 'MANAGER', 'Manager B', 'manager-b@example.test', ${hashed}),
      (${organizationId}, ${branchA}, 'AGENT', 'Agent A', 'agent-a@example.test', ${hashed})`;
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent-a@example.test');
  const campaign = (await send('POST', '/api/campaigns', { branchId: branchA, name: 'Field campaign', routingMethod: 'ROUND_ROBIN' }, managerA)).json().id as string;
  const agentId = (await db`SELECT id FROM user_account WHERE email = 'agent-a@example.test'`)[0]!.id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/agents`, { agentId }, managerA)).statusCode, 200);
  assert.equal((await send('POST', `/api/campaigns/${campaign}/activate`, undefined, managerA)).statusCode, 200);

  const globalInput = { scope: 'GLOBAL', key: 'company_source', label: 'Company source', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} };
  assert.equal((await send('POST', '/api/fields', globalInput, managerA)).statusCode, 403);
  assert.equal((await send('POST', '/api/fields', globalInput, admin)).statusCode, 201);
  const branchInput = { scope: 'BRANCH', branchId: branchA, key: 'internal_note', label: 'Internal note', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} };
  assert.equal((await send('POST', '/api/fields', branchInput, managerB)).statusCode, 403);
  const branchField = await send('POST', '/api/fields', branchInput, managerA);
  assert.equal(branchField.statusCode, 201, branchField.body);
  assert.equal((await send('POST', '/api/fields', branchInput, managerA)).statusCode, 409);
  assert.ok(!(await send('GET', '/api/fields', undefined, managerB)).json().items.some((item: { id: string }) => item.id === branchField.json().id));
  const scratch = await send('POST', '/api/fields', { ...branchInput, key: 'scratch', label: 'Scratch' }, managerA);
  assert.equal(scratch.statusCode, 201, scratch.body);
  const scratchId = scratch.json().id as string;
  const retyped = await send('PATCH', `/api/fields/${scratchId}`, { version: 1, label: 'Scratch number', options: [], validation: {}, active: true,
    fieldType: 'NUMBER', valueMode: 'MANUAL', calculation: null }, managerA);
  assert.equal(retyped.statusCode, 200, retyped.body);
  assert.equal((await send('PATCH', `/api/fields/${scratchId}`, { version: 1, label: 'Stale', options: [], validation: {}, active: true }, managerA)).statusCode, 409);
  const hiddenId = branchField.json().id as string;
  const selectInput = { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign, key: 'interest', label: 'Interest',
    fieldType: 'SINGLE_SELECT', valueMode: 'MANUAL', options: [{ value: 'high', label: 'High', active: true }], validation: {} };
  const selectField = await send('POST', '/api/fields', selectInput, managerA);
  assert.equal(selectField.statusCode, 201, selectField.body);
  const selectId = selectField.json().id as string;
  const calculationInput = { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign, key: 'lead_age_days', label: 'Lead age',
    fieldType: 'CALCULATED', valueMode: 'CALCULATED', options: [], validation: {}, calculation: { kind: 'LEAD_AGE_DAYS' } };
  const calculatedId = (await send('POST', '/api/fields', calculationInput, managerA)).json().id as string;
  assert.equal((await send('GET', `/api/fields?campaignId=${campaign}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/fields?campaignId=${campaign}`, undefined, agent)).statusCode, 403);
  const binding = { active: true, position: 1, requiredStage: 'NONE', visibleToAgent: true, editableByAgent: true,
    visibleToManager: true, editableByManager: true, showInTable: true, showInDetails: true, filterable: true,
    usableByAutomation: false, usableByAi: false };
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerB)).statusCode, 403);
  const bound = await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerA);
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerA)).statusCode, 409);
  assert.equal((await send('PATCH', `/api/fields/${selectId}`, { version: 1, label: 'Changed type', options: [], validation: {}, active: true,
    fieldType: 'TEXT', valueMode: 'MANUAL', calculation: null }, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${hiddenId}`,
    { ...binding, position: 2, visibleToAgent: false, editableByAgent: false }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${calculatedId}`,
    { ...binding, position: 3, editableByAgent: false, editableByManager: false }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${calculatedId}`, { ...binding, version: 1 }, managerA)).statusCode, 400);

  const lead = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Field lead', phone: '+15550000123' } }, managerA);
  assert.equal(lead.statusCode, 201, lead.body);
  const leadId = lead.json().id as string;
  const agentFields = await send('GET', `/api/leads/${leadId}/fields`, undefined, agent);
  assert.equal(agentFields.statusCode, 200, agentFields.body);
  assert.deepEqual(new Set(agentFields.json().items.map((field: { id: string }) => field.id)), new Set([selectId, calculatedId]));
  const calculated = agentFields.json().items.find((field: { id: string }) => field.id === calculatedId);
  assert.equal(calculated.value, 0);
  assert.equal(calculated.editable, false);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${hiddenId}`, { value: 'Secret' }, agent)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields/${hiddenId}/history`, undefined, agent)).statusCode, 404);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${calculatedId}`, { value: 99 }, managerA)).statusCode, 403);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'invalid' }, agent)).statusCode, 400);
  const firstValue = await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high' }, agent);
  assert.equal(firstValue.statusCode, 200, firstValue.body);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high' }, agent)).statusCode, 409);
  const nextValue = await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: null, version: firstValue.json().version }, agent);
  assert.equal(nextValue.statusCode, 200, nextValue.body);
  const valueRace = await Promise.all([1, 2].map(() => send('PUT', `/api/leads/${leadId}/fields/${selectId}`,
    { value: 'high', version: nextValue.json().version }, agent)));
  assert.deepEqual(valueRace.map((response) => response.statusCode).sort(), [200, 409]);
  const storedSecret = 'Synthetic manager-only value';
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${hiddenId}`, {value:storedSecret}, managerA)).statusCode, 200);
  const table = `/api/leads?campaignId=${campaign}&tableFields=true&limit=1`;
  const ownTable = await send('GET', table, undefined, agent);
  assert.equal(ownTable.statusCode, 200, ownTable.body);
  assert.deepEqual(ownTable.json().tableFields.map((field:{id:string})=>field.id),[selectId,calculatedId]);
  assert.deepEqual(ownTable.json().items[0].tableValues,{[selectId]:'high',[calculatedId]:0});
  assert.ok(!ownTable.body.includes(storedSecret) && !ownTable.body.includes(hiddenId));
  const managerTable = await send('GET', table, undefined, managerA);
  assert.equal(managerTable.json().items[0].tableValues[hiddenId],storedSecret);
  const outsideTable = await send('GET', table, undefined, managerB);
  assert.deepEqual(outsideTable.json(),{items:[],tableFields:[],nextCursor:null});
  const onlyCalculated = await send('GET',table+'&fieldColumn='+calculatedId,undefined,agent);
  assert.deepEqual(onlyCalculated.json().items[0].tableValues,{[calculatedId]:0});
  const selected = await send('GET',table+'&fieldColumn='+selectId+'&fieldColumn='+calculatedId,undefined,agent);
  assert.deepEqual(selected.json().items[0].tableValues,{[selectId]:'high',[calculatedId]:0});
  const disallowed = await send('GET',table+'&fieldColumn='+hiddenId,undefined,agent);
  assert.deepEqual(disallowed.json().tableFields,[]);
  assert.ok(!disallowed.body.includes(hiddenId));
  const view={name:'Current campaign columns',scope:'PERSONAL',filters:{campaignId:campaign},columns:['contact'],fieldColumns:[selectId]};
  const storedView = await send('POST','/api/lead-views',view,agent);
  assert.equal(storedView.statusCode,201,storedView.body);
  assert.equal((await send('POST','/api/lead-views',{...view,name:'Hidden',fieldColumns:[hiddenId]},agent)).statusCode,404);
  assert.equal((await send('POST','/api/lead-views',{...view,name:'No campaign',filters:{}},agent)).statusCode,400);
  assert.deepEqual((await send('GET','/api/lead-views',undefined,agent)).json().items[0].fieldColumns,[selectId]);
  const zeroColumns=await send('POST','/api/lead-views',{...view,name:'Static columns only',fieldColumns:[]},agent);
  assert.equal(zeroColumns.statusCode,201,zeroColumns.body);
  assert.deepEqual((await send('GET','/api/lead-views/'+zeroColumns.json().id,undefined,agent)).json().fieldColumns,[]);
  const filterView=await send('POST','/api/lead-views',{...view,name:'Permitted answer filter',
    filters:{campaignId:campaign,fieldId:selectId,fieldValue:'"high"'}},agent);
  assert.equal(filterView.statusCode,201,filterView.body);
  await db`UPDATE campaign_field SET show_in_table=false WHERE campaign_id=${campaign} AND field_id=${selectId}`;
  const afterPolicyChange = await send('GET', table, undefined, agent);
  assert.deepEqual(afterPolicyChange.json().tableFields.map((field:{id:string})=>field.id),[calculatedId]);
  assert.ok(!afterPolicyChange.body.includes(selectId));
  const maskedView = await send('GET','/api/lead-views',undefined,agent);
  assert.deepEqual(maskedView.json().items.find((item:{id:string})=>item.id===storedView.json().id).fieldColumns,[]);
  await db`UPDATE campaign_field SET visible_to_agent=false,editable_by_agent=false WHERE campaign_id=${campaign} AND field_id=${selectId}`;
  const deniedView=await send('GET','/api/lead-views',undefined,agent);
  const restricted=deniedView.json().items.find((item:{id:string})=>item.id===filterView.json().id);
  assert.deepEqual(restricted.filters,{campaignId:campaign});
  assert.equal(restricted.fieldFilterUnavailable,true);
  assert.ok(!deniedView.body.includes(selectId) && !deniedView.body.includes('high'));
  const filterViewPath='/api/lead-views/'+filterView.json().id;
  const currentView=await send('GET',filterViewPath,undefined,agent);
  assert.equal(currentView.statusCode,200,currentView.body);
  assert.deepEqual(currentView.json(),restricted);
  assert.equal((await send('GET',filterViewPath,undefined,managerB)).statusCode,404);
  await db`UPDATE campaign_field SET show_in_table=true,visible_to_agent=true,editable_by_agent=true WHERE campaign_id=${campaign} AND field_id=${selectId}`;
  const history = await send('GET', `/api/leads/${leadId}/fields/${selectId}/history?limit=1`, undefined, agent);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items.length, 1);
  assert.ok(history.json().nextCursor);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields/${selectId}/history?limit=1&cursor=${history.json().nextCursor}`, undefined, agent)).json().items.length, 1);
  assert.equal((await send('PATCH', `/api/fields/${selectId}`, { version: 1, label: 'Interest', options: [{ value: 'low', label: 'Low', active: true }],
    validation: {}, active: true }, managerA)).statusCode, 409);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high', version: nextValue.json().version }, managerB)).statusCode, 404);
  assert.equal((await db`SELECT count(*)::integer AS count FROM field_value_history WHERE lead_id = ${leadId} AND field_id = ${selectId}`)[0]!.count, 3);

  const required = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
    key: 'registration_code', label: 'Registration code', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: { minLength: 3 } }, managerA);
  assert.equal(required.statusCode, 201, required.body);
  const requiredId = required.json().id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${requiredId}`,
    { ...binding, position: 4, requiredStage: 'LEAD_CREATION' }, managerA)).statusCode, 200);
  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Missing required', phone: '+15550000124' } }, managerA)).statusCode, 409);
  const populated = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Populated', phone: '+15550000124' }, fields: [{ fieldId: requiredId, value: 'ABC' }] }, managerA);
  assert.equal(populated.statusCode, 201, populated.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id = ${populated.json().id} AND field_id = ${requiredId}`)[0]!.value, 'ABC');
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${requiredId}`, { value: 'x' }, agent)).statusCode, 400);
  const emailCandidate = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Email candidate', email: 'fields-review@example.test' }, fields: [{ fieldId: requiredId, value: 'EMAIL' }] }, managerA);
  assert.equal(emailCandidate.statusCode, 201, emailCandidate.body);
  const review = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Ambiguous fields', phone: '+15550000124', email: 'fields-review@example.test' },
    fields: [{ fieldId: requiredId, value: 'REVIEW' }] }, managerA);
  assert.equal(review.statusCode, 202, review.body);
  const reviewContactId = (await db`SELECT contact_id FROM lead WHERE id = ${populated.json().id}`)[0]!.contact_id as string;
  const reviewed = await send('POST', `/api/contact-reviews/${review.json().reviewId}/resolve`, { contactId: reviewContactId }, managerA);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id = ${reviewed.json().id} AND field_id = ${requiredId}`)[0]!.value, 'REVIEW');

  const closeRequired = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
    key: 'outcome', label: 'Outcome', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} }, managerA);
  const closeId = closeRequired.json().id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${closeId}`,
    { ...binding, position: 5, requiredStage: 'CLOSE' }, managerA)).statusCode, 200);
  assert.equal((await send('POST', `/api/leads/${leadId}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${closeId}`, { value: 'Qualified' }, agent)).statusCode, 200);
  assert.equal((await send('POST', `/api/leads/${leadId}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${closeId}`, { value: null, version: 1 }, agent)).statusCode, 409);

  const metricIds: Record<string, string> = {};
  for (const [key, kind] of [['ai_attempts','AI_CONTACT_ATTEMPTS'], ['human_attempts','HUMAN_CONTACT_ATTEMPTS'],
    ['human_response_seconds','HUMAN_RESPONSE_SECONDS'], ['first_human','FIRST_HUMAN_CONTACT_AT']] as const) {
    const created = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
      key, label: key, fieldType: 'CALCULATED', valueMode: 'CALCULATED', options: [], validation: {}, calculation: { kind } }, managerA);
    assert.equal(created.statusCode, 201, created.body);
    metricIds[key] = created.json().id;
    assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${metricIds[key]}`,
      { ...binding, position: 10, editableByAgent: false, editableByManager: false }, managerA)).statusCode, 200);
  }
  const connection = await db`INSERT INTO integration_connection (organization_id, branch_id, kind, provider, name, status)
    VALUES (${organizationId}, ${branchA}, 'MESSAGING', 'FAKE', 'Test', 'CONNECTED') RETURNING id`;
  const sender = await db`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${organizationId}, ${connection[0]!.id}, 'test-sender', 'Test sender') RETURNING id`;
  const conversation = await db`INSERT INTO conversation (lead_id, connection_id, sender_id, channel, participant_ref, controller_type,
    controller_user_id, state) VALUES (${leadId}, ${connection[0]!.id}, ${sender[0]!.id}, 'TEST', 'participant', 'HUMAN', ${agentId}, 'HUMAN_ACTIVE') RETURNING id`;
  const base = Date.now();
  const firstAi = new Date(base - 3 * 3600_000);
  const firstHuman = new Date(base - 2 * 3600_000);
  const inbound = new Date(base - 3600_000);
  const reply = new Date(base - 3000_000);
  // Isolated pre-148 historical fixture: legacy records remain readable without retroactive action receipts.
  // Transactional DDL restores the one new INSERT guard even on rollback; every other guard remains active.
  await db.begin(async tx => {
    await tx`ALTER TABLE conversation_message DISABLE TRIGGER ai_send_message_guard`;
    await tx`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state,sent_at)
      VALUES(${conversation[0]!.id},${connection[0]!.id},${sender[0]!.id},'OUTBOUND','AI','Legacy AI initial','SENT',${firstAi})`;
    await tx`ALTER TABLE conversation_message ENABLE TRIGGER ai_send_message_guard`;
  });
  await assert.rejects(db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state)
    VALUES(${conversation[0]!.id},${connection[0]!.id},${sender[0]!.id},'OUTBOUND','AI','Unproven new send','QUEUED')`, /FRESH_MESSAGE_PROOF_REQUIRED/);
  await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id, direction, author_type,
      author_user_id, body, delivery_state, sent_at)
    VALUES (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'OUTBOUND', 'HUMAN', ${agentId}, 'Human initial', 'SENT', ${firstHuman}),
      (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'OUTBOUND', 'HUMAN', ${agentId}, 'Human reply', 'SENT', ${reply})`;
  await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id, direction, author_type, body, delivery_state, received_at)
    VALUES (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'INBOUND', 'CUSTOMER', 'Question', 'RECEIVED', ${inbound})`;
  const metrics = (await send('GET', `/api/leads/${leadId}/fields`, undefined, agent)).json().items;
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.ai_attempts).value, 1);
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.human_attempts).value, 2);
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.human_response_seconds).value, 600);
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.first_human).value, firstHuman.toISOString());

  const withoutMessages=await send('POST','/api/leads',{branchId:branchA,campaignId:campaign,
    contact:{name:'No contact yet',phone:'+15550000193'},fields:[{fieldId:requiredId,value:'REVIEW'}]},managerA);
  assert.equal(withoutMessages.statusCode,201,withoutMessages.body);
  const filtered=(fieldId:string,value:unknown)=>new URLSearchParams({
    campaignId:campaign,fieldId,fieldValue:JSON.stringify(value),
  }).toString();
  const responses=filtered(metricIds.human_response_seconds!,600);
  const query=await send('GET','/api/leads?tableFields=true&limit=1&'+responses,undefined,agent);
  assert.equal(query.statusCode,200,query.body);
  assert.deepEqual(query.json().items.map((item:{id:string})=>item.id),[leadId]);
  assert.equal(query.json().items[0].tableValues[metricIds.human_response_seconds!],600);
  assert.equal(query.json().nextCursor,null);
  const noResponse=await send('GET','/api/leads?'+filtered(metricIds.human_response_seconds!,0),undefined,managerA);
  assert.deepEqual(noResponse.json().items,[]);
  const zeroAttempts=await send('GET','/api/leads?limit=1&'+filtered(metricIds.human_attempts!,0),undefined,managerA);
  assert.equal(zeroAttempts.statusCode,200,zeroAttempts.body);
  assert.equal(zeroAttempts.json().items[0].id,withoutMessages.json().id);
  const time=await send('GET','/api/leads?'+filtered(metricIds.first_human!,firstHuman.toISOString().replace('Z','+00:00')),undefined,managerA);
  assert.equal(time.statusCode,200,time.body);
  assert.deepEqual(time.json().items.map((item:{id:string})=>item.id),[leadId]);
  for (const value of [-1,0.5,'600',null]) {
    assert.equal((await send('GET','/api/leads?'+filtered(metricIds.human_response_seconds!,value),undefined,agent)).statusCode,400);
  }
  const cohort=await send('GET','/api/analytics/leads?metric=ALL&'+responses,undefined,agent);
  assert.equal(cohort.statusCode,200,cohort.body);
  assert.deepEqual(cohort.json().items.map((item:{id:string})=>item.id),[leadId]);
  assert.equal((await send('GET','/api/leads?'+responses,undefined,managerB)).statusCode,404);
  const savedCalculation=await send('POST','/api/lead-views',{...view,name:'Response seconds',
    filters:Object.fromEntries(new URLSearchParams(responses)),fieldColumns:[metricIds.human_response_seconds]},agent);
  assert.equal(savedCalculation.statusCode,201,savedCalculation.body);
  await db`UPDATE campaign_field SET visible_to_agent=false WHERE campaign_id=${campaign} AND field_id=${metricIds.human_response_seconds!}`;
  const hiddenCalculation=await send('GET','/api/lead-views/'+savedCalculation.json().id,undefined,agent);
  assert.deepEqual(hiddenCalculation.json().filters,{campaignId:campaign});
  assert.equal(hiddenCalculation.json().fieldFilterUnavailable,true);
  assert.equal((await send('GET','/api/analytics/leads?metric=ALL&'+responses,undefined,agent)).statusCode,404);
  const catalog=await send('GET',`/api/campaigns/${campaign}/filter-fields`,undefined,agent);
  assert.ok(!catalog.body.includes(metricIds.human_response_seconds!));
  assert.equal(catalog.json().items.find((item:{id:string})=>item.id===metricIds.first_human).filter_type,'DATETIME');

  await db`WITH extra AS (
    INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type)
    SELECT ${organizationId},${branchA},${campaign},'table_extra_'||n,'Table extra '||n,'TEXT' FROM generate_series(1,28) n
    RETURNING id
  ) INSERT INTO campaign_field(campaign_id,field_id,position,show_in_table,visible_to_agent)
    SELECT ${campaign},id,100,true,true FROM extra`;
  const catalogPath=`/api/campaigns/${campaign}/table-fields`;
  const firstColumns=await send('GET',catalogPath,undefined,agent);
  const nextColumns=await send('GET',catalogPath+'?after='+firstColumns.json().nextAfter,undefined,agent);
  assert.equal(firstColumns.statusCode,200,firstColumns.body);
  assert.equal(firstColumns.json().items.length,25);
  assert.equal(nextColumns.statusCode,200,nextColumns.body);
  assert.ok(nextColumns.json().items.length>0);
  assert.equal(nextColumns.json().nextAfter,null);
  assert.ok(nextColumns.json().items.every((item:{id:string})=>!firstColumns.json().items.some((first:{id:string})=>first.id===item.id)));
  assert.deepEqual((await send('GET',catalogPath,undefined,managerB)).json().items,[]);
});
