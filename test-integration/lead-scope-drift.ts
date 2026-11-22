import type { Database } from '../src/db.js';

// Fault injection for existing tests of stale worker and pinned-source defenses.
// Run only against the isolated integration database with serial test execution.
export async function withSimulatedLeadScopeDrift<T>(db: Database, simulate: () => Promise<T>): Promise<T> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== '/lead_operations_test') throw Error('Isolated TEST_DATABASE_URL required');
  const [database] = await db`SELECT current_database() AS name`;
  if (database?.name !== 'lead_operations_test') throw Error('Unexpected fault-injection database');
  await db`ALTER TABLE lead DISABLE TRIGGER lead_branch_transfer_required`;
  try { return await simulate(); }
  finally { await db`ALTER TABLE lead ENABLE TRIGGER lead_branch_transfer_required`; }
}
