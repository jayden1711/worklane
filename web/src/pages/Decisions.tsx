import { useEffect, useMemo, useState } from 'react';
import { decide, type Decision, type State } from '../api';
import { navigate, pageKey, typing } from '../App';
import { ValuePill } from '../components/patterns';
import { ago, Avatar, Badge, Button, cx, Empty, Kbd } from '../components/ui';
import { Header } from './Overview';

/**
 * A decision as an approval card (Beautiful UI's approval and recommendation cards):
 * the question is the heading, the recommendation is called out, the receipts sit in
 * an inset list, and each option is a row; picking one answers it. Only the
 * decision's owner or a writer gets the rows (canAnswer); everyone else sees whom it waits on.
 */
export function DecisionCard({ d, selected, onAnswered, proposed }: { d: Decision; selected: boolean; onAnswered?: () => void; proposed?: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (a: string) => {
    setBusy(a);
    setErr(null);
    try {
      await decide(d.id, a);
      onAnswered?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  // Only the option the recommendation names; a free-text recommendation (in its pill above) marks none.
  const recommended = (o: string) => o === d.recommendation;
  const receipts = d.receipts.filter(Boolean);
  return (
    <div id={d.id} className={cx('overflow-hidden rounded-card bg-surface shadow-card transition-shadow', selected && 'ring-2 ring-blue')} data-decision={d.id} data-testid="decision-card" style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <div className="primitive-card-pad">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <Avatar login={d.owner} size={18} />
          {d.issue !== null && (
            <button className="font-mono text-blue-ink hover:underline" onClick={() => navigate(`/issues/${d.issue}`)}>
              #{d.issue}
            </button>
          )}
          <Badge tone={d.kind === 'land' ? 'danger' : 'warn'}>{d.kind === 'land' ? 'Approve landing' : 'Question'}</Badge>
          <span>for @{d.owner}</span>
          <span>· asked {ago(d.askedAt)}</span>
        </div>
        <div className="mt-2 text-[14px] font-medium text-ink">{d.question}</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Recommended: <ValuePill>{d.recommendation}</ValuePill>
        </p>
        {!!receipts.length && (
          <ul className="mt-2.5 space-y-1 rounded-control bg-inset px-2.5 py-2 text-[12px] text-ink-2 shadow-hairline">
            {receipts.map((r, i) => (
              <li key={i} className="truncate" title={r}>
                {r}
              </li>
            ))}
          </ul>
        )}
        {!d.answer && d.canAnswer !== false && (
          // Each option is an action: one click answers. The recommended one is the dark primary pill,
          // destructive ones (reject, close) are red, the rest raised; each carries its key.
          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Answer">
            {d.options.map((o, i) => (
              <Button key={o} type="button" size="sm" data-option={o} data-testid="decision-option" variant={recommended(o) ? 'default' : /reject|close/.test(o) ? 'danger' : 'outline'} disabled={!!busy} onClick={() => void answer(o)} title={recommended(o) ? 'recommended' : undefined}>
                {busy === o ? `${o}…` : o}
                {proposed === o && (
                  <span className="rounded-full bg-blue-tint px-1.5 text-[10.5px] font-medium text-blue-ink" data-testid="decision-proposed">
                    chat proposed
                  </span>
                )}
                <span className={cx('inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 font-mono text-[10px]', recommended(o) ? 'bg-surface/20 text-surface' : 'bg-inset text-ink-3 shadow-hairline')}>{i + 1}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="primitive-card-footer flex min-h-10 items-center gap-2 border-t border-line text-[12px]">
        {d.answer ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pr-2.5 pl-1 font-medium text-green">
            <span className="flex size-4.5 items-center justify-center rounded-full bg-green text-white">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
            Answered {d.answer.answer} by @{d.answer.by} {ago(d.answer.at)}
          </span>
        ) : d.canAnswer === false ? (
          <span className="text-ink-3">Waiting on @{d.owner}; only they or one of the project's writers can answer it.</span>
        ) : (
          <span className="text-ink-3">Click an option to answer; the coordinator acts on its next tick.</span>
        )}
        {err && <span className="ml-auto text-red">{err}</span>}
      </div>
    </div>
  );
}

export function Decisions({ state }: { state: State }) {
  const [showAnswered, setShowAnswered] = useState(false);
  const open = useMemo(() => state.decisions.filter((d) => !d.answer), [state.decisions]);
  const list = showAnswered ? state.decisions : open;
  const [sel, setSel] = useState(0);
  // An answer the chat proposed for the decision in the address: marked on its option, never sent by itself.
  const proposed = useMemo(() => new URLSearchParams(window.location.search).get('proposed'), []);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const i = hash ? list.findIndex((d) => d.id === hash) : -1;
    if (i >= 0) setSel(i);
  }, [list]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!pageKey(e)) return;
      const cur = list[sel];
      if (e.key === 'j') setSel((s) => Math.min(list.length - 1, s + 1));
      else if (e.key === 'k') setSel((s) => Math.max(0, s - 1));
      else if (cur && (cur.answer || cur.canAnswer === false) && (/^[1-9]$/.test(e.key) || e.key === 'a' || e.key === 'r')) return;
      else if (cur && !cur.answer && /^[1-9]$/.test(e.key)) {
        const o = cur.options[Number(e.key) - 1];
        if (o) void decide(cur.id, o);
      } else if (cur && !cur.answer && (e.key === 'a' || e.key === 'r')) {
        const o = cur.options.find((x) => (e.key === 'a' ? /approve/.test(x) : /reject|close/.test(x)));
        if (o) void decide(cur.id, o);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [list, sel]);

  useEffect(() => {
    document.querySelector(`[data-decision="${list[sel]?.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, list]);

  return (
    <div data-testid="page-decisions">
      <Header title="Decisions" sub={`${open.length} waiting`}>
        <span className="hidden items-center gap-1 text-[12px] text-ink-3 md:flex">
          <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>1-9</Kbd> answer · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowAnswered((v) => !v)} data-testid="show-answered">
          {showAnswered ? 'Hide answered' : 'Show answered'}
        </Button>
      </Header>
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        {list.length ? list.map((d, i) => <DecisionCard key={d.id} d={d} selected={i === sel} proposed={d.id === window.location.hash.slice(1) ? proposed : null} />) : <Empty title="Nothing to decide" hint="When a change needs your approval, or an agent asks a real question, it shows up here and in your Inbox." />}
      </div>
    </div>
  );
}
