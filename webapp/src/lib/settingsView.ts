import {
  CHAT_HISTORY_MAX_RETENTION_DAYS,
  CHAT_HISTORY_MIN_RETENTION_DAYS,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free logic for the Admin-only Settings view (chat-memory feature).
 *
 * Kept separate from the React component so the retention-days validation can be
 * unit-tested with the repo's `node:test` + tsx convention and mirrors the
 * server-side bounds (settings handler) so the UI can reject bad input before
 * the `PUT /settings` round-trip. The server remains the authority.
 */

/** Result of validating a proposed retention value from the settings form. */
export type RetentionValidation =
  | { ok: true; days: number }
  | { ok: false; error: string };

/**
 * Validate a retention-days input string. Must be a whole number within
 * [{@link CHAT_HISTORY_MIN_RETENTION_DAYS}, {@link CHAT_HISTORY_MAX_RETENTION_DAYS}].
 * On success the parsed integer is returned ready to send.
 */
export function validateRetentionDays(input: string): RetentionValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Enter a number of days.' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: 'Retention must be a whole number of days.' };
  }
  const days = Number(trimmed);
  if (days < CHAT_HISTORY_MIN_RETENTION_DAYS || days > CHAT_HISTORY_MAX_RETENTION_DAYS) {
    return {
      ok: false,
      error: `Retention must be between ${CHAT_HISTORY_MIN_RETENTION_DAYS} and ${CHAT_HISTORY_MAX_RETENTION_DAYS} days.`,
    };
  }
  return { ok: true, days };
}
