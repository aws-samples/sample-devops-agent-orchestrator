import type {
  BatchCreateSpacesRequest,
  BatchCreateSpacesResponse,
  CreateSpaceRequest,
  CreateSpaceResponse,
  SpacesDTO,
} from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * `GET /spaces` client (Task 4.2 backend, consumed by the Task 12 Space_View).
 *
 * Returns every Linked_Account in the Manifest with its Agent_Spaces grouped
 * underneath, each space's activity counts, the account's collected/incomplete
 * status, the per-account Last_Sync_Date, and business-context display
 * name / Business_Unit labels when present (Requirements 3.1–3.6).
 *
 * If the manifest cannot be retrieved or parsed the backend returns an
 * "account data unavailable" error (Requirement 3.7); {@link apiFetch} surfaces
 * that as an `ApiRequestError` the view renders as an error state rather than a
 * partial listing.
 */
export function fetchSpaces(): Promise<SpacesDTO> {
  return apiFetch<SpacesDTO>('/spaces');
}

/**
 * `POST /spaces` client (Admin only) — create a new AWS DevOps Agent Space in a
 * linked/hub account. The backend authorizes the Admin caller, validates the
 * request against the manifest, and runs the create in a Python worker; an
 * Executive caller or a validation/conflict/permission failure surfaces as an
 * {@link ApiRequestError} the Space_View renders inline.
 */
export function createSpace(request: CreateSpaceRequest): Promise<CreateSpaceResponse> {
  return apiFetch<CreateSpaceResponse>('/spaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/**
 * `POST /spaces/batch` client (Admin only) — create a starter agent space in
 * each listed account. Creation is fanned out asynchronously by the backend, so
 * this resolves quickly with the accepted count/ids; the new spaces appear after
 * the next data refresh (the UI marks the accounts "Pending refresh" meanwhile).
 */
export function batchCreateSpaces(
  request: BatchCreateSpacesRequest,
): Promise<BatchCreateSpacesResponse> {
  return apiFetch<BatchCreateSpacesResponse>('/spaces/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}
