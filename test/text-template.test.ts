import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextTemplate, parseCallToActionButtons, textHeaderParameterCount, renderTextHeader, validHeaderExample,
  urlParameterCount,renderTemplateUrl,renderTemplateButtons,validUrlExample } from '../src/messaging/approved-template.js';
import { metaTemplateAdapter } from '../src/messaging/templates-provider.js';
import { metaWhatsAppSendAdapter } from '../src/messaging/providers.js';
test('one text-template parser preserves every supported component and rejects duplicates and unknown semantics',()=> {
  const parts=[{ type:'HEADER',format:'TEXT',text:'A <b>literal</b> title' },{ type:'BODY',text:'Dear {{1}}',example:{ body_text:[['SECRET EXAMPLE']] } },
    { type:'FOOTER',text:'Closing line' }];
  const parsed=parseTextTemplate(parts)!;
  assert.equal(parsed.parameterCount,1);assert.equal(parsed.preview,'A <b>literal</b> title\n\nDear {{1}}\n\nClosing line');
  assert.ok(!JSON.stringify(parsed.components).includes('SECRET EXAMPLE'));
  for (const invalid of [[...parts,parts[0]],[parts[1],parts[1]],[parts[0],parts[0],parts[1]],parts.slice(0,1),[null,parts[1]],
    [{ type:'BODY',text:{ invalid:'not text' } }],[{ type:'BODY',text:'Invalid {{2}}' }],
    [parts[1],{ type:'BUTTONS',buttons:[] }],[{ ...parts[0],format:'IMAGE' },parts[1]],
    [{ ...parts[0],text:'{{2}}' },parts[1]],[parts[1],{ type:'FOOTER',text:'{{1}}' }],
    [{ ...parts[0],text:'x'.repeat(61) },parts[1]],[parts[1],{ type:'FOOTER',text:'x'.repeat(61) }],
    [parts[1],{ type:'FOOTER',text:'Line\nBreak' }]]) assert.equal(parseTextTemplate(invalid),null);
  assert.deepEqual(parseTextTemplate([parts[2],parts[1],parts[0]])?.components,parsed.components);
  assert.deepEqual(parseTextTemplate([{ type:'BODY',text:'Original body' }])?.components,[{ type:'BODY',text:'Original body' }]);
});

test('TEXT HEADER allows one independent parameter with bounded approval and rendered values',()=> {
  assert.equal(textHeaderParameterCount('Welcome {{1}}'),1);assert.equal(textHeaderParameterCount('Welcome'),0);
  for (const invalid of ['{{2}}','{{1}} and {{1}}','{{1}','Hello\nCustomer','x'.repeat(61)]) assert.equal(textHeaderParameterCount(invalid),null);
  assert.equal(renderTextHeader('Welcome {{1}}','Alice'),'Welcome Alice');
  assert.equal(renderTextHeader('Welcome {{1}}'),null);assert.equal(renderTextHeader('Welcome','Unexpected'),null);
  assert.equal(renderTextHeader('x'.repeat(55)+'{{1}}','1234567890'),null);
  assert.equal(validHeaderExample(undefined,'Orphan'),false);assert.equal(validHeaderExample('Welcome {{1}}',' '),false);
  const parsed=parseTextTemplate([{ type:'HEADER',format:'TEXT',text:'Welcome {{1}}',example:{ header_text:['SECRET APPROVAL'] } },
    { type:'BODY',text:'Order {{1}}' }])!;
  assert.equal(parsed.headerParameterCount,1);assert.equal(parsed.parameterCount,1);
  assert.ok(!JSON.stringify(parsed).includes('SECRET APPROVAL'));
});

test('Meta separates HEADER and BODY approval examples and sends independent text parameter components',async(t)=> {
  const original=globalThis.fetch;t.after(()=> { globalThis.fetch=original; });let calls=0;
  globalThis.fetch=async(url,options)=> {
    calls++;const value=JSON.parse(options!.body as string);
    if (String(url).endsWith('/message_templates')) {
      assert.deepEqual(value.components,[{ type:'HEADER',format:'TEXT',text:'Welcome {{1}}',example:{ header_text:['Approval Alice'] } },
        { type:'BODY',text:'Order {{1}}',example:{ body_text:[['Approval Order']] } }]);
      return Response.json({ id:'12345',status:'PENDING',category:'UTILITY' });
    }
    assert.deepEqual(value.template.components,[{ type:'header',parameters:[{ type:'text',text:'Alice Header' }] },
      { type:'body',parameters:[{ type:'text',text:'Order Body' }] }]);
    return Response.json({ messages:[{ id:'wamid.header-body' }] });
  };
  const config={ wabaId:'123',graphVersion:'v25.0' };const credentials={ accessToken:'test',appSecret:'test',verifyToken:'test' };
  const input={ name:'header_notice',language:'en_US',category:'UTILITY' as const,header:'Welcome {{1}}',headerExample:'Approval Alice',
    body:'Order {{1}}',examples:['Approval Order'] };
  await metaTemplateAdapter.create(config,credentials,input);
  await metaWhatsAppSendAdapter.sendTemplate!({ config,credentials,externalSenderId:'12345',recipient:'+15550002222',
    templateName:input.name,templateLanguage:input.language,headerParameter:'Alice Header',bodyParameters:['Order Body'] });
  await assert.rejects(metaTemplateAdapter.create(config,credentials,{ ...input,header:'Static' }),/TEMPLATE_INPUT_INVALID/);
  await assert.rejects(metaWhatsAppSendAdapter.sendTemplate!({ config,credentials,externalSenderId:'12345',recipient:'+15550002222',
    templateName:input.name,templateLanguage:input.language,headerParameter:'\n' }),/PROVIDER_TEMPLATE_INVALID/);
  assert.equal(calls,2);
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

test('static template CTA validates safe targets, preserves canonical history and submits approved button shapes',async(t)=> {
  const buttons=[{ type:'URL' as const,text:'Visit site',url:'https://example.test/offer' },
    { type:'PHONE_NUMBER' as const,text:'Call us',phone_number:'+15550007777' }];
  assert.deepEqual(parseCallToActionButtons(buttons),buttons);
  for (const url of ['javascript:alert(1)','http://example.test','https://user:secret@example.test','https://example.test/{{1}}/extra','https://example.test/line\nbreak',
    'https://example.test/'+'x'.repeat(2000)])
    assert.equal(parseCallToActionButtons([{ ...buttons[0],url }]),null);
  for (const value of [[],[buttons[0],buttons[0]],[{ type:'QUICK_REPLY',text:'Reply' }],[{ ...buttons[1],phone_number:'bad' }],
    [{ ...buttons[1],phone_number:'+15550007777\n' }],[{ ...buttons[0],text:'x'.repeat(26) }]]) assert.equal(parseCallToActionButtons(value),null);
  const parsed=parseTextTemplate([{ type:'BODY',text:'CTA body' },{ type:'BUTTONS',buttons }])!;
  assert.equal(parsed.components.length,2);assert.deepEqual(parsed.buttons,buttons);assert.match(parsed.preview,/Visit site: https:\/\/example.test\/offer/);
  const original=globalThis.fetch;t.after(()=> { globalThis.fetch=original; });let calls=0;
  globalThis.fetch=async(_url,options)=> { calls++;const value=JSON.parse(options!.body as string);
    assert.deepEqual(value.components,[{ type:'BODY',text:'CTA body' },{ type:'BUTTONS',buttons }]);
    return Response.json({ id:'12345',status:'PENDING',category:'UTILITY' }); };
  const config={ wabaId:'123',graphVersion:'v25.0' };const credentials={ accessToken:'test',appSecret:'test',verifyToken:'test' };
  const input={ name:'cta_notice',language:'en_US',category:'UTILITY' as const,body:'CTA body',buttons };
  await metaTemplateAdapter.create(config,credentials,input);
  await assert.rejects(metaTemplateAdapter.create(config,credentials,{ ...input,buttons:[{ type:'URL',text:'Visit site',url:'javascript:alert(1)' }] }),/TEMPLATE_INPUT_INVALID/);
  assert.equal(calls,1);
});

test('dynamic template URL binds one final suffix to a fixed HTTPS origin and strips approval samples',()=> {
  const url='https://example.test/orders/{{1}}';
  assert.equal(urlParameterCount(url),1);assert.equal(urlParameterCount('https://example.test/static'),0);
  for (const invalid of ['https://example.test/{{2}}','https://example.test/{{1}}/tail','https://example.test/{{1}}{{1}}',
    'https://example.{{1}}','https://example.test:{{1}}','https://user:secret@example.test/{{1}}','https://example.test/\\{{1}}',
    'https://example.test/%{{1}}','https://example.test/%0a/{{1}}','http://example.test/{{1}}'])
    assert.equal(urlParameterCount(invalid),null,invalid);
  assert.equal(renderTemplateUrl(url,'orders/123?source=crm'),'https://example.test/orders/orders/123?source=crm');
  assert.equal(renderTemplateUrl('https://example.test/?order={{1}}','ABC%2F123'),'https://example.test/?order=ABC%2F123');
  for (const invalid of [undefined,'',' ','a b','\n','\\evil','https://other.test','//other.test','{{1}}','a%0d','a%00','a%7f','%ZZ','x'.repeat(2000)])
    assert.equal(renderTemplateUrl(url,invalid),null,String(invalid));
  assert.equal(renderTemplateUrl('https://example.test/static','Orphan'),null);
  const buttons=[{ type:'PHONE_NUMBER' as const,text:'Call',phone_number:'+15550007777' },{ type:'URL' as const,text:'Order',url }];
  const parsed=parseTextTemplate([{ type:'BODY',text:'Order {{1}}' },{ type:'BUTTONS',buttons:[buttons[0],{ ...buttons[1],example:['SECRET URL EXAMPLE'] }] }])!;
  assert.equal(parsed.urlParameterIndex,1);assert.equal(parsed.parameterCount,1);
  assert.ok(!JSON.stringify(parsed).includes('SECRET URL EXAMPLE'));
  assert.deepEqual(renderTemplateButtons(parsed.buttons,'123'),[buttons[0],{ ...buttons[1],url:'https://example.test/orders/123' }]);
  assert.equal(validUrlExample(buttons),false);assert.equal(validUrlExample(buttons,'123'),true);
  assert.equal(validUrlExample(undefined,'Orphan'),false);
});

test('Meta dynamic URL approval uses a rendered sample while dispatch sends only the suffix at its original button index',async(t)=> {
  const original=globalThis.fetch;t.after(()=> { globalThis.fetch=original; });let calls=0;
  const config={ wabaId:'123',graphVersion:'v25.0' };const credentials={ accessToken:'test',appSecret:'test',verifyToken:'test' };
  const buttons=[{ type:'PHONE_NUMBER' as const,text:'Call',phone_number:'+15550007777' },
    { type:'URL' as const,text:'Order',url:'https://example.test/order/{{1}}' }];
  globalThis.fetch=async(url,options)=> {
    calls++;const value=JSON.parse(options!.body as string);
    if (String(url).endsWith('/message_templates')) {
      assert.deepEqual(value.components,[{ type:'BODY',text:'Fixed body' },{ type:'BUTTONS',buttons:[buttons[0],
        { ...buttons[1],example:['https://example.test/order/approval-only'] }] }]);
      return Response.json({ id:'12345',status:'PENDING',category:'UTILITY' });
    }
    assert.deepEqual(value.template.components,[{ type:'header',parameters:[{ type:'text',text:'Header Value' }] },
      { type:'body',parameters:[{ type:'text',text:'Body Value' }] },
      { type:'button',sub_type:'url',index:'1',parameters:[{ type:'text',text:'send-only' }] }]);
    return Response.json({ messages:[{ id:'wamid.url-template' }] });
  };
  const input={ name:'url_notice',language:'en_US',category:'UTILITY' as const,body:'Fixed body',buttons,urlExample:'approval-only' };
  await metaTemplateAdapter.create(config,credentials,input);
  const send={ config,credentials,externalSenderId:'12345',recipient:'+15550002222',templateName:input.name,templateLanguage:input.language,
    headerParameter:'Header Value',bodyParameters:['Body Value'],urlButton:{ index:1,suffix:'send-only' } };
  await metaWhatsAppSendAdapter.sendTemplate!(send);
  for (const urlExample of [undefined,'https://other.test','bad value'])
    await assert.rejects(metaTemplateAdapter.create(config,credentials,{ ...input,urlExample }),/TEMPLATE_INPUT_INVALID/);
  await assert.rejects(metaTemplateAdapter.create(config,credentials,{ ...input,buttons:[buttons[0]!] }),/TEMPLATE_INPUT_INVALID/);
  for (const urlButton of [{ index:2,suffix:'abc' },{ index:0.5,suffix:'abc' },{ index:1,suffix:'https://other.test' },{ index:1,suffix:'%0a' }])
    await assert.rejects(metaWhatsAppSendAdapter.sendTemplate!({ ...send,urlButton }),/PROVIDER_TEMPLATE_INVALID/);
  assert.equal(calls,2);
});
