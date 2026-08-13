import { randomUUID } from 'node:crypto';

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  A2A_MESSAGE_MAX_LENGTH,
  A2A_MESSAGE_MIN_LENGTH,
  A2A_TOKEN_MAX_LENGTH,
  type A2aChatResponse,
  type A2aStatus,
} from '@devops-observatory/shared-types';
import { UpstreamUnavailableError, ValidationError } from './errors';

/**
 * Agent-to-Agent (A2A) integration for talking to an individual DevOps Agent
 * Space (Task 36).
 *
 * The DevOps Agent A2A remote server is a per-region HTTPS endpoint
 * (`https://connect.aidevops.{region}.api.aws`, REST/HTTP+JSON binding, A2A
 * v1.0). A space is addressed with a Bearer **access token** that is bound to
 * exactly one space — so a stored token reaches its space regardless of which
 * account this app runs in (no cross-account SigV4). Tokens are created
 * MANUALLY in the DevOps Agent web app and stored here in AWS Secrets Manager,
 * one secret per space, and are NEVER returned to the browser.
 *
 * The pure helpers (secret-name derivation, input validation, request-body
 * construction, task-response parsing) are unit-tested without the SDK/network;
 * the handler wires the Secrets Manager client and `fetch`.
 */

/** A space id is a UUID (the DevOps Agent `agentSpaceId`). */
const SPACE_ID_RE = /^[0-9a-fA-F-]{36}$/;

/** Secrets Manager name prefix for per-space A2A tokens. */
export const A2A_SECRET_PREFIX = 'devops-observatory/a2a/';

/** The JSON shape stored in each per-space secret (token + admin metadata). */
export interface A2aSecretValue {
  token: string;
  region?: string;
  tokenName?: string;
  scope?: string;
  expiresAt?: string;
  updatedAt: string;
}

/**
 * Derive the Secrets Manager secret name for a space's A2A token. Pure and
 * deterministic so both the store and read paths agree.
 */
export function secretNameForSpace(spaceId: string): string {
  return `${A2A_SECRET_PREFIX}${spaceId}`;
}

/** Validate a path `spaceId`, returning it trimmed or throwing a 400. */
export function requireSpaceId(spaceId: string | undefined): string {
  const id = (spaceId ?? '').trim();
  if (!SPACE_ID_RE.test(id)) {
    throw new ValidationError('A valid agent space id is required in the path.');
  }
  return id;
}

/**
 * Validate + normalize a `PUT /a2a-token` body. Pure and SDK-free. The token is
 * required and length-bounded; metadata is optional and trimmed. `defaultRegion`
 * (the hub region) is used when the caller omits a region.
 */
export function validateTokenRequest(
  body: unknown,
  defaultRegion: string,
): { valid: true; value: A2aSecretValue } | { valid: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, message: 'A request body is required.' };
  }
  const raw = body as Record<string, unknown>;
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (token.length === 0) {
    return { valid: false, message: 'A non-empty access token is required.' };
  }
  if (token.length > A2A_TOKEN_MAX_LENGTH) {
    return { valid: false, message: `The token must be at most ${A2A_TOKEN_MAX_LENGTH} characters.` };
  }
  const str = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s.length > 0 ? s : undefined;
  };
  const value: A2aSecretValue = {
    token,
    region: str(raw.region) ?? defaultRegion,
    updatedAt: new Date().toISOString(),
  };
  const tokenName = str(raw.tokenName);
  const scope = str(raw.scope);
  const expiresAt = str(raw.expiresAt);
  if (tokenName) value.tokenName = tokenName;
  if (scope) value.scope = scope;
  if (expiresAt) value.expiresAt = expiresAt;
  return { valid: true, value };
}

/** Validate + normalize an A2A chat message body. Pure and SDK-free. */
export function validateChatRequest(
  body: unknown,
): { valid: true; message: string } | { valid: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, message: 'A request body is required.' };
  }
  const raw = (body as Record<string, unknown>).message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (message.length < A2A_MESSAGE_MIN_LENGTH) {
    return { valid: false, message: 'A non-empty message is required.' };
  }
  if (message.length > A2A_MESSAGE_MAX_LENGTH) {
    return {
      valid: false,
      message: `The message must be at most ${A2A_MESSAGE_MAX_LENGTH} characters.`,
    };
  }
  return { valid: true, message };
}

/** Map a stored secret value to the non-sensitive status DTO (drops the token). */
export function toStatus(value: A2aSecretValue): A2aStatus {
  return {
    configured: true,
    ...(value.region ? { region: value.region } : {}),
    ...(value.tokenName ? { tokenName: value.tokenName } : {}),
    ...(value.scope ? { scope: value.scope } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

/** The A2A remote-server base URL for a region. */
export function a2aBaseUrl(region: string): string {
  return `https://connect.aidevops.${region}.api.aws`;
}

/**
 * Build the A2A `message:send` request body for the `chat` skill (A2A v1.0
 * HTTP+JSON binding). Pure so the wire shape is unit-tested.
 */
export function buildChatBody(message: string, messageId: string = randomUUID()): Record<string, unknown> {
  return {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: message }],
      messageId,
    },
    metadata: { skillId: 'chat' },
  };
}

interface A2aTaskResponse {
  task?: {
    id?: string;
    status?: { state?: string };
    artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
  };
}

/**
 * Extract the answer text + task metadata from an A2A task response. Pure. The
 * answer is the concatenation of every text part across the task's artifacts;
 * an empty/instructional message is returned when the task produced no text so
 * the UI always has something to show.
 */
export function parseChatResponse(payload: unknown): A2aChatResponse {
  const task = (payload as A2aTaskResponse)?.task;
  const parts: string[] = [];
  for (const artifact of task?.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) parts.push(part.text);
    }
  }
  const answer = parts.join('\n').trim();
  return {
    answer: answer.length > 0 ? answer : 'The agent returned no text response.',
    ...(task?.id ? { taskId: task.id } : {}),
    ...(task?.status?.state ? { state: task.status.state } : {}),
  };
}

// ---------------------------------------------------------------------------
// `investigate` skill wire helpers (async, durable) — pure + SDK-free
// ---------------------------------------------------------------------------

/**
 * A2A task states that mean the task is still running (keep polling). Anything
 * else (COMPLETED / FAILED / CANCELED / REJECTED) is terminal. Pure so the
 * durable poller's continue/stop decision is unit-tested.
 */
export const A2A_TASK_NONTERMINAL_STATES = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'] as const;

/** True while the A2A task is still running (submitted/working). */
export function isTaskRunning(state: string | undefined): boolean {
  return state === 'TASK_STATE_SUBMITTED' || state === 'TASK_STATE_WORKING';
}

/**
 * Build the A2A `message:send` body for the `investigate` skill (same envelope
 * as chat, different skillId). Pure so the wire shape is unit-tested.
 */
export function buildInvestigateBody(
  message: string,
  messageId: string = randomUUID(),
): Record<string, unknown> {
  return {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: message }],
      messageId,
    },
    metadata: { skillId: 'investigate' },
  };
}

interface A2aTaskEnvelope {
  id?: string;
  contextId?: string;
  status?: { state?: string };
  artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
  // `message:send` for investigate may nest the task under `task`.
  task?: A2aTaskEnvelope;
}

/** Concatenate every text part across a task's artifacts (shared by parsers). */
function collectArtifactText(task: A2aTaskEnvelope | undefined): string {
  const parts: string[] = [];
  for (const artifact of task?.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Parse the response to starting an investigation. The `investigate` skill
 * returns a WORKING task whose id is the handle we poll; some responses also
 * embed an `{"type":"investigation_started","taskId":…}` artifact — we prefer
 * the task id and fall back to that. Pure. Returns `{ taskId, contextId }` or
 * `taskId: undefined` when the payload has no task handle.
 */
export function parseInvestigationStarted(payload: unknown): {
  taskId?: string;
  contextId?: string;
  state?: string;
} {
  const root = payload as A2aTaskEnvelope;
  const task = root?.task ?? root;
  let taskId = task?.id;
  if (!taskId) {
    // Fall back to an `investigation_started` artifact carrying the taskId.
    const text = collectArtifactText(task);
    if (text) {
      try {
        const parsed = JSON.parse(text) as { taskId?: string };
        if (typeof parsed?.taskId === 'string') taskId = parsed.taskId;
      } catch {
        /* not JSON — no embedded taskId */
      }
    }
  }
  return {
    ...(taskId ? { taskId } : {}),
    ...(task?.contextId ? { contextId: task.contextId } : {}),
    ...(task?.status?.state ? { state: task.status.state } : {}),
  };
}

/**
 * Parse a `GET /a2a/tasks/{id}` poll response into `{ state, findings }`. Pure.
 * `findings` is the concatenated artifact text (the investigation write-up),
 * empty until the task produces output.
 */
export function parseTaskPoll(payload: unknown): { state?: string; findings: string } {
  const root = payload as A2aTaskEnvelope;
  const task = root?.task ?? root;
  return {
    ...(task?.status?.state ? { state: task.status.state } : {}),
    findings: collectArtifactText(task),
  };
}

// ---------------------------------------------------------------------------
// Secrets Manager access (per-space A2A token)
// ---------------------------------------------------------------------------

let cachedSecrets: SecretsManagerClient | undefined;
function secrets(): SecretsManagerClient {
  if (!cachedSecrets) {
    cachedSecrets = new SecretsManagerClient({ region: process.env.HUB_REGION });
  }
  return cachedSecrets;
}

/** Read a space's stored A2A secret, or `undefined` when none is configured. */
export async function getStoredToken(spaceId: string): Promise<A2aSecretValue | undefined> {
  try {
    const out = await secrets().send(
      new GetSecretValueCommand({ SecretId: secretNameForSpace(spaceId) }),
    );
    if (!out.SecretString) return undefined;
    return JSON.parse(out.SecretString) as A2aSecretValue;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw new UpstreamUnavailableError('The stored A2A token could not be read.');
  }
}

/** Create or replace a space's A2A token secret (idempotent on the secret name). */
export async function putStoredToken(spaceId: string, value: A2aSecretValue): Promise<void> {
  const SecretId = secretNameForSpace(spaceId);
  const SecretString = JSON.stringify(value);
  try {
    await secrets().send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await secrets().send(
        new CreateSecretCommand({
          Name: SecretId,
          SecretString,
          Description: `DevOps Observatory A2A access token for agent space ${spaceId}`,
        }),
      );
      return;
    }
    throw new UpstreamUnavailableError('The A2A token could not be stored.');
  }
}

/**
 * List the agent-space ids that currently have an A2A token stored, by paging
 * Secrets Manager for secrets under the A2A name prefix. Metadata only — no
 * secret values are fetched. A read failure surfaces as an upstream error.
 */
export async function listConfiguredSpaceIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let nextToken: string | undefined;
  try {
    do {
      const out = await secrets().send(
        new ListSecretsCommand({
          Filters: [{ Key: 'name', Values: [A2A_SECRET_PREFIX] }],
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      for (const secret of out.SecretList ?? []) {
        const name = secret.Name ?? '';
        if (name.startsWith(A2A_SECRET_PREFIX)) {
          const id = name.slice(A2A_SECRET_PREFIX.length);
          if (id.length > 0) ids.add(id);
        }
      }
      nextToken = out.NextToken;
    } while (nextToken);
  } catch {
    throw new UpstreamUnavailableError('The configured A2A spaces could not be listed.');
  }
  return ids;
}

/** Delete a space's A2A token secret (best-effort; missing = already gone). */
export async function deleteStoredToken(spaceId: string): Promise<void> {
  try {
    await secrets().send(
      new DeleteSecretCommand({
        SecretId: secretNameForSpace(spaceId),
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw new UpstreamUnavailableError('The A2A token could not be removed.');
  }
}

/**
 * Call the space's A2A `chat` skill using its stored Bearer token. The token is
 * bound to the space, so no space id is sent on the wire. A non-2xx or
 * unreachable endpoint surfaces as an upstream error. 120s timeout per the
 * DevOps Agent guidance (initial responses can take 5–30s).
 */
export async function sendChat(value: A2aSecretValue, message: string): Promise<A2aChatResponse> {
  const region = value.region ?? process.env.HUB_REGION ?? 'us-east-1';
  const url = `${a2aBaseUrl(region)}/a2a/message:send`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${value.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'A2A-Version': '1.0',
      },
      body: JSON.stringify(buildChatBody(message)),
      signal: controller.signal,
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new UpstreamUnavailableError(
          'The stored A2A token was rejected (401). It may be expired or revoked — rotate it in the DevOps Agent console and re-store it.',
        );
      }
      throw new UpstreamUnavailableError(`The agent space returned an error (HTTP ${resp.status}).`);
    }
    return parseChatResponse(await resp.json());
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamUnavailableError('The agent space did not respond within 120 seconds.');
    }
    throw new UpstreamUnavailableError('The agent space could not be reached.');
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// `investigate` skill HTTP calls (used INSIDE durable steps)
// ---------------------------------------------------------------------------

/** Bearer + A2A headers for a stored token (shared by the investigate calls). */
function a2aHeaders(value: A2aSecretValue): Record<string, string> {
  return {
    Authorization: `Bearer ${value.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'A2A-Version': '1.0',
  };
}

/**
 * Start an investigation on the space's `investigate` skill and return the task
 * handle to poll. Called from inside a durable step (its result is
 * checkpointed). A rejected token (401) or missing task handle surfaces as an
 * upstream error so the durable step's retry/failure handling can react.
 */
export async function sendInvestigateStart(
  value: A2aSecretValue,
  message: string,
): Promise<{ taskId: string; contextId?: string }> {
  const region = value.region ?? process.env.HUB_REGION ?? 'us-east-1';
  const url = `${a2aBaseUrl(region)}/a2a/message:send`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: a2aHeaders(value),
      body: JSON.stringify(buildInvestigateBody(message)),
      signal: controller.signal,
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new UpstreamUnavailableError(
          'The stored A2A token was rejected (401). Rotate it in the DevOps Agent console and re-store it.',
        );
      }
      throw new UpstreamUnavailableError(`The agent space returned an error (HTTP ${resp.status}).`);
    }
    const started = parseInvestigationStarted(await resp.json());
    if (!started.taskId) {
      throw new UpstreamUnavailableError(
        'The agent space did not return an investigation task id.',
      );
    }
    return { taskId: started.taskId, ...(started.contextId ? { contextId: started.contextId } : {}) };
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamUnavailableError('The agent space did not respond within 120 seconds.');
    }
    throw new UpstreamUnavailableError('The agent space could not be reached.');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Poll a running investigation's task (`GET /a2a/tasks/{taskId}`) and return its
 * `{ state, findings }`. Called from inside the durable `waitForCondition` check
 * (each attempt is checkpointed). A short 30s timeout keeps each poll snappy —
 * the durable wait strategy, not this call, is what waits between polls.
 */
export async function pollInvestigateTask(
  value: A2aSecretValue,
  taskId: string,
): Promise<{ state?: string; findings: string }> {
  const region = value.region ?? process.env.HUB_REGION ?? 'us-east-1';
  const url = `${a2aBaseUrl(region)}/a2a/tasks/${encodeURIComponent(taskId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(url, { method: 'GET', headers: a2aHeaders(value), signal: controller.signal });
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new UpstreamUnavailableError('The stored A2A token was rejected (401) while polling.');
      }
      // The investigate task is frequently purged shortly after creation — the
      // A2A server then returns 404 TASK_NOT_FOUND. Treat that as a terminal
      // (non-running) state so the durable poller stops and reports it clearly,
      // rather than throwing a raw HTTP error mid-poll.
      if (resp.status === 404) {
        return { state: 'TASK_NOT_FOUND', findings: '' };
      }
      throw new UpstreamUnavailableError(
        `The agent space returned an error polling the task (HTTP ${resp.status}).`,
      );
    }
    return parseTaskPoll(await resp.json());
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamUnavailableError('Polling the investigation task timed out.');
    }
    throw new UpstreamUnavailableError('The agent space could not be reached while polling.');
  } finally {
    clearTimeout(timeout);
  }
}
