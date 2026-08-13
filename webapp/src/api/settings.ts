import type { AppSettings } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * Application settings API client.
 *
 * - {@link fetchSettings} — `GET /settings`, available to any authenticated
 *   user, so the Chat view can show the active chat-memory retention window and
 *   the Admin Settings view can edit it.
 * - {@link saveSettings} — Admin-only `PUT /settings`. The backend re-asserts
 *   the Admin group before any write (Requirements 2.3, 2.5): an Executive
 *   caller gets a 403 and nothing is persisted. Out-of-range values are
 *   rejected server-side. A rejection surfaces as an `ApiRequestError`.
 */

/** `GET /settings` — the current app settings (retention window). */
export function fetchSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings');
}

/** Partial settings update: send only the field(s) being changed. */
export interface SettingsPatch {
  chatHistoryRetentionDays?: number;
  /** External AI (MCP) access flag (Task 39, Requirement 16.6). */
  externalMcpEnabled?: boolean;
}

/**
 * Admin-only `PUT /settings` — partial update of the app settings (the
 * chat-history retention window and/or the external MCP access flag). Each
 * present field is validated server-side; omitted fields are preserved.
 */
export function saveSettings(patch: SettingsPatch): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
