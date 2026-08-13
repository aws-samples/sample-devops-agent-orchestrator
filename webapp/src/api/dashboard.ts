import type { DashboardDTO } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * `GET /dashboard` client (Task 4.3 backend, consumed by the Task 13 Dashboard).
 *
 * Returns the aggregate totals (incidents = investigations + open
 * recommendations, per the design), the grouping selector (`businessUnit` when
 * business context assigns any account, else `account`), and the per-group
 * breakdown rows — with unassigned accounts collected under an "Unassigned"
 * bucket (Requirements 6.1–6.5, 12.5–12.7). Zero metrics are returned as the
 * integer 0, never omitted (Requirement 6.7).
 *
 * When the manifest is unavailable the backend returns zeroed totals and an
 * empty breakdown (the no-data signal, Requirement 6.8) rather than an error,
 * so the view can render this shape directly.
 */
export function fetchDashboard(): Promise<DashboardDTO> {
  return apiFetch<DashboardDTO>('/dashboard');
}
