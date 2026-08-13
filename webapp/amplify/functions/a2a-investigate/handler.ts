import {
  CallbackTimeoutError,
  type DurableContext,
  withDurableExecution,
} from '@aws/durable-execution-sdk-js';

import {
  getStoredToken,
  isTaskRunning,
  pollInvestigateTask,
  sendChat,
  sendInvestigateStart,
} from '../shared/a2a';
import {
  patchInvestigationRecord,
  type InvestigateResult,
  type InvestigationDecision,
  type InvestigatePayload,
} from '../shared/a2aInvestigate';

/**
 * Durable `investigate` orchestrator (Task 38).
 *
 * A Lambda DURABLE FUNCTION that reliably runs a long DevOps Agent
 * investigation, then pauses for a human to review the findings before the
 * execution is closed. The API-side `a2a` handler starts it asynchronously
 * (a named durable execution) and polls its status; this function:
 *
 *   1. `start-investigation` — start the space's `investigate` skill and capture
 *      the A2A task id (the token is read INSIDE the step and never returned/
 *      checkpointed, so no secret is persisted in the execution state).
 *   2. `poll-task` — a durable `waitForCondition` that polls the A2A task with
 *      exponential backoff until it reaches a terminal state, WITHOUT holding a
 *      Lambda invocation open between polls (no compute charge while waiting).
 *   3. `await-approval` — a durable callback (human-in-the-loop): the findings
 *      are published to the S3 index and the execution suspends until a reviewer
 *      approves (acknowledge) or rejects (dismiss). The app never auto-acts on
 *      the agent's analysis.
 *
 * All non-deterministic work (network + secret reads) runs inside steps / the
 * condition check / the callback submitter, per the durable replay model.
 */

/** Poll backoff: start at 10s, grow ×1.5 up to 60s, for at most ~90 attempts. */
const POLL_INITIAL_DELAY_SECONDS = 10;
const POLL_MAX_DELAY_SECONDS = 60;
const POLL_BACKOFF_RATE = 1.5;
const POLL_MAX_ATTEMPTS = 90;
/** How long the findings wait for a human decision before expiring. */
const APPROVAL_TIMEOUT = { hours: 12 } as const;

interface PollState {
  taskState?: string;
  findings: string;
}

export const handler = withDurableExecution(
  async (event: InvestigatePayload, context: DurableContext): Promise<InvestigateResult> => {
    const { spaceId, executionName, message } = event;
    const skill = event.skill ?? 'investigate';

    // ---------------------------------------------------------------------
    // `chat` skill — synchronous at the endpoint but often slower than the API
    // Gateway 30s limit, so we run it here (durable, async) and the browser
    // polls for the answer. One step, no polling / approval. The step CATCHES
    // its own errors (no retry storm on a 120s call) and returns a result.
    // ---------------------------------------------------------------------
    if (skill === 'chat') {
      const res = await context.step('run-chat', async () => {
        const token = await getStoredToken(spaceId);
        if (!token) {
          return {
            ok: false as const,
            error: 'No A2A access token is configured for this agent space.',
          };
        }
        try {
          const chat = await sendChat(token, message);
          return { ok: true as const, answer: chat.answer };
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : 'The agent space could not be reached.',
          };
        }
      });

      await context.step('record-chat-closed', async () => {
        await patchInvestigationRecord(executionName, {
          phase: 'CLOSED',
          decision: res.ok ? 'approved' : 'rejected',
          ...(res.ok ? { findings: res.answer } : {}),
        });
      });

      if (!res.ok) throw new Error(res.error);
      return { decision: 'approved', findings: res.answer, question: message, skill: 'chat' };
    }

    // 1. Start the investigation. The token is fetched inside the step and only
    //    the task handle is returned (checkpointed) — never the secret.
    const started = await context.step('start-investigation', async () => {
      const token = await getStoredToken(spaceId);
      if (!token) throw new Error(`No A2A access token is configured for agent space ${spaceId}.`);
      return sendInvestigateStart(token, message);
    });

    await context.step('record-task', async () => {
      await patchInvestigationRecord(executionName, { taskId: started.taskId });
    });

    // 2. Poll the A2A task until it reaches a terminal state (durable wait — no
    //    compute charge between attempts).
    const poll = await context.waitForCondition<PollState>(
      'poll-task',
      async (state, ctx) => {
        const token = await getStoredToken(spaceId);
        if (!token) throw new Error(`The A2A access token for space ${spaceId} is no longer available.`);
        const res = await pollInvestigateTask(token, started.taskId);
        ctx.logger.info('investigate poll', { taskId: started.taskId, taskState: res.state });
        return { taskState: res.state, findings: res.findings || state.findings };
      },
      {
        initialState: { taskState: 'TASK_STATE_SUBMITTED', findings: '' },
        waitStrategy: (state, attempt) => {
          if (!isTaskRunning(state.taskState) || attempt >= POLL_MAX_ATTEMPTS) {
            return { shouldContinue: false };
          }
          const delaySeconds = Math.min(
            Math.round(POLL_INITIAL_DELAY_SECONDS * POLL_BACKOFF_RATE ** (attempt - 1)),
            POLL_MAX_DELAY_SECONDS,
          );
          return { shouldContinue: true, delay: { seconds: delaySeconds } };
        },
      },
    );

    if (poll.taskState !== 'TASK_STATE_COMPLETED') {
      // The DevOps Agent `investigate` skill over A2A often does not return
      // results through task polling: the task can vanish (404 → TASK_NOT_FOUND)
      // or sit at TASK_STATE_SUBMITTED indefinitely. Surface a clear, actionable
      // message rather than a raw error.
      if (poll.taskState === 'TASK_NOT_FOUND') {
        throw new Error(
          'The agent accepted the investigation, but its task is no longer available over A2A, ' +
            'so the findings could not be retrieved. This is a current limitation of the DevOps ' +
            'Agent investigate-over-A2A flow (the task is not retained for polling).',
        );
      }
      if (isTaskRunning(poll.taskState)) {
        throw new Error(
          'The investigation is still queued at the agent (task state stayed ' +
            `${poll.taskState}) and did not produce findings within the polling window. This is a ` +
            'current limitation of the DevOps Agent investigate-over-A2A flow.',
        );
      }
      throw new Error(
        `The investigation did not complete (task state: ${poll.taskState ?? 'unknown'}).`,
      );
    }
    const findings = poll.findings.length > 0 ? poll.findings : 'The investigation produced no findings.';

    // 3. Human-in-the-loop gate: register a callback, publish it + the findings
    //    for the reviewer, then suspend until a decision arrives.
    const [approval, callbackId] = await context.createCallback<string>('await-approval', {
      timeout: APPROVAL_TIMEOUT,
    });
    await context.step('record-awaiting-approval', async () => {
      await patchInvestigationRecord(executionName, {
        phase: 'AWAITING_APPROVAL',
        callbackId,
        findings,
      });
    });

    let decision: InvestigationDecision = 'approved';
    try {
      await approval;
    } catch (err) {
      // Timeout → findings expired unreviewed; any other callback failure → the
      // reviewer dismissed the findings.
      decision = err instanceof CallbackTimeoutError ? 'expired' : 'rejected';
    }

    await context.step('record-closed', async () => {
      await patchInvestigationRecord(executionName, { phase: 'CLOSED', decision, findings });
    });

    return {
      decision,
      findings,
      question: message,
      skill: 'investigate',
      ...(started.taskId ? { taskId: started.taskId } : {}),
    };
  },
);
