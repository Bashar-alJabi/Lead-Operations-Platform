import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/db.js';

export async function migrate(): Promise<void> {
  const db = createDatabase();
  try {
    await db`CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir('migrations')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const existing = await db`SELECT 1 FROM schema_migration WHERE version = ${file}`;
      if (existing.length) continue;
      const source = await readFile(join('migrations', file), 'utf8');
      const statements = source.split(';').map((statement) => statement.trim()).filter(Boolean);
      await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(82944601)`;
        const raced = await tx`SELECT 1 FROM schema_migration WHERE version = ${file}`;
        if (raced.length) return;
        for (const statement of statements) await tx.unsafe(statement);
        await tx`INSERT INTO schema_migration (version) VALUES (${file})`;
      });
      process.stdout.write(`Applied ${file}\n`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrate().catch((error) => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
}
