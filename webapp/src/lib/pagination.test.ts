import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PAGE_SIZE, paginate } from './pagination';

/**
 * Tests for the client-side pagination helper (Requirements 3.9, 5.12).
 *
 * Run with: `node --import tsx --test src/lib/pagination.test.ts`
 */

const items = Array.from({ length: 57 }, (_, i) => i + 1);

test('paginate returns the first page with correct metadata', () => {
  const p = paginate(items, 1, 25);
  assert.deepEqual(p.items, items.slice(0, 25));
  assert.equal(p.page, 1);
  assert.equal(p.totalItems, 57);
  assert.equal(p.totalPages, 3);
  assert.equal(p.hasPrev, false);
  assert.equal(p.hasNext, true);
  assert.equal(p.startIndex, 1);
  assert.equal(p.endIndex, 25);
});

test('paginate returns a middle page', () => {
  const p = paginate(items, 2, 25);
  assert.deepEqual(p.items, items.slice(25, 50));
  assert.equal(p.hasPrev, true);
  assert.equal(p.hasNext, true);
  assert.equal(p.startIndex, 26);
  assert.equal(p.endIndex, 50);
});

test('paginate returns the last (partial) page', () => {
  const p = paginate(items, 3, 25);
  assert.deepEqual(p.items, items.slice(50));
  assert.equal(p.items.length, 7);
  assert.equal(p.hasNext, false);
  assert.equal(p.endIndex, 57);
});

test('paginate clamps an out-of-range page to the last page', () => {
  const p = paginate(items, 99, 25);
  assert.equal(p.page, 3);
  assert.deepEqual(p.items, items.slice(50));
});

test('paginate clamps a non-positive page to the first page', () => {
  assert.equal(paginate(items, 0, 25).page, 1);
  assert.equal(paginate(items, -3, 25).page, 1);
});

test('paginate falls back to the default page size for a non-positive size', () => {
  const p = paginate(items, 1, 0);
  assert.equal(p.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(p.items.length, Math.min(DEFAULT_PAGE_SIZE, items.length));
});

test('paginate handles an empty list with a single empty page', () => {
  const p = paginate([], 1, 25);
  assert.deepEqual(p.items, []);
  assert.equal(p.totalPages, 1);
  assert.equal(p.totalItems, 0);
  assert.equal(p.hasPrev, false);
  assert.equal(p.hasNext, false);
  assert.equal(p.startIndex, 0);
  assert.equal(p.endIndex, 0);
});
