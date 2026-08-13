import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRESHNESS_UNKNOWN_LABEL,
  formatLastSync,
  formatMetric,
  formatNullableMetric,
  isFreshnessKnown,
  UNKNOWN_METRIC_LABEL,
} from './format';

/**
 * Tests for the presentation helpers used by the Summary landing view (Task 11).
 *
 * Run with: `node --import tsx --test src/lib/format.test.ts`
 *
 * Requirements: 4.3/4.4 (never show a stale/blank timestamp — "data freshness
 * unknown"), 11.1 (landing metrics + Last_Sync_Date).
 */

test('formatLastSync returns the unknown label for "unknown"', () => {
  assert.equal(formatLastSync('unknown'), FRESHNESS_UNKNOWN_LABEL);
});

test('formatLastSync returns the unknown label for empty/null/undefined', () => {
  assert.equal(formatLastSync(''), FRESHNESS_UNKNOWN_LABEL);
  assert.equal(formatLastSync(null), FRESHNESS_UNKNOWN_LABEL);
  assert.equal(formatLastSync(undefined), FRESHNESS_UNKNOWN_LABEL);
});

test('formatLastSync returns the unknown label for an unparseable value', () => {
  assert.equal(formatLastSync('not-a-date'), FRESHNESS_UNKNOWN_LABEL);
});

test('formatLastSync formats a valid ISO-8601 timestamp in UTC', () => {
  const out = formatLastSync('2026-07-01T12:00:00Z');
  assert.notEqual(out, FRESHNESS_UNKNOWN_LABEL);
  // Stable, locale-independent UTC formatting.
  assert.equal(out, 'Jul 1, 2026, 12:00 UTC');
});

test('isFreshnessKnown reflects whether the value is displayable', () => {
  assert.equal(isFreshnessKnown('2026-07-01T12:00:00Z'), true);
  assert.equal(isFreshnessKnown('unknown'), false);
  assert.equal(isFreshnessKnown('nonsense'), false);
});

test('formatMetric adds thousands separators and coerces to a safe integer', () => {
  assert.equal(formatMetric(0), '0');
  assert.equal(formatMetric(9), '9');
  assert.equal(formatMetric(1234), '1,234');
  assert.equal(formatMetric(1234567), '1,234,567');
  assert.equal(formatMetric(Number.NaN), '0');
});

test('formatNullableMetric renders unknown (null) as the unknown marker, never 0', () => {
  // null = the collector could not retrieve the metric; showing 0 would
  // misalign the UI with the backend.
  assert.equal(formatNullableMetric(null), UNKNOWN_METRIC_LABEL);
  // Known values format exactly like formatMetric — including a true 0.
  assert.equal(formatNullableMetric(0), '0');
  assert.equal(formatNullableMetric(1234), '1,234');
});
