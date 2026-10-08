import { HttpError } from '../security.js';
import { almaHostedAdapter,almaReadEvidence,type AlmaHostedIntent,type AlmaHostedSnapshot } from './alma-hosted.js';
import type { CheckoutIntent,CheckoutSnapshot,PaymentCheckoutAdapter } from './checkout-provider.js';
import { almaEligibilityMoney } from './eligibility.js';

function hostedIntent(intent:CheckoutIntent):AlmaHostedIntent {
  if(!intent.plan || !intent.ipnUrl)throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  return { ...intent,plan:intent.plan,ipnUrl:intent.ipnUrl };
}
function accepted(payment:AlmaHostedSnapshot):CheckoutSnapshot {
  // Creation acknowledgement is always UNPAID; only an independent read can supply financial evidence.
  return { sessionId:payment.paymentId,url:payment.customerUrl,expiresAt:null,mode:payment.mode,currency:payment.currency,minor:payment.minor,intentId:payment.intentId,
    status:payment.processingStatus==='canceled' ? 'EXPIRED' : payment.customerUrl ? 'OPEN' : 'COMPLETE',paymentStatus:'UNPAID',paymentRef:null };
}
// Not activated in the production registry until native confirmation and the Lead flow are complete.
export const almaCheckoutAdapter:PaymentCheckoutAdapter={ writeReplay:'NEVER',idempotencyRetentionMs:null,dispatchBudgetMs:30000,
  currencyPrecision(currency) { almaEligibilityMoney('1',currency);return { scale:2,quantum:'1' }; },
  async create(config,credentials,intent,admit) {
    return accepted(await almaHostedAdapter.create(config,credentials,hostedIntent(intent),admit!));
  },
  async retrieve(config,credentials,intent,sessionId) {
    const payment=await almaHostedAdapter.retrieve(config,credentials,hostedIntent(intent),sessionId);
    const result=accepted(payment);const evidence=almaReadEvidence(payment);
    return { ...result,paymentStatus:evidence.paymentStatus,paymentRef:evidence.paymentStatus==='PAID' ? evidence.paymentId : null,providerEvidence:evidence };
  },
};
