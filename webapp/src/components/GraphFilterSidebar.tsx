import { useMemo, useState, type CSSProperties } from 'react';
import type { GraphEdge, GraphNode } from '@devops-observatory/shared-types';
import {
  DIMENSION_LABELS,
  dimensionValue,
  FILTER_DIMENSIONS,
  uniqueDimensionValues,
  uniqueEdgeTypes,
  type FilterDimension,
  type FilterState,
} from '../lib/graphFilters';

/**
 * Reactive filter sidebar for the Graph_View (Task 40).
 *
 * Renders on the RIGHT of the page (main nav is on the left). Each dimension
 * has an "All" toggle, a SEARCH box (for when there are thousands of values),
 * and a SCROLLABLE list of per-value checkboxes. Unchecking a value reactively
 * hides matching nodes. All values start checked (default = everything visible).
 */

export interface GraphFilterSidebarProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  visibleNodes: number;
  totalNodes: number;
  visibleEdges: number;
  totalEdges: number;
}

export function GraphFilterSidebar({
  nodes,
  edges,
  state,
  onChange,
  visibleNodes,
  totalNodes,
  visibleEdges,
  totalEdges,
}: GraphFilterSidebarProps): JSX.Element {
  return (
    <aside
      aria-label="Graph filters"
      style={{
        width: 260,
        flexShrink: 0,
        border: '1px solid #eaecf0',
        borderRadius: 12,
        background: '#fff',
        padding: '1rem',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
        overflowY: 'auto',
        maxHeight: 700,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.875rem',
      }}
    >
      <p style={{ margin: 0, fontWeight: 700, fontSize: '0.9375rem', color: '#101828' }}>
        Filters
      </p>
      {FILTER_DIMENSIONS.map((dim) => (
        <DimensionGroup key={dim} dim={dim} nodes={nodes} state={state} onChange={onChange} />
      ))}
      <EdgeTypeGroup edges={edges} state={state} onChange={onChange} />
      <p style={{ margin: 0, fontSize: '0.75rem', color: '#667085', borderTop: '1px solid #eaecf0', paddingTop: '0.75rem' }}>
        {visibleNodes} / {totalNodes} nodes · {visibleEdges} / {totalEdges} edges
      </p>
    </aside>
  );
}

/** Max items shown without scrolling — beyond this a scrollable pane kicks in. */
const SCROLL_THRESHOLD = 8;

function DimensionGroup({
  dim,
  nodes,
  state,
  onChange,
}: {
  dim: FilterDimension;
  nodes: GraphNode[];
  state: FilterState;
  onChange: (next: FilterState) => void;
}): JSX.Element {
  const values = useMemo(() => uniqueDimensionValues(nodes, dim), [nodes, dim]);
  const checked = state[dim];
  const allChecked = values.length > 0 && values.every((v) => checked.has(v));
  const [search, setSearch] = useState('');

  // Count nodes per value (for the badge).
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of nodes) {
      const v = dimensionValue(node, dim);
      if (v) map.set(v, (map.get(v) ?? 0) + 1);
    }
    return map;
  }, [nodes, dim]);

  // Filter the displayed values by the search term (case-insensitive).
  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return values;
    return values.filter((v) => v.toLowerCase().includes(q));
  }, [values, search]);

  if (values.length === 0) return <></>;

  function toggleAll(on: boolean) {
    const next = { ...state, [dim]: on ? new Set(values) : new Set<string>() };
    onChange(next);
  }

  function toggleValue(val: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(val); else next.delete(val);
    onChange({ ...state, [dim]: next });
  }

  const needsScroll = values.length > SCROLL_THRESHOLD;

  const labelStyle: CSSProperties = {
    cursor: 'pointer',
    userSelect: 'none',
    flex: 1,
    fontSize: '0.8125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const countStyle: CSSProperties = {
    color: '#98a2b3',
    fontSize: '0.6875rem',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };

  return (
    <div>
      <p style={{ margin: '0 0 0.25rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#667085' }}>
        {DIMENSION_LABELS[dim]}
        <span style={{ fontWeight: 400, marginLeft: '0.375rem' }}>({values.length})</span>
      </p>

      {/* All toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', borderBottom: '1px solid #f2f4f7', paddingBottom: '0.25rem', marginBottom: '0.25rem' }}>
        <input
          type="checkbox"
          id={`gf-all-${dim}`}
          checked={allChecked}
          onChange={(e) => toggleAll(e.target.checked)}
        />
        <label htmlFor={`gf-all-${dim}`} style={{ ...labelStyle, fontWeight: 600 }}>All</label>
        <span style={countStyle}>{values.length}</span>
      </div>

      {/* Search (shown when there are more items than the scroll threshold) */}
      {needsScroll && (
        <input
          type="search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={`Search ${DIMENSION_LABELS[dim]}`}
          autoComplete="off"
          spellCheck={false}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '0.3rem 0.5rem',
            borderRadius: 5,
            border: '1px solid #d0d5dd',
            fontSize: '0.75rem',
            marginBottom: '0.25rem',
          }}
        />
      )}

      {/* Scrollable value list */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.125rem',
          ...(needsScroll ? { maxHeight: 160, overflowY: 'auto', paddingRight: '0.25rem' } : {}),
        }}
      >
        {displayed.length === 0 && search.length > 0 && (
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#98a2b3', fontStyle: 'italic' }}>
            No matches
          </p>
        )}
        {displayed.map((val) => (
          <div key={val} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <input
              type="checkbox"
              id={`gf-${dim}-${val}`}
              checked={checked.has(val)}
              onChange={(e) => toggleValue(val, e.target.checked)}
              style={{ flexShrink: 0 }}
            />
            <label htmlFor={`gf-${dim}-${val}`} style={labelStyle} title={val}>
              {val}
            </label>
            <span style={countStyle}>{counts.get(val) ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


/** Edge type filter group — show/hide edges by relationship type. */
function EdgeTypeGroup({
  edges,
  state,
  onChange,
}: {
  edges: GraphEdge[];
  state: FilterState;
  onChange: (next: FilterState) => void;
}): JSX.Element {
  const values = useMemo(() => uniqueEdgeTypes(edges), [edges]);
  const checked = state.edgeType;
  const allChecked = values.length > 0 && values.every((v) => checked.has(v));
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of edges) {
      if (edge.type) map.set(edge.type, (map.get(edge.type) ?? 0) + 1);
    }
    return map;
  }, [edges]);

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return values;
    return values.filter((v) => v.toLowerCase().includes(q));
  }, [values, search]);

  if (values.length === 0) return <></>;

  const needsScroll = values.length > 8;

  function toggleAll(on: boolean) {
    onChange({ ...state, edgeType: on ? new Set(values) : new Set<string>() });
  }
  function toggleValue(val: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(val); else next.delete(val);
    onChange({ ...state, edgeType: next });
  }

  const labelStyle: CSSProperties = { cursor: 'pointer', userSelect: 'none', flex: 1, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const countStyle: CSSProperties = { color: '#98a2b3', fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums', flexShrink: 0 };

  return (
    <div>
      <p style={{ margin: '0 0 0.25rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#667085' }}>
        {DIMENSION_LABELS.edgeType}
        <span style={{ fontWeight: 400, marginLeft: '0.375rem' }}>({values.length})</span>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', borderBottom: '1px solid #f2f4f7', paddingBottom: '0.25rem', marginBottom: '0.25rem' }}>
        <input type="checkbox" id="gf-all-edgeType" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
        <label htmlFor="gf-all-edgeType" style={{ ...labelStyle, fontWeight: 600 }}>All</label>
        <span style={countStyle}>{values.length}</span>
      </div>
      {needsScroll && (
        <input
          type="search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search Edge Type"
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', padding: '0.3rem 0.5rem', borderRadius: 5, border: '1px solid #d0d5dd', fontSize: '0.75rem', marginBottom: '0.25rem' }}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', ...(needsScroll ? { maxHeight: 160, overflowY: 'auto', paddingRight: '0.25rem' } : {}) }}>
        {displayed.length === 0 && search.length > 0 && (
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#98a2b3', fontStyle: 'italic' }}>No matches</p>
        )}
        {displayed.map((val) => (
          <div key={val} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <input type="checkbox" id={`gf-edgeType-${val}`} checked={checked.has(val)} onChange={(e) => toggleValue(val, e.target.checked)} style={{ flexShrink: 0 }} />
            <label htmlFor={`gf-edgeType-${val}`} style={labelStyle} title={val}>{val}</label>
            <span style={countStyle}>{counts.get(val) ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
