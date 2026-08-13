import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type {
  A2aConfiguredSpace,
  A2aInvestigateState,
  A2aInvestigateStatusResponse,
  ChatCitation,
} from '@devops-observatory/shared-types';
import { streamChat } from '../api/chat';
import {
  a2aChatStart,
  a2aChatStatus,
  a2aInvestigateApprove,
  a2aInvestigateReject,
  a2aInvestigateStart,
  a2aInvestigateStatus,
  fetchA2aConfiguredSpaces,
} from '../api/a2a';
import { clearChatHistory, fetchChatHistory } from '../api/chatHistory';
import { ApiRequestError } from '../api/client';
import {
  applyChatStreamEvent,
  countCodePoints,
  createExchange,
  failExchange,
  historyToExchanges,
  MAX_CHAT_MESSAGE_LENGTH,
  toHistory,
  validateChatMessage,
  type ChatExchange,
} from '../lib/chatView';

/** An investigation kept client-side while it runs (its space + latest status). */
type ActiveInvestigation = A2aInvestigateStatusResponse & { spaceId: string };

/** Investigate/chat run states that are final (stop polling, no more actions). */
const INVESTIGATE_TERMINAL_STATES: readonly A2aInvestigateState[] = [
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'TIMED_OUT',
  'STOPPED',
  'NOT_FOUND',
];

/**
 * Poll an async A2A chat run until it reaches a terminal state (or a client-side
 * cap of ~150s). Returns the newest status seen; transient poll errors are
 * retried. The answer, when present, is in `findings`.
 */
async function pollA2aChat(
  spaceId: string,
  executionName: string,
): Promise<A2aInvestigateStatusResponse> {
  let last: A2aInvestigateStatusResponse = { executionName, status: 'RUNNING' };
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      last = await a2aChatStatus(spaceId, executionName);
    } catch {
      continue; // transient — keep polling
    }
    if (INVESTIGATE_TERMINAL_STATES.includes(last.status)) return last;
  }
  return last;
}

/**
 * Chat_UI (Task 15 — Requirements 8.1–8.7, 8.9, 11.2).
 *
 * Lets an authenticated user ask natural-language questions answered by the
 * managed knowledge base. The view:
 *  - validates the question client-side (1–1,000 code points; empty/too-long is
 *    rejected with a visible error and never sent) and disables submit while
 *    invalid or in flight (Requirements 8.1, 8.9);
 *  - renders the streamed answer incrementally as chunks arrive (8.2);
 *  - shows an in-progress indicator from submission until the first chunk or a
 *    failure (8.6);
 *  - lists the deduplicated cited sources per answer, and a "no sources cited"
 *    notice when the set is empty (8.3, 8.4);
 *  - keeps an ordered multi-turn transcript and forwards prior completed turns
 *    as history so follow-ups build on context (8.5); and
 *  - on any failure (in-stream error event, network failure, or non-200) shows
 *    an error on the affected turn while preserving the prior conversation (8.7).
 *
 * Credential safety (design): the browser never holds AWS credentials — every
 * question goes through the authenticated streaming `/chat` endpoint, which
 * verifies the caller's Cognito token (Requirement 8.8).
 */
export function ChatView(): JSX.Element {
  const [exchanges, setExchanges] = useState<ChatExchange[]>([]);
  const [input, setInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  // Persisted chat memory (loaded on mount) and the active retention window.
  const [historyLoading, setHistoryLoading] = useState(true);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  // A2A target: 'org' = knowledge-base chat; otherwise a space id to talk to
  // that space's live agent. Populated from the A2A-configured spaces.
  const [a2aSpaces, setA2aSpaces] = useState<A2aConfiguredSpace[]>([]);
  const [target, setTarget] = useState<string>('org');
  // A2A mode when a space is targeted: 'chat' (fast Q&A) or 'investigate' (a
  // long, durable, human-in-the-loop investigation surfaced in a side panel).
  const [mode, setMode] = useState<'chat' | 'investigate'>('chat');
  const [investigation, setInvestigation] = useState<ActiveInvestigation | null>(null);
  const [investigateError, setInvestigateError] = useState<string | null>(null);
  // Set once the reviewer approves/dismisses, so we keep polling the durable
  // execution through to its terminal state (past AWAITING_APPROVAL).
  const [decided, setDecided] = useState(false);

  // Cancel any in-flight stream when the view unmounts (avoids state updates on
  // an unmounted component and abandons the request cleanly).
  const abortRef = useRef<AbortController | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Load the A2A-configured spaces so the user can direct a question at a
  // specific space's live agent. Best effort — the org chat works regardless.
  useEffect(() => {
    let active = true;
    fetchA2aConfiguredSpaces()
      .then((res) => {
        if (active) setA2aSpaces(res.spaces);
      })
      .catch(() => {
        /* selector just won't offer spaces */
      });
    return () => {
      active = false;
    };
  }, []);

  // Restore persisted chat memory on mount so a conversation survives across
  // sessions/devices. Fails soft: on error the view still works as a fresh chat.
  useEffect(() => {
    let active = true;
    setHistoryLoading(true);
    fetchChatHistory()
      .then((res) => {
        if (!active) return;
        setExchanges(historyToExchanges(res.messages));
        setRetentionDays(res.retentionDays);
      })
      .catch(() => {
        /* fall back to an empty transcript */
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleClearHistory(): Promise<void> {
    setClearing(true);
    try {
      await clearChatHistory();
      setExchanges([]);
    } catch {
      /* leave the transcript as-is on failure */
    } finally {
      setClearing(false);
    }
  }

  // Keep the newest turn in view as the transcript grows / streams.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' });
  }, [exchanges]);

  const charCount = countCodePoints(input);
  const overLimit = charCount > MAX_CHAT_MESSAGE_LENGTH;
  const canSubmit = !inFlight && validateChatMessage(input).ok;

  /** Update a single exchange by id (pure state transition). */
  function updateExchange(id: string, updater: (exchange: ChatExchange) => ChatExchange): void {
    setExchanges((prev) => prev.map((exchange) => (exchange.id === id ? updater(exchange) : exchange)));
  }

  // Poll a running investigation. While the durable execution is RUNNING (or the
  // reviewer just decided and we're waiting for it to close), re-fetch its status
  // every few seconds. Stops at AWAITING_APPROVAL (waits for a human) and at any
  // terminal state.
  useEffect(() => {
    if (!investigation) return;
    const { spaceId, executionName, status } = investigation;
    const shouldPoll =
      status === 'RUNNING' || (decided && !INVESTIGATE_TERMINAL_STATES.includes(status));
    if (!shouldPoll) return;
    let active = true;
    const timer = setTimeout(() => {
      a2aInvestigateStatus(spaceId, executionName)
        .then((res) => {
          if (active) setInvestigation({ ...res, spaceId });
        })
        .catch(() => {
          // Transient poll error — keep the last state but reschedule by
          // producing a new object reference so this effect re-runs.
          if (active) setInvestigation((prev) => (prev ? { ...prev } : prev));
        });
    }, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [investigation, decided]);

  /** Start an async investigation against the selected space (durable, polled). */
  async function handleStartInvestigation(message: string): Promise<void> {
    setInput('');
    setValidationError(null);
    setInvestigateError(null);
    setDecided(false);
    setInFlight(true);
    try {
      const res = await a2aInvestigateStart(target, message);
      setInvestigation({ ...res, question: message, spaceId: target });
    } catch (err) {
      setInvestigateError(
        err instanceof ApiRequestError ? err.message : 'The investigation could not be started.',
      );
    } finally {
      setInFlight(false);
    }
  }

  /** Acknowledge the findings — releases the durable human-in-the-loop callback. */
  async function handleApproveInvestigation(): Promise<void> {
    if (!investigation) return;
    setInvestigateError(null);
    try {
      const res = await a2aInvestigateApprove(investigation.spaceId, investigation.executionName);
      setDecided(true);
      setInvestigation({ ...res, spaceId: investigation.spaceId });
    } catch (err) {
      setInvestigateError(
        err instanceof ApiRequestError ? err.message : 'The approval could not be recorded.',
      );
    }
  }

  /** Dismiss the findings — releases the callback as a rejection. */
  async function handleRejectInvestigation(): Promise<void> {
    if (!investigation) return;
    setInvestigateError(null);
    try {
      const res = await a2aInvestigateReject(investigation.spaceId, investigation.executionName);
      setDecided(true);
      setInvestigation({ ...res, spaceId: investigation.spaceId });
    } catch (err) {
      setInvestigateError(
        err instanceof ApiRequestError ? err.message : 'The dismissal could not be recorded.',
      );
    }
  }

  async function handleSubmit(): Promise<void> {
    const validation = validateChatMessage(input);
    if (!validation.ok) {
      // Reject invalid input with a visible error; do not send (Req 8.1, 8.9).
      setValidationError(validation.error);
      return;
    }

    // Investigate mode (a space is targeted): start a durable investigation and
    // surface it in the side panel instead of the chat transcript.
    if (target !== 'org' && mode === 'investigate') {
      await handleStartInvestigation(validation.message);
      return;
    }

    // History is the prior completed turns only — never the in-flight one (8.5).
    const history = toHistory(exchanges);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const exchange = createExchange(id, validation.message);

    setExchanges((prev) => [...prev, exchange]);
    setInput('');
    setValidationError(null);
    setInFlight(true);

    // Directing the question at a specific space: talk to that space's live A2A
    // agent. This runs ASYNC in a durable function (the DevOps Agent chat is
    // synchronous but often slower than the API Gateway 30s limit), so we start
    // it and poll for the answer. No KB citations. Otherwise use the org-wide
    // knowledge-base chat (streamed, with history + citations).
    if (target !== 'org') {
      try {
        const start = await a2aChatStart(target, validation.message);
        const final = await pollA2aChat(target, start.executionName);
        if (final.status === 'SUCCEEDED' && final.findings) {
          updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'chunk', text: final.findings! }));
          updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'done' }));
        } else {
          updateExchange(id, (ex) =>
            failExchange(
              ex,
              final.error ??
                (final.status === 'RUNNING'
                  ? 'The agent space is taking longer than expected. Please try again.'
                  : 'The agent space did not return an answer. Please try again.'),
            ),
          );
        }
      } catch (err) {
        const message =
          err instanceof ApiRequestError
            ? err.message
            : 'The agent space could not be reached. Please try again.';
        updateExchange(id, (ex) => failExchange(ex, message));
      } finally {
        setInFlight(false);
      }
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        { message: validation.message, history },
        {
          onChunk: (text) => updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'chunk', text })),
          onCitations: (citations) =>
            updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'citations', citations })),
          onError: (message) =>
            updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'error', message })),
          onDone: () => updateExchange(id, (ex) => applyChatStreamEvent(ex, { kind: 'done' })),
        },
        { signal: controller.signal },
      );
    } catch (err) {
      // Network/transport failure or a non-200 rejection. The prior conversation
      // is untouched; only the affected turn is flagged (Requirement 8.7).
      if (controller.signal.aborted) return; // superseded/unmounted — ignore
      const message =
        err instanceof ApiRequestError
          ? err.message
          : 'Something went wrong answering your question. Please try again.';
      updateExchange(id, (ex) => failExchange(ex, message));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setInFlight(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter submits; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) void handleSubmit();
    }
  }

  return (
    <section aria-labelledby="chat-heading">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h2 id="chat-heading" style={{ marginTop: 0, marginBottom: '0.25rem' }}>
            Chat
          </h2>
          <p style={{ color: '#475467', margin: 0 }}>
            Ask natural-language questions about topology and investigations. Answers are grounded in
            the DevOps knowledge base and cite their sources.
          </p>
          <p style={{ color: '#98a2b3', margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>
            {retentionDays === null
              ? 'Your conversation is remembered between sessions.'
              : `Your conversation is remembered for up to ${retentionDays} day${retentionDays === 1 ? '' : 's'}.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleClearHistory()}
          disabled={clearing || inFlight || exchanges.length === 0}
          style={{
            flexShrink: 0,
            padding: '0.375rem 0.75rem',
            borderRadius: 6,
            border: '1px solid #d0d5dd',
            background: '#fff',
            color: exchanges.length === 0 ? '#98a2b3' : '#344054',
            cursor: clearing || inFlight || exchanges.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: '0.875rem',
          }}
        >
          {clearing ? 'Clearing…' : 'Clear history'}
        </button>
      </div>

      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        style={{
          marginTop: '1rem',
          border: '1px solid #eaecf0',
          borderRadius: 12,
          background: '#fff',
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
          padding: '1.25rem',
          minHeight: 220,
          maxHeight: 560,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        {historyLoading ? (
          <p role="status" aria-live="polite" style={{ margin: 0, color: '#667085', fontSize: '0.9375rem' }}>
            Loading your conversation…
          </p>
        ) : exchanges.length === 0 ? (
          <p style={{ margin: 0, color: '#667085', fontSize: '0.9375rem' }}>
            No questions yet. Ask something like “Which accounts have open recommendations?”
          </p>
        ) : (
          exchanges.map((exchange) => <ExchangeView key={exchange.id} exchange={exchange} />)
        )}
        <div ref={transcriptEndRef} />
      </div>

      {investigation && (
        <InvestigationPanel
          investigation={investigation}
          error={investigateError}
          onApprove={() => void handleApproveInvestigation()}
          onReject={() => void handleRejectInvestigation()}
          onDismiss={() => {
            setInvestigation(null);
            setInvestigateError(null);
            setDecided(false);
          }}
        />
      )}
      {investigateError && !investigation && (
        <p role="alert" style={{ margin: '1rem 0 0', color: '#b42318', fontSize: '0.875rem' }}>
          {investigateError}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
        style={{ marginTop: '1rem' }}
      >
        {a2aSpaces.length > 0 && (
          <div style={{ marginBottom: '0.625rem' }}>
            <label
              htmlFor="chat-target"
              style={{ display: 'block', fontWeight: 600, marginBottom: '0.375rem' }}
            >
              Ask
            </label>
            <select
              id="chat-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                if (e.target.value === 'org') setMode('chat');
              }}
              disabled={inFlight}
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: 8,
                border: '1px solid #d0d5dd',
                fontSize: '0.9375rem',
                fontFamily: 'inherit',
                background: '#fff',
                color: '#101828',
                maxWidth: '100%',
              }}
            >
              <option value="org">Organization (knowledge base)</option>
              <optgroup label="Live agent spaces (A2A)">
                {a2aSpaces.map((s) => (
                  <option key={s.agentSpaceId} value={s.agentSpaceId}>
                    {s.name ?? s.agentSpaceId}
                    {s.account ? ` — ${s.account}` : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            {target !== 'org' && (
              <div
                style={{ marginTop: '0.5rem', display: 'flex', gap: '1.25rem', alignItems: 'center' }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#344054' }}>Mode</span>
                <label style={{ fontSize: '0.875rem', color: '#344054' }}>
                  <input
                    type="radio"
                    name="a2a-mode"
                    checked={mode === 'chat'}
                    onChange={() => setMode('chat')}
                    disabled={inFlight}
                  />{' '}
                  Chat
                </label>
                <label style={{ fontSize: '0.875rem', color: '#344054' }}>
                  <input
                    type="radio"
                    name="a2a-mode"
                    checked={mode === 'investigate'}
                    onChange={() => setMode('investigate')}
                    disabled={inFlight}
                  />{' '}
                  Investigate
                </label>
              </div>
            )}
            <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem', color: '#667085' }}>
              {target === 'org'
                ? 'Answers come from the aggregated knowledge base and cite their sources.'
                : mode === 'investigate'
                  ? 'Runs a full DevOps Agent investigation (this can take minutes). You’ll review the findings before it’s closed.'
                  : 'Answers come live from this space’s AWS DevOps Agent (may take up to 2 minutes).'}
            </p>
          </div>
        )}

        <label htmlFor="chat-input" style={{ display: 'block', fontWeight: 600, marginBottom: '0.375rem' }}>
          Your question
        </label>
        <textarea
          id="chat-input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (validationError) setValidationError(null);
          }}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Ask a question about your DevOps data…"
          aria-invalid={validationError !== null || overLimit}
          aria-describedby="chat-input-help"
          disabled={inFlight}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '0.625rem 0.75rem',
            borderRadius: 8,
            border: `1px solid ${validationError !== null || overLimit ? '#fda29b' : '#d0d5dd'}`,
            fontSize: '0.9375rem',
            fontFamily: 'inherit',
            resize: 'vertical',
            color: '#101828',
            background: inFlight ? '#f9fafb' : '#fff',
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginTop: '0.5rem',
          }}
        >
          <span id="chat-input-help" style={{ fontSize: '0.8125rem', color: '#667085' }}>
            Press Enter to send · Shift+Enter for a new line
          </span>
          <span
            aria-live="polite"
            style={{
              fontSize: '0.8125rem',
              color: overLimit ? '#b42318' : '#667085',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {charCount}/{MAX_CHAT_MESSAGE_LENGTH}
          </span>
        </div>

        {validationError !== null && (
          <p
            role="alert"
            style={{
              margin: '0.5rem 0 0',
              color: '#b42318',
              fontSize: '0.875rem',
            }}
          >
            {validationError}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 1.25rem',
            borderRadius: 8,
            border: 'none',
            background: canSubmit ? '#175cd3' : '#eaecf0',
            color: canSubmit ? '#fff' : '#98a2b3',
            fontSize: '0.9375rem',
            fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {inFlight
            ? target !== 'org' && mode === 'investigate'
              ? 'Starting…'
              : 'Sending…'
            : target !== 'org' && mode === 'investigate'
              ? 'Investigate'
              : 'Ask'}
        </button>
      </form>
    </section>
  );
}

/** Presentation for the investigate state → label + colors. */
function investigateStatusMeta(status: A2aInvestigateState): {
  label: string;
  fg: string;
  bg: string;
} {
  switch (status) {
    case 'RUNNING':
      return { label: 'Investigating…', fg: '#175cd3', bg: '#eff4ff' };
    case 'AWAITING_APPROVAL':
      return { label: 'Awaiting your review', fg: '#b54708', bg: '#fffaeb' };
    case 'SUCCEEDED':
      return { label: 'Acknowledged', fg: '#067647', bg: '#ecfdf3' };
    case 'REJECTED':
      return { label: 'Dismissed', fg: '#475467', bg: '#f2f4f7' };
    case 'NOT_FOUND':
      return { label: 'Not found', fg: '#b42318', bg: '#fef3f2' };
    default:
      return { label: status.replace(/_/g, ' ').toLowerCase(), fg: '#b42318', bg: '#fef3f2' };
  }
}

/**
 * Side panel for a durable `investigate` run: shows the question, a live status
 * badge, the findings once available, and the human-in-the-loop Approve/Dismiss
 * controls while the run is `AWAITING_APPROVAL`.
 */
function InvestigationPanel({
  investigation,
  error,
  onApprove,
  onReject,
  onDismiss,
}: {
  investigation: ActiveInvestigation;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const meta = investigateStatusMeta(investigation.status);
  const awaiting = investigation.status === 'AWAITING_APPROVAL';
  const running = investigation.status === 'RUNNING';
  return (
    <section
      aria-label="Investigation"
      style={{
        marginTop: '1rem',
        border: '1px solid #eaecf0',
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
        padding: '1rem 1.125rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <span style={{ fontWeight: 700, color: '#101828' }}>Investigation</span>
          <span
            role="status"
            aria-live="polite"
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: meta.fg,
              background: meta.bg,
              borderRadius: 999,
              padding: '0.125rem 0.5rem',
            }}
          >
            {meta.label}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close investigation"
          style={{
            border: 'none',
            background: 'transparent',
            color: '#98a2b3',
            cursor: 'pointer',
            fontSize: '1.125rem',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {investigation.question && (
        <p style={{ margin: '0.625rem 0 0', color: '#344054', fontSize: '0.9375rem', whiteSpace: 'pre-wrap' }}>
          <span style={{ fontWeight: 600 }}>Q: </span>
          {investigation.question}
        </p>
      )}

      {running && (
        <p role="status" aria-live="polite" style={{ margin: '0.625rem 0 0', color: '#667085', fontStyle: 'italic' }}>
          The DevOps Agent is investigating. This can take a few minutes — you can keep working; the
          status updates automatically.
        </p>
      )}

      {investigation.findings && (
        <div
          style={{
            marginTop: '0.75rem',
            borderTop: '1px solid #eaecf0',
            paddingTop: '0.75rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#101828',
            fontSize: '0.9375rem',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {investigation.findings}
        </div>
      )}

      {investigation.error && (
        <p role="alert" style={{ margin: '0.625rem 0 0', color: '#b42318', fontSize: '0.875rem' }}>
          {investigation.error}
        </p>
      )}

      {awaiting && (
        <div style={{ marginTop: '0.875rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: '#667085' }}>
            Review the findings above. Nothing is acted on automatically.
          </p>
          <div style={{ display: 'flex', gap: '0.625rem' }}>
            <button
              type="button"
              onClick={onApprove}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: 'none',
                background: '#079455',
                color: '#fff',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Acknowledge
            </button>
            <button
              type="button"
              onClick={onReject}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: '1px solid #d0d5dd',
                background: '#fff',
                color: '#344054',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: '0.625rem 0 0', color: '#b42318', fontSize: '0.875rem' }}>
          {error}
        </p>
      )}
    </section>
  );
}

/** A single question/answer turn in the transcript. */
function ExchangeView({ exchange }: { exchange: ChatExchange }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
      <QuestionBubble question={exchange.question} />
      <AnswerBlock exchange={exchange} />
    </div>
  );
}

function QuestionBubble({ question }: { question: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '80%',
          background: '#eff4ff',
          color: '#175cd3',
          borderRadius: '12px 12px 2px 12px',
          padding: '0.625rem 0.875rem',
          fontSize: '0.9375rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        <span
          style={{
            display: 'block',
            fontSize: '0.6875rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.02em',
            color: '#175cd3',
            opacity: 0.7,
            marginBottom: '0.25rem',
          }}
        >
          You
        </span>
        {question}
      </div>
    </div>
  );
}

function AnswerBlock({ exchange }: { exchange: ChatExchange }): JSX.Element {
  const bubbleStyle: CSSProperties = {
    maxWidth: '80%',
    background: '#f9fafb',
    color: '#101828',
    border: '1px solid #eaecf0',
    borderRadius: '12px 12px 12px 2px',
    padding: '0.75rem 0.875rem',
    fontSize: '0.9375rem',
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={bubbleStyle}>
        <span
          style={{
            display: 'block',
            fontSize: '0.6875rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.02em',
            color: '#667085',
            marginBottom: '0.375rem',
          }}
        >
          Assistant
        </span>

        {/* In-progress indicator: shown from submission until the first chunk or
            a failure (Requirement 8.6). */}
        {exchange.awaitingFirstChunk && exchange.status === 'streaming' && (
          <p role="status" aria-live="polite" style={{ margin: 0, color: '#667085', fontStyle: 'italic' }}>
            Thinking…
          </p>
        )}

        {/* Incrementally rendered answer text (Requirement 8.2). */}
        {exchange.answer.length > 0 && (
          <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {exchange.answer}
            {exchange.status === 'streaming' && !exchange.awaitingFirstChunk && (
              <span aria-hidden style={{ color: '#98a2b3' }}> ▍</span>
            )}
          </p>
        )}

        {/* Error on this turn — the prior conversation is preserved (Req 8.7). */}
        {exchange.status === 'error' && (
          <p
            role="alert"
            style={{
              margin: exchange.answer.length > 0 ? '0.625rem 0 0' : 0,
              color: '#b42318',
              fontSize: '0.9375rem',
            }}
          >
            {exchange.error ?? 'The answer could not be completed.'}
          </p>
        )}

        {/* Citations, shown once received. Empty set => no-sources notice
            (Requirements 8.3, 8.4). Not shown for errored turns. */}
        {exchange.status !== 'error' && exchange.citationsReceived && (
          <Citations citations={exchange.citations} />
        )}
      </div>
    </div>
  );
}

function Citations({ citations }: { citations: ChatCitation[] }): JSX.Element {
  if (citations.length === 0) {
    // No source references were returned with the answer (Requirement 8.4).
    return (
      <p style={{ margin: '0.75rem 0 0', fontSize: '0.8125rem', color: '#667085', fontStyle: 'italic' }}>
        No sources were cited for this answer.
      </p>
    );
  }
  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid #eaecf0', paddingTop: '0.625rem' }}>
      <p
        style={{
          margin: '0 0 0.375rem',
          fontSize: '0.6875rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
          color: '#667085',
        }}
      >
        Sources ({citations.length})
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.125rem', display: 'grid', gap: '0.5rem' }}>
        {citations.map((citation, index) => (
          <CitationItem key={citation.uri ?? citation.title ?? index} citation={citation} />
        ))}
      </ul>
    </div>
  );
}

function CitationItem({ citation }: { citation: ChatCitation }): JSX.Element {
  const label = citation.title ?? citation.uri ?? 'Source';
  return (
    <li style={{ fontSize: '0.875rem', color: '#344054' }}>
      {citation.uri ? (
        <a
          href={citation.uri}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#175cd3', wordBreak: 'break-word' }}
        >
          {label}
        </a>
      ) : (
        <span style={{ wordBreak: 'break-word' }}>{label}</span>
      )}
      {citation.snippet && (
        <span style={{ display: 'block', color: '#667085', marginTop: '0.125rem' }}>
          {citation.snippet}
        </span>
      )}
    </li>
  );
}
