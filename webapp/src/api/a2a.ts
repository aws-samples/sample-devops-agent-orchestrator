import type {
  A2aConfiguredSpacesResponse,
  A2aInvestigateStartResponse,
  A2aInvestigateStatusResponse,
  A2aStatus,
  A2aTokenRequest,
} from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/** `GET /a2a/spaces` — the spaces that have an A2A token stored (any user). */
export function fetchA2aConfiguredSpaces(): Promise<A2aConfiguredSpacesResponse> {
  return apiFetch<A2aConfiguredSpacesResponse>('/a2a/spaces');
}

/**
 * Agent-to-Agent (A2A) API client (Admin only, Task 36).
 *
 * Talks to an individual DevOps Agent Space via the backend, which holds the
 * per-space Bearer token in Secrets Manager. The token value is write-only —
 * it is sent on {@link storeA2aToken} but never returned by any call.
 */

/** `GET /spaces/{id}/a2a-status` — is a token stored + its metadata (no value). */
export function fetchA2aStatus(spaceId: string): Promise<A2aStatus> {
  return apiFetch<A2aStatus>(`/spaces/${encodeURIComponent(spaceId)}/a2a-status`);
}

/** `PUT /spaces/{id}/a2a-token` — store/replace the space's Bearer token. */
export function storeA2aToken(spaceId: string, request: A2aTokenRequest): Promise<A2aStatus> {
  return apiFetch<A2aStatus>(`/spaces/${encodeURIComponent(spaceId)}/a2a-token`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/** `DELETE /spaces/{id}/a2a-token` — remove the stored token. */
export function deleteA2aToken(spaceId: string): Promise<A2aStatus> {
  return apiFetch<A2aStatus>(`/spaces/${encodeURIComponent(spaceId)}/a2a-token`, {
    method: 'DELETE',
  });
}

/**
 * `POST /spaces/{id}/a2a/chat` — start an async chat run. The DevOps Agent chat
 * is synchronous but often slower than the API Gateway 30s limit, so it runs in
 * the durable function; poll {@link a2aChatStatus} for the answer. Chat has no
 * approval step.
 */
export function a2aChatStart(
  spaceId: string,
  message: string,
): Promise<A2aInvestigateStartResponse> {
  return apiFetch<A2aInvestigateStartResponse>(`/spaces/${encodeURIComponent(spaceId)}/a2a/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

/** `GET /spaces/{id}/a2a/chat/{execName}` — chat run status + answer (in `findings`). */
export function a2aChatStatus(
  spaceId: string,
  executionName: string,
): Promise<A2aInvestigateStatusResponse> {
  return apiFetch<A2aInvestigateStatusResponse>(
    `/spaces/${encodeURIComponent(spaceId)}/a2a/chat/${encodeURIComponent(executionName)}`,
  );
}

/**
 * Async `investigate` skill (Task 38). Unlike chat, `investigate` runs a long
 * durable analysis: {@link a2aInvestigateStart} kicks it off (returning an
 * execution name), the caller polls {@link a2aInvestigateStatus} until the
 * findings are ready, then {@link a2aInvestigateApprove} / {@link a2aInvestigateReject}
 * release the human-in-the-loop gate.
 */

/** `POST /spaces/{id}/a2a/investigate` — start an async investigation. */
export function a2aInvestigateStart(
  spaceId: string,
  message: string,
): Promise<A2aInvestigateStartResponse> {
  return apiFetch<A2aInvestigateStartResponse>(
    `/spaces/${encodeURIComponent(spaceId)}/a2a/investigate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );
}

/** `GET /spaces/{id}/a2a/investigate/{execName}` — current status + findings. */
export function a2aInvestigateStatus(
  spaceId: string,
  executionName: string,
): Promise<A2aInvestigateStatusResponse> {
  return apiFetch<A2aInvestigateStatusResponse>(
    `/spaces/${encodeURIComponent(spaceId)}/a2a/investigate/${encodeURIComponent(executionName)}`,
  );
}

/** `POST /spaces/{id}/a2a/investigate/{execName}/approve` — acknowledge findings. */
export function a2aInvestigateApprove(
  spaceId: string,
  executionName: string,
): Promise<A2aInvestigateStatusResponse> {
  return apiFetch<A2aInvestigateStatusResponse>(
    `/spaces/${encodeURIComponent(spaceId)}/a2a/investigate/${encodeURIComponent(executionName)}/approve`,
    { method: 'POST' },
  );
}

/** `POST /spaces/{id}/a2a/investigate/{execName}/reject` — dismiss findings. */
export function a2aInvestigateReject(
  spaceId: string,
  executionName: string,
  reason?: string,
): Promise<A2aInvestigateStatusResponse> {
  return apiFetch<A2aInvestigateStatusResponse>(
    `/spaces/${encodeURIComponent(spaceId)}/a2a/investigate/${encodeURIComponent(executionName)}/reject`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
}
