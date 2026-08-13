import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BusinessContext } from '@devops-observatory/shared-types';
import {
  buildGraphResponse,
  displayLabelFor,
  enrichEdges,
  enrichNode,
  fallbackLabel,
  isEmptyGraph,
  isMemoryAsset,
  truncate,
  unavailableGraph,
  type RawGraphEdge,
  type RawGraphNode,
  LABEL_MAX,
} from '../shared/graphEnrichment';

/**
 * Unit tests for the pure `GET /graph` enrichment core (Task 8).
 *
 * These exercise the deterministic label / overlay / cross-account logic the
 * handler delegates to, mirroring the transform-time rules in
 * `scripts/04_transform_to_graph.py`.
 *
 * Requirements: 7.1 (node/edge JSON), 7.3 + 9.1/9.8 (human-friendly / typed
 * fallback labels, never the raw UUID), 7.6 (cross-account TARGETS_ACCOUNT
 * flagging), 7.7 (unavailable reason categories), 9.9 (latest business-context
 * overlay at query time).
 *
 * Run with: `node --import tsx --test amplify/functions/graph/graphEnrichment.test.ts`
 */

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

function node(id: string, label: string, properties: Record<string, unknown> = {}): RawGraphNode {
  return { id, labels: [label], properties };
}

// ---------------------------------------------------------------------------
// truncate / fallbackLabel (Requirements 9.6, 9.7, 9.8)
// ---------------------------------------------------------------------------

test('truncate leaves short text unchanged and trims whitespace', () => {
  assert.equal(truncate('  hello  '), 'hello');
  assert.equal(truncate(''), '');
  assert.equal(truncate(undefined), '');
});

test('truncate caps long text at the limit with an ellipsis (never exceeding it)', () => {
  const long = 'a'.repeat(LABEL_MAX + 50);
  const result = truncate(long);
  assert.equal(result.length, LABEL_MAX);
  assert.ok(result.endsWith('…'));
});

test('fallbackLabel is "<Type> …<last 8 of id>" derived from the id suffix (Req 9.8)', () => {
  assert.equal(fallbackLabel('Association', 'assoc:0123456789abcdef'), 'Association …89abcdef');
  assert.equal(fallbackLabel('Account', 'acct:345678901234'), 'Account …78901234');
});

// ---------------------------------------------------------------------------
// displayLabelFor per node type (Requirements 9.1–9.5, 9.8)
// ---------------------------------------------------------------------------

test('displayLabelFor derives friendly labels per type, else the typed fallback', () => {
  assert.equal(displayLabelFor('Account', { displayName: 'Payments Prod' }, 'acct:1'), 'Payments Prod');
  assert.equal(displayLabelFor('Account', { name: 'raw-name' }, 'acct:1'), 'raw-name');
  assert.equal(displayLabelFor('AgentSpace', { name: 'Ops Space' }, 'space:1'), 'Ops Space');
  assert.equal(
    displayLabelFor('Asset', { assetType: 'Repo', assetName: 'api' }, 'asset:1'),
    'Repo: api',
  );
  assert.equal(displayLabelFor('AwsService', { name: 's3' }, 'svc:s3'), 's3');
  assert.equal(displayLabelFor('Investigation', { summary: 'Disk full' }, 'inv:1'), 'Disk full');
  assert.equal(displayLabelFor('Recommendation', { title: 'Scale up' }, 'rec:1'), 'Scale up');
  assert.equal(
    displayLabelFor('ExternalTarget', { kind: 'github', ref: 'org/repo' }, 'ext:1'),
    'github: org/repo',
  );
  // No friendly field -> typed fallback, never the raw id.
  assert.equal(displayLabelFor('Association', {}, 'assoc:abcdef1234567890'), 'Association …34567890');
});

// ---------------------------------------------------------------------------
// enrichNode — label rules + query-time business-context overlay
// ---------------------------------------------------------------------------

test('enrichNode never uses the raw UUID as the displayLabel (Req 7.3, 9.8)', () => {
  const enriched = enrichNode(node('assoc:11112222333344445555', 'Association'), null);
  assert.equal(enriched.type, 'Association');
  assert.notEqual(enriched.displayLabel, 'assoc:11112222333344445555');
  assert.equal(enriched.displayLabel, 'Association …44445555');
});

test('enrichNode overlays the LATEST account display name over the baked one (Req 9.9)', () => {
  const raw = node('acct:345678901234', 'Account', {
    accountId: '345678901234',
    displayName: 'Old Name',
    displayLabel: 'Old Name',
  });
  const ctx = context([], { '345678901234': 'Payments Prod' });
  const enriched = enrichNode(raw, ctx);
  // Newest display name wins over the transform-time value.
  assert.equal(enriched.displayLabel, 'Payments Prod');
});

test('enrichNode overlays the latest Business_Unit onto Account nodes (Req 9.9)', () => {
  const raw = node('acct:111111111111', 'Account', { accountId: '111111111111' });
  const ctx = context([{ name: 'Platform', accounts: ['111111111111'] }]);
  const enriched = enrichNode(raw, ctx);
  assert.equal(enriched.businessUnit, 'Platform');
});

test('enrichNode uses the id suffix as the account id when no accountId prop exists', () => {
  const raw = node('acct:222222222222', 'Account');
  const ctx = context([{ name: 'Retail', accounts: ['222222222222'] }], {
    '222222222222': 'Retail Prod',
  });
  const enriched = enrichNode(raw, ctx);
  assert.equal(enriched.displayLabel, 'Retail Prod');
  assert.equal(enriched.businessUnit, 'Retail');
});

test('enrichNode metadata excludes the derived labels to avoid duplication', () => {
  const raw = node('svc:s3', 'AwsService', { name: 's3', displayLabel: 's3' });
  const enriched = enrichNode(raw, null);
  assert.equal(enriched.metadata?.displayLabel, undefined);
  assert.equal(enriched.metadata?.businessUnit, undefined);
  assert.equal(enriched.metadata?.name, 's3');
});

test('enrichNode with no context falls back to raw account id label', () => {
  const raw = node('acct:999999999999', 'Account', { accountId: '999999999999' });
  const enriched = enrichNode(raw, null);
  // No name/displayName and no context -> typed fallback (not the raw prefixed id).
  assert.equal(enriched.displayLabel, 'Account …99999999');
  assert.equal(enriched.businessUnit, undefined);
});

// ---------------------------------------------------------------------------
// enrichEdges — cross-account TARGETS_ACCOUNT flagging (Requirement 7.6)
// ---------------------------------------------------------------------------

/**
 * Topology: Account A owns a space + association that targets Account B.
 *   acct:A -HAS_SPACE-> space:S -HAS_ASSOCIATION-> assoc:X -TARGETS_ACCOUNT-> acct:B
 */
function crossAccountEdges(targetAccount: string): RawGraphEdge[] {
  return [
    { from: 'acct:A', to: 'space:S', type: 'HAS_SPACE' },
    { from: 'space:S', to: 'assoc:X', type: 'HAS_ASSOCIATION' },
    { from: 'assoc:X', to: targetAccount, type: 'TARGETS_ACCOUNT' },
  ];
}

test('a TARGETS_ACCOUNT edge to a DIFFERENT account is crossAccount: true (Req 7.6)', () => {
  const edges = enrichEdges(crossAccountEdges('acct:B'));
  const targets = edges.find((e) => e.type === 'TARGETS_ACCOUNT');
  assert.equal(targets?.crossAccount, true);
});

test('a TARGETS_ACCOUNT edge back to the OWNING account is crossAccount: false (Req 7.6)', () => {
  const edges = enrichEdges(crossAccountEdges('acct:A'));
  const targets = edges.find((e) => e.type === 'TARGETS_ACCOUNT');
  assert.equal(targets?.crossAccount, false);
});

test('non-TARGETS_ACCOUNT edges are never flagged cross-account', () => {
  const edges = enrichEdges(crossAccountEdges('acct:B'));
  for (const e of edges.filter((edge) => edge.type !== 'TARGETS_ACCOUNT')) {
    assert.equal(e.crossAccount, false);
  }
});

test('a TARGETS_ACCOUNT edge with an unknown owner is not flagged cross-account', () => {
  // Only the TARGETS_ACCOUNT edge is present; the owning account cannot be resolved.
  const edges = enrichEdges([{ from: 'assoc:orphan', to: 'acct:B', type: 'TARGETS_ACCOUNT' }]);
  assert.equal(edges[0]?.crossAccount, false);
});

// ---------------------------------------------------------------------------
// buildGraphResponse — full shape (Requirement 7.1)
// ---------------------------------------------------------------------------

test('buildGraphResponse returns enriched node/edge JSON in the API shape (Req 7.1)', () => {
  const nodes: RawGraphNode[] = [
    node('acct:A', 'Account', { accountId: 'A' }),
    node('space:S', 'AgentSpace', { name: 'Ops' }),
    node('assoc:X', 'Association'),
    node('acct:B', 'Account', { accountId: 'B' }),
  ];
  const response = buildGraphResponse(nodes, crossAccountEdges('acct:B'), null);
  assert.equal(response.nodes.length, 4);
  assert.equal(response.edges.length, 3);
  // Node contract: id, type, displayLabel present; every node has a non-UUID label.
  for (const n of response.nodes) {
    assert.ok(n.id.length > 0);
    assert.ok(n.type.length > 0);
    assert.ok(n.displayLabel.length > 0);
    assert.notEqual(n.displayLabel, n.id);
  }
  const cross = response.edges.find((e) => e.type === 'TARGETS_ACCOUNT');
  assert.equal(cross?.crossAccount, true);
  assert.equal(response.unavailableReason, undefined);
});

// ---------------------------------------------------------------------------
// unavailableGraph / isEmptyGraph (Requirement 7.7)
// ---------------------------------------------------------------------------

test('unavailableGraph returns an empty graph plus the reason category (Req 7.7)', () => {
  for (const reason of ['graph_unavailable', 'query_failed', 'empty'] as const) {
    const g = unavailableGraph(reason);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.equal(g.unavailableReason, reason);
  }
});

test('isEmptyGraph is true only when there are no nodes', () => {
  assert.equal(isEmptyGraph({ nodes: [], edges: [] }), true);
  assert.equal(isEmptyGraph(buildGraphResponse([node('acct:A', 'Account')], [], null)), false);
});

// ---------------------------------------------------------------------------
// Memory-asset filtering
// ---------------------------------------------------------------------------

test('isMemoryAsset matches Asset nodes with a memory* assetType only', () => {
  const asset = (assetType: string): RawGraphNode => ({
    id: `asset:s1:${assetType}`,
    labels: ['Asset'],
    properties: { assetType },
  });
  assert.equal(isMemoryAsset(asset('memory')), true);
  assert.equal(isMemoryAsset(asset('memory_store')), true);
  assert.equal(isMemoryAsset(asset('Memory')), true); // case-insensitive
  assert.equal(isMemoryAsset(asset('skill')), false);
  assert.equal(isMemoryAsset(asset('artifact')), false);
  // Non-asset nodes are never memory assets even with a stray property.
  assert.equal(
    isMemoryAsset({ id: 'space:s1', labels: ['AgentSpace'], properties: { assetType: 'memory' } }),
    false,
  );
});

test('buildGraphResponse drops memory assets and edges that touch them', () => {
  const nodes: RawGraphNode[] = [
    { id: 'space:s1', labels: ['AgentSpace'], properties: { name: 'Space 1' } },
    { id: 'asset:s1:skill', labels: ['Asset'], properties: { assetType: 'skill', assetName: 'k' } },
    { id: 'asset:s1:mem', labels: ['Asset'], properties: { assetType: 'memory', assetName: 'm' } },
    { id: 'asset:s1:ms', labels: ['Asset'], properties: { assetType: 'memory_store' } },
  ];
  const edges: RawGraphEdge[] = [
    { from: 'space:s1', to: 'asset:s1:skill', type: 'HAS_ASSET' },
    { from: 'space:s1', to: 'asset:s1:mem', type: 'HAS_ASSET' },
    { from: 'space:s1', to: 'asset:s1:ms', type: 'HAS_ASSET' },
  ];
  const res = buildGraphResponse(nodes, edges, null);
  const ids = res.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['asset:s1:skill', 'space:s1']);
  // Only the edge to the surviving skill asset remains.
  assert.deepEqual(res.edges, [{ from: 'space:s1', to: 'asset:s1:skill', type: 'HAS_ASSET', crossAccount: false }]);
});
