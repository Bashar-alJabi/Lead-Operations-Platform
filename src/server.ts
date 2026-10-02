import { buildApp } from './app.js';
import { createDatabase } from './db.js';

const db = createDatabase();
const app = await buildApp(db);
try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await db.end();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
  });
}
