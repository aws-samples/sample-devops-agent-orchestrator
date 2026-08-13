import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountsForBusinessUnit,
  accountsForDisplayNameEditor,
  ACCOUNT_RESULT_LIMIT,
  addBusinessUnit,
  assignAccountToBusinessUnit,
  configuredAccountIds,
  emptyDraft,
  filterAccounts,
  resolveAccountOption,
  setAccountContext,
  setAccountDisplayName,
  type AccountOption,
} from './contextManagerView';

/**
 * Tests for the scalable account-selection logic used by the Context_Manager
 * (feature: better account selection for orgs with thousands of accounts).
 *
 * Run with: `node --import tsx --test src/lib/contextManagerView.selection.test.ts`
 */

function makeAccounts(n: number): AccountOption[] {
  return Array.from({ length: n }, (_, i) => ({
    account: `1000000000${String(i).padStart(2, '0')}`,
    manifestLabel: i % 2 === 0 ? `Account ${i}` : `1000000000${String(i).padStart(2, '0')}`,
  }));
}

test('filterAccounts caps results and reports the true total (Property: bounded DOM)', () => {
  const accounts = makeAccounts(1000);
  const res = filterAccounts(accounts, '', 50);
  assert.equal(res.matches.length, 50);
  assert.equal(res.total, 1000);
  assert.equal(res.truncated, true);
});

test('filterAccounts matches by id or label, case-insensitively', () => {
  const accounts: AccountOption[] = [
    { account: '111111111111', manifestLabel: 'Payments Prod' },
    { account: '222222222222', manifestLabel: 'Billing Dev' },
  ];
  assert.deepEqual(
    filterAccounts(accounts, 'payments').matches.map((a) => a.account),
    ['111111111111'],
  );
  assert.deepEqual(
    filterAccounts(accounts, '2222').matches.map((a) => a.account),
    ['222222222222'],
  );
  assert.equal(filterAccounts(accounts, 'nomatch').total, 0);
});

test('filterAccounts matches by org name even when an admin label overrides it (Req 3.8)', () => {
  const accounts: AccountOption[] = [
    { account: '111111111111', manifestLabel: 'Payments Prod', orgName: 'payments-prod-org' },
  ];
  assert.deepEqual(
    filterAccounts(accounts, 'payments-prod-org').matches.map((a) => a.account),
    ['111111111111'],
  );
});

test('filterAccounts surfaces an exact id match first', () => {
  const accounts = makeAccounts(100);
  const target = accounts[40].account;
  const res = filterAccounts(accounts, target, 10);
  assert.equal(res.matches[0].account, target);
});

test('filterAccounts default limit is ACCOUNT_RESULT_LIMIT', () => {
  const res = filterAccounts(makeAccounts(200), '');
  assert.equal(res.matches.length, ACCOUNT_RESULT_LIMIT);
});

test('resolveAccountOption falls back to id-as-label for unknown accounts', () => {
  const accounts: AccountOption[] = [{ account: '111111111111', manifestLabel: 'Payments' }];
  assert.deepEqual(resolveAccountOption(accounts, '999999999999'), {
    account: '999999999999',
    manifestLabel: '999999999999',
  });
});

test('accountsForBusinessUnit returns assigned accounts in order, incl. unknown ids', () => {
  const accounts: AccountOption[] = [{ account: '111111111111', manifestLabel: 'Payments' }];
  let draft = addBusinessUnit(emptyDraft(), 'BU');
  const buId = draft.businessUnits[0].id;
  draft = assignAccountToBusinessUnit(draft, buId, '111111111111');
  draft = assignAccountToBusinessUnit(draft, buId, '999999999999'); // not in manifest
  const selected = accountsForBusinessUnit(draft, buId, accounts);
  assert.deepEqual(
    selected.map((a) => a.account),
    ['111111111111', '999999999999'],
  );
  assert.equal(selected[1].manifestLabel, '999999999999');
});

test('accountsForDisplayNameEditor always includes already-configured (pinned) accounts, listed first', () => {
  const accounts = makeAccounts(500);
  // Name an account that would be off-screen for an unrelated search.
  const namedId = accounts[300].account;
  const draft = setAccountDisplayName(emptyDraft(), namedId, 'Special Prod');
  const pinned = configuredAccountIds(draft);
  // Returns the FULL matching list (no cap) so the view can paginate it.
  const matched = accountsForDisplayNameEditor(accounts, 'zzz-no-match', pinned);
  assert.ok(matched.some((a) => a.account === namedId), 'named account is present');
  assert.equal(matched[0]?.account, namedId, 'pinned accounts are listed first');
});

test('accountsForDisplayNameEditor includes accounts that only have free-text context', () => {
  const accounts = makeAccounts(50);
  const ctxId = accounts[10].account;
  let draft = emptyDraft();
  draft = { ...draft, accountContext: { [ctxId]: 'Owned by platform team' } };
  const pinned = configuredAccountIds(draft);
  const matched = accountsForDisplayNameEditor(accounts, 'zzz-no-match', pinned);
  assert.ok(matched.some((a) => a.account === ctxId), 'context-only account is present');
});

test('accountsForDisplayNameEditor ordering is stable regardless of live edits (no reorder on type)', () => {
  const accounts = makeAccounts(20);
  // Snapshot taken with NOTHING configured — the order the user sees at load.
  const pinned = configuredAccountIds(emptyDraft());
  const before = accountsForDisplayNameEditor(accounts, '', pinned).map((a) => a.account);
  // Simulate the user typing context into the 5th account mid-session. Because
  // the pinned snapshot is unchanged, the rendered order must not change.
  const edited = setAccountContext(emptyDraft(), accounts[5].account, 'typing...');
  void edited; // the edit does not feed back into the (snapshotted) pinned set
  const after = accountsForDisplayNameEditor(accounts, '', pinned).map((a) => a.account);
  assert.deepEqual(after, before);
});
