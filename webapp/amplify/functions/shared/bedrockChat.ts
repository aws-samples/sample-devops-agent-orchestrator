import type { LambdaFunctionURLEvent } from 'aws-lambda';
import {
  AgenticRetrieveStreamCommand,
  BedrockAgentRuntimeClient,
  type AgenticRetrieveMessage,
  type AgenticRetrieveResultEvent,
  type AgenticRetrieveStreamResponseOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { ApiError, ChatCitation, ChatStreamEvent, ChatTurn } from '@devops-observatory/shared-types';
import { getChatConfig } from './config';
import { ApiLayerError, ValidationError } from './errors';
import { requireAuthenticatedCaller, type TokenVerifier } from './functionUrlAuth';

/**
 * Knowledge-base chat proxy for the streaming `POST /chat` handler (Task 9).
 *
 * This module holds the testable core of the chat proxy, kept out of
 * `chat/handler.ts` so it can be exercised without the Lambda-only `awslambda`
 * global. It has three concerns:
 *
 *   1. {@link prepareChat} — PRE-STREAM validation (Requirements 8.1, 8.8, 8.9):
 *      require authentication and validate the question (1–1,000 chars). Both
 *      throw an {@link ApiLayerError} before any Bedrock call, so the handler
 *      can return a real 401/400 status instead of a 200 stream.
 *   2. {@link streamChatAnswer} — the streaming proxy (Requirements 8.2–8.4,
 *      8.7): call `AgenticRetrieveStream`, forward answer chunks as they arrive,
 *      collect + deduplicate cited sources, and enforce a hard 60s timeout. Any
 *      in-stream failure or timeout becomes an `error` stream event, never a
 *      thrown exception, and prior turns are preserved because history lives on
 *      the client and is never mutated here.
 *   3. Pure helpers ({@link buildMessages}, {@link collectCitations},
 *      {@link dedupeCitations}) that carry the multi-turn context (Requirement
 *      8.5) and shape citations.
 */

/** Maximum accepted question length in characters (Requirements 8.1, 8.9). */
export const MAX_CHAT_MESSAGE_LENGTH = 1000;

/** Hard cap on answer generation before the stream is failed (Requirement 8.7). */
export const CHAT_TIMEOUT_MS = 60_000;

/** A minimal sink the handler adapts from the Lambda response stream. */
export interface ChatSink {
  write(event: ChatStreamEvent): void;
  end(): void;
}

/** Validated, ready-to-stream chat request. */
export interface PreparedChat {
  /** Full message list forwarded to the KB: prior turns then the new question. */
  messages: AgenticRetrieveMessage[];
}

/** Options for {@link streamChatAnswer} (test seams for the client + timeout). */
export interface StreamChatOptions {
  timeoutMs?: number;
  client?: BedrockAgentRuntimeClient;
}

let cachedClient: BedrockAgentRuntimeClient | undefined;

/** Lazily construct a single Bedrock Agent Runtime client per warm container. */
function client(): BedrockAgentRuntimeClient {
  if (!cachedClient) {
    cachedClient = new BedrockAgentRuntimeClient({ region: getChatConfig().region });
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Request parsing + validation (pre-stream)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Count characters by Unicode code point so multi-byte input is bounded fairly. */
function countChars(text: string): number {
  return Array.from(text).length;
}

/** Decode the (possibly base64-encoded) Function URL body to a UTF-8 string. */
function readBody(body: string | undefined, isBase64Encoded: boolean | undefined): string {
  if (typeof body !== 'string' || body.length === 0) {
    throw new ValidationError('A question is required.');
  }
  return isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

/** Coerce raw prior turns into typed {@link ChatTurn}s, dropping malformed entries. */
export function normalizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { role, content } = entry;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.length > 0) {
      turns.push({ role, content });
    }
  }
  return turns;
}

/**
 * Parse and validate the `POST /chat` body. The question must be present and
 * 1–1,000 characters; anything else is a {@link ValidationError} (Requirements
 * 8.1, 8.9). Prior turns, when present, are normalized for forwarding
 * (Requirement 8.5).
 */
export function parseChatRequest(
  body: string | undefined,
  isBase64Encoded?: boolean,
): { message: string; history: ChatTurn[] } {
  const text = readBody(body, isBase64Encoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new ValidationError('The request body must be a JSON object.');
  }
  const message = parsed.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new ValidationError('The question must not be empty.');
  }
  if (countChars(message) > MAX_CHAT_MESSAGE_LENGTH) {
    throw new ValidationError(
      `The question must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer.`,
    );
  }
  return { message, history: normalizeHistory(parsed.history) };
}

/**
 * Built-in GOVERNED layer of the chat system prompt (Requirement 5.16, 15.2).
 * Always prepended and NOT editable by an admin — the admin `orgSystemPrompt`
 * can shape persona/tone/scope but cannot remove these safety/grounding rules.
 */
export const GOVERNED_PROMPT_PREFIX =
  'You are the assistant for Enterprise DevOps Observatory (EDO), an executive, ' +
  "portfolio-level view over an organization's AWS DevOps Agent estate. " +
  'Ground every answer in the provided knowledge base, business context, and topology facts, and cite sources. ' +
  'If the knowledge base does not contain the answer, say so plainly rather than guessing, and ' +
  'point the user at the relevant DevOps Agent Space for deep per-workload investigation. ' +
  'Never fabricate counts, metrics, or account identifiers. Only surface data the user is entitled to.';

/**
 * Built-in DEFAULT org guidance used when no admin `orgSystemPrompt` is set.
 * Establishes the executive persona/tone.
 */
export const DEFAULT_ORG_SYSTEM_PROMPT =
  'Answer as a concise, business-oriented briefing for a C-level, VP, or director audience who ' +
  'owns the whole AWS environment. Lead with business impact and portfolio-level insight; keep ' +
  'technical detail proportional to the question and note the data freshness where relevant.';

/**
 * Compose the effective chat system prompt: the immutable governed layer,
 * followed by the admin-authored org guidance (or the built-in default when
 * none is set). The governed layer is always present, so an empty or hostile
 * org prompt still yields a safe, grounded assistant (Requirement 5.16).
 */
export function composeSystemPrompt(orgSystemPrompt?: string): string {
  const org =
    typeof orgSystemPrompt === 'string' && orgSystemPrompt.trim().length > 0
      ? orgSystemPrompt.trim()
      : DEFAULT_ORG_SYSTEM_PROMPT;
  return `${GOVERNED_PROMPT_PREFIX}\n\n${org}`;
}

/**
 * Build the ordered KB message list: prior turns (oldest first) followed by the
 * new question, so follow-ups build on prior context (Requirement 8.5).
 *
 * When a `systemPrompt` is supplied, it is injected as a leading user/assistant
 * framing pair (AgenticRetrieve messages are user/assistant only — there is no
 * first-class system role), so the guidance is in effect for the whole
 * conversation. The latest user turn still drives retrieval.
 */
export function buildMessages(
  message: string,
  history: ChatTurn[],
  systemPrompt?: string,
): AgenticRetrieveMessage[] {
  const leading: AgenticRetrieveMessage[] =
    typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
      ? [
          { role: 'user', content: { text: `SYSTEM GUIDANCE (follow strictly):\n${systemPrompt.trim()}` } },
          {
            role: 'assistant',
            content: {
              text: 'Understood. I will follow this guidance and ground my answers in the knowledge base, citing sources.',
            },
          },
        ]
      : [];
  const prior = history.map((turn) => ({
    role: turn.role,
    content: { text: turn.content },
  }));
  return [...leading, ...prior, { role: 'user' as const, content: { text: message } }];
}

/** Options for {@link prepareChat} (test seam for the token verifier). */
export interface PrepareChatOptions {
  verifier?: TokenVerifier;
}

/**
 * Authenticate the caller and validate the question, producing the message list
 * to stream. Authentication is enforced first: the caller's Cognito access
 * token is cryptographically verified and only then is the question validated.
 * Throws an {@link ApiLayerError} (401 unauthenticated / 400 validation) before
 * any Bedrock call so no downstream request is made for a rejected request
 * (Requirements 8.8, 8.9).
 */
export async function prepareChat(
  event: LambdaFunctionURLEvent,
  opts: PrepareChatOptions = {},
): Promise<PreparedChat> {
  await requireAuthenticatedCaller(event, opts.verifier);
  const { message, history } = parseChatRequest(event.body, event.isBase64Encoded);
  return { messages: buildMessages(message, history) };
}

// ---------------------------------------------------------------------------
// Citation extraction (Requirements 8.3, 8.4)
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Derive a short human-friendly title from a source URI (its last path segment). */
function titleFromUri(uri: string): string | undefined {
  const trimmed = uri.replace(/\/+$/, '');
  const segment = trimmed.split('/').pop();
  return segment && segment.length > 0 ? segment : undefined;
}

/**
 * Collect cited sources from a KB `result` event into `acc`. Mirrors the
 * reference chat script: prefer the source URI from item metadata
 * (`_source_uri` / `x-amz-bedrock-kb-source-uri`), falling back to the source
 * retriever identifier. Items with no usable identifier are skipped.
 */
export function collectCitations(
  result: AgenticRetrieveResultEvent,
  acc: ChatCitation[],
): void {
  for (const item of result.results ?? []) {
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const uri =
      asString(metadata['_source_uri']) ??
      asString(metadata['x-amz-bedrock-kb-source-uri']) ??
      asString(item.sourceRetriever?.identifier);
    if (!uri) continue;
    const citation: ChatCitation = { uri };
    const title = titleFromUri(uri);
    if (title) citation.title = title;
    const snippet = asString(item.content?.text);
    if (snippet) citation.snippet = snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet;
    acc.push(citation);
  }
}

/**
 * Deduplicate citations by source URI (falling back to title), preserving first
 * occurrence order, so the same source is listed once (Requirement 8.3). An
 * empty result signals "no sources cited" to the client (Requirement 8.4).
 */
export function dedupeCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const citation of citations) {
    const key = citation.uri ?? citation.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming proxy (Requirements 8.2, 8.7)
// ---------------------------------------------------------------------------

/** Raised when answer generation exceeds {@link CHAT_TIMEOUT_MS} (Requirement 8.7). */
export class ChatTimeoutError extends Error {
  constructor() {
    super('The knowledge base did not respond within 60 seconds.');
    this.name = 'ChatTimeoutError';
  }
}

/** Exception member keys that may appear in the KB response stream. */
const EXCEPTION_KEYS = [
  'internalServerException',
  'validationException',
  'resourceNotFoundException',
  'serviceQuotaExceededException',
  'throttlingException',
  'accessDeniedException',
  'conflictException',
  'dependencyFailedException',
  'badGatewayException',
] as const;

/** Throw if a stream event is a Bedrock exception member so the loop fails fast. */
function throwIfException(event: AgenticRetrieveStreamResponseOutput): void {
  for (const key of EXCEPTION_KEYS) {
    const member = (event as unknown as Record<string, unknown>)[key];
    if (isRecord(member)) {
      const message = asString(member.message) ?? 'The knowledge base returned an error.';
      throw new ApiLayerError('UPSTREAM_UNAVAILABLE', message);
    }
  }
}

/**
 * Send the `AgenticRetrieveStream` request and return its event stream. The KB
 * id + chat model come from {@link getChatConfig}; `generateResponse` yields a
 * synthesized, citation-backed answer (Requirement 8.2). An optional
 * `abortSignal` lets the caller cancel the request when the timeout fires.
 */
export async function streamAgenticRetrieve(
  messages: AgenticRetrieveMessage[],
  opts: { client?: BedrockAgentRuntimeClient; abortSignal?: AbortSignal } = {},
): Promise<AsyncIterable<AgenticRetrieveStreamResponseOutput>> {
  const { knowledgeBaseId, modelArn } = getChatConfig();
  const bedrock = opts.client ?? client();
  const response = await bedrock.send(
    new AgenticRetrieveStreamCommand({
      messages,
      retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId } } }],
      agenticRetrieveConfiguration: {
        foundationModelType: 'CUSTOM',
        foundationModelConfiguration: {
          type: 'BEDROCK_FOUNDATION_MODEL',
          bedrockFoundationModelConfiguration: {
            modelConfiguration: { modelArn },
          },
        },
      },
      generateResponse: true,
    }),
    { abortSignal: opts.abortSignal },
  );
  // Fall back to an empty async stream (not `[]`, which is not an
  // AsyncIterable) when the SDK returns no event stream.
  return response.stream ?? (async function* () {})();
}

/** Run `work(signal)` but reject with {@link ChatTimeoutError} after `ms`. */
async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ChatTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Map a thrown value to a user-facing chat error message. */
function toChatErrorMessage(err: unknown): string {
  if (err instanceof ChatTimeoutError) return err.message;
  if (err instanceof ApiLayerError) return err.message;
  if (err instanceof Error && err.name === 'AbortError') {
    return new ChatTimeoutError().message;
  }
  return 'An unexpected error occurred while answering your question.';
}

/**
 * Proxy `AgenticRetrieveStream` into the sink: emit `chunk` events as answer
 * text arrives (Requirement 8.2), then a single `citations` event with the
 * deduplicated cited sources (empty = no sources cited; Requirements 8.3, 8.4),
 * then `done`. Any failure or a >60s timeout is emitted as a single `error`
 * event instead — never thrown — and prior turns are preserved because the
 * conversation lives on the client and is never mutated here (Requirement 8.7).
 * The sink is always ended exactly once.
 */
export async function streamChatAnswer(
  messages: AgenticRetrieveMessage[],
  sink: ChatSink,
  opts: StreamChatOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  const citations: ChatCitation[] = [];
  try {
    await withTimeout(timeoutMs, async (signal) => {
      const stream = await streamAgenticRetrieve(messages, {
        client: opts.client,
        abortSignal: signal,
      });
      for await (const event of stream) {
        throwIfException(event);
        const chunk = event.responseEvent?.text;
        if (typeof chunk === 'string' && chunk.length > 0) {
          sink.write({ kind: 'chunk', text: chunk });
        } else if (event.result) {
          collectCitations(event.result, citations);
        }
      }
    });
    sink.write({ kind: 'citations', citations: dedupeCitations(citations) });
    sink.write({ kind: 'done' });
  } catch (err) {
    // Log the underlying cause for operability — the client only sees a
    // sanitized message, so without this the real failure is invisible.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[chat] answer generation failed:', detail, err);
    sink.write({ kind: 'error', message: toChatErrorMessage(err) });
  } finally {
    sink.end();
  }
}

/** Translate a thrown value into the standard {@link ApiError} envelope. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiLayerError) return err.toApiError();
  return { code: 'INTERNAL', message: 'An unexpected error occurred.' };
}

// ---------------------------------------------------------------------------
// Non-streaming answer (HTTP API `POST /chat`)
// ---------------------------------------------------------------------------

/** A fully-synthesized chat answer with its deduplicated citation set. */
export interface ChatAnswer {
  answer: string;
  citations: ChatCitation[];
}

/**
 * Produce a complete (non-streaming) answer for the HTTP API `POST /chat` route.
 *
 * The public streaming Function URL model is blocked in this deployment's
 * environment, so chat runs over the JWT-authorized HTTP API and must return a
 * single JSON body. This reuses the exact streaming proxy ({@link
 * streamChatAnswer}) — same `AgenticRetrieveStream` call, citation dedup, and
 * timeout — but accumulates the emitted events in memory instead of writing
 * them to the client. An in-stream `error`/timeout event (which the streaming
 * path surfaces rather than throwing) is re-raised here as an
 * {@link ApiLayerError} so `withErrorHandling` renders the correct status.
 */
export async function answerChatOnce(
  messages: AgenticRetrieveMessage[],
  opts: StreamChatOptions = {},
): Promise<ChatAnswer> {
  let answer = '';
  let citations: ChatCitation[] = [];
  let errorMessage: string | undefined;
  const sink: ChatSink = {
    write: (event) => {
      if (event.kind === 'chunk') answer += event.text;
      else if (event.kind === 'citations') citations = event.citations;
      else if (event.kind === 'error') errorMessage = event.message;
    },
    end: () => {},
  };
  await streamChatAnswer(messages, sink, opts);
  if (errorMessage !== undefined) {
    throw new ApiLayerError('UPSTREAM_UNAVAILABLE', errorMessage);
  }
  return { answer, citations };
}
