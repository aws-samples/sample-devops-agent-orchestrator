import {
  DescribeExecutionCommand,
  DescribeMapRunCommand,
  ListExecutionsCommand,
  ListMapRunsCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { RefreshProgress, RefreshState, RefreshStatus } from '@devops-observatory/shared-types';
import { getRefreshConfig } from './config';

/**
 * Step Functions orchestration for the admin-triggered refresh (Task 26.4).
 *
 * The scalable refresh (webapp task 26) is a Step Functions **Standard** state
 * machine that fans collection out across accounts with a **Distributed Map**
 * (ListAccounts → CollectAccount map → AssembleManifest → finalize). Standard
 * executions run up to a year, so multi-hour refreshes over thousands of
 * accounts have no execution-time ceiling (Requirement 10.11). Because that far
 * exceeds Lambda's limit, `POST /refresh` merely STARTS the execution and returns
 * within 5s (Requirement 10.3), while `GET /refresh/status` DESCRIBES it for the
 * in-progress / completed / failed indicator and the per-account collection
 * progress (Requirements 10.4, 10.8, 10.12).
 *
 * Single-flight (Requirement 10.5) is enforced here: `startRefresh` rejects when
 * a `RUNNING` execution already exists (`ListExecutions`), so a second trigger
 * starts nothing. This keeps the refresh Lambdas on the `@aws-sdk/client-sfn`
 * dependency only — no DynamoDB SDK, avoiding the lockfile conflict that the
 * DynamoDB-backed lock table previously caused.
 *
 * Last_Sync_Date is the manifest `collectedAt`, written only by the
 * AssembleManifest stage after collection; these handlers never touch it, so a
 * start failure or a mid-pipeline failure leaves it unchanged (Requirements
 * 10.6, 10.7, 10.8).
 */

/**
 * Ordered pipeline stages (Requirement 10.1). `collect` is the fan-out map; the
 * finalize stages run once over the full dataset.
 */
export const REFRESH_STAGES = ['collect', 'transform', 'kb_sync', 'graph_reload'] as const;
export type RefreshStage = (typeof REFRESH_STAGES)[number];

/** Sentinel error thrown by {@link startRefresh} when a refresh is already running. */
export const ALREADY_RUNNING = 'RefreshAlreadyRunning';

let cachedClient: SFNClient | undefined;

/** Lazily construct a single Step Functions client per warm Lambda container. */
function sfn(): SFNClient {
  if (!cachedClient) {
    cachedClient = new SFNClient({ region: getRefreshConfig().region });
  }
  return cachedClient;
}

/** The minimal identity of a started refresh execution. */
export interface StartedRefresh {
  executionArn: string;
  startedAt?: string;
}

/**
 * True when the state machine currently has at least one RUNNING execution.
 * The single admin actor and the button's disabled-while-running UX make the
 * check-then-start race negligible; a rare double-start is still bounded (the
 * second run overwrites the same derived artifacts idempotently).
 */
export async function isRefreshRunning(): Promise<boolean> {
  const { stateMachineArn } = getRefreshConfig();
  const out = await sfn().send(
    new ListExecutionsCommand({ stateMachineArn, statusFilter: 'RUNNING', maxResults: 1 }),
  );
  return (out.executions?.length ?? 0) > 0;
}

/**
 * Start the refresh state machine asynchronously (Requirement 10.3), rejecting
 * if one is already running (Requirement 10.5). `StartExecution` on a STANDARD
 * state machine returns immediately with the new execution ARN, so the caller
 * confirms acceptance well within 5s. Throws an error whose message is
 * {@link ALREADY_RUNNING} when a refresh is in progress; the handler maps that
 * to a 409 rejection that starts nothing.
 */
export async function startRefresh(): Promise<StartedRefresh> {
  if (await isRefreshRunning()) {
    throw new Error(ALREADY_RUNNING);
  }
  const { stateMachineArn } = getRefreshConfig();
  const out = await sfn().send(
    new StartExecutionCommand({ stateMachineArn, input: JSON.stringify({}) }),
  );
  return {
    executionArn: out.executionArn ?? '',
    startedAt: out.startDate ? out.startDate.toISOString() : undefined,
  };
}

/** Fields of a Step Functions `DescribeExecution` result this module consumes. */
export interface ExecutionDescription {
  executionArn?: string;
  status?: string;
  startDate?: Date;
  stopDate?: Date;
  error?: string;
  cause?: string;
}

/** Item counts from a Distributed Map run's `DescribeMapRun` (subset used here). */
export interface MapRunItemCounts {
  total?: number;
  succeeded?: number;
  failed?: number;
  aborted?: number;
  timedOut?: number;
}

/**
 * Describe a refresh execution and map it to the {@link RefreshStatus} DTO
 * (Requirement 10.4). While the execution is RUNNING, also fetch the collect
 * Distributed Map's progress (Requirement 10.12). Throws the raw SDK error when
 * the execution cannot be described (e.g. an unknown ARN).
 */
export async function describeRefresh(executionArn: string): Promise<RefreshStatus> {
  const out = await sfn().send(new DescribeExecutionCommand({ executionArn }));
  const status = mapExecutionToStatus(out);
  if (status.state === 'RUNNING') {
    const collect = await tryGetCollectProgress(executionArn);
    if (collect) {
      status.currentStage = collect.done ? 'finalizing' : 'collect';
      if (!collect.done) status.progress = collect.progress;
    }
  }
  return status;
}

/**
 * Best-effort: find the collect map run for an execution and compute progress.
 * Returns `undefined` if there is no map run yet (early startup) or the lookup
 * fails — progress is a nice-to-have, never a reason to fail status.
 * `done` is true once the map run itself has finished (collection complete,
 * finalize stages running).
 */
async function tryGetCollectProgress(
  executionArn: string,
): Promise<{ progress: RefreshProgress; done: boolean } | undefined> {
  try {
    const runs = await sfn().send(
      new ListMapRunsCommand({ executionArn, maxResults: 1 }),
    );
    const mapRunArn = runs.mapRuns?.[0]?.mapRunArn;
    if (!mapRunArn) return undefined;
    const run = await sfn().send(new DescribeMapRunCommand({ mapRunArn }));
    const counts: MapRunItemCounts = run.itemCounts ?? {};
    const total = counts.total ?? 0;
    const failed = (counts.failed ?? 0) + (counts.aborted ?? 0) + (counts.timedOut ?? 0);
    const completed = (counts.succeeded ?? 0) + failed;
    const done = run.status !== 'RUNNING';
    return {
      progress: { stage: 'collect', total, completed, failed },
      done,
    };
  } catch {
    return undefined;
  }
}

/** Terminal states in which a stage-specific failure message applies. */
function isFailureState(state: RefreshState): boolean {
  return state === 'FAILED' || state === 'TIMED_OUT' || state === 'ABORTED';
}

/** Map a raw Step Functions execution status to the {@link RefreshState} DTO. */
function toRefreshState(rawStatus: string | undefined): RefreshState {
  switch (rawStatus) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'ABORTED':
      return 'ABORTED';
    // RUNNING and PENDING_REDRIVE both mean "still in progress".
    default:
      return 'RUNNING';
  }
}

/**
 * Extract the failing pipeline stage from an execution `error`/`cause`. State
 * names in the machine embed the stage (e.g. `Collect`, `Transform`, `KbSync`,
 * `GraphReload`), and `pipeline`-style markers may also appear; match either.
 * Returns `undefined` when no recognised stage can be determined.
 */
export function extractFailedStage(...texts: Array<string | undefined>): RefreshStage | undefined {
  const stageAliases: Record<string, RefreshStage> = {
    collect: 'collect',
    transform: 'transform',
    kb_sync: 'kb_sync',
    kbsync: 'kb_sync',
    graph_reload: 'graph_reload',
    graphreload: 'graph_reload',
  };
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const [alias, stage] of Object.entries(stageAliases)) {
      if (lower.includes(alias)) return stage;
    }
  }
  return undefined;
}

/** Build the stage-specific failure message surfaced on a failed refresh (Req 10.8). */
function describeFailure(
  error: string | undefined,
  cause: string | undefined,
): { stage?: RefreshStage; message: string } {
  if (error === ALREADY_RUNNING) {
    return { message: 'A refresh is already in progress; concurrent refreshes are rejected.' };
  }
  const stage = extractFailedStage(cause, error);
  if (stage) {
    return {
      stage,
      message: `The refresh failed during the "${stage}" stage. The last sync date is unchanged.`,
    };
  }
  return {
    message:
      'The refresh pipeline failed and did not complete. The last sync date is unchanged. See the refresh logs for the failing stage.',
  };
}

/**
 * Pure mapping from a Step Functions execution description to the
 * {@link RefreshStatus} DTO. Exposed for unit testing without the SDK.
 */
export function mapExecutionToStatus(out: ExecutionDescription): RefreshStatus {
  const state = toRefreshState(out.status);
  const status: RefreshStatus = {
    executionId: out.executionArn ?? '',
    state,
  };
  if (out.startDate) status.startedAt = out.startDate.toISOString();
  if (out.stopDate) status.finishedAt = out.stopDate.toISOString();

  if (isFailureState(state)) {
    const failure = describeFailure(out.error, out.cause);
    if (failure.stage) status.errorStage = failure.stage;
    status.errorMessage = failure.message;
  }
  return status;
}

/**
 * Pure mapping from a map run's item counts to a {@link RefreshProgress}.
 * Exposed for unit testing without the SDK.
 */
export function mapCountsToProgress(counts: MapRunItemCounts): RefreshProgress {
  const total = counts.total ?? 0;
  const failed = (counts.failed ?? 0) + (counts.aborted ?? 0) + (counts.timedOut ?? 0);
  const completed = (counts.succeeded ?? 0) + failed;
  return { stage: 'collect', total, completed, failed };
}
