import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  BusinessContext,
  Manifest,
  ManifestAccount,
  ManifestSpace,
} from '@devops-observatory/shared-types';
import { getHubConfig } from './config';

/**
 * Reads the hub S3 artifacts consumed by the read APIs (Task 4):
 *   - `raw/_manifest.json`      — authoritative account scope (Requirement 12.2)
 *   - `hub/business_context.json` — optional display-name / Business_Unit labels
 *
 * Both loads FAIL CLOSED: a missing, unreadable, or structurally invalid object
 * resolves to an "unavailable" result rather than throwing, so callers can apply
 * the freshness-unknown / no-partial-listing rules (Requirements 3.7, 4.3, 4.4).
 */

/** Result of attempting to load the manifest. */
export type ManifestLoad =
  | { status: 'ok'; manifest: Manifest }
  | { status: 'unavailable' };

let cachedClient: S3Client | undefined;

/** Lazily construct a single S3 client per warm Lambda container. */
function s3(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({});
  }
  return cachedClient;
}

/** Read an S3 object body as a UTF-8 string, or `undefined` if it cannot be read. */
async function getObjectString(bucket: string, key: string): Promise<string | undefined> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return undefined;
    // `transformToString` is available on the SDK v3 stream mixin in Node.
    return await body.transformToString('utf-8');
  } catch {
    // Missing key, access error, or transport failure — treat as unavailable.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Coerce a capability metric, preserving "unknown". The collector writes JSON
 * null when a metric could not be retrieved, and pre-capability manifests omit
 * the key entirely — both normalize to `null` (unknown), NEVER to 0, so the
 * API and UI reflect what actually happened during collection.
 */
function toNullableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Coerce a raw space entry into a typed {@link ManifestSpace} (counts default to 0). */
function normalizeSpace(raw: unknown): ManifestSpace | undefined {
  if (!isRecord(raw)) return undefined;
  const agentSpaceId = raw.agentSpaceId;
  if (typeof agentSpaceId !== 'string' || agentSpaceId.length === 0) return undefined;
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    agentSpaceId,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    counts: {
      associations: toCount(counts.associations),
      assets: toCount(counts.assets),
      investigations: toCount(counts.investigations),
      // Older manifests (collected before incidents were tracked) have no
      // `incidents`; fall back to `investigations` since they are the same.
      incidents: toCount(counts.incidents ?? counts.investigations),
      recommendations: toCount(counts.recommendations),
      // Capability counts: null/absent = unknown (collection error or a
      // pre-capability manifest) and stays null — never coerced to 0.
      telemetry: toNullableCount(counts.telemetry),
      pipelines: toNullableCount(counts.pipelines),
      communications: toNullableCount(counts.communications),
      mcpServers: toNullableCount(counts.mcpServers),
      remoteAgents: toNullableCount(counts.remoteAgents),
      webhooks: toNullableCount(counts.webhooks),
      logDeliveries: toNullableCount(counts.logDeliveries),
      users: toNullableCount(counts.users),
    },
  };
}

/** Coerce a raw account entry into a typed {@link ManifestAccount}. */
function normalizeAccount(raw: unknown): ManifestAccount | undefined {
  if (!isRecord(raw)) return undefined;
  const account = raw.account;
  if (typeof account !== 'string' || account.length === 0) return undefined;
  const spacesRaw = Array.isArray(raw.spaces) ? raw.spaces : [];
  const spaces = spacesRaw
    .map(normalizeSpace)
    .filter((s): s is ManifestSpace => s !== undefined);
  // The pipeline writes `error: null` on success and a string on failure.
  const error = typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : undefined;
  // Usage from GetAccountUsage — null when absent or structurally invalid.
  const usageRaw = isRecord(raw.usage) ? raw.usage : null;
  const usage = usageRaw
    ? {
        investigationHours: typeof usageRaw.investigationHours === 'number' ? usageRaw.investigationHours : 0,
        evaluationHours: typeof usageRaw.evaluationHours === 'number' ? usageRaw.evaluationHours : 0,
        systemLearningHours: typeof usageRaw.systemLearningHours === 'number' ? usageRaw.systemLearningHours : 0,
        onDemandHours: typeof usageRaw.onDemandHours === 'number' ? usageRaw.onDemandHours : 0,
        periodStart: typeof usageRaw.periodStart === 'string' ? usageRaw.periodStart : '',
        periodEnd: typeof usageRaw.periodEnd === 'string' ? usageRaw.periodEnd : '',
      }
    : null;
  return {
    account,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    error,
    spaces,
    usage,
  };
}

/**
 * Parse and structurally validate the manifest. Returns `undefined` (→ treated
 * as unavailable) when the top-level shape is not a manifest. `collectedAt`
 * validity is deliberately NOT enforced here — an invalid/missing timestamp is
 * surfaced later as freshness "unknown" while the account listing is preserved
 * (Requirement 4.4).
 */
function parseManifest(text: string): Manifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) return undefined;
  const accounts = raw.accounts
    .map(normalizeAccount)
    .filter((a): a is ManifestAccount => a !== undefined);
  return {
    collectedAt: typeof raw.collectedAt === 'string' ? raw.collectedAt : '',
    region: typeof raw.region === 'string' ? raw.region : '',
    accounts,
  };
}

/**
 * Load the collection manifest from the hub bucket. A missing, unreadable, or
 * structurally invalid manifest resolves to `{ status: 'unavailable' }` so
 * callers never emit a partial or fabricated listing (Requirement 3.7).
 */
export async function loadManifest(): Promise<ManifestLoad> {
  const { bucket, manifestKey } = getHubConfig();
  const text = await getObjectString(bucket, manifestKey);
  if (text === undefined) return { status: 'unavailable' };
  const manifest = parseManifest(text);
  if (!manifest) return { status: 'unavailable' };
  return { status: 'ok', manifest };
}

function normalizeBusinessContext(raw: unknown): BusinessContext | undefined {
  if (!isRecord(raw)) return undefined;
  const businessUnitsRaw = Array.isArray(raw.businessUnits) ? raw.businessUnits : [];
  const businessUnits = businessUnitsRaw
    .map((bu): BusinessContext['businessUnits'][number] | undefined => {
      if (!isRecord(bu) || typeof bu.name !== 'string' || bu.name.length === 0) return undefined;
      const accounts = Array.isArray(bu.accounts)
        ? bu.accounts.filter((a): a is string => typeof a === 'string')
        : [];
      return {
        name: bu.name,
        description: typeof bu.description === 'string' ? bu.description : undefined,
        accounts,
      };
    })
    .filter((bu): bu is BusinessContext['businessUnits'][number] => bu !== undefined);

  const displayNamesRaw = isRecord(raw.accountDisplayNames) ? raw.accountDisplayNames : {};
  const accountDisplayNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(displayNamesRaw)) {
    if (typeof value === 'string' && value.length > 0) accountDisplayNames[key] = value;
  }

  const contextRaw = isRecord(raw.accountContext) ? raw.accountContext : {};
  const accountContext: Record<string, string> = {};
  for (const [key, value] of Object.entries(contextRaw)) {
    if (typeof value === 'string' && value.length > 0) accountContext[key] = value;
  }

  const orgSystemPrompt =
    typeof raw.orgSystemPrompt === 'string' && raw.orgSystemPrompt.trim().length > 0
      ? raw.orgSystemPrompt
      : undefined;

  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    businessUnits,
    accountDisplayNames,
    accountContext,
    ...(orgSystemPrompt !== undefined ? { orgSystemPrompt } : {}),
  };
}

/**
 * Load the business context from the hub bucket. Returns `null` when the object
 * is absent or invalid — the read views then fall back to raw account ids and
 * by-account grouping (Requirements 3.5, 6.5).
 */
export async function loadBusinessContext(): Promise<BusinessContext | null> {
  const { bucket, businessContextKey } = getHubConfig();
  const text = await getObjectString(bucket, businessContextKey);
  if (text === undefined) return null;
  try {
    return normalizeBusinessContext(JSON.parse(text)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the business context to the hub bucket as a durable object
 * (`hub/business_context.json`, Requirement 5.3). Unlike the loaders this does
 * NOT fail closed: it throws when the write fails so the `PUT /context` handler
 * can surface a save-failure error. A failed `PutObject` does not mutate the
 * existing object, so the previously persisted context is left unchanged
 * (Requirement 5.4).
 */
export async function saveBusinessContext(context: BusinessContext): Promise<void> {
  const { bucket, businessContextKey } = getHubConfig();
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: businessContextKey,
      Body: JSON.stringify(context),
      ContentType: 'application/json',
    }),
  );
}
