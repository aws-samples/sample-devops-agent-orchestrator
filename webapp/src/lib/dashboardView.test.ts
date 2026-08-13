import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AccountSpaces,
  DashboardDTO,
  SpacesDTO,
} from '@devops-observatory/shared-types';
import {
  AGENT_SPACE_ACTIVITY_FIELDS,
  agentSpaceActivityRows,
  capabilityEntries,
  DASHBOARD_BREAKDOWN_FIELDS,
  DASHBOARD_CAPABILITY_FIELDS,
  DASHBOARD_TOTAL_FIELDS,
  groupingColumnLabel,
  groupingDescription,
  hasNoData,
  totalEntries,
} from './dashboardView';

/**
 * Tests for the Dashboard presentation helpers (Task 13).
 *
 * Run with: `node --import tsx --test src/lib/dashboardView.test.ts`
 *
 * Requirements: 6.1–6.3 (totals + per-Agent_Space activity counts), 6.4/6.5
 * (by-Business_Unit vs by-account grouping labels), 6.7 (zero rendered as 0),
 * 6.8 (no-data detection), 11.5 (tabular presentation feeds tables).
 */

/** Fully-zeroed aggregate totals (activity + capability rollups). */
function zeroTotals(): DashboardDTO['totals'] {
  return {
    incidents: 0,
    investigations: 0,
    agentSpaces: 0,
    telemetry: 0,
    pipelines: 0,
    communications: 0,
    mcpServers: 0,
    remoteAgents: 0,
    webhooks: 0,
    logDeliveries: 0,
    users: 0,
 investigationHours: 0,
 evaluationHours: 0,
 systemLearningHours: 0,
 onDemandHours: 0,
  };
}

function dashboard(overrides: Partial<DashboardDTO> = {}): DashboardDTO {
  return {
    totals: zeroTotals(),
    grouping: 'account',
    breakdown: [],
    lastSyncDate: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

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

function spacesDTO(accounts: AccountSpaces[]): SpacesDTO {
  return { accounts, lastSyncDate: '2026-07-01T12:00:00Z' };
}

// ---------------------------------------------------------------------------
// Totals (Requirements 6.1–6.3, 6.7)
// ---------------------------------------------------------------------------

test('totalEntries returns incidents, investigations, agent spaces in a stable order (Req 6.1–6.3)', () => {
  const entries = totalEntries({ ...zeroTotals(), incidents: 9, investigations: 4, agentSpaces: 3 });
  assert.deepEqual(
    entries.map((e) => e.key),
    DASHBOARD_TOTAL_FIELDS.map((f) => f.key),
  );
  assert.deepEqual(
    entries.map((e) => e.value),
    [9, 4, 3],
  );
});

test('totalEntries keeps zero metrics as explicit 0 (Req 6.7)', () => {
  const entries = totalEntries(zeroTotals());
  assert.deepEqual(
    entries.map((e) => e.value),
    [0, 0, 0],
  );
});

test('capabilityEntries lists every capability rollup in a stable order with safe values', () => {
  const entries = capabilityEntries({
    ...zeroTotals(),
    telemetry: 3,
    pipelines: 2,
    communications: 1,
    mcpServers: 4,
    remoteAgents: 1,
    webhooks: 5,
    logDeliveries: 2,
    users: 7,
  });
  assert.deepEqual(
    entries.map((e) => e.key),
    DASHBOARD_CAPABILITY_FIELDS.map((f) => f.key),
  );
  assert.deepEqual(
    entries.map((e) => e.value),
    [3, 2, 1, 4, 1, 5, 2, 7],
  );
});

test('capabilityEntries keeps zero capability metrics as explicit 0 (Req 6.7)', () => {
  assert.deepEqual(
    capabilityEntries(zeroTotals()).map((e) => e.value),
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test('breakdown fields carry the activity totals followed by every capability rollup', () => {
  assert.deepEqual(
    DASHBOARD_BREAKDOWN_FIELDS.map((f) => f.key),
    [
      'incidents',
      'investigations',
      'agentSpaces',
      ...DASHBOARD_CAPABILITY_FIELDS.map((f) => f.key),
    ],
  );
});

test('totalEntries coerces negative/non-finite totals to a safe 0 (Req 6.7)', () => {
  const entries = totalEntries({
    incidents: -5,
    investigations: Number.NaN,
    agentSpaces: 2.9,
  } as unknown as DashboardDTO['totals']);
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(byKey.incidents, 0);
  assert.equal(byKey.investigations, 0);
  assert.equal(byKey.agentSpaces, 2);
});

// ---------------------------------------------------------------------------
// Grouping labels (Requirements 6.4, 6.5)
// ---------------------------------------------------------------------------

test('groupingColumnLabel reflects business-unit vs account grouping (Req 6.4, 6.5)', () => {
  assert.equal(groupingColumnLabel('businessUnit'), 'Business unit');
  assert.equal(groupingColumnLabel('account'), 'Account');
});

test('groupingDescription explains the active grouping (Req 6.4, 6.5)', () => {
  assert.match(groupingDescription('businessUnit'), /business unit/i);
  assert.match(groupingDescription('businessUnit'), /Unassigned/);
  assert.match(groupingDescription('account'), /account/i);
});

// ---------------------------------------------------------------------------
// No-data detection (Requirement 6.8)
// ---------------------------------------------------------------------------

test('hasNoData is true when the breakdown is empty (Req 6.8)', () => {
  assert.equal(hasNoData(dashboard({ breakdown: [] })), true);
});

test('hasNoData is false when at least one breakdown row exists (Req 6.8)', () => {
  const dto = dashboard({
    breakdown: [{ key: 'Payments', totals: { ...zeroTotals(), agentSpaces: 1 } }],
  });
  assert.equal(hasNoData(dto), false);
});

// ---------------------------------------------------------------------------
// Per-Agent_Space activity flattening (Requirement 6.3)
// ---------------------------------------------------------------------------

test('agentSpaceActivityRows flattens spaces across accounts with the three activity counts (Req 6.3)', () => {
  const rows = agentSpaceActivityRows(
    spacesDTO([
      account({
        account: '111122223333',
        displayName: 'Payments',
        hasNoSpaces: false,
        spaces: [
          {
            agentSpaceId: 's-1',
            displayName: 'Prod Space',
            counts: { associations: 2, assets: 3, investigations: 5, recommendations: 4 },
            status: 'collected',
          },
        ],
      }),
      account({
        account: '444455556666',
        displayName: 'Media',
        hasNoSpaces: false,
        spaces: [
          {
            agentSpaceId: 's-2',
            displayName: 's-2',
            counts: { associations: 0, assets: 0, investigations: 0, recommendations: 0 },
            status: 'collected',
          },
        ],
      }),
    ]),
  );

  assert.equal(rows.length, 2);
  // Fields exposed match Requirement 6.3 exactly.
  assert.deepEqual(
    AGENT_SPACE_ACTIVITY_FIELDS.map((f) => f.key),
    ['recommendations', 'associations', 'assets'],
  );

  const first = rows[0];
  assert.equal(first?.key, '111122223333:s-1');
  assert.equal(first?.spaceName, 'Prod Space');
  assert.equal(first?.accountLabel, 'Payments');
  assert.deepEqual(first?.counts, { recommendations: 4, associations: 2, assets: 3 });

  // Zero-activity space still renders explicit zeros (Req 6.7).
  const second = rows[1];
  assert.deepEqual(second?.counts, { recommendations: 0, associations: 0, assets: 0 });
});

test('agentSpaceActivityRows coerces negative/non-finite counts to zero (Req 6.7)', () => {
  const rows = agentSpaceActivityRows(
    spacesDTO([
      account({
        hasNoSpaces: false,
        spaces: [
          {
            agentSpaceId: 's-1',
            displayName: 's-1',
            counts: {
              associations: -1,
              assets: Number.NaN,
              investigations: 0,
              recommendations: 7.9,
            } as unknown as AccountSpaces['spaces'][number]['counts'],
            status: 'collected',
          },
        ],
      }),
    ]),
  );
  assert.deepEqual(rows[0]?.counts, { recommendations: 7, associations: 0, assets: 0 });
});

test('agentSpaceActivityRows returns no rows for accounts without spaces', () => {
  const rows = agentSpaceActivityRows(spacesDTO([account({ hasNoSpaces: true, spaces: [] })]));
  assert.equal(rows.length, 0);
});
