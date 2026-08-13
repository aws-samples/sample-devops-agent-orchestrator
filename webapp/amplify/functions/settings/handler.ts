import {
  CHAT_HISTORY_MAX_RETENTION_DAYS,
  CHAT_HISTORY_MIN_RETENTION_DAYS,
} from '@devops-observatory/shared-types';
import { assertAdmin } from '../shared/authz';
import { clampRetentionDays, getSettings, putSettings } from '../shared/chatHistory';
import { UpstreamUnavailableError, ValidationError } from '../shared/errors';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * Application settings route.
 *
 * - `GET /settings` — any authenticated user. Returns the current app settings
 *   (the chat-history retention window) so the SPA can display and, for Admins,
 *   edit it. Fails soft to the default retention window.
 * - `PUT /settings` — Admin only. {@link assertAdmin} runs BEFORE any write and
 *   throws 401/403 for missing identities / Executive callers (Requirements
 *   2.3, 2.5, 2.6). The retention value must be an integer within
 *   [{@link CHAT_HISTORY_MIN_RETENTION_DAYS}, {@link CHAT_HISTORY_MAX_RETENTION_DAYS}];
 *   an out-of-range or non-numeric value is rejected and nothing is written.
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'PUT') {
    return handlePut(event);
  }
  return jsonResponse(await getSettings());
});

async function handlePut(event: ApiEvent): Promise<ApiResult> {
  assertAdmin(event); // authz gate — denials change no state (Req 2.3, 2.5, 2.6)

  const body = parseBody(event) as {
    chatHistoryRetentionDays?: unknown;
    externalMcpEnabled?: unknown;
  };

  // Partial update: either (or both) settings may be present, but at least one
  // must be, and each present field is validated before anything is written.
  const patch: { chatHistoryRetentionDays?: number; externalMcpEnabled?: boolean } = {};

  if (body.chatHistoryRetentionDays !== undefined) {
    const raw = body.chatHistoryRetentionDays;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      throw new ValidationError('chatHistoryRetentionDays must be an integer number of days.');
    }
    if (raw < CHAT_HISTORY_MIN_RETENTION_DAYS || raw > CHAT_HISTORY_MAX_RETENTION_DAYS) {
      throw new ValidationError(
        `chatHistoryRetentionDays must be between ${CHAT_HISTORY_MIN_RETENTION_DAYS} and ${CHAT_HISTORY_MAX_RETENTION_DAYS} days.`,
      );
    }
    patch.chatHistoryRetentionDays = clampRetentionDays(raw);
  }

  // External AI (MCP) access flag (Task 39, Requirement 16.6): a strict boolean
  // only. Enforcement happens in the external tools Lambda at request time, so
  // this write is the single Admin control and never touches the webapp chat.
  if (body.externalMcpEnabled !== undefined) {
    if (typeof body.externalMcpEnabled !== 'boolean') {
      throw new ValidationError('externalMcpEnabled must be true or false.');
    }
    patch.externalMcpEnabled = body.externalMcpEnabled;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Provide chatHistoryRetentionDays and/or externalMcpEnabled.');
  }

  try {
    const saved = await putSettings(patch);
    return jsonResponse(saved);
  } catch {
    throw new UpstreamUnavailableError(
      'The settings could not be saved. The previously saved settings are unchanged.',
    );
  }
}

function parseBody(event: ApiEvent): unknown {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  if (decoded.trim() === '') {
    throw new ValidationError('A settings body is required.');
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
}
