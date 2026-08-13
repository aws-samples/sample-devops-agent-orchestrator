import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphResponse } from '@devops-observatory/shared-types';
import { MAX_TOPOLOGY_CHARS, summarizeTopology } from './graphContext';

/**
 * Tests for the GraphRAG topology summarizer (Task 29.4, Requirement 15.1).
 *
 * Run with: `node --import tsx --test amplify/functions/shared/graphContext.test.ts`
 */

function graph(): GraphResponse {
  return {
    nodes: [
      { id: 'a1', type: 'Account', displayLabel: 'Payments Prod' },
      { id: 'a2', type: 'Account', displayLabel: 'Fraud Prod' },
      { id: 's1', type: 'AgentSpace', displayLabel: 'payments-space' },
      { id: 'svc1', type: 'AwsService', displayLabel: 'Amazon EKS' },
    ],
    edges: [
      { from: 'a1', to: 's1', type: 'HAS_SPACE' },
      { from: 's1', to: 'svc1', type: 'USES' },
      { from: 's1', to: 'a2', type: 'TARGETS_ACCOUNT', crossAccount: true },
    ],
  };
}

test('summarizeTopology returns empty string for an empty graph (graceful skip)', () => {
  assert.equal(summarizeTopology({ nodes: [], edges: [] }), '');
});

test('summarizeTopology reports entity and relationship counts', () => {
  const s = summarizeTopology(graph());
  assert.match(s, /Entity counts:.*Account 2/);
  assert.match(s, /Relationships:.*HAS_SPACE 1/);
});

test('summarizeTopology highlights cross-account links by label', () => {
  const s = summarizeTopology(graph());
  assert.match(s, /Cross-account links \(1\):/);
  assert.match(s, /payments-space TARGETS_ACCOUNT Fraud Prod/);
});

test('summarizeTopology lists accounts with their connected resources by label + type', () => {
  const s = summarizeTopology(graph());
  assert.match(s, /Accounts and connected resources:/);
  assert.match(s, /Payments Prod: payments-space \(AgentSpace\)/);
});

test('summarizeTopology stamps freshness when a valid lastSyncDate is provided', () => {
  const s = summarizeTopology(graph(), { lastSyncDate: '2026-07-08T12:00:00Z' });
  assert.match(s, /Topology as of 2026-07-08T12:00:00Z \(UTC\)\./);
  const unknown = summarizeTopology(graph(), { lastSyncDate: 'unknown' });
  assert.ok(!/Topology as of/.test(unknown));
});

test('summarizeTopology self-bounds large lists via section caps', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => ({
    id: `n${i}`,
    type: 'Account' as const,
    displayLabel: `Account number ${i}`,
  }));
  const s = summarizeTopology({ nodes, edges: [] });
  // 2000 accounts collapse to a capped list + an "…and N more accounts" note.
  assert.match(s, /…and \d+ more accounts/);
  assert.ok(s.length <= MAX_TOPOLOGY_CHARS + '\n…(topology truncated)'.length);
});

test('summarizeTopology hard-truncates and marks it when over the char budget', () => {
  const s = summarizeTopology(graph(), { maxChars: 120 });
  assert.ok(s.length <= 120 + '\n…(topology truncated)'.length);
  assert.match(s, /…\(topology truncated\)/);
});
