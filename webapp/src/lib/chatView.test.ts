import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatStreamEvent } from '@devops-observatory/shared-types';
import {
  applyChatStreamEvent,
  createExchange,
  countCodePoints,
  failExchange,
  MAX_CHAT_MESSAGE_LENGTH,
  parseChatStreamEvent,
  parseNdjsonLines,
  toHistory,
  validateChatMessage,
  type ChatExchange,
} from './chatView';

/**
 * Tests for the Chat_UI pure logic (Task 15).
 *
 * Run with: `node --import tsx --test src/lib/chatView.test.ts`
 *
 * Requirements: 8.1/8.9 (1–1,000 character validation, reject empty/too-long),
 * 8.2 (incremental NDJSON framing + answer assembly), 8.3/8.4 (citations incl.
 * the empty no-sources case), 8.5 (ordered multi-turn history), 8.7 (errors
 * preserve the conversation).
 */

// ---------------------------------------------------------------------------
// Length validation (Requirements 8.1, 8.9)
// ---------------------------------------------------------------------------

test('countCodePoints counts Unicode code points, not UTF-16 units', () => {
  assert.equal(countCodePoints('abc'), 3);
  // Emoji + astral characters are single code points despite being 2 UTF-16 units.
  assert.equal(countCodePoints('👍'), 1);
  assert.equal(countCodePoints('a👍b'), 3);
  assert.equal('👍'.length, 2); // sanity: UTF-16 length differs
});

test('validateChatMessage rejects empty and whitespace-only input (Req 8.9)', () => {
  assert.equal(validateChatMessage('').ok, false);
  assert.equal(validateChatMessage('   ').ok, false);
  assert.equal(validateChatMessage('\n\t  ').ok, false);
});

test('validateChatMessage accepts the 1-character lower boundary (Req 8.1)', () => {
  const result = validateChatMessage('a');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.message, 'a');
});

test('validateChatMessage trims and returns the trimmed message', () => {
  const result = validateChatMessage('  hello world  ');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.message, 'hello world');
});

test('validateChatMessage accepts exactly 1000 code points and rejects 1001 (Req 8.1, 8.9)', () => {
  const atLimit = 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH);
  const atLimitResult = validateChatMessage(atLimit);
  assert.equal(atLimitResult.ok, true);
  assert.equal(atLimitResult.ok && countCodePoints(atLimitResult.message), 1000);

  const overLimit = 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1);
  assert.equal(validateChatMessage(overLimit).ok, false);
});

test('validateChatMessage bounds by code points for multi-byte input (Req 8.1, 8.9)', () => {
  // 1000 emoji = 1000 code points (2000 UTF-16 units) — accepted by code point.
  const atLimit = '😀'.repeat(MAX_CHAT_MESSAGE_LENGTH);
  assert.equal(validateChatMessage(atLimit).ok, true);
  // 1001 emoji exceeds the limit by code point.
  const overLimit = '😀'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1);
  assert.equal(validateChatMessage(overLimit).ok, false);
});

// ---------------------------------------------------------------------------
// NDJSON frame parsing (Requirement 8.2)
// ---------------------------------------------------------------------------

test('parseChatStreamEvent parses each event kind', () => {
  assert.deepEqual(parseChatStreamEvent('{"kind":"chunk","text":"hi"}'), {
    kind: 'chunk',
    text: 'hi',
  });
  assert.deepEqual(parseChatStreamEvent('{"kind":"done"}'), { kind: 'done' });
  assert.deepEqual(parseChatStreamEvent('{"kind":"error","message":"boom"}'), {
    kind: 'error',
    message: 'boom',
  });
});

test('parseChatStreamEvent returns null for blank or malformed lines', () => {
  assert.equal(parseChatStreamEvent(''), null);
  assert.equal(parseChatStreamEvent('   '), null);
  assert.equal(parseChatStreamEvent('not json'), null);
  assert.equal(parseChatStreamEvent('{"kind":"unknown"}'), null);
  // A chunk without text is malformed and dropped.
  assert.equal(parseChatStreamEvent('{"kind":"chunk"}'), null);
});

test('parseChatStreamEvent tolerates a trailing carriage return (\\r\\n framing)', () => {
  assert.deepEqual(parseChatStreamEvent('{"kind":"done"}\r'), { kind: 'done' });
});

test('parseChatStreamEvent gives errors without a message a default', () => {
  const event = parseChatStreamEvent('{"kind":"error"}');
  assert.equal(event?.kind, 'error');
  assert.ok(event?.kind === 'error' && event.message.length > 0);
});

test('parseNdjsonLines parses multiple complete events in one read (Req 8.2)', () => {
  const buffer = '{"kind":"chunk","text":"a"}\n{"kind":"chunk","text":"b"}\n{"kind":"done"}\n';
  const { events, rest } = parseNdjsonLines(buffer);
  assert.deepEqual(events, [
    { kind: 'chunk', text: 'a' },
    { kind: 'chunk', text: 'b' },
    { kind: 'done' },
  ]);
  assert.equal(rest, '');
});

test('parseNdjsonLines holds a trailing partial line in rest (split across reads) (Req 8.2)', () => {
  // First read ends mid-frame.
  const first = parseNdjsonLines('{"kind":"chunk","text":"hel');
  assert.deepEqual(first.events, []);
  assert.equal(first.rest, '{"kind":"chunk","text":"hel');

  // Next read completes the frame and starts another.
  const second = parseNdjsonLines(first.rest + 'lo"}\n{"kind":"do');
  assert.deepEqual(second.events, [{ kind: 'chunk', text: 'hello' }]);
  assert.equal(second.rest, '{"kind":"do');

  const third = parseNdjsonLines(second.rest + 'ne"}\n');
  assert.deepEqual(third.events, [{ kind: 'done' }]);
  assert.equal(third.rest, '');
});

test('parseNdjsonLines skips blank/malformed lines but keeps good ones', () => {
  const buffer = '\n{"kind":"chunk","text":"a"}\nbroken\n{"kind":"done"}\n';
  const { events } = parseNdjsonLines(buffer);
  assert.deepEqual(events, [{ kind: 'chunk', text: 'a' }, { kind: 'done' }]);
});

// ---------------------------------------------------------------------------
// Citations parsing (Requirements 8.3, 8.4)
// ---------------------------------------------------------------------------

test('parseChatStreamEvent parses a non-empty citations set (Req 8.3)', () => {
  const line = JSON.stringify({
    kind: 'citations',
    citations: [
      { title: 'Doc', uri: 's3://bucket/doc.md', snippet: 'a snippet' },
      { uri: 's3://bucket/other.md' },
    ],
  });
  const event = parseChatStreamEvent(line);
  assert.equal(event?.kind, 'citations');
  assert.ok(event?.kind === 'citations');
  assert.equal(event.citations.length, 2);
  assert.equal(event.citations[0]?.title, 'Doc');
  assert.equal(event.citations[1]?.uri, 's3://bucket/other.md');
});

test('parseChatStreamEvent parses an empty citations set as no-sources (Req 8.4)', () => {
  const event = parseChatStreamEvent('{"kind":"citations","citations":[]}');
  assert.deepEqual(event, { kind: 'citations', citations: [] });
});

test('parseChatStreamEvent drops citation entries with no usable fields', () => {
  const line = JSON.stringify({ kind: 'citations', citations: [{}, { uri: 'x' }, 'bad'] });
  const event = parseChatStreamEvent(line);
  assert.ok(event?.kind === 'citations');
  assert.deepEqual(event.citations, [{ uri: 'x' }]);
});

// ---------------------------------------------------------------------------
// Applying stream events to an exchange (Requirements 8.2, 8.3, 8.4, 8.6, 8.7)
// ---------------------------------------------------------------------------

test('createExchange starts awaiting the first chunk (Req 8.6)', () => {
  const exchange = createExchange('1', 'What is up?');
  assert.equal(exchange.status, 'streaming');
  assert.equal(exchange.awaitingFirstChunk, true);
  assert.equal(exchange.answer, '');
  assert.equal(exchange.citationsReceived, false);
});

test('applyChatStreamEvent appends chunks incrementally and clears the indicator (Req 8.2, 8.6)', () => {
  let exchange = createExchange('1', 'q');
  exchange = applyChatStreamEvent(exchange, { kind: 'chunk', text: 'Hello' });
  assert.equal(exchange.answer, 'Hello');
  assert.equal(exchange.awaitingFirstChunk, false);
  exchange = applyChatStreamEvent(exchange, { kind: 'chunk', text: ' world' });
  assert.equal(exchange.answer, 'Hello world');
});

test('applyChatStreamEvent stores citations and marks them received (Req 8.3, 8.4)', () => {
  let exchange = createExchange('1', 'q');
  exchange = applyChatStreamEvent(exchange, { kind: 'citations', citations: [] });
  assert.equal(exchange.citationsReceived, true);
  assert.deepEqual(exchange.citations, []);

  const cited = applyChatStreamEvent(createExchange('2', 'q'), {
    kind: 'citations',
    citations: [{ uri: 's3://b/x.md' }],
  });
  assert.equal(cited.citationsReceived, true);
  assert.equal(cited.citations.length, 1);
});

test('applyChatStreamEvent marks complete on done', () => {
  let exchange = createExchange('1', 'q');
  exchange = applyChatStreamEvent(exchange, { kind: 'chunk', text: 'hi' });
  exchange = applyChatStreamEvent(exchange, { kind: 'done' });
  assert.equal(exchange.status, 'complete');
});

test('applyChatStreamEvent marks error and a later done does not override it (Req 8.7)', () => {
  let exchange = createExchange('1', 'q');
  exchange = applyChatStreamEvent(exchange, { kind: 'error', message: 'timeout' });
  assert.equal(exchange.status, 'error');
  assert.equal(exchange.error, 'timeout');
  assert.equal(exchange.awaitingFirstChunk, false);
  exchange = applyChatStreamEvent(exchange, { kind: 'done' });
  assert.equal(exchange.status, 'error');
});

test('applyChatStreamEvent does not mutate the input exchange', () => {
  const original = createExchange('1', 'q');
  const next = applyChatStreamEvent(original, { kind: 'chunk', text: 'x' });
  assert.equal(original.answer, '');
  assert.notEqual(original, next);
});

test('failExchange preserves content and question while flagging the error (Req 8.7)', () => {
  let exchange = createExchange('1', 'my question');
  exchange = applyChatStreamEvent(exchange, { kind: 'chunk', text: 'partial' });
  const failed = failExchange(exchange, 'network down');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'network down');
  assert.equal(failed.question, 'my question');
  assert.equal(failed.answer, 'partial');
});

// ---------------------------------------------------------------------------
// Multi-turn history mapping (Requirement 8.5)
// ---------------------------------------------------------------------------

function completedExchange(id: string, question: string, answer: string): ChatExchange {
  return {
    id,
    question,
    answer,
    citations: [],
    citationsReceived: true,
    status: 'complete',
    awaitingFirstChunk: false,
  };
}

test('toHistory maps completed exchanges to ordered user/assistant turns (Req 8.5)', () => {
  const exchanges = [
    completedExchange('1', 'first q', 'first a'),
    completedExchange('2', 'second q', 'second a'),
  ];
  assert.deepEqual(toHistory(exchanges), [
    { role: 'user', content: 'first q' },
    { role: 'assistant', content: 'first a' },
    { role: 'user', content: 'second q' },
    { role: 'assistant', content: 'second a' },
  ]);
});

test('toHistory excludes in-flight and errored exchanges (Req 8.5, 8.7)', () => {
  const streaming = createExchange('2', 'in flight');
  const errored = failExchange(createExchange('3', 'boom'), 'failed');
  const exchanges = [completedExchange('1', 'q', 'a'), streaming, errored];
  assert.deepEqual(toHistory(exchanges), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ]);
});

test('toHistory returns an empty history when there are no completed turns', () => {
  assert.deepEqual(toHistory([]), []);
  assert.deepEqual(toHistory([createExchange('1', 'q')]), []);
});

// A small compile-time nudge that the event union is exhaustively handled.
const _events: ChatStreamEvent[] = [
  { kind: 'chunk', text: 'x' },
  { kind: 'citations', citations: [] },
  { kind: 'done' },
  { kind: 'error', message: 'e' },
];
void _events;
