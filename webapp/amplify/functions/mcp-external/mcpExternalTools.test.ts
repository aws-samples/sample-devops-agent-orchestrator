import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXTERNAL_ACCESS_DISABLED_MESSAGE,
  EXTERNAL_TOOL_NAMES,
  EXTERNAL_TOOL_SCHEMAS,
  runExternalTool,
  type ExternalToolDeps,
} from './mcpExternalTools';
import { TOOL_NAMES } from '../mcp-tools/mcpTools';

/**
 * Unit tests for the EXTERNAL MCP tool dispatcher (Task 39, Requirement 16).
 * No SDK / network — deps are stubbed. Covers the kill switch (16.6/16.7), the
 * external tools' defensive argument validation, and the fallthrough to the
 * shared snapshot dispatcher.
 *
 * Run with: `node --import tsx --test amplify/functions/mcp-external/mcpExternalTools.test.ts`
 */

const SPACE = 'a1b2c3d4-5678-4abc-9def-0123456789ab';

/** Deps stub: everything enabled and recorded so tests can assert call flow. */
function stubDeps(overrides: Partial<ExternalToolDeps> = {}): ExternalToolDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isExternalAccessEnabled: async () => true,
    searchKb: async (query) => {
      calls.push(`searchKb:${query}`);
      return { answer: 'kb answer', citations: [] };
    },
    getTopologyGraph: async () => {
      calls.push('getTopologyGraph');
      return { nodes: [], edges: [] };
    },
    getBusinessContext: async () => {
      calls.push('getBusinessContext');
      return null;
    },
    askObservatory: async (question) => {
      calls.push(`askObservatory:${question}`);
      return { answer: 'grounded answer', citations: [] };
    },
    listAgentSpaces: async () => {
      calls.push('listAgentSpaces');
      return [{ agentSpaceId: SPACE, name: 'space-1', account: '123456789012' }];
    },
    askAgentSpace: async (id, question) => {
      calls.push(`askAgentSpace:${id}:${question}`);
      return { answer: 'space answer' };
    },
    ...overrides,
  };
}

test('the disabled flag blocks EVERY tool without touching any data source (Req 16.7)', async () => {
  const deps = stubDeps({ isExternalAccessEnabled: async () => false });
  const allTools = [
    EXTERNAL_TOOL_NAMES.askDevopsObservatory,
    EXTERNAL_TOOL_NAMES.listAgentSpaces,
    EXTERNAL_TOOL_NAMES.askAgentSpace,
    TOOL_NAMES.searchKb,
    TOOL_NAMES.queryTopologyGraph,
    TOOL_NAMES.getBusinessContext,
  ];
  for (const tool of allTools) {
    const res = (await runExternalTool(tool, { query: 'q', question: 'q', agentSpaceId: SPACE }, deps)) as {
      error?: string;
    };
    assert.equal(res.error, EXTERNAL_ACCESS_DISABLED_MESSAGE, `${tool} must be blocked`);
  }
  assert.deepEqual(deps.calls, [], 'no data source may be touched while disabled');
});

test('ask_devops_observatory dispatches with a valid question', async () => {
  const deps = stubDeps();
  const res = (await runExternalTool(
    EXTERNAL_TOOL_NAMES.askDevopsObservatory,
    { question: '  which BU has open incidents?  ' },
    deps,
  )) as { answer: string };
  assert.equal(res.answer, 'grounded answer');
  assert.deepEqual(deps.calls, ['askObservatory:which BU has open incidents?']);
});

test('ask_devops_observatory rejects a missing/empty/over-long question', async () => {
  const deps = stubDeps();
  for (const args of [{}, { question: '   ' }, { question: 'x'.repeat(1001) }]) {
    const res = (await runExternalTool(EXTERNAL_TOOL_NAMES.askDevopsObservatory, args, deps)) as {
      error?: string;
    };
    assert.ok(res.error, `must reject ${JSON.stringify(args).slice(0, 40)}`);
  }
  assert.deepEqual(deps.calls, []);
});

test('list_agent_spaces returns the spaces (and a hint when none)', async () => {
  const deps = stubDeps();
  const res = (await runExternalTool(EXTERNAL_TOOL_NAMES.listAgentSpaces, {}, deps)) as {
    spaces: unknown[];
    message?: string;
  };
  assert.equal(res.spaces.length, 1);
  assert.equal(res.message, undefined);

  const empty = stubDeps({ listAgentSpaces: async () => [] });
  const res2 = (await runExternalTool(EXTERNAL_TOOL_NAMES.listAgentSpaces, {}, empty)) as {
    spaces: unknown[];
    message?: string;
  };
  assert.equal(res2.spaces.length, 0);
  assert.ok(res2.message);
});

test('ask_agent_space validates the space id shape before any relay', async () => {
  const deps = stubDeps();
  for (const bad of [undefined, '', 'not-a-uuid', `${SPACE}x`]) {
    const res = (await runExternalTool(
      EXTERNAL_TOOL_NAMES.askAgentSpace,
      { agentSpaceId: bad, question: 'hello' },
      deps,
    )) as { error?: string };
    assert.ok(res.error?.includes('agentSpaceId'), `must reject ${String(bad)}`);
  }
  assert.deepEqual(deps.calls, []);
});

test('ask_agent_space relays a valid request (token never in the result)', async () => {
  const deps = stubDeps();
  const res = (await runExternalTool(
    EXTERNAL_TOOL_NAMES.askAgentSpace,
    { agentSpaceId: SPACE, question: 'any active incidents?' },
    deps,
  )) as { answer: string };
  assert.equal(res.answer, 'space answer');
  assert.deepEqual(deps.calls, [`askAgentSpace:${SPACE}:any active incidents?`]);
  assert.equal(JSON.stringify(res).includes('token'), false);
});

test('snapshot tools fall through to the shared dispatcher (one implementation)', async () => {
  const deps = stubDeps();
  const res = (await runExternalTool(TOOL_NAMES.searchKb, { query: 'coverage' }, deps)) as {
    answer: string;
  };
  assert.equal(res.answer, 'kb answer');
  assert.deepEqual(deps.calls, ['searchKb:coverage']);
});

test('gateway-prefixed tool names are normalized (targetName___tool)', async () => {
  const deps = stubDeps();
  const res = (await runExternalTool(
    `edo-external-tools___${EXTERNAL_TOOL_NAMES.askDevopsObservatory}`,
    { question: 'q' },
    deps,
  )) as { answer: string };
  assert.equal(res.answer, 'grounded answer');
});

test('an unknown tool yields a clean model-readable error via the shared path', async () => {
  const deps = stubDeps();
  await assert.rejects(
    () => runExternalTool('no_such_tool', {}, deps),
    (err: Error) => err.name === 'UnknownToolError',
  );
});

test('the external schema exposes exactly the six tools with unique names', () => {
  const names = EXTERNAL_TOOL_SCHEMAS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    [...names].sort(),
    [
      'ask_agent_space',
      'ask_devops_observatory',
      'get_business_context',
      'list_agent_spaces',
      'query_topology_graph',
      'search_kb',
    ],
  );
});
