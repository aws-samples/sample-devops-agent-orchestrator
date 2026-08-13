import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, GraphResponse } from '@devops-observatory/shared-types';
import {
  buildVisEdges,
  buildVisNodes,
  CROSS_ACCOUNT_EDGE_COLOR,
  fallbackNodeLabel,
  GRAPH_NODE_TYPES,
  graphUnavailableMessage,
  isCrossAccountEdge,
  isGraphUnavailable,
  legendEntries,
  nodeMetadataEntries,
  NODE_TYPE_STYLES,
  nodeTypeStyle,
  resolveNodeLabel,
  SAME_ACCOUNT_EDGE_COLOR,
  unavailableMessageForReason,
} from './graphView';

/**
 * Tests for the Graph_View presentation helpers (Task 14).
 *
 * Run with: `node --import tsx --test src/lib/graphView.test.ts`
 *
 * Requirements: 7.2 (per-type indicator + legend covering every node type),
 * 7.3/7.4 (human-friendly label + typed fallback, never the raw UUID alone),
 * 7.5 (business-meaningful metadata for node select), 7.6 (visually distinct
 * cross-account edges), 7.7 (unavailable-graph message + reason category).
 */

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'acct:345678901234',
    type: 'Account',
    displayLabel: 'Payments Prod',
    ...overrides,
  };
}

function graph(overrides: Partial<GraphResponse> = {}): GraphResponse {
  return { nodes: [node()], edges: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Per-type indicators + legend (Requirement 7.2)
// ---------------------------------------------------------------------------

test('every supported node type has a distinct color + shape indicator (Req 7.2)', () => {
  const colors = new Set<string>();
  const shapes = new Set<string>();
  for (const type of GRAPH_NODE_TYPES) {
    const style = NODE_TYPE_STYLES[type];
    assert.ok(style, `missing style for ${type}`);
    assert.ok(style.color.length > 0);
    colors.add(style.color);
    shapes.add(style.shape);
  }
  // Colors must be unique per type so the indicators are visually distinct.
  assert.equal(colors.size, GRAPH_NODE_TYPES.length, 'node type colors must be unique');
  // Shapes are drawn from a small set; at least several distinct shapes are used.
  assert.ok(shapes.size >= 5, 'expected a variety of distinct node shapes');
});

test('legend covers exactly every supported node type, in order (Req 7.2)', () => {
  const entries = legendEntries();
  assert.deepEqual(
    entries.map((e) => e.type),
    [...GRAPH_NODE_TYPES],
  );
  // Every entry maps a human label + indicator to its type.
  for (const entry of entries) {
    const style = NODE_TYPE_STYLES[entry.type];
    assert.equal(entry.color, style.color);
    assert.equal(entry.shape, style.shape);
    assert.equal(entry.label, style.label);
    assert.ok(entry.label.length > 0);
  }
  // Labels are business-oriented, not raw type identifiers.
  const agentSpace = entries.find((e) => e.type === 'AgentSpace');
  assert.equal(agentSpace?.label, 'Agent space');
  const awsService = entries.find((e) => e.type === 'AwsService');
  assert.equal(awsService?.label, 'AWS service');
  // Sanity: all 8 documented node types are present.
  assert.equal(entries.length, 8);
});

test('nodeTypeStyle falls back for unknown node types', () => {
  const style = nodeTypeStyle('SomethingNew');
  assert.equal(style.label, 'Other');
  assert.ok(style.color.length > 0);
});

// ---------------------------------------------------------------------------
// Node labels (Requirements 7.3, 7.4, 11.2)
// ---------------------------------------------------------------------------

test('resolveNodeLabel prefers the enriched displayLabel (Req 7.3)', () => {
  assert.equal(resolveNodeLabel(node({ displayLabel: 'Payments Prod' })), 'Payments Prod');
});

test('resolveNodeLabel falls back to a typed label, never the raw UUID alone (Req 7.4)', () => {
  const n = node({
    id: 'inv:0af1b2c3d4e5f6a7',
    type: 'Investigation',
    displayLabel: '',
    label: undefined,
  });
  const label = resolveNodeLabel(n);
  assert.equal(label, fallbackNodeLabel('Investigation', 'inv:0af1b2c3d4e5f6a7'));
  assert.match(label, /^Investigation …/);
  // The fallback must not be the bare id.
  assert.notEqual(label, n.id);
});

test('resolveNodeLabel uses a human-friendly raw label but not the id itself (Req 7.4)', () => {
  // A raw label that differs from the id is human-friendly enough to show.
  assert.equal(
    resolveNodeLabel(node({ displayLabel: '', label: 'Friendly Name' })),
    'Friendly Name',
  );
  // A raw label equal to the id must fall through to the typed fallback.
  const n = node({ id: 'svc:ec2', type: 'AwsService', displayLabel: '', label: 'svc:ec2' });
  assert.equal(resolveNodeLabel(n), fallbackNodeLabel('AwsService', 'svc:ec2'));
});

test('fallbackNodeLabel uses the last 8 chars of the id suffix (design)', () => {
  assert.equal(fallbackNodeLabel('Account', 'acct:345678901234'), 'Account …78901234');
  assert.equal(fallbackNodeLabel('Asset', 'short'), 'Asset …short');
});

// ---------------------------------------------------------------------------
// vis-network node shaping (Requirements 7.2, 7.3)
// ---------------------------------------------------------------------------

test('buildVisNodes carries the human label + per-type indicator (Req 7.2, 7.3)', () => {
  const [vis] = buildVisNodes([node({ type: 'AgentSpace', displayLabel: 'Prod Space' })]);
  assert.equal(vis?.label, 'Prod Space');
  assert.equal(vis?.group, 'AgentSpace');
  assert.equal(vis?.color.background, NODE_TYPE_STYLES.AgentSpace.color);
  assert.equal(vis?.shape, NODE_TYPE_STYLES.AgentSpace.shape);
});

// ---------------------------------------------------------------------------
// Cross-account edge styling (Requirement 7.6)
// ---------------------------------------------------------------------------

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { from: 'assoc:a', to: 'acct:b', type: 'TARGETS_ACCOUNT', ...overrides };
}

test('isCrossAccountEdge only flags edges marked crossAccount:true (Req 7.6)', () => {
  assert.equal(isCrossAccountEdge(edge({ crossAccount: true })), true);
  assert.equal(isCrossAccountEdge(edge({ crossAccount: false })), false);
  assert.equal(isCrossAccountEdge(edge({})), false);
});

test('buildVisEdges styles cross-account edges distinctly from same-account (Req 7.6)', () => {
  const [cross, same] = buildVisEdges([
    edge({ crossAccount: true }),
    edge({ from: 'assoc:c', to: 'acct:c', crossAccount: false }),
  ]);

  assert.equal(cross?.color.color, CROSS_ACCOUNT_EDGE_COLOR);
  assert.equal(cross?.dashes, true);
  assert.ok((cross?.width ?? 0) > (same?.width ?? 0), 'cross-account edge should be thicker');
  assert.equal(cross?.label, 'cross-account');

  assert.equal(same?.color.color, SAME_ACCOUNT_EDGE_COLOR);
  assert.equal(same?.dashes, false);
  assert.notEqual(same?.color.color, cross?.color.color);
});

test('buildVisEdges gives each edge a unique id even for duplicate endpoints', () => {
  const edges = buildVisEdges([edge(), edge()]);
  assert.equal(edges.length, 2);
  assert.notEqual(edges[0]?.id, edges[1]?.id);
});

// ---------------------------------------------------------------------------
// Node metadata panel (Requirement 7.5)
// ---------------------------------------------------------------------------

test('nodeMetadataEntries leads with label + type and includes business metadata (Req 7.5)', () => {
  const entries = nodeMetadataEntries(
    node({
      type: 'Recommendation',
      displayLabel: 'Right-size the fleet',
      businessUnit: 'Payments',
      metadata: { status: 'OPEN', severity: 'high', priorityScore: 7 },
    }),
  );
  const byLabel = Object.fromEntries(entries.map((e) => [e.label, e.value]));
  assert.equal(byLabel.Name, 'Right-size the fleet');
  assert.equal(byLabel.Type, 'Recommendation');
  assert.equal(byLabel['Business unit'], 'Payments');
  assert.equal(byLabel.Status, 'OPEN');
  assert.equal(byLabel.Severity, 'high');
  // camelCase keys are humanized.
  assert.equal(byLabel['Priority score'], '7');
});

test('nodeMetadataEntries skips empty values and duplicate id/label fields (Req 7.5)', () => {
  const entries = nodeMetadataEntries(
    node({
      metadata: {
        displayLabel: 'dupe',
        businessUnit: 'dupe',
        id: 'dupe',
        label: 'dupe',
        emptyField: '',
        nullField: null,
        realField: 'kept',
      },
    }),
  );
  const labels = entries.map((e) => e.label);
  assert.ok(labels.includes('Real field'));
  assert.ok(!labels.includes('Empty field'));
  assert.ok(!labels.includes('Null field'));
  // The raw id/label/displayLabel/businessUnit metadata keys are not duplicated.
  assert.equal(entries.filter((e) => e.value === 'dupe').length, 0);
});

test('nodeMetadataEntries omits Business unit when the node has none', () => {
  const entries = nodeMetadataEntries(node({ businessUnit: undefined, metadata: {} }));
  assert.ok(!entries.some((e) => e.label === 'Business unit'));
});

// ---------------------------------------------------------------------------
// Unavailable-graph messaging (Requirement 7.7)
// ---------------------------------------------------------------------------

test('isGraphUnavailable is true for a reason or an empty node set (Req 7.7)', () => {
  assert.equal(isGraphUnavailable(graph({ unavailableReason: 'empty', nodes: [] })), true);
  assert.equal(isGraphUnavailable(graph({ nodes: [] })), true);
  assert.equal(isGraphUnavailable(graph({ nodes: [node()] })), false);
});

test('graphUnavailableMessage distinguishes no-data from load-failure (Req 7.7)', () => {
  const empty = graphUnavailableMessage(graph({ unavailableReason: 'empty', nodes: [] }));
  assert.equal(empty?.category, 'no-data');
  assert.match(empty?.detail ?? '', /no data|refresh/i);

  const unavailable = graphUnavailableMessage(
    graph({ unavailableReason: 'graph_unavailable', nodes: [] }),
  );
  assert.equal(unavailable?.category, 'load-failure');

  const failed = graphUnavailableMessage(graph({ unavailableReason: 'query_failed', nodes: [] }));
  assert.equal(failed?.category, 'load-failure');
});

test('graphUnavailableMessage treats an empty graph with no reason as no-data (Req 7.7)', () => {
  const message = graphUnavailableMessage(graph({ nodes: [], edges: [] }));
  assert.equal(message?.category, 'no-data');
});

test('graphUnavailableMessage returns null when the graph is renderable', () => {
  assert.equal(graphUnavailableMessage(graph({ nodes: [node()] })), null);
});

test('unavailableMessageForReason maps every reason to a category (Req 7.7)', () => {
  assert.equal(unavailableMessageForReason('empty').category, 'no-data');
  assert.equal(unavailableMessageForReason('graph_unavailable').category, 'load-failure');
  assert.equal(unavailableMessageForReason('query_failed').category, 'load-failure');
});
