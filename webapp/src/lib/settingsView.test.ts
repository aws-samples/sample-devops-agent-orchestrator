import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_HISTORY_MAX_RETENTION_DAYS,
  CHAT_HISTORY_MIN_RETENTION_DAYS,
} from '@devops-observatory/shared-types';
import { validateRetentionDays } from './settingsView';

/**
 * Tests for the Admin Settings retention validation (feature: chat history as
 * memory, admin-configurable retention).
 *
 * Run with: `node --import tsx --test src/lib/settingsView.test.ts`
 */

test('accepts an in-range whole number of days', () => {
  const res = validateRetentionDays('14');
  assert.deepEqual(res, { ok: true, days: 14 });
});

test('accepts the inclusive bounds', () => {
  assert.equal(validateRetentionDays(String(CHAT_HISTORY_MIN_RETENTION_DAYS)).ok, true);
  assert.equal(validateRetentionDays(String(CHAT_HISTORY_MAX_RETENTION_DAYS)).ok, true);
});

test('rejects values above the maximum retention window', () => {
  const res = validateRetentionDays(String(CHAT_HISTORY_MAX_RETENTION_DAYS + 1));
  assert.equal(res.ok, false);
});

test('rejects zero / below minimum', () => {
  assert.equal(validateRetentionDays('0').ok, false);
});

test('rejects empty and non-integer input', () => {
  assert.equal(validateRetentionDays('').ok, false);
  assert.equal(validateRetentionDays('  ').ok, false);
  assert.equal(validateRetentionDays('7.5').ok, false);
  assert.equal(validateRetentionDays('abc').ok, false);
  assert.equal(validateRetentionDays('-3').ok, false);
});
