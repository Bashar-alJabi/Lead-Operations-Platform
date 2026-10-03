import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/db.js';

export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollar: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (dollar) {
      if (source.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i))?.[0];
      if (tag) { dollar = tag; i += tag.length - 1; continue; }
    }
    if (char === ';') { const statement = source.slice(start, i).trim();
      if (statement) statements.push(statement); start = i + 1; }
  }
  if (quote || dollar || blockComment) throw new Error('UNTERMINATED_MIGRATION_SQL');
  const last = source.slice(start).trim();
  if (last) statements.push(last);
  return statements;
}

export async function migrate(): Promise<void> {
  const db = createDatabase();
  try {
    await db`CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir('migrations')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const existing = await db`SELECT 1 FROM schema_migration WHERE version = ${file}`;
      if (existing.length) continue;
      const source = await readFile(join('migrations', file), 'utf8');
      const statements = splitStatements(source);
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
