import assert from 'node:assert/strict';
import { configuredMediaScanner } from '../src/media/scanner.js';
// The harmless industry antivirus test signature stays in memory, never a saved upload.
const signature = Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=', 'base64');
const scanner = configuredMediaScanner();
const clean = await scanner.scan(Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'));
assert.equal(clean.clean, true);
assert.equal((await scanner.scan(signature)).clean, false);
process.stdout.write(JSON.stringify({ status: 'ok', scannerVersion: clean.version,
  cleanFileAccepted: true, antivirusTestSignatureRejected: true }) + '\n');
