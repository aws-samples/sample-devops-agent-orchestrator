import { randomUUID } from 'node:crypto';

import {
  GetDurableExecutionCommand,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException as LambdaResourceNotFound,
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  A2aInvestigateStartResponse,
  A2aInvestigateState,
  A2aInvestigateStatusResponse,
  A2aRunSkill,
} from '@devops-observatory/shared-types';

import { UpstreamUnavailableError, ValidationError } from './errors';

/**
 * Orchestration for the async, durable `investigate` skill (Task 38).
 *
 * The heavy lifting (start the investigation, poll the A2A task for minutes,
 * pause for a human decision) runs in a separate Lambda DURABLE FUNCTION
 * (`functions/a2a-investigate`). This module is the API-side glue used by the
 * `a2a` route handler:
 *   - {@link startInvestigation}  — invoke the durable function asynchronously
 *     (a named durable execution) and record an index object in S3.
 *   - {@link getInvestigationStatus} — read the durable execution's status
 *     (`GetDurableExecution`) + the S3 index to build the SPA status DTO.
 *   - {@link approveInvestigation} / {@link rejectInvestigation} — release the
 *     durable function's human-in-the-loop callback (success / failure).
 *
 * S3 side-channel: `GetDurableExecution` exposes only the terminal result, not
 * the pending callback id or intermediate findings, so the durable function and
 * this module coordinate through a small JSON object per execution in the hub
 * bucket at `hub/a2a_investigations/<executionName>.json`. It also carries the
 * execution ARN so the status/approve/reject routes work from the (URL-safe)
 * execution NAME alone, even across browser reloads. No new datastore — the app
 * already reads/writes this bucket for chat memory + settings.
 */

/** S3 prefix (in the hub bucket) for the per-execution index objects. */
export const A2A_INVESTIGATION_PREFIX = 'hub/a2a_investigations/';

/** Env var carrying the durable function's QUALIFIED (alias) ARN — set in backend.ts. */
const FUNCTION_ARN_ENV = 'A2A_INVESTIGATE_FUNCTION_ARN';

/** A reviewer decision on the findings (durable function result + S3 record). */
export type InvestigationDecision = 'approved' | 'rejected' | 'expired';

/** Lifecycle phase recorded in the S3 index object. */
export type InvestigationPhase = 'RUNNING' | 'AWAITING_APPROVAL' | 'CLOSED';

/**
 * The per-execution index object stored in S3. Written first by
 * {@link startInvestigation} (with `executionArn` + `question`), then updated by
 * the durable function as it progresses (task id → callback id + findings →
 * final decision). Read by the status/approve/reject routes.
 */
export interface InvestigationRecord {
  spaceId: string;
  question: string;
  executionArn: string;
  phase: InvestigationPhase;
  /** Which skill this run drives (`chat` = no approval). Defaults to investigate. */
  skill?: A2aRunSkill;
  taskId?: string;
  /** Present only while `AWAITING_APPROVAL` — the durable callback handle. */
  callbackId?: string;
  findings?: string;
  decision?: InvestigationDecision;
  updatedAt: string;
}

/** Payload the durable function receives (it must know its own execution name). */
export interface InvestigatePayload {
  spaceId: string;
  executionName: string;
  message: string;
  /** Which skill to run. Defaults to `investigate` when absent (older payloads). */
  skill?: A2aRunSkill;
}

/** The durable function's return value (checkpointed as the execution Result). */
export interface InvestigateResult {
  decision: InvestigationDecision;
  findings: string;
  question: string;
  taskId?: string;
  skill?: A2aRunSkill;
}

// ---------------------------------------------------------------------------
// Clients + env
// ---------------------------------------------------------------------------

function region(): string {
  return process.env.HUB_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
}

function bucket(): string {
  const b = process.env.HUB_BUCKET;
  if (!b) throw new UpstreamUnavailableError('The hub bucket is not configured.');
  return b;
}

let cachedS3: S3Client | undefined;
function s3(): S3Client {
  if (!cachedS3) cachedS3 = new S3Client({ region: region() });
  return cachedS3;
}

let cachedLambda: LambdaClient | undefined;
function lambda(): LambdaClient {
  if (!cachedLambda) cachedLambda = new LambdaClient({ region: region() });
  return cachedLambda;
}

// ---------------------------------------------------------------------------
// S3 index object (shared by the durable function and the routes)
// ---------------------------------------------------------------------------

/** URL-safe S3 key for an execution's index object. */
export function investigationKey(executionName: string): string {
  return `${A2A_INVESTIGATION_PREFIX}${encodeURIComponent(executionName)}.json`;
}

/** Read an execution's index object, or `undefined` when it does not exist. */
export async function readInvestigationRecord(
  executionName: string,
): Promise<InvestigationRecord | undefined> {
  try {
    const res = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: investigationKey(executionName) }),
    );
    const text = await res.Body?.transformToString('utf-8');
    if (!text) return undefined;
    return JSON.parse(text) as InvestigationRecord;
  } catch {
    return undefined;
  }
}

/** Create/replace an execution's index object. */
export async function writeInvestigationRecord(
  executionName: string,
  record: InvestigationRecord,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: investigationKey(executionName),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Read-modify-write a subset of an execution's index object (used by the durable
 * function to add the task id, then the callback id + findings, then the final
 * decision, without clobbering the fields written at start).
 */
export async function patchInvestigationRecord(
  executionName: string,
  patch: Partial<InvestigationRecord>,
): Promise<void> {
  const current = await readInvestigationRecord(executionName);
  if (!current) throw new UpstreamUnavailableError('The investigation index object is missing.');
  await writeInvestigationRecord(executionName, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Start / status / approve / reject (API-side)
// ---------------------------------------------------------------------------

/** A URL-safe, unique durable-execution name for a new run (prefixed by skill). */
export function newRunName(spaceId: string, skill: A2aRunSkill): string {
  const prefix = skill === 'chat' ? 'chat' : 'inv';
  return `${prefix}-${spaceId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}-${randomUUID()}`;
}

/**
 * Start a durable A2A run (chat or investigate): invoke the durable function
 * asynchronously as a named durable execution, then write the S3 index object
 * (with the returned execution ARN + the question) so later status/approve/
 * reject calls work from the (URL-safe) name.
 */
export async function startInvestigation(
  spaceId: string,
  message: string,
  skill: A2aRunSkill = 'investigate',
): Promise<A2aInvestigateStartResponse> {
  const functionArn = process.env[FUNCTION_ARN_ENV];
  if (!functionArn) {
    throw new UpstreamUnavailableError('The A2A run function is not configured.');
  }
  const executionName = newRunName(spaceId, skill);
  const payload: InvestigatePayload = { spaceId, executionName, message, skill };

  let executionArn: string | undefined;
  try {
    const out = await lambda().send(
      new InvokeCommand({
        FunctionName: functionArn, // qualified (alias) ARN — required for durable
        InvocationType: 'Event', // async: returns immediately with the execution ARN
        DurableExecutionName: executionName,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    executionArn = out.DurableExecutionArn;
  } catch {
    throw new UpstreamUnavailableError('The A2A run could not be started.');
  }
  if (!executionArn) {
    throw new UpstreamUnavailableError(
      'The A2A run was invoked but no durable execution ARN was returned.',
    );
  }

  await writeInvestigationRecord(executionName, {
    spaceId,
    question: message,
    executionArn,
    phase: 'RUNNING',
    skill,
    updatedAt: new Date().toISOString(),
  });

  return { executionName, executionArn, status: 'RUNNING', skill };
}

/** Map the durable-execution result decision to the SPA-facing status. */
function decisionToState(decision: InvestigationDecision | undefined): A2aInvestigateState {
  if (decision === 'rejected') return 'REJECTED';
  if (decision === 'expired') return 'FAILED';
  return 'SUCCEEDED';
}

/**
 * Build the SPA status DTO for an execution by combining `GetDurableExecution`
 * (authoritative lifecycle + terminal result) with the S3 index object (question,
 * task id, pending findings while awaiting approval). Returns `NOT_FOUND` when no
 * index object exists for the name.
 */
export async function getInvestigationStatus(
  executionName: string,
): Promise<A2aInvestigateStatusResponse> {
  const record = await readInvestigationRecord(executionName);
  if (!record) return { executionName, status: 'NOT_FOUND' };

  const base: A2aInvestigateStatusResponse = {
    executionName,
    status: 'RUNNING',
    skill: record.skill ?? 'investigate',
    ...(record.question ? { question: record.question } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.findings ? { findings: record.findings } : {}),
  };

  let durableStatus: string | undefined;
  let result: InvestigateResult | undefined;
  let errorMessage: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  try {
    const out = await lambda().send(
      new GetDurableExecutionCommand({
        DurableExecutionArn: record.executionArn,
        IncludeExecutionData: true,
      }),
    );
    durableStatus = out.Status;
    startedAt = out.StartTimestamp ? out.StartTimestamp.toISOString() : undefined;
    endedAt = out.EndTimestamp ? out.EndTimestamp.toISOString() : undefined;
    if (out.Result) {
      try {
        result = JSON.parse(out.Result) as InvestigateResult;
      } catch {
        /* non-JSON result — ignore */
      }
    }
    errorMessage = out.Error?.ErrorMessage;
  } catch (err) {
    // History retained-out or transient: fall back to the S3 index below.
    if (!(err instanceof LambdaResourceNotFound)) {
      // Keep serving the last-known S3 state rather than failing the poll.
      durableStatus = undefined;
    }
  }

  // Terminal, per the durable execution.
  if (durableStatus === 'SUCCEEDED') {
    return {
      ...base,
      status: decisionToState(result?.decision),
      ...(result?.findings ? { findings: result.findings } : {}),
      ...(result?.taskId ? { taskId: result.taskId } : {}),
      ...(result?.decision === 'expired'
        ? { error: 'The findings expired before they were reviewed.' }
        : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
    };
  }
  if (durableStatus === 'FAILED' || durableStatus === 'TIMED_OUT' || durableStatus === 'STOPPED') {
    return {
      ...base,
      status: durableStatus,
      error: errorMessage ?? 'The investigation did not complete.',
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
    };
  }

  // Still running (or durable status unavailable) — use the S3 phase for the
  // human-in-the-loop signal.
  const status: A2aInvestigateState =
    record.phase === 'AWAITING_APPROVAL'
      ? 'AWAITING_APPROVAL'
      : record.phase === 'CLOSED'
        ? decisionToState(record.decision)
        : 'RUNNING';
  return { ...base, status, ...(startedAt ? { startedAt } : {}) };
}

/** Load an execution's pending callback id, or throw an actionable 400/502. */
async function requirePendingCallback(executionName: string): Promise<string> {
  const record = await readInvestigationRecord(executionName);
  if (!record) throw new ValidationError('No such investigation.');
  if (record.phase !== 'AWAITING_APPROVAL' || !record.callbackId) {
    throw new ValidationError('This investigation is not awaiting a decision.');
  }
  return record.callbackId;
}

/** Approve (acknowledge) the findings — releases the durable callback with success. */
export async function approveInvestigation(executionName: string): Promise<void> {
  const callbackId = await requirePendingCallback(executionName);
  try {
    await lambda().send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackId,
        Result: JSON.stringify({ decision: 'approved' }),
      }),
    );
  } catch {
    throw new UpstreamUnavailableError('The approval could not be recorded.');
  }
}

/** Reject (dismiss) the findings — releases the durable callback with a failure. */
export async function rejectInvestigation(executionName: string, reason?: string): Promise<void> {
  const callbackId = await requirePendingCallback(executionName);
  try {
    await lambda().send(
      new SendDurableExecutionCallbackFailureCommand({
        CallbackId: callbackId,
        Error: {
          ErrorType: 'Rejected',
          ErrorMessage:
            reason && reason.trim().length > 0 ? reason.trim() : 'Dismissed by reviewer.',
        },
      }),
    );
  } catch {
    throw new UpstreamUnavailableError('The rejection could not be recorded.');
  }
}
