import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CHAT_HISTORY_DEFAULT_RETENTION_DAYS,
  CHAT_HISTORY_MAX_RETENTION_DAYS,
  CHAT_HISTORY_MIN_RETENTION_DAYS,
  type AppSettings,
  type ChatCitation,
  type ChatHistoryMessage,
} from '@devops-observatory/shared-types';

/**
 * S3-backed store for persistent chat memory + app settings (chat-memory
 * feature). Storage lives in the same hub bucket as the manifest and business
 * context — no extra datastore or dependency (reuses the S3 client the read
 * APIs already use), which keeps the deployment's dependency tree small.
 *
 * Layout in the hub bucket:
 *   hub/chat_history/<cognitoSub>.json  — one object per user: their ordered
 *                                         chat turns. Per-user objects keep each
 *                                         user's memory private (a caller only
 *                                         ever reads/writes their own key).
 *   hub/app_settings.json               — the singleton app settings (retention).
 *
 * S3 has no per-item TTL, so the retention window is enforced by PRUNING on
 * every read and write: messages older than `now - retentionDays` are dropped
 * (and never returned). Reads fail soft (return defaults/empty on error) so chat
 * still works if the store is briefly unavailable; writes surface errors to the
 * caller, which decides whether they are fatal (settings save) or best-effort
 * (persisting a chat turn).
 *
 * Concurrency: a user's history object is read-modify-written on append, so
 * concurrent writes for the SAME user are last-writer-wins. Chat turns for a
 * user are effectively sequential, so this is acceptable.
 */

const SECONDS_PER_DAY = 86_400;
const HISTORY_PREFIX = 'hub/chat_history/';
const SETTINGS_KEY = 'hub/app_settings.json';
/** Cap on messages retained/returned per user (bounds object size + response). */
const HISTORY_MAX_MESSAGES = 200;

export interface ChatHistoryConfig {
  bucket: string;
  region: string;
}

/** Resolve the hub bucket + region from the environment (injected in backend.ts). */
export function getChatHistoryConfig(): ChatHistoryConfig {
  return {
    bucket: process.env.HUB_BUCKET ?? 'devops-agent-hub-123456789012-us-east-1',
    region: process.env.HUB_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  };
}

let cachedClient: S3Client | undefined;

/** Lazily construct a single S3 client per warm container. */
function s3(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({ region: getChatHistoryConfig().region });
  }
  return cachedClient;
}

/** Read an S3 object body as a UTF-8 string, or `undefined` if it cannot be read. */
async function getObjectString(key: string): Promise<string | undefined> {
  const { bucket } = getChatHistoryConfig();
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return undefined;
    return await body.transformToString('utf-8');
  } catch {
    return undefined;
  }
}

async function putObjectJson(key: string, value: unknown): Promise<void> {
  const { bucket } = getChatHistoryConfig();
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Retention settings
// ---------------------------------------------------------------------------

/** Clamp a proposed retention value to the inclusive supported bounds. */
export function clampRetentionDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) return CHAT_HISTORY_DEFAULT_RETENTION_DAYS;
  if (n < CHAT_HISTORY_MIN_RETENTION_DAYS) return CHAT_HISTORY_MIN_RETENTION_DAYS;
  if (n > CHAT_HISTORY_MAX_RETENTION_DAYS) return CHAT_HISTORY_MAX_RETENTION_DAYS;
  return n;
}

/**
 * Read the current app settings. Fails soft: a missing object or any read error
 * yields the default retention window so chat memory keeps working.
 */
export async function getSettings(): Promise<AppSettings> {
  const text = await getObjectString(SETTINGS_KEY);
  if (text === undefined) {
    return defaultSettings();
  }
  try {
    const raw = JSON.parse(text);
    if (!isRecord(raw)) throw new Error('bad settings');
    return {
      chatHistoryRetentionDays: clampRetentionDays(raw.chatHistoryRetentionDays),
      // Strict `=== true` so anything malformed reads as DISABLED — external
      // MCP access fails closed (Task 39, Requirement 16.6).
      externalMcpEnabled: raw.externalMcpEnabled === true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return defaultSettings();
  }
}

/** The defaults used when no settings object exists (or it is unreadable). */
function defaultSettings(): AppSettings {
  return {
    chatHistoryRetentionDays: CHAT_HISTORY_DEFAULT_RETENTION_DAYS,
    externalMcpEnabled: false,
    updatedAt: '',
  };
}

/**
 * Persist a partial settings update (Admin-only path) with read-modify-write so
 * the fields not being changed are preserved. Throws on write failure.
 */
export async function putSettings(
  patch: Partial<Pick<AppSettings, 'chatHistoryRetentionDays' | 'externalMcpEnabled'>>,
): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    chatHistoryRetentionDays:
      patch.chatHistoryRetentionDays !== undefined
        ? clampRetentionDays(patch.chatHistoryRetentionDays)
        : current.chatHistoryRetentionDays,
    externalMcpEnabled:
      patch.externalMcpEnabled !== undefined ? patch.externalMcpEnabled : current.externalMcpEnabled,
    updatedAt: new Date().toISOString(),
  };
  await putObjectJson(SETTINGS_KEY, next);
  return next;
}

/** Persist the retention setting (Admin-only path). Throws on write failure. */
export async function putRetentionDays(days: number): Promise<AppSettings> {
  return putSettings({ chatHistoryRetentionDays: days });
}

// ---------------------------------------------------------------------------
// Chat message persistence
// ---------------------------------------------------------------------------

function historyKey(userId: string): string {
  // Encode to keep the key safe; the Cognito sub is already URL-safe but guard anyway.
  return `${HISTORY_PREFIX}${encodeURIComponent(userId)}.json`;
}

/** A turn to persist (role + content, plus citations on assistant turns). */
export interface NewChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: ChatCitation[];
}

function toHistoryMessage(raw: unknown): ChatHistoryMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const role = raw.role;
  const content = raw.content;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return undefined;
  const citations = Array.isArray(raw.citations) ? (raw.citations as ChatCitation[]) : undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    role,
    content,
    ...(citations && citations.length > 0 ? { citations } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

/** Read + normalize a user's stored messages (unpruned). Fails soft to []. */
async function readMessages(userId: string): Promise<ChatHistoryMessage[]> {
  const text = await getObjectString(historyKey(userId));
  if (text === undefined) return [];
  try {
    const raw = JSON.parse(text);
    const list = isRecord(raw) && Array.isArray(raw.messages) ? raw.messages : [];
    return list.map(toHistoryMessage).filter((m): m is ChatHistoryMessage => m !== undefined);
  } catch {
    return [];
  }
}

/** Keep only messages within the retention window, newest-trimmed to the cap. */
function prune(messages: ChatHistoryMessage[], retentionDays: number): ChatHistoryMessage[] {
  const cutoffIso = new Date(
    Date.now() - clampRetentionDays(retentionDays) * SECONDS_PER_DAY * 1000,
  ).toISOString();
  const kept = messages.filter((m) => m.createdAt === '' || m.createdAt >= cutoffIso);
  // Bound the object: keep the most recent HISTORY_MAX_MESSAGES (oldest-first order preserved).
  return kept.length > HISTORY_MAX_MESSAGES ? kept.slice(kept.length - HISTORY_MAX_MESSAGES) : kept;
}

/**
 * Append one or more turns to a user's memory (read-modify-write), pruning to
 * the retention window on write. Best-effort by contract: the caller (chat
 * handler) catches failures so a storage hiccup never fails the chat response.
 */
export async function appendMessages(
  userId: string,
  messages: NewChatMessage[],
  retentionDays: number,
): Promise<void> {
  if (messages.length === 0) return;
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const existing = await readMessages(userId);
  const appended: ChatHistoryMessage[] = messages.map((m, index) => ({
    id: `${iso}#${String(index).padStart(3, '0')}`,
    role: m.role,
    content: m.content,
    ...(m.citations && m.citations.length > 0 ? { citations: m.citations } : {}),
    createdAt: iso,
  }));
  const next = prune([...existing, ...appended], retentionDays);
  await putObjectJson(historyKey(userId), { messages: next });
}

/**
 * Read a user's chat memory, oldest-first, trimmed to the retention window.
 * Fails soft to `[]`.
 */
export async function listHistory(
  userId: string,
  retentionDays: number,
): Promise<ChatHistoryMessage[]> {
  const messages = await readMessages(userId);
  return prune(messages, retentionDays);
}

/** Delete a user's chat memory object. Throws on failure so the caller can report it. */
export async function clearHistory(userId: string): Promise<void> {
  const { bucket } = getChatHistoryConfig();
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: historyKey(userId) }));
}
