import Fastify, { type FastifyInstance } from 'fastify';
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
import { registerSenderBindingRoutes } from './routes/sender-bindings.js';
import { smtpEmailAdapter, type IdentityEmailAdapter } from './identity-email.js';
import type { MessagingProviderAdapter } from './messaging/providers.js';

export async function buildApp(db: Database, options: { logger?: boolean; emailAdapter?: IdentityEmailAdapter;
  messagingAdapter?: MessagingProviderAdapter } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.token'] }, bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

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
  registerSenderBindingRoutes(app, db);
  registerIdentityEmailRoutes(app, db, options.emailAdapter ?? smtpEmailAdapter);
  return app;
}
