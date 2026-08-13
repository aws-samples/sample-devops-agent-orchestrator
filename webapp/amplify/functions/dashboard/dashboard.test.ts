import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AggregateTotals,
  BusinessContext,
  Manifest,
  ManifestAccount,
} from '@devops-observatory/shared-types';
import { buildDashboard, unavailableDashboard } from '../shared/aggregation';

/**
 * Tests for the `GET /dashboard` logic (Task 4.3).
 *
 * The handler is a thin wrapper that loads `raw/_manifest.json` +
 * `hub/business_context.json` and delegates shaping to {@link buildDashboard}
 * (or {@link unavailableDashboard} when the manifest is unavailable). These
 * tests exercise the aggregation core: totals across all manifest accounts,
 * the incident mapping (incident == investigation — the INVESTIGATION backlog
 * task count; recommendations are a separate metric), grouping selection
 * (by-Business_Unit when context assigns any account, else by account), the
 * "Unassigned" bucket, zero rendered as `0`, new accounts being picked up
 * automatically, and the empty / no-data branch.
 *
 * Run with: `node --import tsx --test amplify/functions/dashboard/dashboard.test.ts`
 *
 * Requirements: 6.4 (by-BU breakdown), 6.5 (by-account fallback), 6.6 (accurate
 * aggregation), 6.7 (zero as 0), 6.8 (no-data when empty), 12.1/12.5 (sum across
 * all accounts), 12.3 (new accounts picked up), 12.6 (aggregate totals),
 * 12.7 (Unassigned bucket).
 */

function account(
  id: string,
  spaces: ManifestAccount['spaces'],
  error?: string,
): ManifestAccount {
  return { account: id, error, spaces, usage: null };
}

/**
 * Build a space. `incidents` mirrors `investigations` (the collector records
 * the same INVESTIGATION-backlog-task count under both names), and
 * recommendations are a separate metric not folded into incidents.
 */
function space(
  agentSpaceId: string,
  investigations: number,
  recommendations: number,
  associations = 0,
  assets = 0,
  capabilities: Partial<ManifestAccount['spaces'][number]['counts']> = {},
): ManifestAccount['spaces'][number] {
  return {
    agentSpaceId,
        counts: {
      associations,
      assets,
      investigations,
      incidents: investigations,
      recommendations,
      telemetry: 0,
      pipelines: 0,
      communications: 0,
      mcpServers: 0,
      remoteAgents: 0,
      webhooks: 0,
      logDeliveries: 0,
      users: 0,
      ...capabilities,
    },
  };
}

function manifest(accounts: ManifestAccount[], collectedAt = '2026-07-01T12:00:00Z'): Manifest {
  return { collectedAt, region: 'us-east-1', accounts };
}

function context(
  businessUnits: BusinessContext['businessUnits'],
  accountDisplayNames: Record<string, string> = {},
): BusinessContext {
  return {
    version: 1,
    updatedAt: '2026-07-01T12:00:00Z',
    businessUnits,
    accountDisplayNames,
    accountContext: {},
  };
}

/** Look up a breakdown row by key (order-independent assertions). */
function row(dto: ReturnType<typeof buildDashboard>, key: string) {
  return dto.breakdown.find((r) => r.key === key);
}

/** Fully-zeroed aggregate totals (activity + capability rollups). */
function zeroTotals() {
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

/**
 * Per-key sum of two aggregate-totals objects (test-side reimplementation).
 * Mirrors the production null propagation: unknown (+) anything = unknown.
 */
function addAll(a: AggregateTotals, b: AggregateTotals): AggregateTotals {
  // Written via a uniform record so a mixed-nullability union key can be
  // assigned in the loop; the shape matches AggregateTotals exactly.
  const out = zeroTotals() as Record<keyof AggregateTotals, number | null>;
  for (const k of Object.keys(out) as Array<keyof AggregateTotals>) {
    const left = a[k];
    const right = b[k];
    out[k] = left === null || right === null ? null : left + right;
  }
  return out as AggregateTotals;
}

// ---------------------------------------------------------------------------
// Totals aggregation across all accounts (Requirements 6.6, 12.1, 12.5, 12.6)
// ---------------------------------------------------------------------------

test('totals sum incidents/investigations/agentSpaces across every account (Req 12.5)', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 2, 3), space('s2', 1, 1)]),
      account('222222222222', [space('s3', 10, 0)]),
    ]),
    null,
  );
  // investigations: 2 + 1 + 10 = 13; incidents equals investigations.
  assert.equal(dto.totals.investigations, 13);
  assert.equal(dto.totals.incidents, 13);
  assert.equal(dto.totals.agentSpaces, 3);
});

test('incident mapping matches Summary: incident == investigation (Req 6.6)', () => {
  const dto = buildDashboard(manifest([account('111111111111', [space('s1', 4, 5)])]), null);
  // 4 investigations == 4 incidents; the 5 recommendations are not folded in.
  assert.equal(dto.totals.incidents, 4);
  assert.equal(dto.totals.investigations, 4);
});

// ---------------------------------------------------------------------------
// Grouping selection: by business unit vs by account (Requirements 6.4, 6.5)
// ---------------------------------------------------------------------------

test('groups by account when business context is absent (Req 6.5)', () => {
  const dto = buildDashboard(
    manifest([account('111111111111', [space('s1', 1, 1)])]),
    null,
  );
  assert.equal(dto.grouping, 'account');
  assert.equal(dto.breakdown.length, 1);
  assert.equal(dto.breakdown[0]?.key, '111111111111');
});

test('groups by account when context exists but assigns no accounts to a BU (Req 6.5)', () => {
  const dto = buildDashboard(
    manifest([account('111111111111', [space('s1', 1, 1)])]),
    context([{ name: 'Empty BU', accounts: [] }], { '111111111111': 'Payments' }),
  );
  // No BU has any accounts -> fall back to by-account grouping, using display names.
  assert.equal(dto.grouping, 'account');
  assert.equal(row(dto, 'Payments')?.totals.incidents, 1);
});

test('groups by Business_Unit when context assigns at least one account (Req 6.4)', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 2, 1)]),
      account('222222222222', [space('s2', 3, 0)]),
    ]),
    context([{ name: 'Platform', accounts: ['111111111111', '222222222222'] }]),
  );
  assert.equal(dto.grouping, 'businessUnit');
  assert.equal(dto.breakdown.length, 1);
  // Platform: investigations 2+3=5 == incidents 5.
  assert.equal(row(dto, 'Platform')?.totals.incidents, 5);
  assert.equal(row(dto, 'Platform')?.totals.investigations, 5);
  assert.equal(row(dto, 'Platform')?.totals.agentSpaces, 2);
});

test('multiple accounts in one BU are combined into a single row (Req 12.6)', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 1, 1)]),
      account('222222222222', [space('s2', 2, 2)]),
      account('333333333333', [space('s3', 4, 0)]),
    ]),
    context([
      { name: 'Retail', accounts: ['111111111111', '222222222222'] },
      { name: 'Media', accounts: ['333333333333'] },
    ]),
  );
  assert.equal(dto.grouping, 'businessUnit');
  // Retail: inv 1+2=3 == incidents 3, 2 spaces
  assert.equal(row(dto, 'Retail')?.totals.incidents, 3);
  assert.equal(row(dto, 'Retail')?.totals.agentSpaces, 2);
  // Media: inv 4 == incidents 4, 1 space
  assert.equal(row(dto, 'Media')?.totals.incidents, 4);
  assert.equal(row(dto, 'Media')?.totals.agentSpaces, 1);
});

// ---------------------------------------------------------------------------
// Unassigned bucket (Requirement 12.7)
// ---------------------------------------------------------------------------

test('accounts not in any BU fall into the "Unassigned" bucket (Req 12.7)', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 2, 1)]),
      account('999999999999', [space('s2', 5, 5)]),
    ]),
    context([{ name: 'Platform', accounts: ['111111111111'] }]),
  );
  assert.equal(dto.grouping, 'businessUnit');
  assert.equal(row(dto, 'Platform')?.totals.incidents, 2);
  // Unassigned holds the unlabelled account: inv 5 == incidents 5.
  assert.equal(row(dto, 'Unassigned')?.totals.incidents, 5);
  assert.equal(row(dto, 'Unassigned')?.totals.investigations, 5);
  assert.equal(row(dto, 'Unassigned')?.totals.agentSpaces, 1);
});

test('breakdown row totals sum back to the aggregate totals', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 2, 1)]),
      account('222222222222', [space('s2', 3, 4)]),
      account('999999999999', [space('s3', 5, 5)]),
    ]),
    context([{ name: 'Platform', accounts: ['111111111111', '222222222222'] }]),
  );
  const summed = dto.breakdown.reduce<AggregateTotals>((acc, r) => addAll(acc, r.totals), zeroTotals());
  assert.deepEqual(summed, dto.totals);
});

// ---------------------------------------------------------------------------
// Capability rollups (telemetry / pipelines / communications / MCP servers /
// remote agents / webhooks / log deliveries / users) per BU and org-wide
// ---------------------------------------------------------------------------

test('capability counts roll up per business unit and organization-wide', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [
        space('s1', 0, 0, 0, 0, { telemetry: 2, pipelines: 1, webhooks: 3, users: 4 }),
        space('s2', 0, 0, 0, 0, { telemetry: 1, mcpServers: 2, logDeliveries: 1 }),
      ]),
      account('222222222222', [
        space('s3', 0, 0, 0, 0, { communications: 2, remoteAgents: 1, users: 1 }),
      ]),
    ]),
    context([{ name: 'Platform', accounts: ['111111111111'] }]),
  );

  // Per-BU: the two Platform spaces sum; the unassigned account is separate.
  assert.deepEqual(row(dto, 'Platform')?.totals, {
    ...zeroTotals(),
    agentSpaces: 2,
    telemetry: 3,
    pipelines: 1,
    mcpServers: 2,
    webhooks: 3,
    logDeliveries: 1,
    users: 4,
  });
  assert.deepEqual(row(dto, 'Unassigned')?.totals, {
    ...zeroTotals(),
    agentSpaces: 1,
    communications: 2,
    remoteAgents: 1,
    users: 1,
  });

  // Organization-wide totals include every account.
  assert.equal(dto.totals.telemetry, 3);
  assert.equal(dto.totals.pipelines, 1);
  assert.equal(dto.totals.communications, 2);
  assert.equal(dto.totals.mcpServers, 2);
  assert.equal(dto.totals.remoteAgents, 1);
  assert.equal(dto.totals.webhooks, 3);
  assert.equal(dto.totals.logDeliveries, 1);
  assert.equal(dto.totals.users, 5);
});

test('an unknown (null) capability metric is treated as 0 in rollups so totals stay meaningful', () => {
  const dto = buildDashboard(
    manifest([
      account('111111111111', [
        // webhooks could not be counted for this space (collection error).
        space('s1', 0, 0, 0, 0, { telemetry: 2, webhooks: null }),
        space('s2', 0, 0, 0, 0, { telemetry: 1, webhooks: 1 }),
      ]),
      account('222222222222', [space('s3', 0, 0, 0, 0, { webhooks: 2, users: null })]),
    ]),
    context([
      { name: 'Platform', accounts: ['111111111111'] },
      { name: 'Retail', accounts: ['222222222222'] },
    ]),
  );

  // Platform: telemetry fully known (3); webhooks: 0(null) + 1 = 1 (unknown
  // treated as 0 so the rollup shows the measurable portion).
  const platform = row(dto, 'Platform')?.totals;
  assert.equal(platform?.telemetry, 3);
  assert.equal(platform?.webhooks, 1);

  // Retail: webhooks known (2); users unknown -> 0.
  const retail = row(dto, 'Retail')?.totals;
  assert.equal(retail?.webhooks, 2);
  assert.equal(retail?.users, 0);

  // Org-wide: sums all, treating unknowns as 0.
  assert.equal(dto.totals.webhooks, 3); // 0 + 1 + 2
  assert.equal(dto.totals.users, 0); // 0 + 0 (null treated as 0)
  assert.equal(dto.totals.telemetry, 3);
});

// ---------------------------------------------------------------------------
// New accounts picked up with no code change (Requirement 12.3)
// ---------------------------------------------------------------------------

test('a newly added manifest account appears without any code change (Req 12.3)', () => {
  const before = buildDashboard(manifest([account('111111111111', [space('s1', 1, 1)])]), null);
  assert.equal(before.breakdown.length, 1);

  const after = buildDashboard(
    manifest([
      account('111111111111', [space('s1', 1, 1)]),
      account('222222222222', [space('s2', 2, 2)]),
    ]),
    null,
  );
  assert.equal(after.breakdown.length, 2);
  assert.ok(row(after, '222222222222'), 'the new account has its own by-account row');
  assert.equal(after.totals.agentSpaces, 2);
});

// ---------------------------------------------------------------------------
// Zero handling (Requirement 6.7)
// ---------------------------------------------------------------------------

test('zero metrics are present as 0, not omitted (Req 6.7)', () => {
  const dto = buildDashboard(
    manifest([account('111111111111', [space('s1', 0, 0)])]),
    null,
  );
  assert.equal(dto.totals.incidents, 0);
  assert.equal(dto.totals.investigations, 0);
  // A single space still counts toward agent-space usage.
  assert.equal(dto.totals.agentSpaces, 1);
  const r = row(dto, '111111111111');
  // incidents/investigations (and every capability rollup) are explicit zeros;
  // the one space is still counted.
  assert.deepEqual(r?.totals, { ...zeroTotals(), agentSpaces: 1 });
});

test('a BU with only zero-activity accounts still yields explicit-zero incident/investigation counts (Req 6.7)', () => {
  const dto = buildDashboard(
    manifest([account('111111111111', [space('s1', 0, 0)])]),
    context([{ name: 'Quiet BU', accounts: ['111111111111'] }]),
  );
  assert.equal(dto.grouping, 'businessUnit');
  // Zero incidents/investigations are present as 0 (not omitted); the space is counted.
  assert.deepEqual(row(dto, 'Quiet BU')?.totals, { ...zeroTotals(), agentSpaces: 1 });
});

test('a BU whose account has no spaces yields fully-zero totals (Req 6.7)', () => {
  const dto = buildDashboard(
    manifest([account('111111111111', [])]),
    context([{ name: 'Empty-space BU', accounts: ['111111111111'] }]),
  );
  assert.equal(dto.grouping, 'businessUnit');
  assert.deepEqual(row(dto, 'Empty-space BU')?.totals, zeroTotals());
});

// ---------------------------------------------------------------------------
// Empty / no-data branch (Requirement 6.8)
// ---------------------------------------------------------------------------

test('an empty manifest yields zero totals and an empty breakdown (Req 6.8)', () => {
  const dto = buildDashboard(manifest([]), null);
  assert.deepEqual(dto.totals, zeroTotals());
  assert.equal(dto.breakdown.length, 0);
});

test('an empty manifest with business context still produces no fabricated rows (Req 6.8)', () => {
  const dto = buildDashboard(manifest([]), context([{ name: 'Platform', accounts: ['111111111111'] }]));
  // Context assigns an account, so grouping is by BU, but no manifest accounts
  // exist -> the breakdown is empty (no fabricated partial counts).
  assert.equal(dto.grouping, 'businessUnit');
  assert.equal(dto.breakdown.length, 0);
  assert.deepEqual(dto.totals, zeroTotals());
});

test('unavailableDashboard returns zeroed totals, empty breakdown, freshness unknown (Req 6.8)', () => {
  const dto = unavailableDashboard();
  assert.deepEqual(dto.totals, zeroTotals());
  assert.equal(dto.breakdown.length, 0);
  assert.equal(dto.grouping, 'account');
  assert.equal(dto.lastSyncDate, 'unknown');
});

// ---------------------------------------------------------------------------
// Last_Sync_Date passthrough (freshness, Requirement 4.x)
// ---------------------------------------------------------------------------

test('a valid collectedAt is surfaced verbatim as lastSyncDate', () => {
  const dto = buildDashboard(manifest([], '2026-07-01T12:00:00Z'), null);
  assert.equal(dto.lastSyncDate, '2026-07-01T12:00:00Z');
});

test('an invalid collectedAt resolves to "unknown"', () => {
  const dto = buildDashboard(manifest([], 'not-a-date'), null);
  assert.equal(dto.lastSyncDate, 'unknown');
});

// ---------------------------------------------------------------------------
// Randomized invariants (lightweight property-style checks, no extra deps)
// ---------------------------------------------------------------------------

test('invariant: totals == sum of breakdown rows, all non-negative integers', () => {
  // Simple seeded PRNG (mulberry32) for deterministic, reproducible runs.
  let seed = 0x1234abcd;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(rand() * (max + 1));

  for (let iter = 0; iter < 200; iter++) {
    const accounts: ManifestAccount[] = [];
    const numAccounts = int(5);
    const accountIds: string[] = [];
    let expInv = 0;
    let expSpaces = 0;
    for (let a = 0; a < numAccounts; a++) {
      const id = `account-${a}`;
      accountIds.push(id);
      const spaces: ManifestAccount['spaces'] = [];
      const numSpaces = int(3);
      for (let s = 0; s < numSpaces; s++) {
        const inv = int(40);
        const rec = int(40);
        expInv += inv;
        expSpaces += 1;
        spaces.push(space(`${id}-s${s}`, inv, rec, int(10), int(10)));
      }
      accounts.push(account(id, spaces));
    }

    // Randomly assign a subset of accounts to a business unit.
    const assigned = accountIds.filter(() => rand() < 0.5);
    const ctx = assigned.length > 0 ? context([{ name: 'BU-1', accounts: assigned }]) : null;

    const dto = buildDashboard(manifest(accounts), ctx);

    // Aggregate totals match the manual expectations (incident == investigation).
    assert.equal(dto.totals.investigations, expInv);
    assert.equal(dto.totals.incidents, expInv);
    assert.equal(dto.totals.agentSpaces, expSpaces);

    // Breakdown rows reconcile to the totals (every metric key).
    const summed = dto.breakdown.reduce<AggregateTotals>((acc, r) => addAll(acc, r.totals), zeroTotals());
    assert.deepEqual(summed, dto.totals);

    // Grouping selection invariant.
    assert.equal(dto.grouping, assigned.length > 0 ? 'businessUnit' : 'account');

    // All metrics are non-negative integers.
    for (const r of dto.breakdown) {
      for (const value of Object.values(r.totals)) {
        assert.ok(Number.isInteger(value) && value >= 0, `expected non-negative integer, got ${value}`);
      }
    }
  }
});
