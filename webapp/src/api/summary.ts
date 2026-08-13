import type { SummaryDTO } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * `GET /summary` client (Task 4.1 backend, consumed by the Task 11 landing view).
 *
 * Returns the aggregate totals (incidents = investigations + open
 * recommendations, per the design), agent-space usage, and Last_Sync_Date used
 * by the default Summary landing view (Requirement 11.1). The backend already
 * returns a freshness-unknown marker with zeroed totals when the manifest is
 * unavailable (Requirement 4.3), so the view can render this shape directly.
 */
export function fetchSummary(): Promise<SummaryDTO> {
  return apiFetch<SummaryDTO>('/summary');
}
