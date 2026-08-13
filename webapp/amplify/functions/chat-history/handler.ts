import { getCaller } from '../shared/authz';
import { clearHistory, getSettings, listHistory } from '../shared/chatHistory';
import { UpstreamUnavailableError } from '../shared/errors';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * Chat memory route — scoped to the caller's own history.
 *
 * - `GET /chat/history` — return the caller's persisted chat memory
 *   (oldest-first, trimmed to the retention window) plus the active retention
 *   window for display. Reads fail soft: a store hiccup yields an empty
 *   history rather than an error, so the Chat view still loads.
 * - `DELETE /chat/history` — clear the caller's own memory. A failure surfaces
 *   as a 502 so the UI can report it.
 *
 * The caller's user id comes from the verified JWT (`getCaller`), so a user can
 * only ever read or clear their own partition (Requirements 1.2, 2.6).
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const caller = getCaller(event);
  const method = event.requestContext.http.method.toUpperCase();

  if (method === 'DELETE') {
    try {
      await clearHistory(caller.userId);
    } catch {
      throw new UpstreamUnavailableError('Your chat history could not be cleared. Please try again.');
    }
    return jsonResponse({ cleared: true });
  }

  const { chatHistoryRetentionDays } = await getSettings();
  const messages = await listHistory(caller.userId, chatHistoryRetentionDays);
  return jsonResponse({ messages, retentionDays: chatHistoryRetentionDays });
});
