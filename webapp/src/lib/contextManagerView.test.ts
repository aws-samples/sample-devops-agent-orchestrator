import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BusinessContext, SpacesDTO } from '@devops-observatory/shared-types';
import {
  ACCOUNT_CONTEXT_MAX_LENGTH,
  addBusinessUnit,
  assignAccountToBusinessUnit,
  availableAccounts,
  BU_NAME_MAX_LENGTH,
  buildDraft,
  businessUnitNameForAccount,
  DISPLAY_NAME_MAX_LENGTH,
  draftToContext,
  emptyDraft,
  isDraftValid,
  issuesForAccount,
  issuesForBusinessUnit,
  knownAccountIds,
  METADATA_MAX_LENGTH,
  ORG_SYSTEM_PROMPT_MAX_LENGTH,
  removeBusinessUnit,
  setAccountContext,
  setAccountDisplayName,
  setOrgSystemPrompt,
  unassignAccount,
  updateBusinessUnitField,
  validateDraft,
  type ContextDraft,
} from './contextManagerView';

/**
 * Tests for the Context_Manager presentation/validation helpers (Task 16).
 *
 * Run with: `node --import tsx --test src/lib/contextManagerView.test.ts`
 *
 * Requirements: 5.1 (BU create/edit/remove, name 1–128, each account maps to
 * exactly one BU), 5.2 (display name 1–128, metadata ≤1024), 5.7 (reject an
 * account absent from the manifest, identifying it).
 */

const MANIFEST_ACCOUNTS = ['345678901234', '111111111111', '222222222222'];

function spaces(accountIds: string[] = MANIFEST_ACCOUNTS): SpacesDTO {
  return {
    lastSyncDate: '2026-07-01T12:00:00Z',
    accounts: accountIds.map((account) => ({
      account,
      displayName: account,
      spaces: [],
      hasNoSpaces: true,
      status: 'collected' as const,
      lastSyncDate: '2026-07-01T12:00:00Z',
    })),
  };
}

const KNOWN = new Set(MANIFEST_ACCOUNTS);

// ---------------------------------------------------------------------------
// Deriving available accounts (Req 5.7 scope)
// ---------------------------------------------------------------------------

test('availableAccounts lists manifest accounts with a business label, sorted', () => {
  const dto: SpacesDTO = {
    lastSyncDate: 'unknown',
    accounts: [
      { account: '222222222222', displayName: 'Zeta', spaces: [], hasNoSpaces: true, status: 'collected', lastSyncDate: 'unknown' },
      { account: '111111111111', displayName: 'Alpha', spaces: [], hasNoSpaces: true, status: 'collected', lastSyncDate: 'unknown' },
    ],
  };
  const opts = availableAccounts(dto);
  assert.deepEqual(
    opts.map((o) => o.manifestLabel),
    ['Alpha', 'Zeta'],
  );
});

test('availableAccounts falls back to the account id when no display name is set', () => {
  const opts = availableAccounts(spaces(['345678901234']));
  assert.equal(opts[0]?.manifestLabel, '345678901234');
});

test('availableAccounts carries the org name through for placeholders/search (Req 3.8)', () => {
  const dto: SpacesDTO = {
    lastSyncDate: 'unknown',
    accounts: [
      {
        account: '111111111111',
        displayName: 'payments-prod',
        orgName: 'payments-prod',
        spaces: [],
        hasNoSpaces: true,
        status: 'collected',
        lastSyncDate: 'unknown',
      },
    ],
  };
  const opts = availableAccounts(dto);
  assert.equal(opts[0]?.orgName, 'payments-prod');
});

test('knownAccountIds returns the manifest account set (Req 5.7 authority)', () => {
  const known = knownAccountIds(spaces());
  assert.equal(known.size, 3);
  assert.ok(known.has('345678901234'));
  assert.ok(!known.has('999999999999'));
});

// ---------------------------------------------------------------------------
// Business_Unit CRUD (Req 5.1)
// ---------------------------------------------------------------------------

test('addBusinessUnit appends a new empty unit with a stable id (Req 5.1)', () => {
  const draft = addBusinessUnit(emptyDraft());
  assert.equal(draft.businessUnits.length, 1);
  assert.equal(draft.businessUnits[0]?.name, '');
  assert.ok(draft.businessUnits[0]?.id);
});

test('updateBusinessUnitField edits the name and description (Req 5.1, 5.2)', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', 'Payments');
  draft = updateBusinessUnitField(draft, id, 'description', 'Prod payments platform');
  assert.equal(draft.businessUnits[0]?.name, 'Payments');
  assert.equal(draft.businessUnits[0]?.description, 'Prod payments platform');
});

test('removeBusinessUnit deletes the unit by id (Req 5.1)', () => {
  let draft = addBusinessUnit(addBusinessUnit(emptyDraft()));
  const firstId = draft.businessUnits[0]!.id;
  draft = removeBusinessUnit(draft, firstId);
  assert.equal(draft.businessUnits.length, 1);
  assert.ok(draft.businessUnits.every((bu) => bu.id !== firstId));
});

// ---------------------------------------------------------------------------
// Account-to-BU assignment: exactly one BU (Req 5.1)
// ---------------------------------------------------------------------------

test('assigning an account to a BU adds it, and re-assigning moves it out of the prior BU (Req 5.1)', () => {
  let draft = addBusinessUnit(addBusinessUnit(emptyDraft()));
  const [a, b] = draft.businessUnits.map((bu) => bu.id);
  draft = assignAccountToBusinessUnit(draft, a!, '111111111111');
  assert.deepEqual(draft.businessUnits[0]?.accounts, ['111111111111']);

  // Re-assigning to the other BU removes it from the first (exactly one BU).
  draft = assignAccountToBusinessUnit(draft, b!, '111111111111');
  assert.deepEqual(draft.businessUnits[0]?.accounts, []);
  assert.deepEqual(draft.businessUnits[1]?.accounts, ['111111111111']);
});

test('assigning the same account to the same BU twice is idempotent', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = assignAccountToBusinessUnit(draft, id, '111111111111');
  draft = assignAccountToBusinessUnit(draft, id, '111111111111');
  assert.deepEqual(draft.businessUnits[0]?.accounts, ['111111111111']);
});

test('unassignAccount removes an account from a BU (leaves it ungrouped)', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = assignAccountToBusinessUnit(draft, id, '111111111111');
  draft = unassignAccount(draft, id, '111111111111');
  assert.deepEqual(draft.businessUnits[0]?.accounts, []);
});

// ---------------------------------------------------------------------------
// Display names (Req 5.2)
// ---------------------------------------------------------------------------

test('setAccountDisplayName sets and clears a display name (Req 5.2)', () => {
  let draft = setAccountDisplayName(emptyDraft(), '111111111111', 'Core Prod');
  assert.equal(draft.accountDisplayNames['111111111111'], 'Core Prod');
  draft = setAccountDisplayName(draft, '111111111111', '');
  assert.equal(draft.accountDisplayNames['111111111111'], undefined);
});

// ---------------------------------------------------------------------------
// Per-account free-text context (Req 5.2)
// ---------------------------------------------------------------------------

test('setAccountContext sets and clears an account context (Req 5.2)', () => {
  let draft = setAccountContext(emptyDraft(), '111111111111', 'Prod payments, owned by Payments team');
  assert.equal(draft.accountContext['111111111111'], 'Prod payments, owned by Payments team');
  draft = setAccountContext(draft, '111111111111', '');
  assert.equal(draft.accountContext['111111111111'], undefined);
});

test('businessUnitNameForAccount reports the BU membership shown in the account table', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', 'Payments');
  draft = assignAccountToBusinessUnit(draft, id, '111111111111');
  assert.equal(businessUnitNameForAccount(draft, '111111111111'), 'Payments');
  assert.equal(businessUnitNameForAccount(draft, '222222222222'), undefined);
});

test('rejects account context longer than the account-context limit (Req 5.2)', () => {
  const draft = setAccountContext(emptyDraft(), '111111111111', 'x'.repeat(ACCOUNT_CONTEXT_MAX_LENGTH + 1));
  const re = new RegExp(`at most ${ACCOUNT_CONTEXT_MAX_LENGTH} characters`);
  assert.ok(validateDraft(draft, KNOWN).some((i) => re.test(i.message)));
});

test('accepts account context at exactly the account-context limit (Req 5.2)', () => {
  const draft = setAccountContext(emptyDraft(), '111111111111', 'x'.repeat(ACCOUNT_CONTEXT_MAX_LENGTH));
  assert.equal(isDraftValid(draft, KNOWN), true);
});

// ---------------------------------------------------------------------------
// Org system prompt (Req 5.16)
// ---------------------------------------------------------------------------

test('setOrgSystemPrompt sets the org system prompt on the draft (Req 5.16)', () => {
  const draft = setOrgSystemPrompt(emptyDraft(), 'Advise the VP of Platform.');
  assert.equal(draft.orgSystemPrompt, 'Advise the VP of Platform.');
});

test('draftToContext includes a non-blank org system prompt and omits a blank one (Req 5.16)', () => {
  const withPrompt = draftToContext(setOrgSystemPrompt(emptyDraft(), '  Lead with business impact.  '));
  assert.equal(withPrompt.orgSystemPrompt, 'Lead with business impact.');
  const blank = draftToContext(setOrgSystemPrompt(emptyDraft(), '   '));
  assert.equal(blank.orgSystemPrompt, undefined);
});

test('buildDraft loads a persisted org system prompt into the draft (Req 5.16)', () => {
  const context: BusinessContext = {
    version: 1,
    updatedAt: '2026-07-08T00:00:00Z',
    businessUnits: [],
    accountDisplayNames: {},
    accountContext: {},
    orgSystemPrompt: 'Executive persona.',
  };
  assert.equal(buildDraft(context).orgSystemPrompt, 'Executive persona.');
});

test('rejects an org system prompt longer than the limit (Req 5.16)', () => {
  const draft = setOrgSystemPrompt(emptyDraft(), 'x'.repeat(ORG_SYSTEM_PROMPT_MAX_LENGTH + 1));
  assert.equal(isDraftValid(draft, KNOWN), false);
  assert.ok(validateDraft(draft, KNOWN).some((i) => i.ref === 'orgSystemPrompt'));
});

test('rejects account context for an account absent from the manifest and identifies it (Req 5.7)', () => {
  const draft = setAccountContext(emptyDraft(), '888888888888', 'ghost context');
  const offending = validateDraft(draft, KNOWN).find((i) => i.account === '888888888888');
  assert.ok(offending, 'the unrecognized context account is identified');
});

// ---------------------------------------------------------------------------
// Validation (Req 5.1, 5.2, 5.7)
// ---------------------------------------------------------------------------

test('an empty draft is valid', () => {
  assert.deepEqual(validateDraft(emptyDraft(), KNOWN), []);
  assert.equal(isDraftValid(emptyDraft(), KNOWN), true);
});

test('rejects an empty Business_Unit name (Req 5.1)', () => {
  const draft = addBusinessUnit(emptyDraft());
  const issues = validateDraft(draft, KNOWN);
  assert.ok(issues.some((i) => /name is required/i.test(i.message)));
  assert.equal(isDraftValid(draft, KNOWN), false);
});

test('rejects a Business_Unit name longer than 128 characters (Req 5.1)', () => {
  let draft = addBusinessUnit(emptyDraft());
  draft = updateBusinessUnitField(draft, draft.businessUnits[0]!.id, 'name', 'x'.repeat(BU_NAME_MAX_LENGTH + 1));
  assert.ok(validateDraft(draft, KNOWN).some((i) => /128 characters/.test(i.message)));
});

test('accepts a Business_Unit name of exactly 128 characters (Req 5.1)', () => {
  let draft = addBusinessUnit(emptyDraft());
  draft = updateBusinessUnitField(draft, draft.businessUnits[0]!.id, 'name', 'x'.repeat(BU_NAME_MAX_LENGTH));
  assert.equal(isDraftValid(draft, KNOWN), true);
});

test('rejects metadata (BU description) longer than 1024 characters (Req 5.2)', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', 'BU');
  draft = updateBusinessUnitField(draft, id, 'description', 'x'.repeat(METADATA_MAX_LENGTH + 1));
  assert.ok(validateDraft(draft, KNOWN).some((i) => /at most 1024 characters/.test(i.message)));
});

test('rejects a display name longer than 128 characters (Req 5.2)', () => {
  const draft = setAccountDisplayName(emptyDraft(), '111111111111', 'x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1));
  assert.ok(validateDraft(draft, KNOWN).some((i) => /Display name must be/.test(i.message)));
});

test('rejects a BU account absent from the manifest and identifies it (Req 5.7)', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', 'Ghost BU');
  draft = assignAccountToBusinessUnit(draft, id, '999999999999');
  const issues = validateDraft(draft, KNOWN);
  const offending = issues.find((i) => i.account === '999999999999');
  assert.ok(offending, 'the unrecognized account is identified (Req 5.7)');
  assert.match(offending?.message ?? '', /999999999999/);
  assert.match(offending?.message ?? '', /not present in the collected data manifest/i);
});

test('rejects a display-name account absent from the manifest and identifies it (Req 5.7)', () => {
  const draft = setAccountDisplayName(emptyDraft(), '888888888888', 'Ghost');
  const offending = validateDraft(draft, KNOWN).find((i) => i.account === '888888888888');
  assert.ok(offending, 'the unrecognized display-name account is identified');
});

test('flags an account assigned to more than one BU (Req 5.1 — exactly one)', () => {
  // Construct a malformed draft directly (bypassing the auto-move mutation) to
  // ensure validation still catches a stale duplicate assignment.
  const draft: ContextDraft = {
    version: 1,
    businessUnits: [
      { id: 'bu-a', name: 'A', description: '', accounts: ['111111111111'] },
      { id: 'bu-b', name: 'B', description: '', accounts: ['111111111111'] },
    ],
    accountDisplayNames: {},
    accountContext: {},
    orgSystemPrompt: '',
  };
  const issues = validateDraft(draft, KNOWN);
  assert.ok(issues.some((i) => /more than one business unit/i.test(i.message)));
});

test('validateDraft reports every problem, not just the first', () => {
  const draft: ContextDraft = {
    version: 1,
    businessUnits: [{ id: 'bu-a', name: '', description: '', accounts: ['999999999999'] }],
    accountDisplayNames: { '888888888888': 'Ghost' },
    accountContext: {},
    orgSystemPrompt: '',
  };
  assert.ok(validateDraft(draft, KNOWN).length >= 3);
});

test('issuesForBusinessUnit / issuesForAccount scope issues for inline display', () => {
  const draft: ContextDraft = {
    version: 1,
    businessUnits: [{ id: 'bu-a', name: '', description: '', accounts: [] }],
    accountDisplayNames: { '888888888888': 'Ghost' },
    accountContext: {},
    orgSystemPrompt: '',
  };
  const issues = validateDraft(draft, KNOWN);
  assert.ok(issuesForBusinessUnit(issues, 'bu-a').length >= 1);
  assert.ok(issuesForAccount(issues, '888888888888').length >= 1);
});

// ---------------------------------------------------------------------------
// Draft <-> context conversion (round-trip for save)
// ---------------------------------------------------------------------------

test('buildDraft loads a persisted context into an editable draft', () => {
  const context: BusinessContext = {
    version: 2,
    updatedAt: '2026-07-02T00:00:00Z',
    businessUnits: [{ name: 'Payments', description: 'Prod', accounts: ['345678901234'] }],
    accountDisplayNames: { '345678901234': 'Payments Prod' },
    accountContext: { '345678901234': 'Prod payments workloads' },
  };
  const draft = buildDraft(context);
  assert.equal(draft.version, 2);
  assert.equal(draft.businessUnits[0]?.name, 'Payments');
  assert.equal(draft.businessUnits[0]?.description, 'Prod');
  assert.deepEqual(draft.businessUnits[0]?.accounts, ['345678901234']);
  assert.equal(draft.accountDisplayNames['345678901234'], 'Payments Prod');
  assert.equal(draft.accountContext['345678901234'], 'Prod payments workloads');
});

test('draftToContext produces a clean PUT payload (trims, omits blanks, no updatedAt)', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', '  Payments  ');
  draft = updateBusinessUnitField(draft, id, 'description', '   '); // blank -> omitted
  draft = assignAccountToBusinessUnit(draft, id, '345678901234');
  draft = setAccountDisplayName(draft, '111111111111', '  Core  ');
  draft = setAccountDisplayName(draft, '222222222222', '   '); // blank -> omitted
  draft = setAccountContext(draft, '111111111111', '  Core prod context  ');
  draft = setAccountContext(draft, '222222222222', '   '); // blank -> omitted

  const context = draftToContext(draft);
  assert.equal(context.updatedAt, '', 'updatedAt is stamped by the backend, not the client');
  assert.equal(context.businessUnits[0]?.name, 'Payments');
  assert.equal(context.businessUnits[0]?.description, undefined, 'blank description omitted');
  assert.deepEqual(context.businessUnits[0]?.accounts, ['345678901234']);
  assert.equal(context.accountDisplayNames['111111111111'], 'Core');
  assert.equal(context.accountDisplayNames['222222222222'], undefined, 'blank display name omitted');
  assert.equal(context.accountContext['111111111111'], 'Core prod context');
  assert.equal(context.accountContext['222222222222'], undefined, 'blank context omitted');
});

test('a well-formed draft round-trips through draftToContext and validates clean', () => {
  let draft = addBusinessUnit(emptyDraft());
  const id = draft.businessUnits[0]!.id;
  draft = updateBusinessUnitField(draft, id, 'name', 'Payments');
  draft = assignAccountToBusinessUnit(draft, id, '345678901234');
  assert.equal(isDraftValid(draft, KNOWN), true);
  const context = draftToContext(draft);
  assert.equal(context.businessUnits[0]?.accounts[0], '345678901234');
});
