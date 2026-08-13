import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addBusinessUnit,
  applyCsvToDraft,
  assignAccountToBusinessUnit,
  businessUnitNameForAccount,
  CONTEXT_CSV_HEADERS,
  draftToContext,
  draftToCsv,
  emptyDraft,
  setAccountContext,
  setAccountDisplayName,
  updateBusinessUnitField,
  type AccountOption,
  type ContextDraft,
} from './contextManagerView';
import { parseCsv } from './csv';

/**
 * Tests for the Context_Manager bulk CSV export/import (feature: batch-edit
 * account context via spreadsheet). Business-unit rules under test: empty
 * unassigns, an existing unit assigns (exactly one), an unknown unit is an
 * error and leaves membership unchanged (never auto-created / force-assigned);
 * unknown accounts are skipped with an error.
 *
 * Run with: `node --import tsx --test src/lib/contextManagerView.csv.test.ts`
 */

const KNOWN = new Set(['111111111111', '222222222222', '333333333333']);
const ACCOUNTS: AccountOption[] = [
  { account: '111111111111', manifestLabel: 'Alpha' },
  { account: '222222222222', manifestLabel: '222222222222' },
  { account: '333333333333', manifestLabel: '333333333333' },
];

/** A draft with one BU "Payments" containing account 111. */
function draftWithBu(): { draft: ContextDraft; buId: string } {
  let draft = addBusinessUnit(emptyDraft());
  const buId = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, buId, 'name', 'Payments');
  draft = assignAccountToBusinessUnit(draft, buId, '111111111111');
  return { draft, buId };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('draftToCsv emits the header plus one row per account with current values', () => {
  let { draft } = draftWithBu();
  draft = setAccountDisplayName(draft, '111111111111', 'Payments Prod');
  draft = setAccountContext(draft, '111111111111', 'Prod, owned by team');

  const rows = parseCsv(draftToCsv(draft, ACCOUNTS));
  assert.deepEqual(rows[0], [...CONTEXT_CSV_HEADERS]);
  assert.equal(rows.length, 1 + ACCOUNTS.length);
  const row111 = rows.find((r) => r[0] === '111111111111');
  assert.deepEqual(row111, ['111111111111', 'Payments Prod', 'Payments', 'Prod, owned by team']);
  // Unassigned account with no display name/context => empty cells.
  const row222 = rows.find((r) => r[0] === '222222222222');
  assert.deepEqual(row222, ['222222222222', '', '', '']);
});

test('draftToCsv output survives a CSV round-trip with commas/quotes in context', () => {
  let draft = emptyDraft();
  draft = setAccountContext(draft, '111111111111', 'a, b, "c"');
  const rows = parseCsv(draftToCsv(draft, ACCOUNTS));
  const row = rows.find((r) => r[0] === '111111111111');
  assert.equal(row?.[3], 'a, b, "c"');
});

// ---------------------------------------------------------------------------
// Import — happy path
// ---------------------------------------------------------------------------

test('applyCsvToDraft sets display name, context, and assigns an existing BU', () => {
  const { draft } = draftWithBu(); // BU "Payments" exists (with 111 already in it)
  const csv = [
    'account_id,display_name,business_unit,context',
    '222222222222,Core,Payments,Prod core workloads',
  ].join('\n');
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(result.errors.length, 0);
  assert.equal(result.applied, 1);
  assert.equal(result.draft.accountDisplayNames['222222222222'], 'Core');
  assert.equal(result.draft.accountContext['222222222222'], 'Prod core workloads');
  assert.equal(businessUnitNameForAccount(result.draft, '222222222222'), 'Payments');
});

test('an empty business_unit cell unassigns the account (allowed, no BU)', () => {
  const { draft } = draftWithBu(); // 111 is in "Payments"
  const csv = 'account_id,business_unit\n111111111111,';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(result.errors.length, 0);
  assert.equal(businessUnitNameForAccount(result.draft, '111111111111'), undefined);
});

test('assigning via CSV moves the account out of its previous BU (exactly one)', () => {
  let { draft } = draftWithBu(); // "Payments" with 111
  draft = addBusinessUnit(draft);
  const otherId = draft.businessUnits[1]!.id;
  draft = updateBusinessUnitField(draft, otherId, 'name', 'Billing');
  const csv = 'account_id,business_unit\n111111111111,Billing';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(businessUnitNameForAccount(result.draft, '111111111111'), 'Billing');
  assert.equal(result.draft.businessUnits.find((b) => b.name === 'Payments')?.accounts.length, 0);
});

test('business_unit match is case-insensitive and trimmed', () => {
  const { draft } = draftWithBu();
  const csv = 'account_id,business_unit\n222222222222,  payments  ';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(result.errors.length, 0);
  assert.equal(businessUnitNameForAccount(result.draft, '222222222222'), 'Payments');
});

// ---------------------------------------------------------------------------
// Import — business-unit rules (no auto-create, no force-assign)
// ---------------------------------------------------------------------------

test('an unknown business unit is an error and leaves membership unchanged (no auto-create)', () => {
  const { draft } = draftWithBu();
  const csv = 'account_id,business_unit\n222222222222,Nonexistent BU';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  // BU is not created…
  assert.ok(!result.draft.businessUnits.some((b) => b.name === 'Nonexistent BU'));
  // …the account is not assigned…
  assert.equal(businessUnitNameForAccount(result.draft, '222222222222'), undefined);
  // …and the problem is reported for that row.
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.account, '222222222222');
  assert.match(result.errors[0]?.message ?? '', /does not exist/i);
});

test('an unknown business unit does not disturb an existing assignment', () => {
  const { draft } = draftWithBu(); // 111 in "Payments"
  const csv = 'account_id,business_unit\n111111111111,Ghost BU';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(result.errors.length, 1);
  // membership left unchanged
  assert.equal(businessUnitNameForAccount(result.draft, '111111111111'), 'Payments');
});

// ---------------------------------------------------------------------------
// Import — unknown accounts, headers, blanks
// ---------------------------------------------------------------------------

test('an unknown account id is reported and the row is skipped (Req 5.7)', () => {
  const csv = 'account_id,display_name\n999999999999,Ghost';
  const result = applyCsvToDraft(emptyDraft(), csv, KNOWN);
  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.account, '999999999999');
  assert.equal(result.draft.accountDisplayNames['999999999999'], undefined);
});

test('a missing account_id column is a single header error', () => {
  const csv = 'display_name,context\nCore,note';
  const result = applyCsvToDraft(emptyDraft(), csv, KNOWN);
  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? '', /account_id/);
});

test('headers are matched by name regardless of column order; extra columns ignored', () => {
  const csv = 'context,extra,account_id,display_name\nhello,ignored,111111111111,Core';
  const result = applyCsvToDraft(emptyDraft(), csv, KNOWN);
  assert.equal(result.errors.length, 0);
  assert.equal(result.draft.accountDisplayNames['111111111111'], 'Core');
  assert.equal(result.draft.accountContext['111111111111'], 'hello');
});

test('columns not present in the file are left untouched', () => {
  let draft = setAccountContext(emptyDraft(), '111111111111', 'keep me');
  // Only display_name is provided; context column absent -> context unchanged.
  const csv = 'account_id,display_name\n111111111111,Core';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  assert.equal(result.draft.accountDisplayNames['111111111111'], 'Core');
  assert.equal(result.draft.accountContext['111111111111'], 'keep me');
});

test('blank lines and empty account_id rows are skipped', () => {
  const csv = 'account_id,display_name\n\n111111111111,Core\n,Orphan\n';
  const result = applyCsvToDraft(emptyDraft(), csv, KNOWN);
  assert.equal(result.draft.accountDisplayNames['111111111111'], 'Core');
  // The ",Orphan" row (missing account_id) is reported.
  assert.ok(result.errors.some((e) => /Missing account_id/i.test(e.message)));
});

test('an imported draft round-trips to a clean PUT payload', () => {
  const { draft } = draftWithBu();
  const csv = 'account_id,display_name,business_unit,context\n222222222222,Core,Payments,ctx';
  const result = applyCsvToDraft(draft, csv, KNOWN);
  const context = draftToContext(result.draft);
  assert.equal(context.accountDisplayNames['222222222222'], 'Core');
  assert.equal(context.accountContext['222222222222'], 'ctx');
  assert.ok(context.businessUnits.find((b) => b.name === 'Payments')?.accounts.includes('222222222222'));
});
