// A run while it runs: its live feed (the agent's text, thinking, each tool call with
// its input and result, file diffs as they're written, console messages) over SSE from
// the instance's own server, and, for the owner, the console: a message for the agent
// (held until its current turn ends) and Stop. Everything arrives redacted and capped.
import { useEffect, useRef, useState } from 'react';
import { api, apiPath, token } from '../api';
import { Loading, StatusMark, ToolRow } from './patterns';
import { ago, Badge, Button, Card, cx, EST_NOTE, estUsd } from './ui';

export type FeedItem = { seq: number; at: string } & (
  | { kind: 'start'; run: string; issue: number | null; role: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; tool: string; input: string }
  | { kind: 'tool_result'; id: string; status: 'ok' | 'error'; output: string }
  | { kind: 'diff'; id: string; tool: string; file: string; diff: string }
  | { kind: 'message'; id: string; state: 'queued' | 'delivered' | 'dropped'; text?: string }
  | { kind: 'truncated'; why: 'bytes' | 'lines' }
  | { kind: 'end'; reason: string; costUsd: number; turns: number }
);

export interface ConsoleData {
  owner: string;
  canControl: boolean;
  live: boolean;
  pending: { id: string; text: string; by: string; at: string }[];
  held: { at: string; id: string | null; text: string | null }[];
  events: { at: string; type: string; id: string | null; by: string | null; text: string | null; why: string | null }[];
}

const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);
/** A tool input as one line: a shell command or a file path when it has one, else the JSON. */
const inputLine = (tool: string, input: string) => {
  try {
    const j = JSON.parse(input) as Record<string, unknown>;
    const v = j.command ?? j.file_path ?? j.notebook_path ?? j.pattern ?? j.path ?? j.url;
    if (typeof v === 'string') return v;
  } catch {
    // a capped input isn't whole JSON: show it as it is
  }
  return input || tool;
};

/** The live runs (GET /api/live), for linking each running agent to its live view. */
export interface LiveList {
  canControl: boolean;
  runs: { run: string; issue: number | null; role: string; model: string; startedAt: string; pending: unknown[] }[];
}

/** The live run a running agent (issue and role) is, if the coordinator lists it. */
export const liveRunFor = (r: { issue: number; role: string }, live: LiveList | null | undefined) => live?.runs.find((x) => x.issue === r.issue && x.role === r.role)?.run ?? null;

/** A diff's lines, + green and - red, the rest quiet. */
function Diff({ file, tool, diff }: { file: string; tool: string; diff: string }) {
  return (
    <div className="overflow-hidden rounded-control bg-surface shadow-hairline" data-testid="live-diff">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 font-mono text-[11.5px]">
        <span className="text-ink-3">{tool}</span>
        <span className="min-w-0 truncate text-ink">{file}</span>
      </div>
      <pre className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[1.7]">
        {diff.split('\n').map((l, i) => (
          <div key={i} className={cx('px-2.5 whitespace-pre-wrap', /^(\+\+\+|---|@@)/.test(l) ? 'text-ink-3' : l.startsWith('+') ? 'bg-green-tint text-green' : l.startsWith('-') ? 'bg-red-tint text-red' : 'text-ink-2')}>
            {l || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** The feed, oldest first (also what the render checks render). A tool's result is shown on its call. */
export function LiveFeedView({ items, ended }: { items: FeedItem[]; ended: boolean }) {
  const results = new Map<string, Extract<FeedItem, { kind: 'tool_result' }>>();
  for (const it of items) if (it.kind === 'tool_result') results.set(it.id, it);
  const end = items.find((i): i is Extract<FeedItem, { kind: 'end' }> => i.kind === 'end');
  return (
    <div className="space-y-2" data-testid="live-feed" aria-live="polite">
      {items.map((it) => {
        switch (it.kind) {
          case 'start':
            return (
              <div key={it.seq} className="text-[12px] text-ink-3">
                {it.role} started on {it.model} · {ago(it.at)}
              </div>
            );
          case 'text':
            return (
              <div key={it.seq} className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink" data-testid="live-text">
                {it.text}
              </div>
            );
          case 'thinking':
            return (
              <details key={it.seq} className="rounded-control bg-inset px-2.5 py-1.5 shadow-hairline" data-testid="live-thinking">
                <summary className="cursor-pointer text-[12px] font-medium text-ink-3">Thinking</summary>
                <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{it.text}</div>
              </details>
            );
          case 'tool': {
            const r = results.get(it.id);
            return (
              <div key={it.seq} data-testid="live-tool" data-tool={it.tool}>
                <ToolRow
                  icon={WRITE.has(it.tool) ? 'write' : READ.has(it.tool) ? 'read' : 'run'}
                  label={it.tool}
                  chip={inputLine(it.tool, it.input)}
                  end={r ? <Badge tone={r.status === 'ok' ? 'ok' : 'danger'}>{r.status}</Badge> : !ended ? <Badge tone="info">running</Badge> : undefined}
                  detail={[it.input && inputLine(it.tool, it.input) !== it.input ? `input: ${it.input}` : '', r?.output ?? ''].filter(Boolean).join('\n\n') || undefined}
                />
              </div>
            );
          }
          case 'diff':
            return <Diff key={it.seq} file={it.file} tool={it.tool} diff={it.diff} />;
          case 'message':
            return (
              <div key={it.seq} className="flex justify-end" data-testid="live-message" data-state={it.state}>
                <div className="max-w-[80%] rounded-card bg-blue-tint px-3 py-2 text-[13px] text-ink">
                  {it.text && <div className="whitespace-pre-wrap">{it.text}</div>}
                  <div className="mt-1 text-[11.5px] text-ink-3">{it.state === 'queued' ? 'your message: held until the current turn ends' : it.state === 'delivered' ? 'your message: delivered' : 'your message: dropped, the run ended first'}</div>
                </div>
              </div>
            );
          case 'truncated':
            return (
              <div key={it.seq} className="rounded-control bg-orange-tint px-2.5 py-1.5 text-[12px] text-orange" data-testid="live-truncated">
                The feed reached its {it.why === 'bytes' ? 'size' : 'line'} cap: nothing more is shown until the run ends.
              </div>
            );
          default:
            return null;
        }
      })}
      {end ? (
        <Card className="primitive-card-pad flex items-center gap-2 text-[12.5px]" data-testid="live-end">
          <StatusMark state={end.reason === 'succeeded' ? 'done' : 'failed'} />
          <span className="font-medium text-ink">Run ended: {end.reason}</span>
          <span className="text-ink-3">
            {end.turns} turn(s) · <span title={EST_NOTE}>{estUsd(end.costUsd)}</span>
          </span>
        </Card>
      ) : (
        !ended && (
          <div className="flex items-center gap-2" data-testid="live-working">
            <StatusMark state="running" />
            <span className="shimmer-text text-[13px] font-medium">Working…</span>
          </div>
        )
      )}
    </div>
  );
}

/** The owner's console for a live run: a message (held until the turn ends) and Stop, with a confirm step. */
export function ConsolePanel({ data, run, onChange = () => {} }: { data: ConsoleData; run: string; onChange?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const post = async (what: 'message' | 'stop', body: object) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/runs/${encodeURIComponent(run)}/${what}`, { method: 'POST', body: JSON.stringify(body) });
      setMsg({ ok: true, text: what === 'message' ? 'sent: it reaches the agent when its current turn ends' : 'stop requested: the coordinator stops it within seconds' });
      if (what === 'message') setText('');
      setConfirmStop(false);
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  if (!data.canControl) {
    return (
      <div className="rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink-2 shadow-hairline" data-testid="console-read-only">
        Only the owner, @{data.owner}, can message or stop this run.
      </div>
    );
  }
  if (!data.live) return null;
  const held = data.pending.length ? data.pending : data.held.map((h) => ({ id: h.id ?? '', text: h.text ?? '', by: '', at: h.at }));
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card" data-testid="console-panel">
      <div className="primitive-card-pad space-y-2">
        <div className="text-[13px] font-medium text-ink">Message the agent</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="It's held until the agent's current turn ends, then given to it as your next message."
          className="block w-full resize-y rounded-control bg-field px-2.5 py-2 text-[13px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--blue)]"
          data-testid="console-input"
        />
        {!!held.length && (
          <ul className="space-y-1" data-testid="console-pending">
            {held.map((h, i) => (
              <li key={h.id || i} className="flex items-start gap-2 rounded-control bg-inset px-2.5 py-1.5 text-[12.5px] shadow-hairline" data-testid="console-pending-item">
                <Badge tone="info">held</Badge>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-ink-2">{h.text}</span>
                <span className="shrink-0 text-[11.5px] text-ink-3">{ago(h.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="primitive-card-footer flex flex-wrap items-center gap-2 border-t border-line">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void post('message', { text })} data-testid="console-send">
          Send
        </Button>
        {confirmStop ? (
          <span className="flex items-center gap-1.5" data-testid="console-stop-review">
            <span className="text-[12px] text-ink-2">Stop this run? Its task is blocked, saying you stopped it.</span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void post('stop', {})} data-testid="console-stop-confirm">
              Stop the run
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmStop(false)} data-testid="console-stop-cancel">
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmStop(true)} className="ml-auto" data-testid="console-stop">
            Stop…
          </Button>
        )}
        {msg && (
          <span className={cx('w-full text-[12px]', msg.ok ? 'text-green' : 'text-red')} data-testid="console-message">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/** Follows a run's feed over SSE until it ends; the console's state is re-read as messages move. */
export function LiveRun({ run, onEnded }: { run: string; onEnded: () => void }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [con, setCon] = useState<ConsoleData | null>(null);
  const ref = useRef(onEnded);
  ref.current = onEnded;
  const loadConsole = () =>
    api<ConsoleData>(`/api/runs/${encodeURIComponent(run)}/console`)
      .then(setCon)
      .catch(() => {});
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    void loadConsole();
    // The first read says why, when the live view isn't this user's (owner only) or there's no such run.
    void api<{ items: FeedItem[] }>(`/api/runs/${encodeURIComponent(run)}/feed?after=-1`)
      .then(() => apiPath(`/api/runs/${encodeURIComponent(run)}/live`))
      .then((p) => {
        if (closed) return;
        es = new EventSource(`${p}?t=${encodeURIComponent(token)}`);
        es.addEventListener('item', (e) => {
          const it = JSON.parse((e as MessageEvent).data as string) as FeedItem;
          setItems((xs) => (xs.some((x) => x.seq === it.seq) ? xs : [...xs, it]));
          if (it.kind === 'message') void loadConsole();
        });
        es.addEventListener('end', () => {
          setEnded(true);
          es?.close();
          ref.current();
        });
      })
      .catch((e: Error) => setError(e.message));
    const t = setInterval(() => void loadConsole(), 5_000);
    return () => {
      closed = true;
      es?.close();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  if (error) return <Card className="p-4 text-[13px] text-ink-2" data-testid="live-unavailable">{error}</Card>;
  return (
    <div className="space-y-4" data-testid="live-run">
      {con && <ConsolePanel data={con} run={run} onChange={() => void loadConsole()} />}
      {items.length ? <LiveFeedView items={items} ended={ended} /> : <Loading label="Waiting for the run's first step…" />}
    </div>
  );
}
