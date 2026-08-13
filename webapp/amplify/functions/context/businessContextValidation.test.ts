import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORG_SYSTEM_PROMPT_MAX_LENGTH } from '@devops-observatory/shared-types';
import {
  ACCOUNT_CONTEXT_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  validateBusinessContext,
  type ValidationResult,
} from '../shared/businessContextValidation';

/**
 * Tests for the `business_context.json` validator (Task 5.1).
 *
 * Requirements: 5.1 (BU name non-empty, 1–128 chars), 5.2 (display name 1–128,
 * description ≤1024), 5.7 (every referenced account must exist in the manifest;
 * unrecognized accounts are rejected with an issue that identifies the account).
 */

const MANIFEST_ACCOUNTS = ['345678901234', '111111111111', '222222222222'];

/** Convenience: assert the result is invalid and return its issues. */
function issuesOf(result: ValidationResult) {
  assert.equal(result.valid, false);
  return result.valid ? [] : result.issues;
}

// ---------------------------------------------------------------------------
// Valid context (happy path)
// ---------------------------------------------------------------------------

test('accepts a well-formed context and normalizes it (Req 5.1, 5.2)', () => {
  const result = validateBusinessContext(
    {
      version: 1,
      updatedAt: 'ignored-by-validator',
      businessUnits: [
        { name: 'Payments Platform', description: 'Prod payments', accounts: ['345678901234'] },
      ],
      accountDisplayNames: { '345678901234': 'Payments Prod' },
    },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.context.businessUnits.length, 1);
  assert.equal(result.context.businessUnits[0]?.name, 'Payments Platform');
  assert.deepEqual(result.context.businessUnits[0]?.accounts, ['345678901234']);
  assert.equal(result.context.accountDisplayNames['345678901234'], 'Payments Prod');
  // updatedAt is stamped by the caller, not the validator.
  assert.equal(result.context.updatedAt, '');
});

test('accepts an empty/omitted context as a valid empty context', () => {
  const result = validateBusinessContext({}, MANIFEST_ACCOUNTS);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.context.businessUnits, []);
  assert.deepEqual(result.context.accountDisplayNames, {});
  assert.equal(result.context.version, 1);
});

test('rejects a non-object input', () => {
  assert.equal(validateBusinessContext(null, MANIFEST_ACCOUNTS).valid, false);
  assert.equal(validateBusinessContext('nope', MANIFEST_ACCOUNTS).valid, false);
  assert.equal(validateBusinessContext([], MANIFEST_ACCOUNTS).valid, false);
});

// ---------------------------------------------------------------------------
// Business_Unit name bounds (Req 5.1)
// ---------------------------------------------------------------------------

test('rejects an empty Business_Unit name (Req 5.1)', () => {
  const result = validateBusinessContext(
    { businessUnits: [{ name: '', accounts: [] }] },
    MANIFEST_ACCOUNTS,
  );
  const issues = issuesOf(result);
  assert.ok(issues.some((i) => i.path === 'businessUnits[0].name'));
});

test('rejects a whitespace-only Business_Unit name (Req 5.1)', () => {
  const result = validateBusinessContext(
    { businessUnits: [{ name: '   ', accounts: [] }] },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'businessUnits[0].name'));
});

test('rejects a Business_Unit name longer than 128 characters (Req 5.1)', () => {
  const result = validateBusinessContext(
    { businessUnits: [{ name: 'x'.repeat(NAME_MAX_LENGTH + 1), accounts: [] }] },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'businessUnits[0].name'));
});

test('accepts a Business_Unit name of exactly 128 characters (Req 5.1)', () => {
  const result = validateBusinessContext(
    { businessUnits: [{ name: 'x'.repeat(NAME_MAX_LENGTH), accounts: [] }] },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Display name bounds (Req 5.2)
// ---------------------------------------------------------------------------

test('rejects an empty display name (Req 5.2)', () => {
  const result = validateBusinessContext(
    { accountDisplayNames: { '345678901234': '' } },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'accountDisplayNames.345678901234'));
});

test('rejects a display name longer than 128 characters (Req 5.2)', () => {
  const result = validateBusinessContext(
    { accountDisplayNames: { '345678901234': 'x'.repeat(NAME_MAX_LENGTH + 1) } },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'accountDisplayNames.345678901234'));
});

// ---------------------------------------------------------------------------
// Description / metadata bounds (Req 5.2)
// ---------------------------------------------------------------------------

test('rejects a description longer than 1024 characters (Req 5.2)', () => {
  const result = validateBusinessContext(
    {
      businessUnits: [
        { name: 'BU', description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1), accounts: [] },
      ],
    },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'businessUnits[0].description'));
});

test('accepts a description of exactly 1024 characters (Req 5.2)', () => {
  const result = validateBusinessContext(
    {
      businessUnits: [
        { name: 'BU', description: 'x'.repeat(DESCRIPTION_MAX_LENGTH), accounts: [] },
      ],
    },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Per-account free-text context bounds + existence (Req 5.2, 5.7)
// ---------------------------------------------------------------------------

test('accepts and normalizes per-account context (Req 5.2)', () => {
  const result = validateBusinessContext(
    { accountContext: { '345678901234': 'Prod payments workloads' } },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.context.accountContext['345678901234'], 'Prod payments workloads');
});

test('omits blank per-account context from the normalized output', () => {
  const result = validateBusinessContext(
    { accountContext: { '345678901234': '   ' } },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.context.accountContext['345678901234'], undefined);
});

test('rejects per-account context longer than the account-context limit (Req 5.2)', () => {
  const result = validateBusinessContext(
    { accountContext: { '345678901234': 'x'.repeat(ACCOUNT_CONTEXT_MAX_LENGTH + 1) } },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'accountContext.345678901234'));
});

test('accepts per-account context that exceeds the BU description limit but is within the account-context limit (Req 5.2)', () => {
  // Account context is decoupled from (and larger than) the BU description limit.
  const result = validateBusinessContext(
    { accountContext: { '345678901234': 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) } },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
});

test('rejects per-account context for an account absent from the manifest and identifies it (Req 5.7)', () => {
  const result = validateBusinessContext(
    { accountContext: { '888888888888': 'ghost' } },
    MANIFEST_ACCOUNTS,
  );
  const offending = issuesOf(result).find((i) => i.account === '888888888888');
  assert.ok(offending, 'the offending account is identified');
  assert.equal(offending?.path, 'accountContext.888888888888');
});

// --- orgSystemPrompt (Req 5.16) --------------------------------------------

test('accepts and normalizes an org system prompt (Req 5.16)', () => {
  const result = validateBusinessContext(
    { orgSystemPrompt: 'Advise the VP of Platform. Lead with business impact.' },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.context.orgSystemPrompt, 'Advise the VP of Platform. Lead with business impact.');
});

test('omits a blank org system prompt from the normalized output (Req 5.16)', () => {
  const result = validateBusinessContext({ orgSystemPrompt: '   ' }, MANIFEST_ACCOUNTS);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.context.orgSystemPrompt, undefined);
});

test('rejects an org system prompt longer than the limit (Req 5.16)', () => {
  const result = validateBusinessContext(
    { orgSystemPrompt: 'x'.repeat(ORG_SYSTEM_PROMPT_MAX_LENGTH + 1) },
    MANIFEST_ACCOUNTS,
  );
  assert.ok(issuesOf(result).some((i) => i.path === 'orgSystemPrompt'));
});

// ---------------------------------------------------------------------------
// Account existence in the manifest (Req 5.7)
// ---------------------------------------------------------------------------

test('rejects a BU account not present in the manifest and identifies it (Req 5.7)', () => {
  const result = validateBusinessContext(
    { businessUnits: [{ name: 'BU', accounts: ['999999999999'] }] },
    MANIFEST_ACCOUNTS,
  );
  const issues = issuesOf(result);
  const offending = issues.find((i) => i.account === '999999999999');
  assert.ok(offending, 'the offending account is identified in the issue');
  assert.equal(offending?.path, 'businessUnits[0].accounts[0]');
  assert.match(offending?.message ?? '', /999999999999/);
});

test('rejects a display-name key not present in the manifest and identifies it (Req 5.7)', () => {
  const result = validateBusinessContext(
    { accountDisplayNames: { '888888888888': 'Ghost' } },
    MANIFEST_ACCOUNTS,
  );
  const offending = issuesOf(result).find((i) => i.account === '888888888888');
  assert.ok(offending, 'the offending account is identified');
  assert.equal(offending?.path, 'accountDisplayNames.888888888888');
});

test('accepts referenced accounts that all exist in the manifest (Req 5.7)', () => {
  const result = validateBusinessContext(
    {
      businessUnits: [{ name: 'BU', accounts: ['111111111111', '222222222222'] }],
      accountDisplayNames: { '345678901234': 'Payments' },
    },
    MANIFEST_ACCOUNTS,
  );
  assert.equal(result.valid, true);
});

test('reports every problem, not just the first (multi-issue)', () => {
  const result = validateBusinessContext(
    {
      businessUnits: [{ name: '', accounts: ['999999999999'] }],
      accountDisplayNames: { '888888888888': 'Ghost' },
    },
    MANIFEST_ACCOUNTS,
  );
  const issues = issuesOf(result);
  assert.ok(issues.length >= 3, `expected multiple issues, got ${issues.length}`);
});
