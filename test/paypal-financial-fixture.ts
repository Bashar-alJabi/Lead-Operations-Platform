import type { PayPalCaptureStatus } from '../src/payments/paypal-orders.js';
export type SyntheticPayPalOrder={ id:string;intentId:string;merchantId:string;currency:string;amount:string;
  status:'PAYER_ACTION_REQUIRED'|'APPROVED'|'COMPLETED';captureId:string;captureStatus:PayPalCaptureStatus };
// Synthetic transport only. Production imports neither this fixture nor its credentials/certificate.
export function syntheticPayPalFinancialTransport() {
  const orders=new Map<string,SyntheticPayPalOrder>();const orderKeys:string[]=[];const captureKeys:string[]=[];
  let captureFailure:'NONE'|'UNKNOWN'|'RATE'|'REJECTED'='NONE';let readFailure=false;
  let gate:((order:SyntheticPayPalOrder)=>Promise<void>)|null=null;
  function captureResource(o:SyntheticPayPalOrder) { return { id:o.captureId,status:o.captureStatus,final_capture:true,
    amount:{ currency_code:o.currency,value:o.amount },payee:{ merchant_id:o.merchantId },supplementary_data:{ related_ids:{ order_id:o.id } } }; }
  function orderResource(o:SyntheticPayPalOrder) { return { id:o.id,status:o.status,intent:'CAPTURE',purchase_units:[{ reference_id:o.intentId,custom_id:o.intentId,
    amount:{ currency_code:o.currency,value:o.amount },payee:{ merchant_id:o.merchantId },...(o.status==='COMPLETED' ? { payments:{ captures:[captureResource(o)] } } : {}) }],
    links:[{ rel:'payer-action',method:'GET',href:'https://www.sandbox.paypal.com/checkoutnow?token='+o.id }],payer:{ private:'fixture PII must be omitted' } }; }
  const fetcher:typeof fetch=async(target,init)=> {
    const url=String(target);if(!url.startsWith('https://api-m.sandbox.paypal.com/'))throw new Error('Unexpected non-sandbox provider HTTP');
    if(url.endsWith('/v1/oauth2/token'))return Response.json({ access_token:'SyntheticFinancialAccessToken123',token_type:'Bearer',app_id:'APP-Synthetic123',expires_in:3600 });
    const path=new URL(url).pathname;
    if(init?.method==='POST' && path==='/v2/checkout/orders') {
      const body=JSON.parse(String(init.body));const unit=body.purchase_units[0];const id='O'+unit.custom_id.replaceAll('-','').toUpperCase();
      orderKeys.push((init.headers as Record<string,string>)['PayPal-Request-Id']!);
      if(!orders.has(unit.custom_id))orders.set(unit.custom_id,{ id,intentId:unit.custom_id,merchantId:unit.payee.merchant_id,currency:unit.amount.currency_code,
        amount:unit.amount.value,status:'PAYER_ACTION_REQUIRED',captureId:'C'+unit.custom_id.replaceAll('-','').toUpperCase(),captureStatus:'COMPLETED' });
      return Response.json(orderResource(orders.get(unit.custom_id)!));
    }
    const o=[...orders.values()].find((entry)=>path.includes(entry.id) || path.includes(entry.captureId));if(!o)throw new Error('Unknown synthetic financial resource');
    if(init?.method==='POST' && path===`/v2/checkout/orders/${o.id}/capture`) {
      captureKeys.push((init.headers as Record<string,string>)['PayPal-Request-Id']!);if(gate)await gate(o);
      if(captureFailure==='RATE')return Response.json({ name:'RATE_LIMIT_REACHED' },{ status:429,headers:{ 'retry-after':'1' } });
      if(captureFailure==='REJECTED')return Response.json({ name:'UNPROCESSABLE_ENTITY' },{ status:422 });
      o.status='COMPLETED';if(captureFailure==='UNKNOWN')throw new Error('Synthetic connection lost after financial write');return Response.json(orderResource(o));
    }
    if(readFailure)return Response.json({ name:'AUTHENTICATION_FAILURE' },{ status:401 });
    if(path===`/v2/checkout/orders/${o.id}`)return Response.json(orderResource(o));
    if(path===`/v2/payments/captures/${o.captureId}`)return Response.json(captureResource(o));
    throw new Error('Unexpected synthetic financial path');
  };
  return { orders,orderKeys,captureKeys,fetch:fetcher,orderResource,captureResource,
    setCaptureFailure(value:typeof captureFailure){ captureFailure=value; },setReadFailure(value:boolean){ readFailure=value; },setGate(value:typeof gate){ gate=value; } };
}
