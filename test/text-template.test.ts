import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextTemplate } from '../src/messaging/approved-template.js';
import { metaTemplateAdapter } from '../src/messaging/templates-provider.js';
test('one text-template parser preserves every supported component and rejects duplicates and unknown semantics',()=> {
  const parts=[{ type:'HEADER',format:'TEXT',text:'A <b>literal</b> title' },{ type:'BODY',text:'Dear {{1}}',example:{ body_text:[['SECRET EXAMPLE']] } },
    { type:'FOOTER',text:'Closing line' }];
  const parsed=parseTextTemplate(parts)!;
  assert.equal(parsed.parameterCount,1);assert.equal(parsed.preview,'A <b>literal</b> title\n\nDear {{1}}\n\nClosing line');
  assert.ok(!JSON.stringify(parsed.components).includes('SECRET EXAMPLE'));
  for (const invalid of [[...parts,parts[0]],[parts[1],parts[1]],[parts[0],parts[0],parts[1]],parts.slice(0,1),[{ type:'BODY',text:'Invalid {{2}}' }],
    [parts[1],{ type:'BUTTONS',buttons:[] }],[{ ...parts[0],format:'IMAGE' },parts[1]],
    [{ ...parts[0],text:'{{1}}' },parts[1]],[parts[1],{ type:'FOOTER',text:'{{1}}' }],
    [{ ...parts[0],text:'x'.repeat(61) },parts[1]],[parts[1],{ type:'FOOTER',text:'x'.repeat(61) }],
    [parts[1],{ type:'FOOTER',text:'Line\nBreak' }]]) assert.equal(parseTextTemplate(invalid),null);
  assert.deepEqual(parseTextTemplate([parts[2],parts[1],parts[0]])?.components,parsed.components);
  assert.deepEqual(parseTextTemplate([{ type:'BODY',text:'Original body' }])?.components,[{ type:'BODY',text:'Original body' }]);
});
test('Meta creation submits static HEADER/BODY/FOOTER with body-only examples and keeps pending approval',async(t)=> {
  const original=globalThis.fetch;t.after(()=> { globalThis.fetch=original; });let calls=0;
  globalThis.fetch=async(_url,options)=> {
    calls++;const value=JSON.parse(options!.body as string);
    assert.deepEqual(value.components,[{ type:'HEADER',format:'TEXT',text:'Welcome' },
      { type:'BODY',text:'Dear {{1}}',example:{ body_text:[['Alice']] } },{ type:'FOOTER',text:'Closing line' }]);
    return Response.json({ id:'12345',status:'PENDING',category:'UTILITY' });
  };
  const config={ wabaId:'123',graphVersion:'v25.0' };const credentials={ accessToken:'test',appSecret:'test',verifyToken:'test' };
  const input={ name:'composite_notice',language:'en_US',category:'UTILITY' as const,header:'Welcome',body:'Dear {{1}}',
    footer:'Closing line',examples:['Alice'] };
  const created=await metaTemplateAdapter.create(config,credentials,input);assert.equal(created.status,'PENDING');
  assert.equal(parseTextTemplate(created.components)?.parameterCount,1);
  await assert.rejects(metaTemplateAdapter.create(config,credentials,{ ...input,header:'{{1}}' }),/TEMPLATE_INPUT_INVALID/);
  assert.equal(calls,1);
});
