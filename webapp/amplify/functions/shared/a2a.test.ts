import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  a2aBaseUrl,
  buildChatBody,
  buildInvestigateBody,
  isTaskRunning,
  parseChatResponse,
  parseInvestigationStarted,
  parseTaskPoll,
  requireSpaceId,
  secretNameForSpace,
  toStatus,
  validateChatRequest,
  validateTokenRequest,
  type A2aSecretValue,
} from './a2a';
import { ValidationError } from './errors';

/**
 * Unit tests for the pure A2A helpers (Task 36). No SDK / network — these cover
 * secret-name derivation, input validation, the A2A request-body shape, and
 * task-response parsing (including the token never leaking into status).
 *
 * Run with: `node --import tsx --test amplify/functions/shared/a2a.test.ts`
 */

const SPACE = 'a1b2c3d4-5678-4abc-9def-0123456789ab';

test('secretNameForSpace namespaces the space id under the A2A prefix', () => {
  assert.equal(secretNameForSpace(SPACE), `devops-observatory/a2a/${SPACE}`);
});

test('requireSpaceId accepts a UUID and rejects junk', () => {
  assert.equal(requireSpaceId(`  ${SPACE}  `), SPACE);
  assert.throws(() => requireSpaceId(undefined), ValidationError);
  assert.throws(() => requireSpaceId('not-a-space'), ValidationError);
});

test('validateTokenRequest requires a non-empty token and defaults the region', () => {
  const ok = validateTokenRequest({ token: '  aidevops_v1_abc  ' }, 'us-east-1');
  assert.equal(ok.valid, true);
  if (!ok.valid) return;
  assert.equal(ok.value.token, 'aidevops_v1_abc'); // trimmed
  assert.equal(ok.value.region, 'us-east-1'); // defaulted
  assert.ok(ok.value.updatedAt.length > 0);

  assert.equal(validateTokenRequest({}, 'us-east-1').valid, false);
  assert.equal(validateTokenRequest({ token: '   ' }, 'us-east-1').valid, false);
  assert.equal(validateTokenRequest(null, 'us-east-1').valid, false);
});

test('validateTokenRequest carries optional metadata and rejects an over-long token', () => {
  const ok = validateTokenRequest(
    { token: 't', region: 'us-west-2', tokenName: 'obs', scope: 'operate', expiresAt: '2026-08-15' },
    'us-east-1',
  );
  assert.equal(ok.valid, true);
  if (!ok.valid) return;
  assert.deepEqual(ok.value, {
    token: 't',
    region: 'us-west-2',
    tokenName: 'obs',
    scope: 'operate',
    expiresAt: '2026-08-15',
    updatedAt: ok.value.updatedAt,
  });

  const tooLong = validateTokenRequest({ token: 'x'.repeat(513) }, 'us-east-1');
  assert.equal(tooLong.valid, false);
});

test('validateChatRequest enforces a non-empty, bounded message', () => {
  const ok = validateChatRequest({ message: '  hello  ' });
  assert.equal(ok.valid, true);
  if (ok.valid) assert.equal(ok.message, 'hello');

  assert.equal(validateChatRequest({ message: '   ' }).valid, false);
  assert.equal(validateChatRequest({ message: 'x'.repeat(4001) }).valid, false);
  assert.equal(validateChatRequest({}).valid, false);
});

test('toStatus reports configured and NEVER includes the token value', () => {
  const value: A2aSecretValue = {
    token: 'super-secret',
    region: 'us-east-1',
    tokenName: 'obs',
    scope: 'operate',
    expiresAt: '2026-08-15',
    updatedAt: '2026-07-16T00:00:00Z',
  };
  const status = toStatus(value);
  assert.equal(status.configured, true);
  assert.equal(status.tokenName, 'obs');
  assert.equal(status.scope, 'operate');
  assert.equal(status.region, 'us-east-1');
  // The secret value must never appear on the status DTO.
  assert.equal(JSON.stringify(status).includes('super-secret'), false);
  assert.equal('token' in status, false);
});

test('a2aBaseUrl builds the regional connect endpoint', () => {
  assert.equal(a2aBaseUrl('us-east-1'), 'https://connect.aidevops.us-east-1.api.aws');
  assert.equal(a2aBaseUrl('eu-west-1'), 'https://connect.aidevops.eu-west-1.api.aws');
});

test('buildChatBody produces the A2A v1.0 message:send shape for the chat skill', () => {
  const body = buildChatBody('why is my service down?', 'fixed-id');
  assert.deepEqual(body, {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: 'why is my service down?' }],
      messageId: 'fixed-id',
    },
    metadata: { skillId: 'chat' },
  });
});

test('parseChatResponse concatenates artifact text parts and carries task metadata', () => {
  const res = parseChatResponse({
    task: {
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ parts: [{ text: 'line one' }, { text: 'line two' }] }],
    },
  });
  assert.equal(res.answer, 'line one\nline two');
  assert.equal(res.taskId, 'task-1');
  assert.equal(res.state, 'TASK_STATE_COMPLETED');
});

test('parseChatResponse falls back to a message when the task has no text', () => {
  const res = parseChatResponse({ task: { id: 't', artifacts: [] } });
  assert.equal(res.answer, 'The agent returned no text response.');
  assert.equal(res.taskId, 't');
});

// ---------------------------------------------------------------------------
// `investigate` skill helpers (Task 38)
// ---------------------------------------------------------------------------

test('isTaskRunning is true only for submitted/working states', () => {
  assert.equal(isTaskRunning('TASK_STATE_SUBMITTED'), true);
  assert.equal(isTaskRunning('TASK_STATE_WORKING'), true);
  assert.equal(isTaskRunning('TASK_STATE_COMPLETED'), false);
  assert.equal(isTaskRunning('TASK_STATE_FAILED'), false);
  assert.equal(isTaskRunning(undefined), false);
});

test('buildInvestigateBody produces the message:send shape for the investigate skill', () => {
  const body = buildInvestigateBody('investigate the latency spike', 'fixed-id');
  assert.deepEqual(body, {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: 'investigate the latency spike' }],
      messageId: 'fixed-id',
    },
    metadata: { skillId: 'investigate' },
  });
});

test('parseInvestigationStarted prefers the task id', () => {
  const res = parseInvestigationStarted({
    id: 'task-42',
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_WORKING' },
  });
  assert.equal(res.taskId, 'task-42');
  assert.equal(res.contextId, 'ctx-1');
  assert.equal(res.state, 'TASK_STATE_WORKING');
});

test('parseInvestigationStarted unwraps a nested task envelope', () => {
  const res = parseInvestigationStarted({ task: { id: 'task-7', status: { state: 'TASK_STATE_WORKING' } } });
  assert.equal(res.taskId, 'task-7');
});

test('parseInvestigationStarted falls back to an investigation_started artifact', () => {
  const res = parseInvestigationStarted({
    status: { state: 'TASK_STATE_WORKING' },
    artifacts: [
      { parts: [{ text: JSON.stringify({ type: 'investigation_started', taskId: 'task-embedded' }) }] },
    ],
  });
  assert.equal(res.taskId, 'task-embedded');
});

test('parseInvestigationStarted returns no taskId when none is present', () => {
  assert.equal(parseInvestigationStarted({ status: { state: 'TASK_STATE_WORKING' } }).taskId, undefined);
});

test('parseTaskPoll extracts state and concatenated findings', () => {
  const res = parseTaskPoll({
    id: 'task-1',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ parts: [{ text: 'finding A' }, { text: 'finding B' }] }],
  });
  assert.equal(res.state, 'TASK_STATE_COMPLETED');
  assert.equal(res.findings, 'finding A\nfinding B');
});

test('parseTaskPoll returns empty findings while still working', () => {
  const res = parseTaskPoll({ id: 't', status: { state: 'TASK_STATE_WORKING' } });
  assert.equal(res.state, 'TASK_STATE_WORKING');
  assert.equal(res.findings, '');
});
