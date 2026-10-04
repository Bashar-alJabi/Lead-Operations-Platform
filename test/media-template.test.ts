import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextTemplate,validTemplateMedia,type TemplateMediaKind } from '../src/messaging/approved-template.js';
import { metaTemplateAdapter,safeTemplateCatalogComponents } from '../src/messaging/templates-provider.js';
import { metaWhatsAppSendAdapter } from '../src/messaging/providers.js';
test('media template headers canonicalize approval references, bind scanned snapshots and send provider media ids independently',async()=> {
  const original=globalThis.fetch;const requests:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=> { const body=JSON.parse(init!.body as string);requests.push(body);
    return body.messaging_product ? Response.json({ messages:[{ id:'wamid.test-media-template' }] }) : Response.json({ id:'888',status:'PENDING',category:'UTILITY' }); };
  const config={ graphVersion:'v25.0',wabaId:'123' };const credentials={ accessToken:'synthetic-not-live',appSecret:'test-only',verifyToken:'test-only' };
  const common={ config,credentials,externalSenderId:'555',recipient:'+15550006666',templateName:'media_notice',templateLanguage:'en_US' };
  try {
    for (const kind of ['image','video','document'] as TemplateMediaKind[]) {
      const format=kind.toUpperCase() as 'IMAGE'|'VIDEO'|'DOCUMENT';
      const raw=[{ type:'HEADER',format,example:{ header_handle:['2:private:approval-handle'] } },{ type:'BODY',text:'Hello {{1}}' },{ type:'FOOTER',text:'Footer' }];
      const parsed=parseTextTemplate(raw)!;assert.equal(parsed.headerMediaKind,kind);assert.equal(parsed.headerParameterCount,0);
      assert.deepEqual(parsed.components[0],{ type:'HEADER',format });assert.ok(!JSON.stringify(parsed).includes('approval-handle'));
      assert.ok(!JSON.stringify(safeTemplateCatalogComponents(raw)).includes('approval-handle'));
      const mime=kind==='image' ? 'image/png' : kind==='video' ? 'video/mp4' : 'application/pdf';
      const media={ attachmentId:'11111111-2222-3333-4444-555555555555',kind,mime,sha256:'a'.repeat(64),sizeBytes:1234 };
      assert.equal(validTemplateMedia(kind,media),true);assert.equal(validTemplateMedia(kind),false);assert.equal(validTemplateMedia(null,media),false);
      assert.equal(validTemplateMedia(kind,{ ...media,sha256:'wrong' }),false);assert.equal(validTemplateMedia(kind,{ ...media,mime:'text/html' }),false);
      assert.equal(validTemplateMedia(kind,{ ...media,sizeBytes:0 }),false);
      await metaTemplateAdapter.create(config,credentials,{ name:'media_notice',language:'en_US',category:'UTILITY',body:'Hello {{1}}',examples:['Approval body'],
        mediaHeader:{ format,handle:'2:private:approval-handle' } });
      assert.deepEqual((requests.at(-1)!.components as unknown[])[0],{ type:'HEADER',format,example:{ header_handle:['2:private:approval-handle'] } });
      await metaWhatsAppSendAdapter.sendTemplate!({ ...common,bodyParameters:['Customer body'],mediaHeader:{ kind,providerMediaId:'777',filename:'customer-file.pdf' } });
      const template=requests.at(-1)!.template as { components:unknown[] };
      assert.deepEqual(template.components[0],{ type:'header',parameters:[{ type:kind,[kind]:{ id:'777',...(kind==='document' ? { filename:'customer-file.pdf' } : {}) } }] });
      assert.deepEqual(template.components[1],{ type:'body',parameters:[{ type:'text',text:'Customer body' }] });
      assert.ok(!JSON.stringify(requests.at(-1)).includes('approval-handle'));
    }
    assert.equal(parseTextTemplate([{ type:'HEADER',format:'LOCATION' },{ type:'BODY',text:'Unsupported' }]),null);
    assert.equal(parseTextTemplate([{ type:'HEADER',format:'IMAGE',text:'Cannot be text and media' },{ type:'BODY',text:'Invalid' }]),null);
    const before=requests.length;
    await assert.rejects(metaTemplateAdapter.create(config,credentials,{ name:'bad',language:'en_US',category:'UTILITY',body:'Invalid',header:'Wrong text',
      mediaHeader:{ format:'IMAGE',handle:'2:private:approval-handle' } }),/TEMPLATE_INPUT_INVALID/);
    await assert.rejects(metaWhatsAppSendAdapter.sendTemplate!({ ...common,headerParameter:'Wrong text',mediaHeader:{ kind:'image',providerMediaId:'777',filename:'image.png' } }),/PROVIDER_TEMPLATE_INVALID/);
    await assert.rejects(metaWhatsAppSendAdapter.sendTemplate!({ ...common,mediaHeader:{ kind:'image',providerMediaId:'https://evil.test',filename:'image.png' } }),/PROVIDER_TEMPLATE_INVALID/);
    assert.equal(requests.length,before);
  } finally { globalThis.fetch=original; }
});
