import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node check-receipt.mjs /path/to/fixture');
const { parseReceiptId, formatReceiptId } = await import(pathToFileURL(resolve(fixture, 'src', 'receipts.mjs')).href);

assert.equal(parseReceiptId('RCPT-1999-00001'), null);
assert.equal(parseReceiptId('RCPT-2100-00001'), null);
assert.deepEqual(parseReceiptId('RCPT-2026-00421'), { year: 2026, serial: 421 });
assert.equal(parseReceiptId('RCPT-2026-421'), null);
assert.equal(formatReceiptId(2026, 421), 'RCPT-2026-00421');
