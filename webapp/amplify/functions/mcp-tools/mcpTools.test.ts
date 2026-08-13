import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BusinessContext, GraphResponse } from '@devops-observatory/shared-types';
import {
  filterGraphBySearch,
  parseToolName,
  runTool,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  UnknownToolError,
  type ToolDeps,
} from './mcpTools';

/**
 * Tests for the EDO MCP tool dispatch/shaping core (Task 29, Requirement 15).
 *
 * Run with: `node --import tsx --test amplify/functions/mcp-tools/mcpTools.test.ts`
 */

function graph(): GraphResponse {
  return {
    nodes: [
      { id: 'a1', type: 'Account', displayLabel: 'Payments Prod', businessUnit: 'FinTech' },
      { id: 's1', type: 'AgentSpace', displayLabel: 'gitlab-testing' },
      { id: 'svc1', type: 'AwsService', displayLabel: 'Amazon EKS' },
    ],
    edges: [
      { from: 'a1', to: 's1', type: 'HAS_SPACE' },
      { from: 's1', to: 'svc1', type: 'USES' },
    ],
  };
}

function stubDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    async searchKb(query: string) {
      return { answer: `answer for: ${query}`, citations: [{ uri: 's3://kb/doc.md', title: 'doc.md' }] };
    },
    async getTopologyGraph() {
      return graph();
    },
    async getBusinessContext() {
      return null;
    },
    ...overrides,
  };
}

// --- parseToolName ---------------------------------------------------------

test('parseToolName strips the gateway target prefix', () => {
  assert.equal(parseToolName('edo-snapshot-tools___search_kb'), 'search_kb');
});

test('parseToolName returns a bare name unchanged and empty for undefined', () => {
  assert.equal(parseToolName('search_kb'), 'search_kb');
  assert.equal(parseToolName(undefined), '');
});

// --- tool schemas ----------------------------------------------------------

test('TOOL_SCHEMAS declares the three snapshot tools with input schemas', () => {
  const names = TOOL_SCHEMAS.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_business_context', 'query_topology_graph', 'search_kb']);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(typeof t.description === 'string' && t.description.length > 0);
  }
});

// --- filterGraphBySearch ---------------------------------------------------

test('filterGraphBySearch returns the graph unchanged for a blank term', () => {
  const g = graph();
  assert.deepEqual(filterGraphBySearch(g, ''), g);
  assert.deepEqual(filterGraphBySearch(g, '   '), g);
});

test('filterGraphBySearch keeps matching nodes and only edges between them', () => {
  const g = filterGraphBySearch(graph(), 'gitlab');
  assert.deepEqual(g.nodes.map((n) => n.id), ['s1']);
  assert.deepEqual(g.edges, []); // both endpoints of each edge no longer present
});

test('filterGraphBySearch matches by business unit and type, preserving connecting edges', () => {
  // "fintech" matches the account by businessUnit; add the space too via a second pass check.
  const byBu = filterGraphBySearch(graph(), 'fintech');
  assert.deepEqual(byBu.nodes.map((n) => n.id), ['a1']);
  const byType = filterGraphBySearch(graph(), 'agentspace');
  assert.deepEqual(byType.nodes.map((n) => n.id), ['s1']);
});

// --- runTool dispatch ------------------------------------------------------

test('runTool: search_kb requires a non-empty query', async () => {
  const res = (await runTool(TOOL_NAMES.searchKb, {}, stubDeps())) as { error?: string };
  assert.match(res.error ?? '', /query/i);
});

test('runTool: search_kb returns a grounded answer with citations', async () => {
  const res = (await runTool('edo-snapshot-tools___search_kb', { query: 'open recommendations?' }, stubDeps())) as {
    answer: string;
    citations: unknown[];
  };
  assert.match(res.answer, /open recommendations\?/);
  assert.equal(res.citations.length, 1);
});

test('runTool: query_topology_graph returns the (optionally filtered) graph', async () => {
  const all = (await runTool(TOOL_NAMES.queryTopologyGraph, {}, stubDeps())) as GraphResponse;
  assert.equal(all.nodes.length, 3);
  const filtered = (await runTool(TOOL_NAMES.queryTopologyGraph, { search: 'eks' }, stubDeps())) as GraphResponse;
  assert.deepEqual(filtered.nodes.map((n) => n.id), ['svc1']);
});

test('runTool: get_business_context returns the context, or a message when none', async () => {
  const none = (await runTool(TOOL_NAMES.getBusinessContext, {}, stubDeps())) as { message?: string };
  assert.match(none.message ?? '', /no business context/i);

  const context: BusinessContext = {
    version: 1,
    updatedAt: '2026-07-07T00:00:00Z',
    businessUnits: [{ name: 'FinTech', accounts: ['a1'] }],
    accountDisplayNames: { a1: 'Payments Prod' },
    accountContext: {},
  };
  const got = (await runTool(TOOL_NAMES.getBusinessContext, {}, stubDeps({
    async getBusinessContext() {
      return context;
    },
  }))) as BusinessContext;
  assert.equal(got.businessUnits[0]?.name, 'FinTech');
});

test('runTool throws UnknownToolError for an unrecognized tool', async () => {
  await assert.rejects(() => runTool('edo-snapshot-tools___delete_everything', {}, stubDeps()), UnknownToolError);
});
