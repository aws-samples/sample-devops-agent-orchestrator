import { useEffect, useMemo, useRef, useState } from 'react';
import { DataSet, Network, type Options } from 'vis-network/standalone';
import type { GraphNode, GraphResponse } from '@devops-observatory/shared-types';
import { fetchGraph } from '../api/graph';
import { resolveErrorMessage } from '../lib/viewState';
import { LoadingMessage } from '../components/StateMessage';
import { GraphFilterSidebar } from '../components/GraphFilterSidebar';
import {
  computeVisibility,
  edgeIsVisible,
  initialFilterState,
  type FilterState,
} from '../lib/graphFilters';
import {
  buildVisEdges,
  buildVisNodes,
  CROSS_ACCOUNT_EDGE_COLOR,
  graphUnavailableMessage,
  legendEntries,
  nodeMetadataEntries,
  type GraphUnavailableMessage,
  type LegendEntry,
} from '../lib/graphView';

/**
 * Graph_View (Task 14 — Requirements 7.1–7.7, 11.2).
 *
 * Renders the enriched topology graph from `GET /graph` inside the WebApp with
 * vis-network — no external graph tool required (7.1). Each node uses a
 * per-type indicator (color + shape) with a legend mapping every supported node
 * type to its indicator (7.2); nodes are labelled with their human-friendly
 * `displayLabel` / typed fallback rather than a UUID (7.3, 7.4, 11.2). Selecting
 * a node shows its label and business-meaningful metadata in a side panel (7.5).
 * Cross-account `TARGETS_ACCOUNT` edges are drawn visually distinct from
 * same-account edges (7.6). When the graph is unavailable or empty the view
 * shows a message plus the reason category and never a blank canvas (7.7).
 *
 * Credential safety: the browser never holds AWS credentials — the topology is
 * fetched only through the authenticated `GET /graph` API.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; graph: GraphResponse }
  | { status: 'error'; message: string };

export function GraphView(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchGraph()
      .then((graph) => {
        if (active) setState({ status: 'ready', graph });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = resolveErrorMessage(
          err,
          'Unable to load the topology graph right now. Please try again.',
        );
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="graph-heading">
      <h2 id="graph-heading" style={{ marginTop: 0 }}>
        Graph
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        Cross-account topology of accounts, agent spaces, associations, and the services they
        target.
      </p>

      {state.status === 'loading' && <LoadingMessage>Loading graph…</LoadingMessage>}

      {state.status === 'error' && (
        // A request-level failure (e.g. auth/network) — still never a blank view
        // (Requirement 7.7): show the reason so the user knows why.
        <UnavailableMessage
          message={{
            category: 'load-failure',
            title: 'Graph cannot be displayed',
            detail: state.message,
          }}
        />
      )}

      {state.status === 'ready' && <GraphContent graph={state.graph} />}
    </section>
  );
}

function GraphContent({ graph }: { graph: GraphResponse }): JSX.Element {
  const unavailable = graphUnavailableMessage(graph);
  if (unavailable) {
    return <UnavailableMessage message={unavailable} />;
  }
  return <GraphCanvas graph={graph} />;
}

function GraphCanvas({ graph }: { graph: GraphResponse }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesDataSetRef = useRef<DataSet<{ id: string; hidden?: boolean }> | null>(null);
  const edgesDataSetRef = useRef<DataSet<{ id: string; hidden?: boolean }> | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => initialFilterState(graph.nodes, graph.edges));

  // Index nodes by id so a vis-network selection event can resolve the enriched
  // node for the metadata panel (Requirement 7.5).
  const nodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of graph.nodes) map.set(node.id, node);
    return map;
  }, [graph.nodes]);

  // Compute visibility counts for the stats footer.
  const { visibleNodeIds, visibleEdgeCount } = useMemo(
    () => computeVisibility(graph.nodes, graph.edges, filters),
    [graph.nodes, graph.edges, filters],
  );

  // --- Create the network once ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const nodes = new DataSet(buildVisNodes(graph.nodes));
    const edges = new DataSet(buildVisEdges(graph.edges));
    nodesDataSetRef.current = nodes as unknown as DataSet<{ id: string; hidden?: boolean }>;
    edgesDataSetRef.current = edges as unknown as DataSet<{ id: string; hidden?: boolean }>;

    const options: Options = {
      autoResize: true,
      height: '100%',
      width: '100%',
      interaction: { hover: true, tooltipDelay: 150 },
      nodes: {
        borderWidth: 1,
        font: { color: '#101828', size: 14, face: 'system-ui, sans-serif' },
        color: { border: '#101828' },
      },
      edges: {
        smooth: { enabled: true, type: 'dynamic', roundness: 0.5 },
        font: { size: 11, color: '#b42318', strokeWidth: 3, strokeColor: '#ffffff' },
      },
      physics: {
        stabilization: { enabled: true, iterations: 150 },
        barnesHut: { gravitationalConstant: -8000, springLength: 140 },
      },
    };

    const network = new Network(container, { nodes, edges }, options);
    networkRef.current = network;

    network.on('selectNode', (params: { nodes: string[] }) => {
      const id = params.nodes[0];
      setSelected(id ? nodesById.get(id) ?? null : null);
    });
    network.on('deselectNode', () => setSelected(null));

    return () => {
      network.destroy();
      networkRef.current = null;
      nodesDataSetRef.current = null;
      edgesDataSetRef.current = null;
    };
  }, [graph.nodes, graph.edges, nodesById]);

  // --- Apply filter changes reactively (update hidden flag on the DataSets) ---
  useEffect(() => {
    const nodesDs = nodesDataSetRef.current;
    const edgesDs = edgesDataSetRef.current;
    if (!nodesDs || !edgesDs) return;

    // Update node visibility.
    for (const node of graph.nodes) {
      nodesDs.update({ id: node.id, hidden: !visibleNodeIds.has(node.id) });
    }
    // Update edge visibility: both endpoints must be visible AND edge type checked.
    // Use the original graph edges (which carry `from`/`to`) keyed by index
    // to avoid brittle id parsing.
    const edgeIds = edgesDs.getIds() as string[];
    for (let i = 0; i < graph.edges.length && i < edgeIds.length; i++) {
      const edge = graph.edges[i];
      const visible = edgeIsVisible(edge, visibleNodeIds, filters);
      edgesDs.update({ id: edgeIds[i], hidden: !visible });
    }
  }, [visibleNodeIds, graph.nodes, graph.edges, filters]);

  return (
    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'flex-start' }}>
      {/* Graph + legend + metadata panel */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div
          ref={containerRef}
          role="application"
          aria-label="Topology graph"
          style={{
            height: 560,
            border: '1px solid #eaecf0',
            borderRadius: 12,
            background: '#fff',
            boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
          }}
        />
        <Legend />
        {selected && <MetadataPanel node={selected} />}
      </div>
      {/* Filter sidebar — on the RIGHT */}
      <GraphFilterSidebar
        nodes={graph.nodes}
        edges={graph.edges}
        state={filters}
        onChange={setFilters}
        visibleNodes={visibleNodeIds.size}
        totalNodes={graph.nodes.length}
        visibleEdges={visibleEdgeCount}
        totalEdges={graph.edges.length}
      />
    </div>
  );
}

function Legend(): JSX.Element {
  const entries = legendEntries();
  return (
    <div
      aria-label="Legend"
      style={{
        marginTop: '0.875rem',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem 1.25rem',
        border: '1px solid #eaecf0',
        borderRadius: 12,
        background: '#fff',
        padding: '0.875rem 1rem',
      }}
    >
      <p
        style={{
          margin: 0,
          width: '100%',
          fontSize: '0.75rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
          color: '#667085',
        }}
      >
        Legend
      </p>
      {entries.map((entry) => (
        <LegendItem key={entry.type} entry={entry} />
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 24,
            height: 0,
            borderTop: `3px dashed ${CROSS_ACCOUNT_EDGE_COLOR}`,
          }}
        />
        <span style={{ fontSize: '0.875rem', color: '#344054' }}>Cross-account link</span>
      </div>
    </div>
  );
}

function LegendItem({ entry }: { entry: LegendEntry }): JSX.Element {
  // Approximate each vis-network shape with a CSS swatch so the legend indicator
  // matches the canvas indicator (color always; shape via border-radius/clip).
  const swatch: React.CSSProperties = {
    display: 'inline-block',
    width: 14,
    height: 14,
    background: entry.color,
    flexShrink: 0,
  };
  if (entry.shape === 'dot' || entry.shape === 'ellipse') {
    swatch.borderRadius = '50%';
  } else if (entry.shape === 'diamond') {
    swatch.transform = 'rotate(45deg)';
  } else if (entry.shape === 'triangle') {
    swatch.clipPath = 'polygon(50% 0%, 0% 100%, 100% 100%)';
  } else if (entry.shape === 'star') {
    swatch.clipPath =
      'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)';
  } else if (entry.shape === 'hexagon') {
    swatch.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
  } else if (entry.shape === 'box' || entry.shape === 'square') {
    swatch.borderRadius = 2;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span aria-hidden style={swatch} />
      <span style={{ fontSize: '0.875rem', color: '#344054' }}>{entry.label}</span>
    </div>
  );
}

function MetadataPanel({ node }: { node: GraphNode | null }): JSX.Element {
  if (!node) return <></>;
  return (
    <aside
      aria-label="Selected node details"
      style={{
        border: '1px solid #eaecf0',
        borderRadius: 12,
        background: '#fff',
        padding: '1rem',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
      }}
    >
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Node Details</h3>
      {node === null ? (
        <></>
      ) : (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr', gap: '0.625rem' }}>
          {nodeMetadataEntries(node).map((entry) => (
            <div key={entry.label}>
              <dt
                style={{
                  margin: 0,
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.02em',
                  color: '#667085',
                }}
              >
                {entry.label}
              </dt>
              <dd style={{ margin: '0.125rem 0 0', fontSize: '0.9375rem', color: '#101828', wordBreak: 'break-word' }}>
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}

function UnavailableMessage({ message }: { message: GraphUnavailableMessage }): JSX.Element {
  const isLoadFailure = message.category === 'load-failure';
  return (
    <div
      role={isLoadFailure ? 'alert' : 'status'}
      style={{
        marginTop: '1.5rem',
        padding: '1rem 1.25rem',
        borderRadius: 12,
        border: isLoadFailure ? '1px solid #fecdca' : '1px dashed #d0d5dd',
        background: isLoadFailure ? '#fef3f2' : '#fcfcfd',
        color: isLoadFailure ? '#b42318' : '#667085',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>{message.title}</p>
      <p style={{ margin: '0.375rem 0 0', fontSize: '0.9375rem' }}>{message.detail}</p>
    </div>
  );
}
