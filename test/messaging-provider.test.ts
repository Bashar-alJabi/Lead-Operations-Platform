import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaWhatsAppSendAdapter, ProviderSendError } from '../src/messaging/providers.js';

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
