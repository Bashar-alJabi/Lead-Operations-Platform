import type { PaymentReceiptAdapters } from './receipt-provider.js';
import { stripeReceiptAdapter } from './stripe-receipt.js';
export const paymentReceiptAdapters:PaymentReceiptAdapters={ STRIPE:stripeReceiptAdapter };
