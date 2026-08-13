import type {
  ChatCitation,
  ChatHistoryMessage,
  ChatStreamEvent,
  ChatTurn,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free logic for the Chat_UI (Task 15 — Requirements 8.1–8.7, 8.9).
 *
 * Kept separate from the React view (which owns the fetch/stream + rendering) so
 * the pieces that are easy to get subtly wrong — length validation, NDJSON
 * frame parsing, multi-turn history mapping, and applying stream events to the
 * in-progress answer — can be unit-tested with the repo's `node:test` + tsx
 * convention, independent of the DOM, fetch, or Amplify.
 *
 * Requirements: 8.1/8.9 (1–1,000 character validation, reject empty/too-long),
 * 8.2 (incremental answer assembly from `chunk` events), 8.3/8.4 (citations,
 * incl. the empty "no sources cited" case), 8.5 (ordered multi-turn history),
 * 8.7 (errors preserve the conversation — the error is captured on the turn,
 * never by discarding prior turns).
 */

// ---------------------------------------------------------------------------
// Message length validation (Requirements 8.1, 8.9)
// ---------------------------------------------------------------------------

/**
 * Maximum accepted question length in characters. Mirrors the server-side
 * `MAX_CHAT_MESSAGE_LENGTH` so client- and server-side validation agree
 * (Requirements 8.1, 8.9).
 */
export const MAX_CHAT_MESSAGE_LENGTH = 1000;

/**
 * Count characters by Unicode code point (not UTF-16 code units), matching the
 * server's `Array.from(text).length` counting so multi-byte input is bounded
 * identically on both sides.
 */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/** Result of validating a chat question before sending it. */
export type ChatValidationResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Validate a question for submission (Requirements 8.1, 8.9). The input is
 * trimmed; a whitespace-only or empty question is rejected, as is one longer
 * than {@link MAX_CHAT_MESSAGE_LENGTH} code points. On success the trimmed
 * message is returned ready to send.
 */
export function validateChatMessage(input: string): ChatValidationResult {
  const trimmed = input.trim();
  const length = countCodePoints(trimmed);
  if (length === 0) {
    return { ok: false, error: 'Enter a question to ask.' };
  }
  if (length > MAX_CHAT_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Your question must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer (currently ${length}).`,
    };
  }
  return { ok: true, message: trimmed };
}

// ---------------------------------------------------------------------------
// NDJSON stream frame parsing (Requirements 8.2, 8.3, 8.4, 8.7)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce one raw citation object into a {@link ChatCitation}, dropping junk. */
function normalizeCitation(raw: unknown): ChatCitation | null {
  if (!isRecord(raw)) return null;
  const citation: ChatCitation = {};
  if (typeof raw.title === 'string' && raw.title.length > 0) citation.title = raw.title;
  if (typeof raw.uri === 'string' && raw.uri.length > 0) citation.uri = raw.uri;
  if (typeof raw.snippet === 'string' && raw.snippet.length > 0) citation.snippet = raw.snippet;
  // A citation with no usable field carries no information — drop it.
  if (citation.title === undefined && citation.uri === undefined && citation.snippet === undefined) {
    return null;
  }
  return citation;
}

/** Coerce the raw `citations` array of a citations event into typed citations. */
function normalizeCitations(raw: unknown): ChatCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatCitation[] = [];
  for (const entry of raw) {
    const citation = normalizeCitation(entry);
    if (citation) out.push(citation);
  }
  return out;
}

/**
 * Parse a single NDJSON line into a {@link ChatStreamEvent}, or `null` when the
 * line is blank or not a well-formed event. Trailing `\r` (from `\r\n`) is
 * tolerated. Malformed lines are dropped rather than throwing so one bad frame
 * cannot abort the stream.
 */
export function parseChatStreamEvent(line: string): ChatStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  switch (parsed.kind) {
    case 'chunk':
      return typeof parsed.text === 'string' ? { kind: 'chunk', text: parsed.text } : null;
    case 'citations':
      return { kind: 'citations', citations: normalizeCitations(parsed.citations) };
    case 'done':
      return { kind: 'done' };
    case 'error':
      return {
        kind: 'error',
        message:
          typeof parsed.message === 'string' && parsed.message.length > 0
            ? parsed.message
            : 'The knowledge base returned an error.',
      };
    default:
      return null;
  }
}

/** The parsed events plus any trailing partial line left in the buffer. */
export interface NdjsonParseResult {
  events: ChatStreamEvent[];
  /** The unterminated remainder (no trailing `\n`) to prepend to the next read. */
  rest: string;
}

/**
 * Split a decoded buffer on newlines and parse each complete line into a
 * {@link ChatStreamEvent} (Requirement 8.2 — incremental framing). Only lines
 * terminated by `\n` are consumed; a trailing partial line is returned in
 * `rest` so it can be completed by the next chunk of the stream. Handles
 * multiple events in one read and lines split across reads.
 */
export function parseNdjsonLines(buffer: string): NdjsonParseResult {
  const events: ChatStreamEvent[] = [];
  let rest = buffer;
  let newlineIndex = rest.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = rest.slice(0, newlineIndex);
    rest = rest.slice(newlineIndex + 1);
    const event = parseChatStreamEvent(line);
    if (event) events.push(event);
    newlineIndex = rest.indexOf('\n');
  }
  return { events, rest };
}

// ---------------------------------------------------------------------------
// Conversation model + multi-turn history (Requirements 8.5, 8.7)
// ---------------------------------------------------------------------------

/** Lifecycle of one question/answer exchange in the transcript. */
export type ChatExchangeStatus = 'streaming' | 'complete' | 'error';

/**
 * One ordered question/answer turn in the conversation. The assistant answer is
 * assembled incrementally from `chunk` events (Requirement 8.2); `citations`
 * holds the deduplicated cited set once the `citations` event arrives, and
 * `citationsReceived` distinguishes "no sources cited" (received, empty) from
 * "not yet received" (Requirements 8.3, 8.4). On failure `status` becomes
 * `error` and the prior turns are untouched (Requirement 8.7).
 */
export interface ChatExchange {
  id: string;
  question: string;
  answer: string;
  citations: ChatCitation[];
  citationsReceived: boolean;
  status: ChatExchangeStatus;
  /** True from submission until the first chunk or a failure (Requirement 8.6). */
  awaitingFirstChunk: boolean;
  error?: string;
}

/** Create a fresh, in-progress exchange for a newly submitted question. */
export function createExchange(id: string, question: string): ChatExchange {
  return {
    id,
    question,
    answer: '',
    citations: [],
    citationsReceived: false,
    status: 'streaming',
    awaitingFirstChunk: true,
  };
}

/**
 * Apply one {@link ChatStreamEvent} to an exchange, returning a new exchange
 * (never mutating the input) so React state updates stay pure:
 *  - `chunk`  → append text and clear the awaiting-first-chunk flag (8.2, 8.6).
 *  - `citations` → store the deduplicated set and mark it received (8.3, 8.4).
 *  - `done`   → mark complete (unless already errored).
 *  - `error`  → mark errored with the message; the turn (and all prior turns)
 *               are preserved (8.7).
 */
export function applyChatStreamEvent(exchange: ChatExchange, event: ChatStreamEvent): ChatExchange {
  switch (event.kind) {
    case 'chunk':
      return { ...exchange, answer: exchange.answer + event.text, awaitingFirstChunk: false };
    case 'citations':
      return { ...exchange, citations: event.citations, citationsReceived: true };
    case 'done':
      return exchange.status === 'error' ? exchange : { ...exchange, status: 'complete' };
    case 'error':
      return {
        ...exchange,
        status: 'error',
        awaitingFirstChunk: false,
        error: event.message,
      };
    default:
      return exchange;
  }
}

/** Mark an exchange as failed with a message, preserving its content (8.7). */
export function failExchange(exchange: ChatExchange, message: string): ChatExchange {
  return { ...exchange, status: 'error', awaitingFirstChunk: false, error: message };
}

/**
 * Rebuild the transcript from persisted chat memory (`GET /chat/history`),
 * oldest-first. Messages are a flat, chronological list of `user` / `assistant`
 * turns; they are paired sequentially into completed {@link ChatExchange}s so a
 * restored conversation renders exactly like a live one:
 *   - a `user` turn opens an exchange (its answer filled by the next assistant
 *     turn, if any);
 *   - an `assistant` turn without a preceding open user turn (e.g. a persisted
 *     answer whose question was pruned) opens an answer-only exchange.
 * Restored exchanges are marked `complete` with citations received, so they are
 * eligible as multi-turn history for follow-ups (Requirement 8.5).
 */
export function historyToExchanges(messages: ChatHistoryMessage[]): ChatExchange[] {
  const exchanges: ChatExchange[] = [];
  let open: ChatExchange | null = null;

  const finalize = (): void => {
    if (open) {
      exchanges.push(open);
      open = null;
    }
  };

  for (const message of messages) {
    if (message.role === 'user') {
      // A new question starts a new exchange; close any dangling one first.
      finalize();
      open = {
        id: `hist-${message.id}`,
        question: message.content,
        answer: '',
        citations: [],
        citationsReceived: false,
        status: 'complete',
        awaitingFirstChunk: false,
      };
    } else {
      // assistant turn — attach to the open question, or stand alone.
      if (!open) {
        open = {
          id: `hist-${message.id}`,
          question: '',
          answer: '',
          citations: [],
          citationsReceived: false,
          status: 'complete',
          awaitingFirstChunk: false,
        };
      }
      open.answer = message.content;
      open.citations = message.citations ?? [];
      open.citationsReceived = true;
      finalize();
    }
  }
  finalize();
  return exchanges;
}

/**
 * Map completed prior exchanges to the request `history`, oldest first
 * (Requirement 8.5): each complete exchange contributes a `user` turn then an
 * `assistant` turn so follow-ups build on context. In-flight and errored
 * exchanges (which have no settled assistant answer) are excluded.
 */
export function toHistory(exchanges: ChatExchange[]): ChatTurn[] {
  const history: ChatTurn[] = [];
  for (const exchange of exchanges) {
    if (exchange.status !== 'complete') continue;
    history.push({ role: 'user', content: exchange.question });
    history.push({ role: 'assistant', content: exchange.answer });
  }
  return history;
}
