import {
  AGENT_SPACE_DESCRIPTION_MAX_LENGTH,
  AGENT_SPACE_NAME_MAX_LENGTH,
  AGENT_SPACE_NAME_MIN_LENGTH,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free helpers for the "create agent space" form in the Space_View.
 *
 * Kept separate from the React component so the name suggestion and the
 * client-side validation (which mirrors the backend bounds) can be unit-tested
 * and reused. The backend re-validates authoritatively — this is UX only.
 */

/** A sensible default name for a new space in an account (matches the CLI helper). */
export function defaultSpaceName(accountId: string): string {
  return `devops-agent-${accountId}`;
}

/** The result of validating the create-space form fields. */
export interface CreateSpaceFormIssues {
  name?: string;
  description?: string;
}

/**
 * Validate the trimmed form fields against the shared bounds. Returns an object
 * with per-field messages; an empty object means the form is valid.
 */
export function validateCreateSpaceForm(name: string, description: string): CreateSpaceFormIssues {
  const issues: CreateSpaceFormIssues = {};
  const trimmedName = name.trim();
  if (trimmedName.length < AGENT_SPACE_NAME_MIN_LENGTH) {
    issues.name = 'A space name is required.';
  } else if (trimmedName.length > AGENT_SPACE_NAME_MAX_LENGTH) {
    issues.name = `The name must be at most ${AGENT_SPACE_NAME_MAX_LENGTH} characters.`;
  }
  if (description.trim().length > AGENT_SPACE_DESCRIPTION_MAX_LENGTH) {
    issues.description = `The description must be at most ${AGENT_SPACE_DESCRIPTION_MAX_LENGTH} characters.`;
  }
  return issues;
}

/** True when the form has no validation issues. */
export function isCreateSpaceFormValid(issues: CreateSpaceFormIssues): boolean {
  return !issues.name && !issues.description;
}
