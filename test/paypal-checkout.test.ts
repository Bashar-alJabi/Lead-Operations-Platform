import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentCheckoutAdapters,type CheckoutIntent } from '../src/payments/checkout-provider.js';
import { paymentMoney } from '../src/payments/money.js';
import { paymentIssuanceOptions,paypalCurrencies } from '../src/payments/issuance-profile.js';
import { syntheticPayPalFinancialTransport } from './paypal-financial-fixture.js';
test('PayPal issuance uses configured expectation without inventing merchant capabilities and requires exact configuration',()=> {
  const options=paymentIssuanceOptions('PAYPAL',{ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },{},1);
  assert.equal(options.accountRef,'ABCD234EFGH56');assert.equal('chargesEnabled' in options,false);assert.equal('country' in options,false);
  assert.equal('beneficiaryVerification' in options && options.beneficiaryVerification,'CONFIGURED_EXPECTATION');assert.deepEqual(options.currencies,paypalCurrencies);
  assert.throws(()=>paymentIssuanceOptions('PAYPAL',{ mode:'TEST' },{},1),/PAYMENT_BENEFICIARY_REQUIRED/);
  assert.throws(()=>paymentIssuanceOptions('STRIPE',{ mode:'TEST' },{},1),/PAYMENT_OPTIONS_REQUIRED/);
});
test('Registered PayPal checkout preserves unknown expiry and confirms only independent order and capture reads, never creation response',async(t)=> {
  const transport=syntheticPayPalFinancialTransport();t.mock.method(globalThis,'fetch',transport.fetch);
  const adapter=paymentCheckoutAdapters.PAYPAL!;const config={ mode:'TEST' as const,expectedMerchantId:'ABCD234EFGH56' };
  const credentials={ clientId:'SyntheticFinancialClient123',clientSecret:'SyntheticFinancialSecret123' };
  const intent:CheckoutIntent={ id:'a2066d41-c5d6-423a-87ea-d56a10a6a67a',accountRef:config.expectedMerchantId,name:'Expected payment',
    money:paymentMoney('25','USD',adapter.currencyPrecision('USD')),successUrl:'https://platform.test/?paymentReturn=success',cancelUrl:'https://platform.test/?paymentReturn=cancel' };
  const issued=await adapter.create(config,credentials,intent);assert.equal(issued.expiresAt,null);assert.equal(issued.paymentStatus,'UNPAID');assert.equal(issued.paymentRef,null);
  assert.equal(transport.captureKeys.length,0);const o=transport.orders.get(intent.id)!;o.status='COMPLETED';
  const retry=await adapter.create(config,credentials,intent);assert.equal(retry.status,'COMPLETE');assert.equal(retry.paymentStatus,'UNPAID');assert.equal(retry.providerEvidence,undefined);
  const trusted=await adapter.retrieve(config,credentials,intent,o.id,o.captureId);assert.equal(trusted.paymentStatus,'PAID');assert.equal(trusted.paymentRef,o.captureId);
  assert.equal(trusted.providerEvidence?.merchantId,intent.accountRef);assert.equal(trusted.providerEvidence?.source,'INDEPENDENT_ORDER_CAPTURE_READ');
  assert.equal(JSON.stringify(trusted).includes('fixture PII'),false);
  await assert.rejects(adapter.retrieve(config,credentials,intent,o.id),/PAYMENT_CAPTURE_MISMATCH/);
  await assert.rejects(adapter.retrieve(config,credentials,intent,o.id,'FOREIGNCAPTURE'),/PAYMENT_CAPTURE_MISMATCH/);
  o.captureStatus='PENDING';assert.equal((await adapter.retrieve(config,credentials,intent,o.id,o.captureId)).paymentStatus,'UNPAID');
});
