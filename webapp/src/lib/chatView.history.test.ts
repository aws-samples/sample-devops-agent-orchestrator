import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatHistoryMessage } from '@devops-observatory/shared-types';
import { historyToExchanges, toHistory } from './chatView';

/**
 * Tests for restoring persisted chat memory into the transcript (feature:
 * chat history as memory).
 *
 * Run with: `node --import tsx --test src/lib/chatView.history.test.ts`
 */

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  citations?: ChatHistoryMessage['citations'],
): ChatHistoryMessage {
  return { id, role, content, createdAt: '2026-07-05T00:00:00.000Z', citations };
}

test('historyToExchanges pairs user+assistant turns into complete exchanges', () => {
  const exchanges = historyToExchanges([
    msg('1', 'user', 'Which accounts have open recommendations?'),
    msg('2', 'assistant', 'Accounts A and B.', [{ uri: 's3://kb/a.md', title: 'a.md' }]),
    msg('3', 'user', 'And investigations?'),
    msg('4', 'assistant', 'Twelve total.'),
  ]);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].question, 'Which accounts have open recommendations?');
  assert.equal(exchanges[0].answer, 'Accounts A and B.');
  assert.equal(exchanges[0].status, 'complete');
  assert.equal(exchanges[0].citationsReceived, true);
  assert.equal(exchanges[0].citations.length, 1);
  assert.equal(exchanges[1].question, 'And investigations?');
  assert.equal(exchanges[1].answer, 'Twelve total.');
});

test('historyToExchanges handles a dangling question (no assistant answer yet)', () => {
  const exchanges = historyToExchanges([msg('1', 'user', 'Hello?')]);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].question, 'Hello?');
  assert.equal(exchanges[0].answer, '');
});

test('historyToExchanges handles an answer with no preceding question', () => {
  const exchanges = historyToExchanges([msg('1', 'assistant', 'Orphan answer.')]);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].question, '');
  assert.equal(exchanges[0].answer, 'Orphan answer.');
  assert.equal(exchanges[0].status, 'complete');
});

test('empty history yields an empty transcript', () => {
  assert.deepEqual(historyToExchanges([]), []);
});

test('restored exchanges are eligible as multi-turn history for follow-ups', () => {
  const exchanges = historyToExchanges([
    msg('1', 'user', 'Q1'),
    msg('2', 'assistant', 'A1'),
  ]);
  assert.deepEqual(toHistory(exchanges), [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
  ]);
});
