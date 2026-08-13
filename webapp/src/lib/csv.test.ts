import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, stringifyCsv } from './csv';

/**
 * Tests for the RFC-4180 CSV encode/parse used by the Context_Manager bulk
 * import/export (feature: batch-edit account context via spreadsheet).
 *
 * Run with: `node --import tsx --test src/lib/csv.test.ts`
 */

test('stringifyCsv quotes fields containing commas, quotes, and newlines', () => {
  const csv = stringifyCsv([
    ['account_id', 'context'],
    ['111', 'plain'],
    ['222', 'has, comma'],
    ['333', 'has "quote"'],
    ['444', 'has\nnewline'],
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'account_id,context');
  assert.equal(lines[1], '111,plain');
  assert.equal(lines[2], '222,"has, comma"');
  assert.equal(lines[3], '333,"has ""quote"""');
  // The newline field keeps its embedded newline inside the quotes.
  assert.ok(csv.includes('"has\nnewline"'));
});

test('parseCsv round-trips values with commas, quotes, and newlines', () => {
  const rows = [
    ['account_id', 'display_name', 'business_unit', 'context'],
    ['345678901234', 'Payments Prod', 'Payments Platform', 'Prod, owned by team; note "A"\nsecond line'],
    ['111111111111', '', '', ''],
  ];
  const parsed = parseCsv(stringifyCsv(rows));
  assert.deepEqual(parsed, rows);
});

test('parseCsv handles both CRLF and LF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseCsv('a,b\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('parseCsv ignores a single trailing newline (no phantom empty row)', () => {
  assert.deepEqual(parseCsv('a,b\r\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']]);
});

test('parseCsv preserves empty fields', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv(',,'), [['', '', '']]);
});

test('parseCsv returns [] for empty input', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsv handles a quoted field with an embedded comma and CRLF', () => {
  assert.deepEqual(parseCsv('"a,1","b\r\n2"'), [['a,1', 'b\r\n2']]);
});
