import type {
  GraphControlAction,
  GraphControlActionResponse,
  GraphControlStatus,
} from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * Graph control API client (Admin Settings "Topology graph" section).
 *
 * - {@link fetchGraphControlStatus} — `GET /graph/control`, any authenticated
 *   user. Returns whether the Neptune Analytics graph exists / is transitioning
 *   plus timing metrics, so the Settings view can render the control and poll
 *   while a start/stop is in flight.
 * - {@link controlGraph} — Admin-only `POST /graph/control`. The backend
 *   re-asserts the Admin group before any AWS call; an already-running `start`
 *   or already-stopped `stop` comes back as an `ApiRequestError` (409).
 */

/** `GET /graph/control` — current graph status + timing metrics. */
export function fetchGraphControlStatus(): Promise<GraphControlStatus> {
  return apiFetch<GraphControlStatus>('/graph/control');
}

/** Admin-only `POST /graph/control` — start or stop the topology graph. */
export function controlGraph(action: GraphControlAction): Promise<GraphControlActionResponse> {
  return apiFetch<GraphControlActionResponse>('/graph/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}
