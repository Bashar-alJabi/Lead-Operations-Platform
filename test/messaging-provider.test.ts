import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaWhatsAppSendAdapter, ProviderSendError } from '../src/messaging/providers.js';
import { metaTemplateAdapter, TemplateProviderError } from '../src/messaging/templates-provider.js';

const input = { config: { wabaId: '1234567890', graphVersion: 'v25.0' },
  credentials: { accessToken: 'sandbox-only-token', appSecret: 'sandbox-secret', verifyToken: 'verify-token' },
  externalSenderId: '15550001111', recipient: '+15550002222', body: 'Hello' };

test('Meta text adapter sends the documented shape and classifies unambiguous and unknown failures', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://graph.facebook.com/v25.0/15550001111/messages');
      assert.equal(options?.method, 'POST');
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer sandbox-only-token');
      assert.deepEqual(JSON.parse(String(options?.body)), { messaging_product: 'whatsapp',
        recipient_type: 'individual', to: '15550002222', type: 'text',
        text: { preview_url: false, body: 'Hello' } });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 });
    };
    assert.equal((await metaWhatsAppSendAdapter.sendText(input)).providerMessageId, 'wamid.test');
    globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '15' } });
    await assert.rejects(metaWhatsAppSendAdapter.sendText(input), (error) =>
      error instanceof ProviderSendError && error.kind === 'RETRYABLE' && error.retryAfterSeconds === 15);
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    await assert.rejects(metaWhatsAppSendAdapter.sendText(input), (error) =>
      error instanceof ProviderSendError && error.kind === 'UNKNOWN');
    globalThis.fetch = async () => { throw new Error('network with secret sandbox-only-token'); };
    await assert.rejects(metaWhatsAppSendAdapter.sendText(input), (error) =>
      error instanceof ProviderSendError && error.kind === 'UNKNOWN' && !error.message.includes('sandbox-only-token'));
  } finally { globalThis.fetch = original; }
});

test('Meta template adapter paginates catalog and creates a static text template without leaking credentials', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer sandbox-only-token');
      assert.equal(new URL(String(url)).pathname, '/v25.0/1234567890/message_templates');
      if (options?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(options.body)), { name: 'notice', language: 'en_US',
          category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello' }] });
        return new Response(JSON.stringify({ id: '123', status: 'PENDING', category: 'UTILITY' }), { status: 200 });
      }
      if (calls === 1) return new Response(JSON.stringify({ data: [{ id: '1', name: 'notice',
        language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello' }] }],
        paging: { next: 'second', cursors: { after: 'cursor-1' } } }), { status: 200 });
      assert.equal(new URL(String(url)).searchParams.get('after'), 'cursor-1');
      return new Response(JSON.stringify({ data: [{ id: '2', name: 'notice_fr',
        language: 'fr', status: 'PENDING', category: 'MARKETING', components: [] }] }), { status: 200 });
    };
    const templates = await metaTemplateAdapter.list(input.config, input.credentials);
    assert.equal(templates.length, 2);
    assert.equal(templates[0]!.status, 'APPROVED');
    assert.equal((await metaTemplateAdapter.create(input.config, input.credentials,
      { name: 'notice', language: 'en_US', category: 'UTILITY', body: 'Hello' })).status, 'PENDING');
    globalThis.fetch = async () => new Response('{}', { status: 400 });
    await assert.rejects(metaTemplateAdapter.create(input.config, input.credentials,
      { name: 'notice', language: 'en_US', category: 'UTILITY', body: 'Hello' }),
    (error) => error instanceof TemplateProviderError && error.kind === 'REJECTED');
    globalThis.fetch = async () => { throw new Error('sandbox-only-token'); };
    await assert.rejects(metaTemplateAdapter.create(input.config, input.credentials,
      { name: 'notice', language: 'en_US', category: 'UTILITY', body: 'Hello' }),
    (error) => error instanceof TemplateProviderError && error.kind === 'UNKNOWN'
      && !error.message.includes('sandbox-only-token'));
  } finally { globalThis.fetch = original; }
});
