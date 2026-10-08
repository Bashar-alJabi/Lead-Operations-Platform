import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { bankMoney,bankText,parseBankSettlement } from '../src/payments/bank-transfer.js';
const key='SyntheticBankFeedOnly'.repeat(3);
const now=Date.parse('2026-10-08T12:00:00Z');
const event={ eventId:'evt-1',transactionId:'bank-1',mode:'TEST',accountIdentifier:'SYNTHETIC-ACCOUNT',reference:'BT-'+'A'.repeat(32),amount:'10',currency:'EUR',settledAt:'2026-10-08T11:59:00Z',status:'SETTLED' };
function signed(body:object,at=now) { const raw=Buffer.from(JSON.stringify(body)),t=Math.floor(at/1000).toString();return { raw,header:`t=${t},v1=${createHmac('sha256',key).update(t+'.').update(raw).digest('hex')}` }; }
test('Bank money is exact and currency precision does not allow floats or excess fractions',()=> {
  assert.equal(bankMoney('10','EUR').amount,'10.00');assert.equal(bankMoney('100','JPY').minor,'100');assert.equal(bankMoney('1.234','KWD').minor,'1234');
  for(const [amount,currency] of [['1.001','EUR'],['1.1','JPY'],['1e3','EUR'],['0','EUR'],['-1','EUR'],['1','XYZ']])assert.throws(()=>bankMoney(amount!,currency!));
  assert.equal(bankText(' verified bank reference '),'verified bank reference');assert.throws(()=>bankText('a\nb'));
});
test('Bank feed verifies raw signature, clock window and strict settled evidence; claims and extra fields fail',()=> {
  const p=signed(event);assert.equal(parseBankSettlement(p.raw,p.header,key,now).minor,'1000');
  assert.throws(()=>parseBankSettlement(p.raw,p.header+'0',key,now));assert.throws(()=>parseBankSettlement(Buffer.from('{}'),p.header,key,now));
  assert.throws(()=>parseBankSettlement(p.raw,p.header,key,now+301_000));assert.throws(()=>parseBankSettlement(p.raw,p.header,key+'wrong',now));
  for(const change of [{ status:'PENDING' },{ settledAt:'2030-01-01T00:00:00Z' },{ customerPaid:true },{ eventId:'   ' },{ accountIdentifier:'A\nB' },{ currency:'eur' },{ amount:'10.001' }]) {
    const s=signed({ ...event,...change });assert.throws(()=>parseBankSettlement(s.raw,s.header,key,now));
  }
});
