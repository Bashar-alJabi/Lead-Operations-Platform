import postgres from 'postgres';
import { requiredEnv } from './config.js';

export type Database = ReturnType<typeof postgres>;

export function createDatabase(url = requiredEnv('DATABASE_URL')): Database {
  return postgres(url, {
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
  });
}
