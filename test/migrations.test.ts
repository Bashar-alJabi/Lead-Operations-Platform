import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitStatements } from '../scripts/migrate.js';

test('migration splitter preserves quoted semicolons and PostgreSQL function bodies', () => {
  const sql = `-- a comment with ;\nCREATE FUNCTION test() RETURNS text LANGUAGE plpgsql AS $$
  BEGIN RETURN 'a;b'; END;
  $$;
  /* another ; comment */ SELECT ';';`;
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0]!, /BEGIN RETURN 'a;b'; END;/);
  assert.match(statements[1]!, /SELECT ';'/);
  assert.throws(() => splitStatements('SELECT $$unterminated;'), /UNTERMINATED_MIGRATION_SQL/);
});
