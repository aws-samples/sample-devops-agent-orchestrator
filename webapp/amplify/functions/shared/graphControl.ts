import {
  GetGraphCommand,
  ListGraphsCommand,
  NeptuneGraphClient,
  StartGraphCommand,
  StopGraphCommand,
} from '@aws-sdk/client-neptune-graph';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  GraphControlAction,
  GraphControlStatus,
  GraphLifecycleState,
} from '@devops-observatory/shared-types';

/**
 * Start/stop + status of the Neptune Analytics topology graph, backing the
 * Admin Settings "Topology graph" control (`GET`/`POST /graph/control`).
 *
 * Neptune Analytics supports a true PAUSE/RESUME via the `neptune-graph`
 * StartGraph / StopGraph APIs — non-destructive, so the graph, its id, and its
 * data all survive; only compute is released while stopped, which is what stops
 * the m-NCU-hour charge:
 *   - stop  → {@link StopGraphCommand}: AVAILABLE → STOPPING → STOPPED.
 *   - start → {@link StartGraphCommand}: STOPPED → STARTING → AVAILABLE.
 * Both return immediately with the transitional status; the SPA polls
 * {@link getGraphStatus} until it settles.
 *
 * The graph is resolved by NAME (config `NEPTUNE_GRAPH_NAME`) so the control
 * works regardless of the endpoint-derived id. Timing metrics come from the
 * service (`createTime`) plus a tiny S3 state object recording the last
 * app-initiated action (so "last stopped" survives across cold starts).
 */

/** Neptune Analytics statuses that mean "in transition" (keep polling). */
const TRANSITIONING_STATES: ReadonlySet<GraphLifecycleState> = new Set([
  'CREATING',
  'UPDATING',
  'DELETING',
  'RESETTING',
  'SNAPSHOTTING',
  'IMPORTING',
  'STARTING',
  'STOPPING',
]);

/** S3 object recording the last start/stop action initiated from the app. */
const STATE_KEY = 'hub/graph_control.json';

interface GraphControlConfig {
  graphName: string;
  region: string;
  bucket: string;
}

/** Resolve config from env (injected in backend.ts), mirroring `config.env`. */
function getConfig(): GraphControlConfig {
  return {
    graphName: process.env.NEPTUNE_GRAPH_NAME ?? 'devops-agent-topology',
    region: process.env.HUB_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    bucket: process.env.HUB_BUCKET ?? 'devops-agent-hub-123456789012-us-east-1',
  };
}

let cachedGraphClient: NeptuneGraphClient | undefined;
function graphClient(): NeptuneGraphClient {
  if (!cachedGraphClient) {
    cachedGraphClient = new NeptuneGraphClient({ region: getConfig().region });
  }
  return cachedGraphClient;
}

let cachedS3: S3Client | undefined;
function s3(): S3Client {
  if (!cachedS3) {
    cachedS3 = new S3Client({ region: getConfig().region });
  }
  return cachedS3;
}

/** Raised for expected control-flow conflicts (already running / already stopped). */
export class GraphControlConflict extends Error {}

/** Normalize a raw `neptune-graph` status string to our lifecycle enum. */
function toLifecycleState(raw: string | undefined): GraphLifecycleState {
  switch ((raw ?? '').toUpperCase()) {
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'STOPPED':
      return 'STOPPED';
    case 'STARTING':
      return 'STARTING';
    case 'STOPPING':
      return 'STOPPING';
    case 'CREATING':
      return 'CREATING';
    case 'UPDATING':
      return 'UPDATING';
    case 'DELETING':
      return 'DELETING';
    case 'RESETTING':
      return 'RESETTING';
    case 'SNAPSHOTTING':
      return 'SNAPSHOTTING';
    case 'IMPORTING':
      return 'IMPORTING';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

interface ResolvedGraph {
  id: string;
  state: GraphLifecycleState;
  createdAt?: string;
}

/** Find the graph by NAME, returning its id, state, and create time. */
async function findGraphByName(): Promise<ResolvedGraph | undefined> {
  const { graphName } = getConfig();
  let nextToken: string | undefined;
  do {
    const page = await graphClient().send(new ListGraphsCommand({ nextToken }));
    for (const g of page.graphs ?? []) {
      if (g.name === graphName && g.id) {
        // GetGraph gives the authoritative status + createTime.
        try {
          const detail = await graphClient().send(new GetGraphCommand({ graphIdentifier: g.id }));
          return {
            id: g.id,
            state: toLifecycleState(detail.status ?? g.status),
            createdAt: detail.createTime ? detail.createTime.toISOString() : undefined,
          };
        } catch {
          return { id: g.id, state: toLifecycleState(g.status) };
        }
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

async function readState(): Promise<{ lastAction?: GraphControlAction; lastActionAt?: string }> {
  const { bucket } = getConfig();
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
    const text = (await res.Body?.transformToString('utf-8')) ?? '';
    const raw = JSON.parse(text) as Record<string, unknown>;
    const action =
      raw.lastAction === 'start' || raw.lastAction === 'stop' ? raw.lastAction : undefined;
    return {
      lastAction: action,
      lastActionAt: typeof raw.lastActionAt === 'string' ? raw.lastActionAt : undefined,
    };
  } catch {
    return {};
  }
}

/** Record the last app-initiated action (best-effort; never throws). */
async function writeState(action: GraphControlAction): Promise<void> {
  const { bucket } = getConfig();
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: STATE_KEY,
        Body: JSON.stringify({ lastAction: action, lastActionAt: new Date().toISOString() }),
        ContentType: 'application/json',
      }),
    );
  } catch {
    /* metrics are best-effort — the action itself already succeeded */
  }
}

/** Shape a {@link GraphControlStatus} from the resolved graph + persisted state. */
function toStatus(
  graph: ResolvedGraph | undefined,
  state: { lastAction?: GraphControlAction; lastActionAt?: string },
): GraphControlStatus {
  const { graphName } = getConfig();
  if (!graph) {
    return {
      provisioned: false,
      running: false,
      state: 'DELETED',
      transitioning: false,
      graphName,
      ...(state.lastAction ? { lastAction: state.lastAction } : {}),
      ...(state.lastActionAt ? { lastActionAt: state.lastActionAt } : {}),
    };
  }
  return {
    provisioned: true,
    running: graph.state === 'AVAILABLE',
    state: graph.state,
    transitioning: TRANSITIONING_STATES.has(graph.state),
    graphName,
    graphId: graph.id,
    ...(graph.createdAt ? { createdAt: graph.createdAt } : {}),
    ...(state.lastAction ? { lastAction: state.lastAction } : {}),
    ...(state.lastActionAt ? { lastActionAt: state.lastActionAt } : {}),
  };
}

/** Current graph status + timing metrics for `GET /graph/control`. */
export async function getGraphStatus(): Promise<GraphControlStatus> {
  const [graph, state] = await Promise.all([findGraphByName(), readState()]);
  return toStatus(graph, state);
}

/**
 * START (resume) the graph. Rejects with {@link GraphControlConflict} when no
 * graph is provisioned, it is already running, or it is transitioning.
 */
export async function startGraph(): Promise<GraphControlStatus> {
  const current = await findGraphByName();
  if (!current) {
    throw new GraphControlConflict(
      'No topology graph is provisioned. Run a data refresh to provision it first.',
    );
  }
  if (current.state === 'AVAILABLE') {
    throw new GraphControlConflict('The graph is already running.');
  }
  if (current.state !== 'STOPPED') {
    throw new GraphControlConflict(`The graph is currently ${current.state.toLowerCase()}.`);
  }
  await graphClient().send(new StartGraphCommand({ graphIdentifier: current.id }));
  await writeState('start');
  return getGraphStatus();
}

/**
 * STOP (pause) the graph, releasing compute so it stops billing (data is
 * preserved). Rejects with {@link GraphControlConflict} when no graph is
 * provisioned, it is already stopped, or it is transitioning.
 */
export async function stopGraph(): Promise<GraphControlStatus> {
  const current = await findGraphByName();
  if (!current) {
    throw new GraphControlConflict('No topology graph is provisioned.');
  }
  if (current.state === 'STOPPED') {
    throw new GraphControlConflict('The graph is already stopped.');
  }
  if (current.state !== 'AVAILABLE') {
    throw new GraphControlConflict(`The graph is currently ${current.state.toLowerCase()}.`);
  }
  await graphClient().send(new StopGraphCommand({ graphIdentifier: current.id }));
  await writeState('stop');
  return getGraphStatus();
}
