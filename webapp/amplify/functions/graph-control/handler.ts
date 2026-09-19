import type {
  GraphControlActionResponse,
  GraphControlAction,
} from '@devops-observatory/shared-types';
import { assertAdmin } from '../shared/authz';
import { ConflictError, UpstreamUnavailableError, ValidationError } from '../shared/errors';
import {
  GraphControlConflict,
  getGraphStatus,
  startGraph,
  stopGraph,
} from '../shared/graphControl';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * Neptune Analytics graph control route.
 *
 * - `GET /graph/control` — any authenticated user. Returns the current graph
 *   status (exists / transitioning / state) plus timing metrics so the Settings
 *   view can render the control and poll while a start/stop is in flight.
 * - `POST /graph/control` — Admin only. {@link assertAdmin} runs BEFORE any AWS
 *   call and throws 401/403 for missing identities / Executive callers, so a
 *   denied request changes nothing. Body: `{ "action": "start" | "stop" }`.
 *   `stop` deletes the graph (taking a final snapshot); `start` restores it from
 *   the latest snapshot or creates it fresh. An already-running `start` or
 *   already-stopped `stop` is a 409 conflict.
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'POST') {
    return handlePost(event);
  }
  return jsonResponse(await getGraphStatus());
});

async function handlePost(event: ApiEvent): Promise<ApiResult> {
  assertAdmin(event); // authz gate — denials make no AWS call and change no state

  const action = parseAction(event);
  try {
    const status = action === 'start' ? await startGraph() : await stopGraph();
    const response: GraphControlActionResponse = { action, status };
    return jsonResponse(response);
  } catch (err) {
    if (err instanceof GraphControlConflict) {
      throw new ConflictError(err.message);
    }
    throw new UpstreamUnavailableError(
      `The graph could not be ${action === 'start' ? 'started' : 'stopped'} right now. Please try again.`,
    );
  }
}

/** Parse + validate the `action` field from the request body. */
function parseAction(event: ApiEvent): GraphControlAction {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  if (decoded.trim() === '') {
    throw new ValidationError('An action is required: "start" or "stop".');
  }
  let body: unknown;
  try {
    body = JSON.parse(decoded);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
  const action = (body as { action?: unknown }).action;
  if (action !== 'start' && action !== 'stop') {
    throw new ValidationError('action must be "start" or "stop".');
  }
  return action;
}
