import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const root = join(process.cwd(), '.local');
const dataDir = join(root, 'postgres');
const configPath = join(root, 'database.json');
await mkdir(root, { recursive: true });

let config: { user: string; password: string; port: number };
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch {
  config = { user: 'lead_operations', password: randomBytes(32).toString('base64url'), port: 5432 };
  await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
}

const pg = new EmbeddedPostgres({ databaseDir: dataDir, ...config, persistent: true });
let initialized = true;
try { await access(join(dataDir, 'PG_VERSION')); }
catch { initialized = false; }
if (!initialized) await pg.initialise();
await pg.start();
if (!initialized) await pg.createDatabase('lead_operations');
const url = `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:${config.port}/lead_operations`;
await writeFile(join(root, 'database-url'), url, { mode: 0o600 });
process.stdout.write('Local PostgreSQL ready on 127.0.0.1:5432. DATABASE_URL is in .local/database-url (ignored by Git).\n');

async function stop() { await pg.stop(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await new Promise(() => {});
