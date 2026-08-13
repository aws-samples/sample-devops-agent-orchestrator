import { useEffect, useRef } from 'react';

/**
 * Idle-expiry timer (Requirement 1.6).
 *
 * Invokes `onIdle` after `timeoutMs` of no user activity while `enabled` is
 * true. Any of a small set of user-interaction events resets the countdown, so
 * an actively-used session never expires; a session left untouched for the full
 * window (30 minutes by default) triggers `onIdle`, which the auth layer wires
 * to sign-out + return-to-sign-in so re-authentication is required.
 *
 * The timer only runs while `enabled` (i.e. while authenticated). When disabled
 * it clears any pending timeout and detaches listeners, so an unauthenticated
 * app does no idle bookkeeping.
 */

/** 30 minutes, in milliseconds (Requirement 1.6). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Window activity signals that count as "the user is still here". */
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousedown',
  'mousemove',
  'keydown',
  'scroll',
  'touchstart',
  'click',
];

export interface UseIdleTimerOptions {
  /** Called once when the idle window elapses without activity. */
  onIdle: () => void;
  /** When false, the timer is inactive (e.g. no authenticated session). */
  enabled: boolean;
  /** Idle window in milliseconds. Defaults to {@link IDLE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export function useIdleTimer({
  onIdle,
  enabled,
  timeoutMs = IDLE_TIMEOUT_MS,
}: UseIdleTimerOptions): void {
  // Keep the latest onIdle in a ref so re-renders that change the callback
  // identity do not re-arm the whole effect (which would reset the countdown).
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timerId: ReturnType<typeof setTimeout>;
    let fired = false;

    const reset = (): void => {
      if (fired) {
        return;
      }
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        fired = true;
        onIdleRef.current();
      }, timeoutMs);
    };

    const handleActivity = (): void => {
      reset();
    };

    const handleVisibility = (): void => {
      // A tab returning to the foreground counts as activity; a tab being
      // hidden does not extend the session.
      if (!document.hidden) {
        reset();
      }
    };

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, handleActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', handleVisibility);

    // Arm the initial countdown.
    reset();

    return () => {
      clearTimeout(timerId);
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, handleActivity);
      }
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, timeoutMs]);
}
