import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefreshStatus } from '@devops-observatory/shared-types';
import { fetchRefreshStatus, startRefresh } from '../api/refresh';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AdminOnly } from '../auth/AdminOnly';
import { BatchCreateSpacesPanel } from '../components/BatchCreateSpacesPanel';
import {
  ALREADY_RUNNING_MESSAGE,
  isAlreadyRunningError,
  isAlreadyRunningStatus,
  isTerminal,
  REFRESH_POLL_INTERVAL_MS,
  refreshStatusView,
  startFailureMessage,
  type RefreshStatusView,
} from '../lib/refreshControl';

/**
 * Admin-only Refresh control (Task 16 — Requirements 2.3, 10.1, 10.3, 10.4,
 * 10.5, 10.8).
 *
 * Triggers the hub refresh pipeline (collect → transform → KB sync → graph
 * reset+reload) via the Admin-only `POST /refresh`, which accepts asynchronously
 * within 5 seconds without blocking on completion (Requirement 10.3). While the
 * refresh runs the control shows an in-progress indicator and polls
 * `GET /refresh/status`, keeping the indicator visible until a completed or
 * failed state (Requirement 10.4). A concurrent trigger is rejected with an
 * "a refresh is already running" message (Requirement 10.5); a stage failure
 * shows a failed state naming the stage that did not complete (Requirement 10.8).
 *
 * Wrapped in {@link AdminOnly}: an Executive sees an access-denied notice and no
 * trigger, and the backend independently rejects any non-Admin refresh request
 * (Requirement 2.3).
 */
export function RefreshView(): JSX.Element {
  const { user } = useAuth();
  return (
    <AdminOnly role={user?.role} feature="Refresh">
      <RefreshControl />
      <BatchCreateSpacesPanel />
    </AdminOnly>
  );
}

type TriggerState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'polling'; executionId: string; view: RefreshStatusView }
  | { status: 'terminal'; view: RefreshStatusView }
  | { status: 'error'; message: string };

function RefreshControl(): JSX.Element {
  const [state, setState] = useState<TriggerState>({ status: 'idle' });
  // Track the active poll timer so it can be cancelled on unmount / new run.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const applyStatus = useCallback((executionId: string, status: RefreshStatus): void => {
    if (!activeRef.current) return;
    const view = refreshStatusView(status);

    // A concurrency rejection or any terminal state stops polling
    // (Requirements 10.5, 10.4, 10.8).
    if (isTerminal(status.state) || isAlreadyRunningStatus(status)) {
      setState({ status: 'terminal', view });
      return;
    }

    // Still running — keep the indicator visible and poll again (Req 10.4).
    setState({ status: 'polling', executionId, view });
    timerRef.current = setTimeout(() => {
      void poll(executionId);
    }, REFRESH_POLL_INTERVAL_MS);
  }, []);

  const poll = useCallback(
    async (executionId: string): Promise<void> => {
      try {
        const status = await fetchRefreshStatus(executionId);
        applyStatus(executionId, status);
      } catch (err: unknown) {
        if (!activeRef.current) return;
        const message =
          err instanceof ApiRequestError
            ? err.message
            : 'Unable to check the refresh status right now.';
        setState({ status: 'error', message });
      }
    },
    [applyStatus],
  );

  const handleTrigger = useCallback(async (): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setState({ status: 'starting' });
    try {
      const started = await startRefresh();
      if (!activeRef.current) return;
      // Async acceptance within 5s (Requirement 10.3); begin polling for status.
      setState({
        status: 'polling',
        executionId: started.executionId,
        view: refreshStatusView({ executionId: started.executionId, state: started.state }),
      });
      void poll(started.executionId);
    } catch (err: unknown) {
      if (!activeRef.current) return;
      // A concurrent-refresh rejection surfaced directly on start (defensive —
      // the backend normally enforces this via the state machine lock, Req 10.5).
      if (isAlreadyRunningError(err)) {
        setState({
          status: 'terminal',
          view: {
            tone: 'error',
            inProgress: false,
            title: 'Refresh already running',
            detail: ALREADY_RUNNING_MESSAGE,
          },
        });
        return;
      }
      // Start failure — the refresh did not start; freshness is unchanged (10.7).
      setState({ status: 'error', message: startFailureMessage(err) });
    }
  }, [poll]);

  const busy = state.status === 'starting' || state.status === 'polling';

  return (
    <section aria-labelledby="refresh-heading">
      <h2 id="refresh-heading" style={{ marginTop: 0 }}>
        Refresh
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        Trigger a full data refresh: collect from linked accounts, transform the graph, sync the
        knowledge base, and reload the topology. This can take several minutes and runs in the
        background.
      </p>

      <button
        type="button"
        onClick={() => void handleTrigger()}
        disabled={busy}
        style={triggerButtonStyle(busy)}
      >
        {state.status === 'starting'
          ? 'Starting…'
          : state.status === 'polling'
            ? 'Refresh running…'
            : 'Start refresh'}
      </button>

      <div style={{ marginTop: '1.5rem' }}>
        <StatusBanner state={state} />
      </div>
    </section>
  );
}

function StatusBanner({ state }: { state: TriggerState }): JSX.Element | null {
  if (state.status === 'idle') {
    return (
      <p style={{ color: '#667085', fontSize: '0.9375rem' }}>
        No refresh has been started in this session.
      </p>
    );
  }

  if (state.status === 'starting') {
    return (
      <Banner
        tone="running"
        inProgress
        title="Starting refresh"
        detail="Requesting a new refresh run…"
      />
    );
  }

  if (state.status === 'error') {
    return <Banner tone="error" inProgress={false} title="Refresh did not start" detail={state.message} />;
  }

  // 'polling' or 'terminal' — render the derived status view.
  const { view } = state;
  return (
    <Banner
      tone={view.tone}
      inProgress={view.inProgress}
      title={view.title}
      detail={view.detail}
      stage={view.stage}
    />
  );
}

function Banner({
  tone,
  inProgress,
  title,
  detail,
  stage,
}: {
  tone: RefreshStatusView['tone'];
  inProgress: boolean;
  title: string;
  detail: string;
  stage?: string;
}): JSX.Element {
  const palette = {
    running: { fg: '#175cd3', bg: '#eff4ff', border: '#b2ccff' },
    success: { fg: '#027a48', bg: '#ecfdf3', border: '#a6f4c5' },
    error: { fg: '#b42318', bg: '#fef3f2', border: '#fecdca' },
  }[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      style={{
        padding: '1rem 1.25rem',
        borderRadius: 12,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
      }}
    >
      <p style={{ margin: 0, fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {inProgress && <Spinner />}
        {title}
      </p>
      <p style={{ margin: '0.375rem 0 0', fontSize: '0.9375rem' }}>{detail}</p>
      {stage && (
        <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>
          Failed stage: <strong>{stage}</strong>
        </p>
      )}
    </div>
  );
}

/** A small CSS spinner marking the in-progress indicator (Requirement 10.4). */
function Spinner(): JSX.Element {
  return (
    <>
      {/* Keyframes are injected inline since the SPA ships no global stylesheet. */}
      <style>{'@keyframes do-spin { to { transform: rotate(360deg); } }'}</style>
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 14,
          height: 14,
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'do-spin 0.8s linear infinite',
        }}
      />
    </>
  );
}

function triggerButtonStyle(disabled: boolean) {
  return {
    padding: '0.625rem 1.25rem',
    borderRadius: 6,
    border: 'none',
    background: disabled ? '#98a2b3' : '#175cd3',
    color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.9375rem',
    fontWeight: 600,
  } as const;
}
