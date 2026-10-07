import { HttpError } from '../security.js';
import { stripePaymentEvents } from './providers.js';
export const paypalPaymentEvents=['CHECKOUT.ORDER.APPROVED','PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DECLINED'] as const;
export function paymentWebhookProfile(provider:string) {
  if(provider==='STRIPE')return { path:'stripe',events:[...stripePaymentEvents],endpointPattern:/^we_[A-Za-z0-9]{6,100}$/,eventPattern:/^(\*|[a-z][a-z0-9_.]{1,127})$/,secret:true };
  if(provider==='PAYPAL')return { path:'paypal',events:[...paypalPaymentEvents],endpointPattern:/^[A-Z0-9]{8,64}$/,eventPattern:/^(\*|[A-Z][A-Z0-9_.-]{1,127})$/,secret:false };
  throw new HttpError(409,'PAYMENT_WEBHOOK_UNSUPPORTED');
}
