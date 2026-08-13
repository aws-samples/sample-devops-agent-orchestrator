import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSpaceName,
  mapWorkerResult,
  validateBatchCreateInput,
  validateCreateSpaceInput,
  type WorkerResult,
} from '../shared/spaces';
import {
  ConflictError,
  UpstreamUnavailableError,
  ValidationError,
} from '../shared/errors';

/**
 * Tests for the pure POST /spaces logic (Admin-only create agent space):
 * request validation and the mapping of the Python worker's structured result
 * to a created space or a typed API error. The SDK invoke path is not exercised
 * here (it is a thin transport around these pure helpers).
 */

// --- validateCreateSpaceInput --------------------------------------------------

test('accepts a valid request and trims fields', () => {
  const out = validateCreateSpaceInput({
    accountId: ' 123456789012 ',
    name: '  my-space  ',
    description: '  hello  ',
  });
  assert.equal(out.valid, true);
  assert.deepEqual(out.valid && out.request, {
    accountId: '123456789012',
    name: 'my-space',
    description: 'hello',
  });
});

test('omits an empty description', () => {
  const out = validateCreateSpaceInput({ accountId: '123456789012', name: 'n', description: '   ' });
  assert.equal(out.valid, true);
  assert.equal(out.valid && 'description' in out.request, false);
});

test('rejects a non-object body', () => {
  assert.equal(validateCreateSpaceInput(null).valid, false);
  assert.equal(validateCreateSpaceInput('nope').valid, false);
});

test('rejects a bad account id', () => {
  for (const bad of ['', '123', 'abcdefghijkl', '1234567890123']) {
    const out = validateCreateSpaceInput({ accountId: bad, name: 'n' });
    assert.equal(out.valid, false, `expected ${bad} to be invalid`);
  }
});

test('rejects an empty or overlong name', () => {
  assert.equal(validateCreateSpaceInput({ accountId: '123456789012', name: '   ' }).valid, false);
  assert.equal(
    validateCreateSpaceInput({ accountId: '123456789012', name: 'x'.repeat(129) }).valid,
    false,
  );
});

test('rejects an overlong description', () => {
  const out = validateCreateSpaceInput({
    accountId: '123456789012',
    name: 'n',
    description: 'x'.repeat(1025),
  });
  assert.equal(out.valid, false);
});

// --- mapWorkerResult -----------------------------------------------------------

test('maps a successful worker result to a created space', () => {
  const result: WorkerResult = {
    ok: true,
    accountId: '123456789012',
    agentSpaceId: 'as-abc',
    name: 'my-space',
  };
  assert.deepEqual(mapWorkerResult(result), {
    accountId: '123456789012',
    agentSpaceId: 'as-abc',
    name: 'my-space',
  });
});

test('a success without a name omits the name', () => {
  const space = mapWorkerResult({ ok: true, accountId: '1', agentSpaceId: 'as-1' });
  assert.equal('name' in space, false);
});

test('conflict maps to a ConflictError (409)', () => {
  assert.throws(
    () => mapWorkerResult({ ok: false, code: 'conflict', error: 'exists' }),
    (e: unknown) => e instanceof ConflictError,
  );
});

test('validation maps to a ValidationError (400)', () => {
  assert.throws(
    () => mapWorkerResult({ ok: false, code: 'validation', error: 'bad' }),
    (e: unknown) => e instanceof ValidationError,
  );
});

test('create_denied maps to an UpstreamUnavailableError with the actionable message', () => {
  assert.throws(
    () => mapWorkerResult({ ok: false, code: 'create_denied', error: 'set ALLOW_AGENT_SPACE_CREATION=true' }),
    (e: unknown) => e instanceof UpstreamUnavailableError && /ALLOW_AGENT_SPACE_CREATION/.test((e as Error).message),
  );
});

test('a generic error (and an ok-but-incomplete result) maps to UpstreamUnavailableError', () => {
  assert.throws(
    () => mapWorkerResult({ ok: false, code: 'error', error: 'throttled' }),
    (e: unknown) => e instanceof UpstreamUnavailableError,
  );
  // ok=true but missing ids is not a valid success — treated as an upstream failure.
  assert.throws(
    () => mapWorkerResult({ ok: true }),
    (e: unknown) => e instanceof UpstreamUnavailableError,
  );
});

// --- validateBatchCreateInput --------------------------------------------------

const known = new Set(['111111111111', '222222222222', '333333333333']);

test('batch: accepts known accounts, de-duplicates, and names each space', () => {
  const out = validateBatchCreateInput(
    { accountIds: ['111111111111', '111111111111', ' 222222222222 '] },
    known,
  );
  assert.equal(out.valid, true);
  if (!out.valid) return;
  assert.deepEqual(out.accountIds, ['111111111111', '222222222222']);
  assert.deepEqual(out.requests, [
    { accountId: '111111111111', name: defaultSpaceName('111111111111') },
    { accountId: '222222222222', name: defaultSpaceName('222222222222') },
  ]);
});

test('batch: rejects a non-array or empty selection', () => {
  assert.equal(validateBatchCreateInput({}, known).valid, false);
  assert.equal(validateBatchCreateInput({ accountIds: 'nope' }, known).valid, false);
  assert.equal(validateBatchCreateInput({ accountIds: [] }, known).valid, false);
  assert.equal(validateBatchCreateInput({ accountIds: ['   '] }, known).valid, false);
});

test('batch: rejects accounts absent from the manifest', () => {
  const out = validateBatchCreateInput({ accountIds: ['111111111111', '999999999999'] }, known);
  assert.equal(out.valid, false);
  assert.match(out.valid ? '' : out.message, /999999999999/);
});

test('batch: rejects more than the cap', () => {
  const many = Array.from({ length: 1001 }, (_v, i) => String(i).padStart(12, '0'));
  const out = validateBatchCreateInput({ accountIds: many }, new Set(many));
  assert.equal(out.valid, false);
  assert.match(out.valid ? '' : out.message, /at most 1000/);
});
