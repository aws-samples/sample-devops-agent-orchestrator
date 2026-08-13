import {
  ORG_SYSTEM_PROMPT_MAX_LENGTH,
  type BusinessContext,
  type BusinessUnit,
} from '@devops-observatory/shared-types';

/**
 * Validation + normalization for `hub/business_context.json` (Task 5.1).
 *
 * The rules mirror the design's data model and Requirements 5.1, 5.2, 5.7:
 *   - Business_Unit name: non-empty string, 1–128 characters (Req 5.1).
 *   - Account display name: 1–128 characters (Req 5.2).
 *   - Business_Unit description / metadata: up to 1024 characters (Req 5.2).
 *   - Every referenced account (in `businessUnits[].accounts` and
 *     `accountDisplayNames` keys) MUST exist in the manifest; an unrecognized
 *     account is rejected with an issue that identifies the offending account
 *     (Req 5.7).
 *
 * The validator is a pure function so it can be unit tested in isolation and
 * reused by the `PUT /context` handler. On success it returns a normalized
 * {@link BusinessContext}; the handler stamps `updatedAt` at save time.
 */

/** Inclusive bound: Business_Unit and display names are 1–128 characters. */
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 128;
/** Inclusive bound: Business_Unit descriptive metadata is at most 1024 characters. */
export const DESCRIPTION_MAX_LENGTH = 1024;
/**
 * Inclusive bound for per-account free-text Account_Context (Requirement 5.2).
 * Larger than the Business_Unit description so an admin can capture rich context
 * per account (purpose, owning team, environment, key workloads, dependencies,
 * notes) that enriches the knowledge base and chat answers.
 */
export const ACCOUNT_CONTEXT_MAX_LENGTH = 4096;

/** A single validation problem. `account` is set when an account is unrecognized. */
export interface ValidationIssue {
  /** Dotted path to the offending field (e.g. `businessUnits[0].name`). */
  path: string;
  /** Human-readable explanation of the failure. */
  message: string;
  /** The unrecognized account id, when the issue is an account-existence failure. */
  account?: string;
}

/** Result of validating a candidate business context. */
export type ValidationResult =
  | { valid: true; context: BusinessContext }
  | { valid: false; issues: ValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a candidate business context against the set of account
 * ids present in the manifest. Returns `{ valid: true, context }` with a clean,
 * typed object on success, or `{ valid: false, issues }` describing every problem
 * found (validation does not stop at the first error so the UI can show them all).
 *
 * `version` and `businessUnits`/`accountDisplayNames` are optional in the input:
 * an absent field is treated as an empty context. `updatedAt` from the input is
 * ignored — the caller stamps it authoritatively at save time.
 */
export function validateBusinessContext(
  input: unknown,
  validAccountIds: Iterable<string>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const known = validAccountIds instanceof Set ? validAccountIds : new Set(validAccountIds);

  if (!isRecord(input)) {
    return { valid: false, issues: [{ path: '', message: 'Business context must be an object.' }] };
  }

  // --- version (optional; positive integer when present) ----------------------
  let version = 1;
  if (input.version !== undefined) {
    if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
      issues.push({ path: 'version', message: 'version must be a positive integer.' });
    } else {
      version = input.version;
    }
  }

  // --- businessUnits ----------------------------------------------------------
  const businessUnits: BusinessUnit[] = [];
  if (input.businessUnits !== undefined) {
    if (!Array.isArray(input.businessUnits)) {
      issues.push({ path: 'businessUnits', message: 'businessUnits must be an array.' });
    } else {
      input.businessUnits.forEach((raw, index) => {
        const path = `businessUnits[${index}]`;
        if (!isRecord(raw)) {
          issues.push({ path, message: 'Each business unit must be an object.' });
          return;
        }

        // name: non-empty string, 1–128 chars (Req 5.1)
        const name = raw.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
          issues.push({ path: `${path}.name`, message: 'Business unit name is required and must be a non-empty string.' });
        } else if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
          issues.push({
            path: `${path}.name`,
            message: `Business unit name must be ${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} characters.`,
          });
        }

        // description: optional, ≤1024 chars (Req 5.2)
        let description: string | undefined;
        if (raw.description !== undefined && raw.description !== null) {
          if (typeof raw.description !== 'string') {
            issues.push({ path: `${path}.description`, message: 'Description must be a string.' });
          } else if (raw.description.length > DESCRIPTION_MAX_LENGTH) {
            issues.push({
              path: `${path}.description`,
              message: `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`,
            });
          } else {
            description = raw.description;
          }
        }

        // accounts: array of strings, each must exist in the manifest (Req 5.7)
        const accounts: string[] = [];
        if (raw.accounts !== undefined) {
          if (!Array.isArray(raw.accounts)) {
            issues.push({ path: `${path}.accounts`, message: 'accounts must be an array of account ids.' });
          } else {
            raw.accounts.forEach((acct, accountIndex) => {
              const accountPath = `${path}.accounts[${accountIndex}]`;
              if (typeof acct !== 'string' || acct.length === 0) {
                issues.push({ path: accountPath, message: 'Each account must be a non-empty string.' });
                return;
              }
              if (!known.has(acct)) {
                issues.push({
                  path: accountPath,
                  message: `Account "${acct}" is not present in the collected data manifest.`,
                  account: acct,
                });
                return;
              }
              accounts.push(acct);
            });
          }
        }

        businessUnits.push({
          name: typeof name === 'string' ? name : '',
          ...(description !== undefined ? { description } : {}),
          accounts,
        });
      });
    }
  }

  // --- accountDisplayNames ----------------------------------------------------
  const accountDisplayNames: Record<string, string> = {};
  if (input.accountDisplayNames !== undefined) {
    if (!isRecord(input.accountDisplayNames)) {
      issues.push({ path: 'accountDisplayNames', message: 'accountDisplayNames must be an object.' });
    } else {
      for (const [accountId, value] of Object.entries(input.accountDisplayNames)) {
        const path = `accountDisplayNames.${accountId}`;
        // Every keyed account must exist in the manifest (Req 5.7).
        if (!known.has(accountId)) {
          issues.push({
            path,
            message: `Account "${accountId}" is not present in the collected data manifest.`,
            account: accountId,
          });
          continue;
        }
        if (typeof value !== 'string' || value.length < NAME_MIN_LENGTH || value.length > NAME_MAX_LENGTH) {
          issues.push({
            path,
            message: `Display name must be a string of ${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} characters.`,
          });
          continue;
        }
        accountDisplayNames[accountId] = value;
      }
    }
  }

  // --- accountContext (free-text per-account metadata) -----------------------
  const accountContext: Record<string, string> = {};
  if (input.accountContext !== undefined) {
    if (!isRecord(input.accountContext)) {
      issues.push({ path: 'accountContext', message: 'accountContext must be an object.' });
    } else {
      for (const [accountId, value] of Object.entries(input.accountContext)) {
        const path = `accountContext.${accountId}`;
        // Every keyed account must exist in the manifest (Req 5.7).
        if (!known.has(accountId)) {
          issues.push({
            path,
            message: `Account "${accountId}" is not present in the collected data manifest.`,
            account: accountId,
          });
          continue;
        }
        if (typeof value !== 'string') {
          issues.push({ path, message: 'Account context must be a string.' });
          continue;
        }
        if (value.length > ACCOUNT_CONTEXT_MAX_LENGTH) {
          issues.push({
            path,
            message: `Account context must be at most ${ACCOUNT_CONTEXT_MAX_LENGTH} characters.`,
          });
          continue;
        }
        // Omit blanks so the persisted object stays clean.
        if (value.trim().length > 0) {
          accountContext[accountId] = value;
        }
      }
    }
  }

  // --- orgSystemPrompt (optional org-wide chat guidance) ---------------------
  let orgSystemPrompt: string | undefined;
  if (input.orgSystemPrompt !== undefined && input.orgSystemPrompt !== null) {
    if (typeof input.orgSystemPrompt !== 'string') {
      issues.push({ path: 'orgSystemPrompt', message: 'Org system prompt must be a string.' });
    } else if (input.orgSystemPrompt.length > ORG_SYSTEM_PROMPT_MAX_LENGTH) {
      issues.push({
        path: 'orgSystemPrompt',
        message: `Org system prompt must be at most ${ORG_SYSTEM_PROMPT_MAX_LENGTH} characters.`,
      });
    } else if (input.orgSystemPrompt.trim().length > 0) {
      // Omit blanks so the persisted object stays clean.
      orgSystemPrompt = input.orgSystemPrompt;
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    context: {
      version,
      updatedAt: '', // stamped by the caller at save time
      businessUnits,
      accountDisplayNames,
      accountContext,
      ...(orgSystemPrompt !== undefined ? { orgSystemPrompt } : {}),
    },
  };
}

/** An empty, well-formed business context used as the default when none is stored. */
export function emptyBusinessContext(): BusinessContext {
  return { version: 1, updatedAt: '', businessUnits: [], accountDisplayNames: {}, accountContext: {} };
}
