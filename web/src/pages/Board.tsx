// The Board, the dashboard's home: every task in flight, one column per stage, for the instance selected in the
// switcher; on a hub, every instance this person has a role on only when they chose "All instances" there (each
// card then says whose it is). Each card is built by the
// instance's own server (GET /api/board, src/board.ts) from what it already recorded; nothing is fetched
// from GitHub per card. The actions on a card are the ones the server says this person's role allows there,
// and each goes to that instance's existing routes (decide, the console), which check the role again.
import { useEffect, useRef, useState } from 'react';
import { Eye, GitMerge, MessageSquare, Send, Vote } from 'lucide-react';
import { instanceStream, liveStream, onInstance, scopeNowOrNull, viewUrl, type BoardBatch, type InstanceScope, type BoardCard, type BoardColumn, type BoardData, type State } from '../api';
import { navigate } from '../App';
import type { Stream } from '../sse';
import { markUpdating, peek } from '../cache';
import { LiveFeedView, type FeedItem } from '../components/LiveRun';
import { DotPill, Loading } from '../components/patterns';
import { TestRunsPanel } from '../components/TestRuns';
import { ago, Badge, Button, cx, Empty, LevelBadge } from '../components/ui';
import { Header } from '../components/Header';

/** One instance's board as the page holds it: `name` is the hub's name for it (null on an instance's own dashboard). */
export interface InstanceBoard {
  name: string | null;
  data: BoardData | null;
  error: string | null;
}

const COLUMNS: { id: BoardColumn; label: string }[] = [
  { id: 'planning', label: 'Planning' },
  { id: 'building', label: 'Building' },
  { id: 'verifying', label: 'Verifying' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'landing', label: 'Landing' },
];

/** How long since `since`, in the largest two units. */
export function elapsed(since: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (!Number.isFinite(m)) return '–';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const cpu = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${(s / 3600).toFixed(1)}h`);

const CHECK_TONE = { failing: 'red', pending: 'orange', passing: 'green', none: 'ink' } as const;
const OUTCOME_TONE: Record<string, 'green' | 'red' | 'orange' | 'ink'> = { pass: 'green', fail: 'red', cancelled: 'red', pending: 'orange', missing: 'orange' };

/** The card's checks: one pill for the whole, expandable to each check. */
function Checks({ checks }: { checks: NonNullable<BoardCard['checks']> }) {
  if (checks.state === 'none' && !checks.items.length) return <span className="text-[11.5px] text-ink-3" data-testid="board-card-checks" data-state="none">no checks yet</span>;
  return (
    <details className="group" data-testid="board-card-checks" data-state={checks.state}>
      <summary className="cursor-pointer list-none">
        <DotPill tone={CHECK_TONE[checks.state]}>
          {checks.state === 'none' ? 'checks' : checks.state} · {checks.items.length}
        </DotPill>
      </summary>
      <ul className="mt-1.5 space-y-0.5">
        {checks.items.map((c) => (
          <li key={c.name} className="flex items-center gap-1.5 text-[11.5px]" data-testid="board-check-item">
            <span className={cx('size-1.5 shrink-0 rounded-full', { green: 'bg-green', red: 'bg-red', orange: 'bg-orange', ink: 'bg-ink-3' }[OUTCOME_TONE[c.outcome] ?? 'ink'])} />
            <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={c.name}>
              {c.name}
            </span>
            <span className="text-ink-3">{c.outcome}</span>
          </li>
        ))}
        <li className="pt-0.5 text-[11px] text-ink-3">{checks.source === 'pr' ? "the PR's required checks at its head" : "the coordinator's last check run"}</li>
      </ul>
    </details>
  );
}

/** A run's live feed (the owner and writers: the server's runs gate), over the instance's own stream until it ends. */
function WatchFeed({ instance, run }: { instance: string | null; run: string }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let es: Stream | null = null;
    let closed = false;
    void onInstance<{ items: FeedItem[] }>(instance, `/api/board/watch/${encodeURIComponent(run)}`)
      .then(() => instanceStream(instance, `/api/runs/${encodeURIComponent(run)}/live`))
      .then((u) => {
        if (closed) return;
        es = liveStream(u, {
          item: (e) => {
            const it = JSON.parse(e.data) as FeedItem;
            setItems((xs) => (xs.some((x) => x.seq === it.seq) ? xs : [...xs, it]));
          },
          end: () => {
            setEnded(true);
            es?.close();
          },
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      closed = true;
      es?.close();
    };
  }, [instance, run]);
  if (error) return <div className="text-[12px] text-ink-2">{error}</div>;
  return items.length ? <LiveFeedView items={items.slice(-40)} ended={ended} /> : <Loading label="Waiting for the run's first step…" />;
}

type Panel = 'watch' | 'steer' | 'answer' | 'approve' | null;

/** One card: what it is, how big, how long, its checks, what its run uses; and the actions this person may take. */
export function BoardCardView({ card, instance, showInstance, now, onChanged = () => {} }: { card: BoardCard; instance: string | null; showInstance: boolean; now: number; onChanged?: () => void }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const a = card.actions;
  const toggle = (p: Panel) => {
    setMsg(null);
    setPanel((x) => (x === p ? null : p));
  };
  const call = async (path: string, body: object, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await onInstance(instance, path, { method: 'POST', body: JSON.stringify(body) });
      setMsg({ ok: true, text: done });
      setText('');
      setPanel(null);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const decide = (id: string, answer: string) => call('/api/decide', { id, answer }, `answered ${answer}`);
  const usage = card.run?.usage;
  return (
    <article className="rounded-card bg-surface p-3 shadow-card" data-testid="board-card" data-instance={instance ?? card.instance} data-card-instance={card.instance} data-issue={card.issue} data-column={card.column}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3" data-testid="board-card-ref">
        {showInstance && (
          <span className="truncate font-medium text-ink-2" data-testid="board-card-instance">
            {instance ?? card.instance}
          </span>
        )}
        <button className="font-mono text-blue-ink hover:underline" onClick={() => navigate(`/issues/${card.issue}`)}>
          #{card.issue}
        </button>
        {card.pr && (
          <a href={card.pr.url} target="_blank" rel="noreferrer" className="font-mono text-blue-ink hover:underline">
            PR #{card.pr.number}
          </a>
        )}
        <span className="ml-auto flex items-center gap-1">
          {card.level && <LevelBadge level={card.level} />}
          {card.batch && (
            <span data-testid="board-card-batch" title={card.batch.id ? `PR batch ${card.batch.id}` : 'waiting for a PR batch'}>
              <Badge tone={CARD_BATCH_TONE[card.batch.status]}>{CARD_BATCH_LABEL[card.batch.status]}</Badge>
            </span>
          )}
          {card.highRisk && <Badge tone="danger">high risk</Badge>}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-ink" data-testid="board-card-title" title={card.title}>
        {card.title}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-ink-2">
        {card.diff !== undefined && (
        <span data-testid="board-card-diff" title={card.diff ? `${card.diff.files} file(s), from ${card.diff.source === 'pr' ? 'the PR' : 'the last proposed change'}` : 'no change yet'}>
          {card.diff ? (
            card.diff.added !== null && card.diff.removed !== null ? (
              <>
                <span className="text-green">+{card.diff.added}</span> <span className="text-red">−{card.diff.removed}</span>
              </>
            ) : (
              `±${card.diff.lines}`
            )
          ) : (
            <span className="text-ink-3">no diff</span>
          )}
        </span>
        )}
        {card.comments !== undefined && (
        <span data-testid="board-card-comments" className="inline-flex items-center gap-1" title={card.comments === null ? 'no PR comments recorded' : 'comments and review comments on the PR'}>
          <MessageSquare className="size-3" /> {card.comments ?? '–'}
        </span>
        )}
        <span data-testid="board-card-elapsed" title={`started ${new Date(card.startedAt).toLocaleString()}; in this state since ${new Date(card.since).toLocaleString()}`}>
          {elapsed(card.startedAt, now)}
        </span>
        {card.checks && <Checks checks={card.checks} />}
      </div>
      {card.run && (
        <div className="mt-2 rounded-control bg-inset px-2 py-1.5 text-[11.5px] text-ink-2 shadow-hairline" data-testid="board-card-run">
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue" />
            <span className="font-medium text-ink">{card.run.role}</span>
            <span className="text-ink-3">{card.run.model}</span>
            <span className="ml-auto text-ink-3">{elapsed(card.run.startedAt, now)}</span>
          </div>
          <div className="mt-0.5 tabular-nums" data-testid="board-card-usage">
            {usage ? `${mb(usage.rssBytes)} memory · ${cpu(usage.cpuSeconds)} CPU · ${usage.processes} process${usage.processes === 1 ? '' : 'es'}` : 'resource use not measured here'}
          </div>
          {card.run.note && <div className="mt-0.5 truncate text-ink-3" title={card.run.note}>{card.run.note}</div>}
        </div>
      )}
      {card.waiting && (
        <div className="mt-2 text-[11.5px] text-orange" data-testid="board-card-wait" title={card.waiting.detail ?? undefined}>
          {card.waiting.label} · {elapsed(card.waiting.since, now)}
          {card.waiting.detail && <div className="mt-0.5 line-clamp-2 text-ink-2">{card.waiting.detail}</div>}
        </div>
      )}
      {(a.watch || a.steer || a.answer || a.approve) && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="board-card-actions">
          {a.watch && (
            <Button size="sm" variant={panel === 'watch' ? 'default' : 'outline'} onClick={() => toggle('watch')} data-testid="board-watch" data-mode={a.watch}>
              <Eye className="size-3.5" /> Watch
            </Button>
          )}
          {a.steer && (
            <Button size="sm" variant={panel === 'steer' ? 'default' : 'outline'} onClick={() => toggle('steer')} data-testid="board-steer">
              <Send className="size-3.5" /> Steer
            </Button>
          )}
          {a.answer && (
            <Button size="sm" variant={panel === 'answer' ? 'default' : 'outline'} onClick={() => toggle('answer')} data-testid="board-answer">
              <Vote className="size-3.5" /> Answer
            </Button>
          )}
          {a.approve &&
            ('merge' in a.approve ? (
              <a href={a.approve.merge} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="board-merge">
                <GitMerge className="size-3.5" /> Merge on GitHub
              </a>
            ) : (
              <Button size="sm" variant={panel === 'approve' ? 'default' : 'outline'} onClick={() => toggle('approve')} data-testid="board-approve">
                <GitMerge className="size-3.5" /> Approve…
              </Button>
            ))}
        </div>
      )}
      {panel === 'watch' && card.run?.live && (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-control bg-page p-2 shadow-hairline" data-testid="board-watch-panel">
          <WatchFeed instance={instance} run={card.run.live} />
        </div>
      )}
      {panel === 'steer' && card.run?.live && (
        <div className="mt-2 space-y-1.5" data-testid="board-steer-panel">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="Held until the agent's current turn ends, then given to it."
            className="block w-full resize-y rounded-control bg-field px-2 py-1.5 text-[12.5px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--blue)]"
            data-testid="board-steer-input"
          />
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void call(`/api/runs/${encodeURIComponent(card.run!.live!)}/message`, { text }, 'sent: it reaches the agent when its current turn ends')} data-testid="board-steer-send">
            Send
          </Button>
        </div>
      )}
      {panel === 'answer' && card.decision && (
        <div className="mt-2 space-y-1.5" data-testid="board-answer-panel">
          <div className="text-[12px] leading-snug text-ink-2">{card.decision.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {card.decision.options.map((o) => (
              <Button key={o} type="button" size="sm" variant={o === card.decision!.recommendation ? 'default' : 'outline'} disabled={busy} onClick={() => void decide(card.decision!.id, o)} data-testid="board-answer-option" data-option={o}>
                {o}
              </Button>
            ))}
          </div>
        </div>
      )}
      {panel === 'approve' && a.approve && 'decision' in a.approve && (
        <div className="mt-2 space-y-1.5" data-testid="board-approve-panel">
          <div className="text-[12px] leading-snug text-ink-2">{card.decision?.question ?? `Approve landing #${card.issue}?`}</div>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void decide((a.approve as { decision: string }).decision, 'approve')} data-testid="board-approve-confirm">
              Approve and land
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPanel(null)} data-testid="board-approve-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <div className={cx('mt-1.5 text-[11.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="board-card-message">
          {msg.text}
        </div>
      )}
    </article>
  );
}

const CARD_BATCH_LABEL: Record<NonNullable<BoardCard['batch']>['status'], string> = { queued: 'batch queued', testing: 'in batch', passed: 'batch passed', returned: 'batch failed' };
const CARD_BATCH_TONE: Record<NonNullable<BoardCard['batch']>['status'], 'ok' | 'danger' | 'info' | 'neutral'> = { queued: 'neutral', testing: 'info', passed: 'ok', returned: 'danger' };
const BATCH_TONE: Record<BoardBatch['status'], 'ok' | 'danger' | 'warn' | 'info' | 'neutral'> = { testing: 'info', bisecting: 'warn', green: 'ok', red: 'danger', abandoned: 'warn', empty: 'neutral' };

/** The Landing column's PR batches: what is being tested now and how the last ones went (a viewer's without detail). */
function BatchStrip({ batches }: { batches: BoardBatch[] }) {
  if (!batches.length) return null;
  return (
    <ul className="space-y-1 rounded-card bg-surface p-2 shadow-card" data-testid="board-batches" aria-label="PR batches">
      {batches.map((b, i) => (
        <li key={`${i}:${b.id}`} className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-2" data-testid="board-batch" data-status={b.status} title={b.detail || undefined}>
          <Badge tone={BATCH_TONE[b.status]}>{b.status}</Badge>
          <span className="truncate font-mono">{b.prs.map((n) => `#${n}`).join(' ')}</span>
        </li>
      ))}
    </ul>
  );
}

/** How many cards a column shows before its "Show more" (oldest first, so what has waited longest is always shown). */
export const COLUMN_CARDS = 30;

/** The board from its data (also what the render checks render): the boards in scope, then a column per stage. Several boards: "All instances", each card labelled. */
export function BoardView({ boards, now = Date.now(), onChanged = () => {} }: { boards: InstanceBoard[]; now?: number; onChanged?: () => void }) {
  const several = boards.length > 1;
  const cards = boards.flatMap((b) => (b.data ? b.data.cards.map((c) => ({ card: c, instance: b.name })) : []));
  const batches = boards.flatMap((b) => b.data?.batches ?? []);
  const failed = boards.filter((b) => b.error);
  const slots = boards.find((b) => b.data)?.data?.slots;
  // Columns shown whole (the rest show their first COLUMN_CARDS: a busy instance's hundreds of waiting cards made
  // every switch to the Board build them all, about 200 ms).
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="space-y-4 p-6" data-testid="board">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] text-ink-2" data-testid="board-scope" data-scope={several ? 'all' : (boards[0]?.name ?? boards[0]?.data?.instance ?? '')}>
          {several ? (
            <>
              <span className="font-medium text-ink">All instances</span> ({boards.length}): {boards.map((b) => b.name).join(', ')}
            </>
          ) : (
            <>
              Instance: <span className="font-medium text-ink">{boards[0]?.name ?? boards[0]?.data?.instance ?? '…'}</span>
            </>
          )}
        </span>
        <span className="text-[12px] text-ink-3">
          {cards.length} in flight
          {slots ? ` · ${slots.running} of ${slots.cap} agent slots in use on this machine` : ''}
        </span>
      </div>
      {failed.map((b) => (
        <div key={b.name ?? ''} className="text-[12.5px] text-red" data-testid="board-instance-error">
          {b.name ? `${b.name}: ` : ''}can't load its board: {b.error}
        </div>
      ))}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const these = cards.filter((x) => x.card.column === col.id);
          return (
            <section key={col.id} className="flex min-w-0 flex-col gap-2 rounded-card bg-canvas p-2" aria-label={col.label} data-testid="board-column" data-column={col.id}>
              <div className="flex items-center gap-2 px-1 pt-0.5">
                <span className="text-[12.5px] font-medium text-ink">{col.label}</span>
                <span className={cx('text-[11.5px] tabular-nums', col.id === 'waiting' && these.length ? 'font-medium text-orange' : 'text-ink-3')}>{these.length}</span>
              </div>
              {col.id === 'landing' && <BatchStrip batches={batches} />}
              {these.length ? (
                <>
                  {(whole.has(col.id) ? these : these.slice(0, COLUMN_CARDS)).map((x) => (
                    <BoardCardView key={`${x.card.instance}:${x.card.issue}`} card={x.card} instance={x.instance} showInstance={several} now={now} onChanged={onChanged} />
                  ))}
                  {!whole.has(col.id) && these.length > COLUMN_CARDS && (
                    <button type="button" data-testid="board-column-more" onClick={() => setWhole((w) => new Set(w).add(col.id))} className="rounded-control px-1 py-1 text-left text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
                      Show {these.length - COLUMN_CARDS} more
                    </button>
                  )}
                </>
              ) : (
                <div className="px-1 pb-1 text-[11.5px] text-ink-3">Nothing here.</div>
              )}
            </section>
          );
        })}
      </div>
      {!cards.length && !failed.length && <Empty title="Nothing in flight" hint="Tasks appear here from the moment they're ready until they land." />}
    </div>
  );
}

/** The boards in a scope: the selected instance's only, or each instance's when "All instances" is chosen; never any other. */
export function loadBoards(scope: InstanceScope, get: <T>(instance: string | null, path: string) => Promise<T> = onInstance): Promise<InstanceBoard[]> {
  return Promise.all(scope.instances.map((n) => get<BoardData>(n, '/api/board').then((data) => ({ name: n, data, error: null }), (e: Error) => ({ name: n, data: null, error: e.message }))));
}

/** What was kept of each board in this scope (web/src/cache.ts), when every one of them was; else null (never half a scope). */
export function keptBoards(scope: InstanceScope): InstanceBoard[] | null {
  const out: InstanceBoard[] = [];
  for (const name of scope.instances) {
    const k = peek<BoardData>(viewUrl('/api/board', name));
    if (!k) return null;
    out.push({ name, data: k.data, error: null });
  }
  return out;
}

/** The selected instance's board (every instance's this person can see, labelled, when they chose All instances), refreshed live. */
export function BoardPage({ state, pulse }: { state: State; pulse: number }) {
  // The scope: the switcher's choice (the selected instance, or All instances), or this page's own server. Fixed for
  // this page's life: the Dashboard is keyed on it, so a switch mounts a new one.
  const scope = scopeNowOrNull();
  // Shown at once from what was kept for this scope, marked "updating…" until the first fresh answer.
  const [boards, setBoards] = useState<InstanceBoard[] | null>(() => (scope ? keptBoards(scope) : null));
  const fromKept = useRef(boards !== null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (scope === null) return;
    let live = true;
    const unmark = fromKept.current ? markUpdating() : () => {};
    fromKept.current = false;
    void loadBoards(scope)
      .then((b) => live && setBoards(b))
      .finally(unmark);
    return () => {
      live = false;
      unmark();
    };
  }, [scope, tick, pulse]);

  // Live: the page's own stream (pulse) covers the selected instance; with All instances, each other one gets its own stream.
  // Elapsed times and resource use are refreshed every 15 s besides.
  useEffect(() => {
    const streams: Stream[] = [];
    let closed = false;
    let timer: number | undefined;
    void (async () => {
      if (!scope) return;
      for (const name of scope.instances) {
        if (closed || name === null || name === scope.current) continue;
        const path = await instanceStream(name, '/api/stream');
        if (closed) return;
        streams.push(
          liveStream(path, {
            change: () => {
              window.clearTimeout(timer);
              timer = window.setTimeout(() => setTick((t) => t + 1), 200);
            },
          }),
        );
      }
    })();
    const t = setInterval(() => {
      setNow(Date.now());
      setTick((x) => x + 1);
    }, 15_000);
    return () => {
      closed = true;
      for (const es of streams) es.close();
      clearInterval(t);
      window.clearTimeout(timer);
    };
  }, [scope]);

  return (
    <div data-testid="page-board">
      <Header title="Board" sub={`every task in flight, by stage · ${state.project.repo}`} />
      {boards ? <BoardView boards={boards} now={now} onChanged={() => setTick((t) => t + 1)} /> : <Loading />}
      {boards ? <BoardTestRuns boards={boards} pulse={tick + pulse} /> : null}
    </div>
  );
}

/** The test runs of the boards in scope (the queue, the slots running and each run's tiers); labelled when there are several. */
export function BoardTestRuns({ boards, pulse = 0 }: { boards: InstanceBoard[]; pulse?: number }) {
  return (
    <div className="space-y-4 px-6 pb-6" data-testid="board-test-runs">
      {boards.map((b) => (
        <div key={b.name ?? ''} className="space-y-1" data-testid="board-test-runs-instance" data-instance={b.name ?? ''}>
          {b.name && boards.length > 1 ? <div className="text-[12px] text-ink-3">{b.name}</div> : null}
          <TestRunsPanel instance={b.name} pulse={pulse} compact />
        </div>
      ))}
    </div>
  );
}
