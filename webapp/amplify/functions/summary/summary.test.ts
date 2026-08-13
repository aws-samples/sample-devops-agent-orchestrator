import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestSpaceCounts, Manifest, ManifestAccount } from '@devops-observatory/shared-types';
import { buildSummary, unavailableSummary } from '../shared/aggregation';

/**
 * Tests for the `GET /summary` logic (Task 4.1).
 *
 * The handler is a thin wrapper that loads `raw/_manifest.json` and delegates
 * shaping to {@link buildSummary} (or {@link unavailableSummary} when the
 * manifest is unavailable). These tests exercise that summary-building logic:
 * the incident mapping (incident == investigation — the INVESTIGATION backlog
 * task count), agent-space usage totals, multi-account aggregation, and
 * Last_Sync_Date freshness.
 *
 * Run with: `node --import tsx --test amplify/functions/summary/summary.test.ts`
 *
 * Requirements: 6.1 (incidents), 6.2 (investigations), 6.3 (agent-space usage),
 * 11.1 (landing metrics + Last_Sync_Date), 4.3/4.4 (freshness unknown), 12.5
 * (sum across all accounts).
 */

/**
 * Build per-space counts. `incidents` mirrors `investigations` — the collector
 * records the same INVESTIGATION-backlog-task count under both names, since an
 * incident and an investigation are the same thing.
 */
function counts(
  investigations: number,
  recommendations: number,
  associations = 0,
  assets = 0,
  capabilities: Partial<ManifestSpaceCounts> = {},
): ManifestSpaceCounts {
  return {
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
  };
}

function account(
  id: string,
  spaces: ManifestAccount['spaces'],
  error?: string,
): ManifestAccount {
  return { account: id, error, spaces, usage: null };
}

function manifest(accounts: ManifestAccount[], collectedAt = '2026-07-01T12:00:00Z'): Manifest {
  return { collectedAt, region: 'us-east-1', accounts };
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

// ---------------------------------------------------------------------------
// Incident mapping + totals (Requirements 6.1, 6.2, 6.3)
// ---------------------------------------------------------------------------

test('incidents == investigations (recommendations are a separate metric)', () => {
  const dto = buildSummary(
    manifest([
      account('111111111111', [
        { agentSpaceId: 'space-a', name: 'A', counts: counts(4, 5, 2, 3) },
      ]),
    ]),
  );
  // 4 investigations == 4 incidents; the 5 recommendations are NOT folded in.
  assert.equal(dto.totals.incidents, 4);
  assert.equal(dto.totals.investigations, 4);
  assert.equal(dto.totals.agentSpaces, 1);
});

test('totals are summed across all manifest accounts (Req 12.5)', () => {
  const dto = buildSummary(
    manifest([
      account('111111111111', [
        { agentSpaceId: 's1', counts: counts(2, 3, 1, 1) },
        { agentSpaceId: 's2', counts: counts(1, 1) },
      ]),
      account('222222222222', [
        { agentSpaceId: 's3', counts: counts(10, 0, 5, 5) },
      ]),
    ]),
  );
  // investigations: 2 + 1 + 10 = 13; incidents equals investigations.
  assert.equal(dto.totals.investigations, 13);
  assert.equal(dto.totals.incidents, 13);
  assert.equal(dto.totals.agentSpaces, 3);
});

// ---------------------------------------------------------------------------
// Zero / empty handling (Requirements 6.7, 6.8)
// ---------------------------------------------------------------------------

test('zero metrics are present as 0, not omitted', () => {
  const dto = buildSummary(
    manifest([account('111111111111', [{ agentSpaceId: 's1', counts: counts(0, 0) }])]),
  );
  assert.equal(dto.totals.incidents, 0);
  assert.equal(dto.totals.investigations, 0);
  assert.equal(dto.totals.agentSpaces, 1);
});

test('an empty manifest yields explicit zero totals', () => {
  const dto = buildSummary(manifest([]));
  assert.deepEqual(dto.totals, zeroTotals());
});

test('an account with no spaces contributes zero but is still counted in scope', () => {
  const dto = buildSummary(manifest([account('111111111111', [])]));
  assert.deepEqual(dto.totals, zeroTotals());
});

test('capability counts (telemetry … users) roll up into the org-wide summary totals', () => {
  const dto = buildSummary(
    manifest([
      account('111111111111', [
        {
          agentSpaceId: 's1',
                    counts: counts(0, 0, 0, 0, { telemetry: 1, pipelines: 2, webhooks: 1, logDeliveries: 2 }),
        },
      ]),
      account('222222222222', [
        {
          agentSpaceId: 's2',
                    counts: counts(0, 0, 0, 0, { telemetry: 2, communications: 1, mcpServers: 1, remoteAgents: 1, users: 3 }),
        },
      ]),
    ]),
  );
  assert.deepEqual(dto.totals, {
    ...zeroTotals(),
    agentSpaces: 2,
    telemetry: 3,
    pipelines: 2,
    communications: 1,
    mcpServers: 1,
    remoteAgents: 1,
    webhooks: 1,
    logDeliveries: 2,
    users: 3,
  });
});

// ---------------------------------------------------------------------------
// Last_Sync_Date freshness (Requirements 4.1, 4.3, 4.4, 11.1)
// ---------------------------------------------------------------------------

test('a valid collectedAt is surfaced verbatim as lastSyncDate', () => {
  const dto = buildSummary(manifest([], '2026-07-01T12:00:00Z'));
  assert.equal(dto.lastSyncDate, '2026-07-01T12:00:00Z');
});

test('a missing collectedAt resolves to "unknown"', () => {
  const dto = buildSummary(manifest([], ''));
  assert.equal(dto.lastSyncDate, 'unknown');
});

test('an invalid collectedAt resolves to "unknown" rather than the raw value', () => {
  const dto = buildSummary(manifest([], 'not-a-date'));
  assert.equal(dto.lastSyncDate, 'unknown');
});

// ---------------------------------------------------------------------------
// Unavailable manifest (Requirement 4.3)
// ---------------------------------------------------------------------------

test('unavailableSummary returns zeroed totals and freshness unknown', () => {
  const dto = unavailableSummary();
  assert.deepEqual(dto.totals, zeroTotals());
  assert.equal(dto.lastSyncDate, 'unknown');
});

// ---------------------------------------------------------------------------
// Randomized invariants (lightweight property-style checks, no extra deps)
// ---------------------------------------------------------------------------

test('invariant: incidents == investigations, totals non-negative integers', () => {
  // Simple seeded PRNG (mulberry32) for deterministic, reproducible runs.
  let seed = 0x9e3779b9;
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
    const numAccounts = int(4);
    let expectedInvestigations = 0;
    let expectedSpaces = 0;
    for (let a = 0; a < numAccounts; a++) {
      const spaces: ManifestAccount['spaces'] = [];
      const numSpaces = int(3);
      for (let s = 0; s < numSpaces; s++) {
        const investigations = int(50);
        const recommendations = int(50);
        expectedInvestigations += investigations;
        expectedSpaces += 1;
        spaces.push({
          agentSpaceId: `acct${a}-space${s}`,
                    counts: counts(investigations, recommendations, int(20), int(20)),
        });
      }
      accounts.push(account(`account-${a}`, spaces));
    }

    const { totals } = buildSummary(manifest(accounts));

    assert.equal(totals.investigations, expectedInvestigations);
    assert.equal(totals.incidents, expectedInvestigations);
    assert.equal(totals.agentSpaces, expectedSpaces);
    for (const value of Object.values(totals)) {
      assert.ok(Number.isInteger(value) && value >= 0, `expected non-negative integer, got ${value}`);
    }
  }
});
