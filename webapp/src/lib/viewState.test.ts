import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESHNESS_UNKNOWN_LABEL } from './format';
import {
  freshnessDisplay,
  GENERIC_LOAD_ERROR,
  resolveErrorMessage,
} from './viewState';

/**
 * Tests for the cross-cutting freshness / error-message helpers (Task 17).
 *
 * Run with: `node --import tsx --test src/lib/viewState.test.ts`
 *
 * Requirements: 4.1 (date + time + explicit time-zone indicator), 4.3/4.4
 * (never a blank/placeholder/cached/invalid timestamp — show "data freshness
 * unknown"). Backs Correctness Property 3 (Freshness accuracy).
 */

test('freshnessDisplay marks a valid ISO-8601 timestamp as known with a UTC indicator', () => {
  const out = freshnessDisplay('2026-07-01T12:00:00Z');
  assert.equal(out.known, true);
  // Requirement 4.1: date + time of day + explicit time-zone indicator.
  assert.match(out.text, /UTC$/);
  assert.equal(out.text, 'Jul 1, 2026, 12:00 UTC');
});

test('freshnessDisplay treats "unknown" as not known', () => {
  const out = freshnessDisplay('unknown');
  assert.equal(out.known, false);
  assert.equal(out.text, FRESHNESS_UNKNOWN_LABEL);
});

test('freshnessDisplay treats null/undefined/empty as not known', () => {
  for (const value of [null, undefined, ''] as const) {
    const out = freshnessDisplay(value);
    assert.equal(out.known, false);
    assert.equal(out.text, FRESHNESS_UNKNOWN_LABEL);
  }
});

test('freshnessDisplay treats an invalid date as not known', () => {
  const out = freshnessDisplay('not-a-date');
  assert.equal(out.known, false);
  assert.equal(out.text, FRESHNESS_UNKNOWN_LABEL);
});

test('freshnessDisplay never returns a blank, raw, or invalid value (Property 3)', () => {
  // A spread of missing/invalid/valid inputs: text is always non-empty and is
  // either a formatted UTC timestamp or the explicit unknown label — never the
  // raw/invalid input and never blank/cached.
  const inputs = ['unknown', '', ' ', 'nonsense', '2026-13-40T99:99:99Z', null, undefined];
  for (const value of inputs) {
    const { known, text } = freshnessDisplay(value as never);
    assert.equal(known, false);
    assert.equal(text, FRESHNESS_UNKNOWN_LABEL);
    assert.notEqual(text.trim(), '');
    assert.notEqual(text, value);
  }
  const valid = freshnessDisplay('2026-01-15T09:30:00Z');
  assert.equal(valid.known, true);
  assert.match(valid.text, / UTC$/);
});

test('resolveErrorMessage uses an ApiRequestError-like message', () => {
  const err = { name: 'ApiRequestError', message: 'Account data is unavailable.' };
  assert.equal(resolveErrorMessage(err, 'fallback'), 'Account data is unavailable.');
});

test('resolveErrorMessage falls back for non-API errors', () => {
  assert.equal(resolveErrorMessage(new Error('boom'), 'fallback'), 'fallback');
  assert.equal(resolveErrorMessage('nope', 'fallback'), 'fallback');
  assert.equal(resolveErrorMessage(undefined, 'fallback'), 'fallback');
  // An ApiRequestError-like value with an empty message falls back too.
  assert.equal(resolveErrorMessage({ name: 'ApiRequestError', message: '' }, 'fallback'), 'fallback');
});

test('resolveErrorMessage default fallback is the generic load error', () => {
  assert.equal(resolveErrorMessage(new Error('boom')), GENERIC_LOAD_ERROR);
});
