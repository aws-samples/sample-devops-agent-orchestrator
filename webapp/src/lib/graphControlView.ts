import type { GraphControlStatus, GraphLifecycleState } from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free logic for the Admin Settings "Topology graph" control (start/
 * stop the Neptune Analytics graph).
 *
 * Kept separate from the React component so the status→label/tone mapping and
 * the button-enablement rules can be unit-tested with the repo's `node:test` +
 * tsx convention. The server remains the authority — these rules only shape the
 * UI (and the backend re-asserts Admin + rejects invalid start/stop anyway).
 */

/** Visual tone for the status badge. */
export type GraphStatusTone = 'running' | 'stopped' | 'transitioning' | 'error';

/** Everything the component needs to render the control from a status. */
export interface GraphStatusView {
  tone: GraphStatusTone;
  /** Short human label, e.g. "Running", "Starting…", "Stopped". */
  label: string;
  /** True while the graph is starting/stopping — the UI keeps polling. */
  transitioning: boolean;
  /** Whether a "Start" action is currently allowed. */
  canStart: boolean;
  /** Whether a "Stop" action is currently allowed. */
  canStop: boolean;
}

const LABELS: Record<GraphLifecycleState, string> = {
  AVAILABLE: 'Running',
  STOPPED: 'Stopped',
  STARTING: 'Starting…',
  STOPPING: 'Stopping…',
  CREATING: 'Creating…',
  UPDATING: 'Updating…',
  DELETING: 'Deleting…',
  RESETTING: 'Working…',
  SNAPSHOTTING: 'Snapshotting…',
  IMPORTING: 'Loading data…',
  FAILED: 'Failed',
  DELETED: 'Not provisioned',
  UNKNOWN: 'Unknown',
};

/**
 * Derive the badge tone, label, and which actions are allowed from a status.
 * A `null` status (not loaded yet / unreadable) is treated as unknown: neither
 * action is offered until the real state is known.
 */
export function viewGraphStatus(status: GraphControlStatus | null): GraphStatusView {
  if (status === null) {
    return { tone: 'error', label: 'Unknown', transitioning: false, canStart: false, canStop: false };
  }

  const label = LABELS[status.state] ?? 'Unknown';
  const transitioning = status.transitioning;

  let tone: GraphStatusTone;
  if (transitioning) {
    tone = 'transitioning';
  } else if (status.state === 'AVAILABLE') {
    tone = 'running';
  } else if (status.state === 'STOPPED' || status.state === 'DELETED') {
    tone = 'stopped';
  } else {
    tone = 'error';
  }

  return {
    tone,
    label,
    transitioning,
    // Resume only from a settled STOPPED state.
    canStart: status.state === 'STOPPED',
    // Pause only from a settled AVAILABLE (running) state.
    canStop: status.state === 'AVAILABLE',
  };
}

/**
 * Format an ISO-8601 timestamp as a stable UTC string for the timing metrics,
 * or `undefined` when it is missing/invalid (so the caller can omit the row).
 */
export function formatGraphTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  })} UTC`;
}
