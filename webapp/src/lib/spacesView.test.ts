import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountSpaces, ManifestSpaceCounts } from '@devops-observatory/shared-types';
import {
  accountIdentity,
  accountMatchesQuery,
  filterSpaceAccounts,
  hasNoSpaces,
  spaceCapabilityEntries,
  spaceCountEntries,
  SPACE_CAPABILITY_FIELDS,
  SPACE_COUNT_FIELDS,
  statusLabel,
} from './spacesView';

/**
 * Tests for the Space_View presentation helpers (Task 12).
 *
 * Run with: `node --import tsx --test src/lib/spacesView.test.ts`
 *
 * Requirements: 3.2 (space counts), 3.3 (collected/incomplete status),
 * 3.5 (business label primary + raw account id secondary), 3.6 (no-spaces).
 */

function account(overrides: Partial<AccountSpaces> = {}): AccountSpaces {
  return {
    account: '111122223333',
    displayName: '111122223333',
    spaces: [],
    hasNoSpaces: true,
    status: 'collected',
    lastSyncDate: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

test('accountIdentity keeps only the raw id when no friendly label is set (Req 3.5)', () => {
  const identity = accountIdentity(account({ displayName: '111122223333' }));
  assert.equal(identity.primary, '111122223333');
  assert.equal(identity.secondary, undefined);
});

test('accountIdentity surfaces the display name as primary and the raw id as secondary (Req 3.5)', () => {
  const identity = accountIdentity(
    account({ account: '111122223333', displayName: 'Payments Platform' }),
  );
  assert.equal(identity.primary, 'Payments Platform');
  assert.equal(identity.secondary, '111122223333');
});

test('accountIdentity falls back to the raw id when displayName is empty', () => {
  const identity = accountIdentity(account({ account: '444455556666', displayName: '' }));
  assert.equal(identity.primary, '444455556666');
  assert.equal(identity.secondary, undefined);
});

test('statusLabel maps collection status to a human label (Req 3.3)', () => {
  assert.equal(statusLabel('collected'), 'Collected');
  assert.equal(statusLabel('incomplete'), 'Incomplete');
});

test('hasNoSpaces reflects the backend flag and an empty spaces array (Req 3.6)', () => {
  assert.equal(hasNoSpaces(account({ hasNoSpaces: true, spaces: [] })), true);
  assert.equal(
    hasNoSpaces(
      account({
        hasNoSpaces: false,
        spaces: [
          {
            agentSpaceId: 's-1',
            displayName: 's-1',
            counts: { associations: 0, assets: 0, investigations: 0, recommendations: 0 },
            status: 'collected',
          },
        ],
      }),
    ),
    false,
  );
  // Defensive: an empty array still triggers the notice even if the flag is stale.
  assert.equal(hasNoSpaces(account({ hasNoSpaces: false, spaces: [] })), true);
});

test('accountMatchesQuery is a no-op for a blank query (Req 3.9)', () => {
  assert.equal(accountMatchesQuery(account(), ''), true);
  assert.equal(accountMatchesQuery(account(), '   '), true);
});

test('accountMatchesQuery matches id, display name, org name, business unit, and space names (Req 3.9)', () => {
  const a = account({
    account: '111122223333',
    displayName: 'Payments Platform',
    orgName: 'payments-prod',
    businessUnit: 'FinTech',
    spaces: [
      {
        agentSpaceId: 'as-42',
        displayName: 'gitlab-testing',
        counts: { associations: 0, assets: 0, investigations: 0, recommendations: 0 },
        status: 'collected',
      },
    ],
  });
  assert.equal(accountMatchesQuery(a, '1111'), true); // raw id
  assert.equal(accountMatchesQuery(a, 'payments platform'), true); // display name
  assert.equal(accountMatchesQuery(a, 'payments-prod'), true); // org name
  assert.equal(accountMatchesQuery(a, 'fintech'), true); // business unit
  assert.equal(accountMatchesQuery(a, 'gitlab'), true); // space name
  assert.equal(accountMatchesQuery(a, 'as-42'), true); // space id
  assert.equal(accountMatchesQuery(a, 'nomatch'), false);
});

test('filterSpaceAccounts returns all accounts for a blank query and filters otherwise (Req 3.9)', () => {
  const accounts = [
    account({ account: '111111111111', displayName: 'Alpha' }),
    account({ account: '222222222222', displayName: 'Beta' }),
  ];
  assert.equal(filterSpaceAccounts(accounts, '').length, 2);
  const filtered = filterSpaceAccounts(accounts, 'beta');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.account, '222222222222');
});

test('spaceCountEntries returns Investigations, Integrations, Recommendations, Assets in a stable order (Req 3.2)', () => {
  // Investigations (== incidents) is shown per space; Integrations is sourced
  // from associations.
  const counts: ManifestSpaceCounts = {
    associations: 3,
    assets: 4,
    investigations: 1,
    incidents: 1,
    recommendations: 2,
    telemetry: 0,
    pipelines: 0,
    communications: 0,
    mcpServers: 0,
    remoteAgents: 0,
    webhooks: 0,
    logDeliveries: 0,
    users: 0,
  };
  const entries = spaceCountEntries(counts);
  assert.deepEqual(
    entries.map((e) => e.key),
    SPACE_COUNT_FIELDS.map((f) => f.key),
  );
  // Investigations(1), Integrations(3), Recommendations(2), Assets(4).
  assert.deepEqual(
    entries.map((e) => e.value),
    [1, 3, 2, 4],
  );
  assert.equal(SPACE_COUNT_FIELDS[0]?.label, 'Investigations');
  assert.equal(
    entries.some((e) => e.key === 'investigations'),
    true,
  );
});

test('spaceCapabilityEntries lists every capability metric in a stable order with safe values', () => {
  const counts: ManifestSpaceCounts = {
    associations: 0,
    assets: 0,
    investigations: 0,
    incidents: 0,
    recommendations: 0,
    telemetry: 2,
    pipelines: 1,
    communications: 3,
    mcpServers: 1,
    remoteAgents: 0,
    webhooks: 4,
    logDeliveries: 2,
    users: 5,
  };
  const entries = spaceCapabilityEntries(counts);
  assert.deepEqual(
    entries.map((e) => e.key),
    SPACE_CAPABILITY_FIELDS.map((f) => f.key),
  );
  // Telemetry, Pipelines, Communications, MCP servers, Remote agents (0 kept
  // explicit), Webhooks, Log deliveries, Users with access.
  assert.deepEqual(
    entries.map((e) => e.value),
    [2, 1, 3, 1, 0, 4, 2, 5],
  );
  assert.equal(SPACE_CAPABILITY_FIELDS.at(-1)?.label, 'Users with access');
});

test('spaceCapabilityEntries treats missing/null capability counts as unknown, never 0', () => {
  // Older manifests (pre-capability tracking) omit the keys entirely; the
  // collector writes null for a metric it could not retrieve. Both are
  // UNKNOWN and must surface as null (rendered "—"), not as a false 0.
  const legacy = {
    associations: 1,
    assets: 1,
    investigations: 0,
    incidents: 0,
    recommendations: 0,
  } as unknown as ManifestSpaceCounts;
  const values = spaceCapabilityEntries(legacy).map((e) => e.value);
  assert.deepEqual(values, [null, null, null, null, null, null, null, null]);

  const withError: ManifestSpaceCounts = {
    associations: 0,
    assets: 0,
    investigations: 0,
    incidents: 0,
    recommendations: 0,
    telemetry: 1,
    pipelines: 0,
    communications: 0,
    mcpServers: 0,
    remoteAgents: 0,
    webhooks: null, // retrieval error during collection
    logDeliveries: null, // retrieval error during collection
    users: 2,
  };
  const byKey = Object.fromEntries(spaceCapabilityEntries(withError).map((e) => [e.key, e.value]));
  assert.equal(byKey.telemetry, 1);
  assert.equal(byKey.pipelines, 0); // a real 0 stays 0
  assert.equal(byKey.webhooks, null);
  assert.equal(byKey.logDeliveries, null);
  assert.equal(byKey.users, 2);
});

test('spaceCountEntries coerces missing/negative/non-finite counts to zero (Req 3.2)', () => {
  const counts = {
    associations: -5,
    assets: Number.NaN,
    investigations: 0,
    incidents: 0,
    recommendations: 7.9,
  } as unknown as ManifestSpaceCounts;
  const byKey = Object.fromEntries(spaceCountEntries(counts).map((e) => [e.key, e.value]));
  assert.equal(byKey.associations, 0);
  assert.equal(byKey.assets, 0);
  assert.equal(byKey.recommendations, 7);
});

test('accountsWithoutSpaces / accountsWithSpaceIds partition by space presence', async () => {
  const { accountsWithoutSpaces, accountsWithSpaceIds } = await import('./spacesView');
  const withSpace = account({
    account: '111111111111',
    hasNoSpaces: false,
    spaces: [
      {
        agentSpaceId: 's-1',
        displayName: 's-1',
        counts: { associations: 1, assets: 0, investigations: 0, incidents: 0, recommendations: 0 },
        status: 'collected',
      },
    ],
  });
  const withoutSpace = account({ account: '222222222222', hasNoSpaces: true, spaces: [] });
  const accounts = [withSpace, withoutSpace];

  assert.deepEqual(
    accountsWithoutSpaces(accounts).map((a) => a.account),
    ['222222222222'],
  );
  assert.deepEqual(accountsWithSpaceIds(accounts), ['111111111111']);
});
