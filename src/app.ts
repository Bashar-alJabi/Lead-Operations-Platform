import Fastify, { type FastifyInstance,type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { sessionCookie } from './config.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerIdentityEmailRoutes } from './routes/identity-email.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerFieldRoutes } from './routes/fields.js';
import { registerLeadWorkflowRoutes } from './routes/lead-workflow.js';
import { registerLeadViewRoutes } from './routes/lead-views.js';
import { registerMessagingSetupRoutes } from './routes/messaging-setup.js';
import { registerMessagingTestSendRoutes } from './routes/messaging-test-send.js';
import { registerMetaMessagingWebhookRoutes } from './routes/meta-messaging-webhook.js';
import { registerMessagingInboundReviewRoutes } from './routes/messaging-inbound-review.js';
import { registerMessagingAttachmentRoutes } from './routes/messaging-attachments.js';
import type { MediaStorage } from './media/storage.js';
import type { MediaScanner } from './media/scanner.js';
import { registerMessagingTemplateRoutes } from './routes/messaging-templates.js';
import { registerMessagingTemplateSampleRoutes } from './routes/messaging-template-samples.js';
import { registerCampaignTemplateRoutes } from './routes/campaign-templates.js';
import { registerSenderBindingRoutes } from './routes/sender-bindings.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerMessagingConsentRoutes } from './routes/messaging-consent.js';
import { registerMessagingPolicyRoutes } from './routes/messaging-policy.js';
import { registerConversationMessageRoutes } from './routes/conversation-messages.js';
import { registerMessageDeliveryRoutes } from './routes/message-delivery.js';
import { smtpEmailAdapter, type IdentityEmailAdapter } from './identity-email.js';
import type { MessagingProviderAdapter, MessagingSendAdapter } from './messaging/providers.js';
import type { MessagingTemplateAdapter } from './messaging/templates-provider.js';
import { registerMetaSourceRoutes } from './routes/meta-sources.js';
import { registerSourceBindingRoutes } from './routes/source-bindings.js';
import { registerSourceMappingRoutes } from './routes/source-mapping.js';
import type { LeadSourceCatalogAdapter } from './sources/meta-provider.js';
import { registerMetaSourceWebhookRoutes } from './routes/meta-source-webhook.js';
import type { LeadSourceSubscriptionAdapter } from './sources/meta-subscription.js';
import { safeRequestUrl } from './safe-logging.js';
import { registerSourceReviewRoutes } from './routes/source-review.js';
import { registerSourceHistoryRoutes } from './routes/source-history.js';
import { registerPaymentConnectionRoutes } from './routes/payment-connections.js';
import { registerPaymentMethodRoutes } from './routes/payment-methods.js';
import { registerPaymentWebhookRoutes } from './routes/payment-webhooks.js';
import { registerPaymentNotificationRoutes } from './routes/payment-notifications.js';
import type { PaymentAdapterRegistry } from './payments/providers.js';
import { registerPaymentLinkRoutes } from './routes/payment-links.js';
import { registerBankTransferRoutes } from './routes/bank-transfers.js';
import { registerAIConnectionRoutes } from './routes/ai-connections.js';
import type { AIAdapterRegistry } from './ai/providers.js';
import { registerAIKnowledgeRoutes } from './routes/ai-knowledge.js';
import { registerAIKnowledgeAssetRoutes } from './routes/ai-knowledge-assets.js';
import { registerAIQualificationRoutes } from './routes/ai-qualification.js';
import { registerLeadQualificationRoutes } from './routes/lead-qualification.js';
import { registerAIFollowupPolicyRoutes } from './routes/ai-followup-policy.js';
import { registerAIOperationalConfigRoutes } from './routes/ai-operational-config.js';
import { registerAISharedUseRoutes } from './routes/ai-shared-use.js';

export async function buildApp(db: Database, options: { logger?: boolean; emailAdapter?: IdentityEmailAdapter;
  messagingAdapter?: MessagingProviderAdapter; messagingTemplateAdapter?: MessagingTemplateAdapter;
  messagingSendAdapter?: MessagingSendAdapter;
  leadSourceCatalogAdapter?: LeadSourceCatalogAdapter;
  leadSourceSubscriptionAdapter?: LeadSourceSubscriptionAdapter;
  paymentConnectionAdapters?:PaymentAdapterRegistry;
  aiConnectionAdapters?:AIAdapterRegistry;
  mediaStorage?: MediaStorage;
  mediaScanner?: MediaScanner;
  globalRateLimitMax?: number;
  rateLimitKeyGenerator?:(request:FastifyRequest)=>string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.token'],
    serializers:{ req:(request)=>({ method:request.method,url:safeRequestUrl(request.url),remoteAddress:request.ip }) } }, bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, { max: options.globalRateLimitMax ?? 120, timeWindow: '1 minute',
    ...(options.rateLimitKeyGenerator ? { keyGenerator:options.rateLimitKeyGenerator } : {}) });

  app.addHook('onRequest', async (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const allowed = process.env.APP_ORIGIN;
    if ((origin || request.cookies[sessionCookie]) && (!allowed || origin !== allowed)) throw new HttpError(403, 'ORIGIN_DENIED');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) {
      reply.code(429).send({ error: 'RATE_LIMITED' });
      return;
    }
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 413) {
      reply.code(413).send({ error: 'REQUEST_TOO_LARGE' }); return;
    }
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 415) {
      reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' }); return;
    }
    if (error instanceof Error && ('validation' in error || ('statusCode' in error && error.statusCode === 400))) {
      reply.code(400).send({ error: 'INVALID_REQUEST' });
      return;
    }
    request.log.error({ err: error }, 'request failed');
    reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db`SELECT 1`;
    return { status: 'ok' };
  });
  registerAuthRoutes(app, db);
  registerOperationsRoutes(app, db);
  registerContactRoutes(app, db);
  registerFieldRoutes(app, db);
  registerLeadWorkflowRoutes(app, db);
  registerLeadViewRoutes(app, db);
  registerMessagingSetupRoutes(app, db, options.messagingAdapter);
  registerMessagingTestSendRoutes(app, db, options.messagingSendAdapter);
  registerMetaMessagingWebhookRoutes(app, db);
  registerMessagingInboundReviewRoutes(app, db);
  registerMessagingAttachmentRoutes(app, db, options.mediaStorage, options.mediaScanner);
  registerMessagingTemplateRoutes(app, db, options.messagingTemplateAdapter);
  registerMessagingTemplateSampleRoutes(app, db, options.mediaStorage, options.mediaScanner);
  registerCampaignTemplateRoutes(app, db);
  registerSenderBindingRoutes(app, db);
  registerConversationRoutes(app, db);
  registerMessagingConsentRoutes(app, db);
  registerMessagingPolicyRoutes(app, db);
  registerConversationMessageRoutes(app, db);
  registerMessageDeliveryRoutes(app, db);
  registerIdentityEmailRoutes(app, db, options.emailAdapter ?? smtpEmailAdapter);
  registerMetaSourceRoutes(app,db,options.leadSourceCatalogAdapter);
  registerSourceBindingRoutes(app,db);
  registerSourceMappingRoutes(app,db);
  registerMetaSourceWebhookRoutes(app,db,options.leadSourceSubscriptionAdapter);
  registerSourceReviewRoutes(app,db);
  registerSourceHistoryRoutes(app,db);
  registerPaymentConnectionRoutes(app,db,options.paymentConnectionAdapters);
  registerPaymentMethodRoutes(app,db);
  registerPaymentWebhookRoutes(app,db,options.paymentConnectionAdapters);
  registerPaymentNotificationRoutes(app,db);
  registerPaymentLinkRoutes(app,db);
  registerBankTransferRoutes(app,db);
  registerAIConnectionRoutes(app,db,options.aiConnectionAdapters);
  registerAIKnowledgeRoutes(app,db);
  registerAIKnowledgeAssetRoutes(app,db,options.mediaStorage);
  registerAIQualificationRoutes(app,db);
  registerLeadQualificationRoutes(app,db);
  registerAIFollowupPolicyRoutes(app,db);
  registerAIOperationalConfigRoutes(app,db);
  registerAISharedUseRoutes(app,db);
  return app;
}
