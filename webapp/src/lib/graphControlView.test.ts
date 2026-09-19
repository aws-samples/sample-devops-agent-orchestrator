import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphControlStatus, GraphLifecycleState } from '@devops-observatory/shared-types';
import { formatGraphTimestamp, viewGraphStatus } from './graphControlView';

/**
 * Tests for the Admin Settings "Topology graph" control logic (feature: start/
 * stop the Neptune Analytics graph).
 *
 * Run with: `node --import tsx --test src/lib/graphControlView.test.ts`
 */

function status(state: GraphLifecycleState, over: Partial<GraphControlStatus> = {}): GraphControlStatus {
  return {
    provisioned: state !== 'DELETED',
    running: state === 'AVAILABLE',
    state,
    transitioning: ['STARTING', 'STOPPING', 'CREATING', 'DELETING', 'RESETTING', 'SNAPSHOTTING', 'IMPORTING', 'UPDATING'].includes(
      state,
    ),
    graphName: 'devops-agent-topology',
    ...over,
  };
}

test('a null status is treated as unknown with no actions offered', () => {
  const view = viewGraphStatus(null);
  assert.equal(view.tone, 'error');
  assert.equal(view.label, 'Unknown');
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, false);
});

test('an AVAILABLE graph is running and can only be stopped', () => {
  const view = viewGraphStatus(status('AVAILABLE'));
  assert.equal(view.tone, 'running');
  assert.equal(view.label, 'Running');
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, true);
  assert.equal(view.transitioning, false);
});

test('a STOPPED graph is stopped and can only be started', () => {
  const view = viewGraphStatus(status('STOPPED'));
  assert.equal(view.tone, 'stopped');
  assert.equal(view.label, 'Stopped');
  assert.equal(view.canStart, true);
  assert.equal(view.canStop, false);
});

test('transitioning states offer neither action and keep polling', () => {
  for (const state of ['STARTING', 'STOPPING'] as const) {
    const view = viewGraphStatus(status(state));
    assert.equal(view.tone, 'transitioning');
    assert.equal(view.transitioning, true);
    assert.equal(view.canStart, false, `${state} should not allow start`);
    assert.equal(view.canStop, false, `${state} should not allow stop`);
  }
});

test('a not-provisioned graph shows "Not provisioned" and offers neither action', () => {
  const view = viewGraphStatus(status('DELETED'));
  assert.equal(view.label, 'Not provisioned');
  assert.equal(view.tone, 'stopped');
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, false);
});

test('FAILED/UNKNOWN render as an error tone', () => {
  assert.equal(viewGraphStatus(status('FAILED')).tone, 'error');
  assert.equal(viewGraphStatus(status('UNKNOWN')).tone, 'error');
});

test('formatGraphTimestamp renders a valid ISO time in UTC, undefined otherwise', () => {
  const formatted = formatGraphTimestamp('2026-09-19T10:30:00.000Z');
  assert.ok(formatted?.includes('UTC'));
  assert.ok(formatted?.includes('2026'));
  assert.equal(formatGraphTimestamp(undefined), undefined);
  assert.equal(formatGraphTimestamp(''), undefined);
  assert.equal(formatGraphTimestamp('not-a-date'), undefined);
});
