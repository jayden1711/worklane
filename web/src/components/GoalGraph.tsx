// A goal's task graph on its page: each child task as a node in its state's colours, each "Depends on" as an arrow
// from the task that finishes first, in columns (layered, from src/goal-graph.ts), drawn as SVG here: no graph
// library. A node opens its PR, else its latest run, else its issue page; every link is one the dashboard already
// has (the PR's recorded URL, its own /runs and /issues routes), never one built from what someone typed.
import { useEffect, useState, type MouseEvent } from 'react';
import { api, type GoalGraph, type TaskStatus } from '../api';
import { navigate } from '../App';
import { Card, STATUS_LABEL, STATUS_TONE } from './ui';

type Node = GoalGraph['nodes'][number];

export const NODE_W = 184;
export const NODE_H = 56;
const GAP_X = 56;
const GAP_Y = 16;
const PAD = 12;
/** Room right of the last column for a cycle's loop back. */
const LOOP = 40;

/** Each state's colours: the tokens its status badge uses everywhere else. */
const TONE_COLOURS = {
  neutral: { fill: 'var(--inset)', stroke: 'var(--line-strong)', ink: 'var(--ink-2)' },
  ok: { fill: 'var(--green-tint)', stroke: 'var(--green)', ink: 'var(--green)' },
  warn: { fill: 'var(--orange-tint)', stroke: 'var(--orange)', ink: 'var(--orange)' },
  danger: { fill: 'var(--red-tint)', stroke: 'var(--red)', ink: 'var(--red)' },
  info: { fill: 'var(--blue-tint)', stroke: 'var(--blue)', ink: 'var(--blue-ink)' },
} as const;
export const nodeColours = (s: TaskStatus | null) => TONE_COLOURS[s ? STATUS_TONE[s] : 'neutral'];

/** Where a node goes: its PR, else its latest run (only for those who may read runs), else its issue page. */
export function nodeTarget(n: Node): { kind: 'pr' | 'run' | 'issue'; href: string; external: boolean; label: string } {
  if (n.pr && /^https:\/\//.test(n.pr.url)) return { kind: 'pr', href: n.pr.url, external: true, label: `PR #${n.pr.number}` };
  if (n.run) return { kind: 'run', href: `/runs/${encodeURIComponent(n.run)}`, external: false, label: 'its latest run' };
  return { kind: 'issue', href: `/issues/${n.issue}`, external: false, label: `issue #${n.issue}` };
}

/** Each node's place: its column from the server, its row ordered by where its dependencies sit (one pass). */
export function layout(g: Pick<GoalGraph, 'nodes' | 'edges'>) {
  const cols = new Map<number, Node[]>();
  for (const n of g.nodes) cols.set(n.layer, [...(cols.get(n.layer) ?? []), n]);
  const row = new Map<number, number>();
  const layers = [...cols.keys()].sort((a, b) => a - b);
  layers.forEach((l, ci) => {
    const here = cols.get(l)!;
    const key = (n: Node) => {
      const ds = g.edges.filter((e) => e.to === n.issue && row.has(e.from)).map((e) => row.get(e.from)!);
      return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : Number.MAX_SAFE_INTEGER;
    };
    if (ci > 0) here.sort((a, b) => key(a) - key(b) || a.issue - b.issue);
    here.forEach((n, r) => row.set(n.issue, r));
  });
  const colIndex = new Map(layers.map((l, i) => [l, i]));
  const pos = new Map(g.nodes.map((n) => [n.issue, { x: PAD + colIndex.get(n.layer)! * (NODE_W + GAP_X), y: PAD + row.get(n.issue)! * (NODE_H + GAP_Y) }]));
  const rows = Math.max(0, ...[...cols.values()].map((c) => c.length));
  return { pos, width: PAD * 2 + LOOP + Math.max(1, layers.length) * (NODE_W + GAP_X) - GAP_X, height: PAD * 2 + Math.max(1, rows) * (NODE_H + GAP_Y) - GAP_Y };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cycleText = (c: readonly number[]) => [...c, c[0]!].map((n) => `#${n}`).join(' → ');

export function GoalGraphView({ graph }: { graph: GoalGraph }) {
  if (!graph.split)
    return (
      <div className="p-4 text-[13px] text-ink-3" data-testid="goal-graph-empty">
        No task graph yet: no split of this goal into tasks is recorded that you can see.
      </div>
    );
  if (!graph.nodes.length)
    return (
      <div className="p-4 text-[13px] text-ink-3" data-testid="goal-graph-empty">
        This goal's split has no tasks.
      </div>
    );
  const { pos, width, height } = layout(graph);
  const open = (e: MouseEvent, t: ReturnType<typeof nodeTarget>) => {
    if (t.external || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(t.href);
  };
  return (
    <div className="space-y-2 p-3">
      {graph.cycles.length > 0 && (
        <div className="rounded-control bg-red-tint p-2.5 text-[12.5px] text-ink" role="alert" data-testid="goal-graph-cycles">
          <span className="font-medium text-red">Dependency cycle: </span>
          {graph.cycles.map((c, i) => (
            <span key={i} className="font-mono" data-testid="goal-graph-cycle">
              {i > 0 && '; '}
              {cycleText(c)}
            </span>
          ))}
          . None of these can start until someone removes one of their "Depends on" lines.
        </div>
      )}
      {graph.capped && (
        <div className="text-[12.5px] text-ink-2" data-testid="goal-graph-capped">
          Showing {graph.nodes.length} of {graph.total} tasks, the earliest columns first. The rest are on the Issues page.
        </div>
      )}
      <div className="max-w-full overflow-x-auto rounded-control bg-inset shadow-hairline" data-testid="goal-graph-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Task graph of #${graph.goal}: ${graph.nodes.length} tasks, ${graph.edges.length} dependencies`} data-testid="goal-graph-svg" className="block">
          <defs>
            <marker id="goal-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" style={{ fill: 'var(--ink-3)' }} />
            </marker>
            <marker id="goal-arrow-cycle" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" style={{ fill: 'var(--red)' }} />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            // A forward edge is a curve right; one that goes back or within a column (a cycle) loops out to the right
            // of both boxes and back, inside the graph's own margin (LOOP).
            const right = Math.max(a.x, b.x) + NODE_W + (e.from < e.to ? LOOP * 0.55 : LOOP * 0.9);
            const d = x2 > x1 ? `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}` : `M${x1},${y1 - 8} C${right},${y1 - 8} ${right},${y2 + 8} ${b.x + NODE_W},${y2 + 8}`;
            return (
              <path key={`${e.from}-${e.to}`} d={d} fill="none" strokeWidth={1.5} style={{ stroke: e.cycle ? 'var(--red)' : 'var(--ink-3)' }} strokeDasharray={e.cycle ? '4 3' : undefined} markerEnd={e.cycle ? 'url(#goal-arrow-cycle)' : 'url(#goal-arrow)'} data-testid="goal-graph-edge" data-from={e.from} data-to={e.to} data-cycle={e.cycle ? 'true' : undefined}>
                <title>{`#${e.to} depends on #${e.from}${e.cycle ? ' (on a cycle)' : ''}`}</title>
              </path>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos.get(n.issue)!;
            const c = nodeColours(n.status);
            const t = nodeTarget(n);
            const state = n.status ? STATUS_LABEL[n.status] : 'Not seen yet';
            return (
              <a
                key={n.issue}
                href={t.href}
                {...(t.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                onClick={(e) => open(e, t)}
                className="goal-node"
                aria-label={`#${n.issue} ${n.title}: ${state}${n.cycle ? ', on a dependency cycle' : ''}. Opens ${t.label}.`}
                data-testid="goal-graph-node"
                data-issue={n.issue}
                data-status={n.status ?? 'unseen'}
                data-target={t.kind}
                data-cycle={n.cycle ? 'true' : undefined}
              >
                <title>{`#${n.issue} ${n.title}`}</title>
                <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10} style={{ fill: 'var(--surface)', stroke: n.cycle ? 'var(--red)' : c.stroke }} strokeWidth={n.cycle ? 2 : 1} strokeDasharray={n.cycle ? '5 3' : undefined} />
                <rect x={p.x + 1} y={p.y + 1} width={NODE_W - 2} height={NODE_H - 2} rx={9} style={{ fill: c.fill }} />
                <text x={p.x + 10} y={p.y + 21} style={{ fill: 'var(--ink)', fontSize: 12.5, fontWeight: 500 }}>
                  <tspan style={{ fill: 'var(--ink-2)', fontFamily: 'var(--font-mono, monospace)' }}>#{n.issue}</tspan> {clip(n.title, 20)}
                </text>
                <text x={p.x + 10} y={p.y + 41} style={{ fill: c.ink, fontSize: 11.5, fontWeight: 500 }} data-testid="goal-graph-node-state">
                  {n.cycle ? `${state} · cycle` : state}
                </text>
              </a>
            );
          })}
        </svg>
      </div>
      <div className="text-[12px] text-ink-3">An arrow points from a task to the one that waits for it. A task opens its PR, else its latest run, else its issue page.</div>
    </div>
  );
}

/** The goal page's panel: fetched again whenever the event log moves. */
export function GoalGraphPanel({ issue, lastId }: { issue: number; lastId: number }) {
  const [graph, setGraph] = useState<GoalGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<GoalGraph>(`/api/goal-graph?issue=${issue}`)
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [issue, lastId]);
  return (
    <Card className="overflow-hidden" data-testid="goal-graph">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Task graph</div>
      {error ? <div className="p-4 text-[13px] text-red">{error}</div> : graph ? <GoalGraphView graph={graph} /> : <div className="p-4 text-[13px] text-ink-3">Loading…</div>}
    </Card>
  );
}
