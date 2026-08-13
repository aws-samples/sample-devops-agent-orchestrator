import type {
  ChatHistoryResponse,
  ClearChatHistoryResponse,
} from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * Chat memory API client (consumed by `views/ChatView.tsx`).
 *
 * - {@link fetchChatHistory} — `GET /chat/history`. Returns the CALLER'S OWN
 *   persisted chat memory (oldest-first, already trimmed to the retention
 *   window) plus the active retention window, so the Chat view can restore a
 *   conversation across sessions and devices.
 * - {@link clearChatHistory} — `DELETE /chat/history`. Clears the caller's own
 *   memory. A failure surfaces as an `ApiRequestError`.
 *
 * Credential safety: the browser never holds AWS credentials — every request
 * carries only the caller's Cognito access token behind the API's JWT
 * authorizer, and the caller's user id is derived server-side from that token.
 */

/** `GET /chat/history` — the caller's recent chat memory + retention window. */
export function fetchChatHistory(): Promise<ChatHistoryResponse> {
  return apiFetch<ChatHistoryResponse>('/chat/history');
}

/** `DELETE /chat/history` — clear the caller's own chat memory. */
export function clearChatHistory(): Promise<ClearChatHistoryResponse> {
  return apiFetch<ClearChatHistoryResponse>('/chat/history', { method: 'DELETE' });
}
