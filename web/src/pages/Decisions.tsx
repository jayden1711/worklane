import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { api, decide, type Decision, type DecisionDetail, type State } from '../api';
import { navigate, pageKey, typing } from '../App';
import { useEntrance } from '../components/patterns';
import { ago, Avatar, Badge, Button, cx, decisionWork, Empty, Kbd, Why } from '../components/ui';
import { Header } from '../components/Header';
import { useArrivalOrder } from '../arrival-order';

/** The detail line that carries a recommendation's reasoning: src/decision-ask.ts writes it (a test keeps the two equal). */
export const RECOMMENDATION_PREFIX = 'Recommendation: ';

/** Past about this many characters a recommendation fills four lines of a card: it starts clamped (then measured). */
const CLAMP_FROM = 280;

/** What each review level means for the owner (docs/design.md, review levels), said wherever a level is shown. */
export const LEVEL_MEANING: Record<string, string> = { L0: 'lands once its checks pass', L1: 'lands once the evaluator agrees', L2: 'lands, and you are told', L3: 'waits for you' };

/** The plain meaning of a term an owner may not know: a review level, done_when, a question number. Null for any other. */
export function termMeaning(term: string): string | null {
  if (LEVEL_MEANING[term]) return LEVEL_MEANING[term]!;
  if (term === 'done_when') return 'the checks that decide it is done';
  const q = /^Q(\d+)$/.exec(term);
  return q ? `question ${q[1]}` : null;
}

const TERM = /\b(?:L[0-3]|done_when|Q\d+)\b/g;

/**
 * Text with each such term followed by its plain meaning ("(L3)" becomes "(L3: waits for you)", "done_when" becomes
 * "done_when (the checks that decide it is done)"), unless the text already says it there. A card's lines go through
 * it; Details keeps the exact words.
 */
export function plainTerms(text: string): string {
  return text.replace(TERM, (term: string, at: number, all: string) => {
    const meaning = termMeaning(term)!;
    const after = all.slice(at + term.length);
    if (after.startsWith(`: ${meaning}`) || after.startsWith(` (${meaning})`)) return term;
    return after.startsWith(')') ? `${term}: ${meaning}` : `${term} (${meaning})`;
  });
}

/** The impact flags' names. */
export const FLAG_LABEL = { 'money-path': 'Money path', auth: 'Auth', secrets: 'Secrets' } as const;

/**
 * A recommendation that is prose, not an option: wrapped, whole, clamped to four lines by CSS (never cut in the
 * string, so never mid-word), with Show more / Show less once it runs past them.
 */
export function RecommendationText({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  // Before the page measures it (or where it can't), a long text is taken to run past four lines.
  const [overflows, setOverflows] = useState(text.length > CLAMP_FROM);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className="mt-1.5" data-testid="decision-recommendation">
      <p ref={ref} className={cx('whitespace-pre-line break-words text-[13px] leading-relaxed text-ink-2', !open && 'line-clamp-4')} data-testid="decision-recommendation-text">
        <span className="font-medium text-ink">{label}</span> {text}
      </p>
      {(overflows || open) && (
        <button type="button" className="mt-0.5 text-[12px] font-medium text-blue-ink hover:underline" aria-expanded={open} data-testid="decision-recommendation-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** Answering a decision: the option on its way (`sending`: one already on its way when it draws), and an error. */
export function useAnswer(id: string, onAnswered?: () => void, sending: string | null = null) {
  const [busy, setBusy] = useState<string | null>(sending);
  const [err, setErr] = useState<string | null>(null);
  const savingId = useId();
  const answer = async (o: string) => {
    setBusy(o);
    setErr(null);
    try {
      await decide(id, o);
      onAnswered?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, err, savingId, answer };
}

/** A decision's prose: a free-text recommendation (an older event's), then the reasoning its detail lines carry. */
export const proseOf = (recommendation: string, options: readonly string[], receipts: readonly string[]): string[] => [
  ...(!options.includes(recommendation) && recommendation.trim() ? [recommendation.trim()] : []),
  ...receipts.filter((r) => r.startsWith(RECOMMENDATION_PREFIX)).map((r) => r.slice(RECOMMENDATION_PREFIX.length)),
];

/**
 * A decision's three lines, in this order, then its reasoning: (1) what happened; (2) the recommended option, by
 * name (or the recommendation in words, when it isn't an option); (3) each option once, with what it does: a button
 * where this person may answer (the recommended one the dark primary), its name otherwise. The decision card and the
 * detail page both draw it; `testId` is the option buttons'. `kind`: the decision's kind; its approve option says,
 * while paused, what approving does (decisionWork: a landing lands now, an intake files now, a plan waits).
 */
export function DecisionLines({ happened, recommendation, prose, options, answerable, ans, proposed = null, keys = false, testId, kind = null }: {
  happened: string;
  recommendation: string;
  prose: string[];
  options: { option: string; does?: string | undefined; cannot?: string | undefined }[];
  answerable: boolean;
  ans: { busy: string | null; savingId: string; answer: (o: string) => Promise<void> };
  proposed?: string | null;
  keys?: boolean;
  testId: string;
  kind?: string | null;
}) {
  const named = options.some((o) => o.option === recommendation) ? recommendation : null;
  // Line 2 is the named option, else the first prose; the rest of the prose is the Why, after the options.
  const line2 = named ? null : (prose[0] ?? null);
  const why = named ? prose : prose.slice(1);
  const { busy, savingId } = ans;
  return (
    <>
      <p className="mt-2 text-[14px] font-medium leading-snug text-ink" data-line="happened" data-testid="decision-happened">
        {plainTerms(happened)}
      </p>
      <div data-line="recommended">
        {named ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2" data-testid="decision-recommended">
            Recommended: <strong className="font-semibold text-ink">{named}</strong>
          </p>
        ) : line2 ? (
          <RecommendationText label="Recommended:" text={plainTerms(line2)} />
        ) : (
          <p className="mt-1.5 text-[13px] text-ink-2">No option is recommended: pick the one that fits.</p>
        )}
      </div>
      <ul className="mt-2.5 space-y-1.5" data-line="effects" data-testid="decision-effects" role={answerable ? 'group' : undefined} aria-label={answerable ? 'Answer' : 'Options'}>
        {options.map((o, i) => {
          const rec = o.option === named;
          return (
            <li key={o.option} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1" data-choice={o.option} data-recommended={rec ? 'true' : undefined}>
              {answerable ? (
                // Each option is an action: one click answers. Destructive ones (reject, close, deny) are red, the rest raised.
                <Button type="button" size="sm" className="shrink-0" data-option={o.option} data-testid={testId} variant={rec ? 'default' : /reject|close|deny/.test(o.option) ? 'danger' : 'outline'} why={!!busy && 'Saving…'} whyAt={savingId} work={o.option === 'approve' ? decisionWork(kind) : null} onClick={() => void ans.answer(o.option)} title={rec ? 'recommended' : undefined}>
                  {busy === o.option ? `${o.option}…` : o.option}
                  {proposed === o.option && (
                    <span className="rounded-full bg-blue-tint px-1.5 text-[10.5px] font-medium text-blue-ink" data-testid="decision-proposed">
                      chat proposed
                    </span>
                  )}
                  {keys && <span className={cx('inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 font-mono text-[10px]', rec ? 'bg-surface/20 text-surface' : 'bg-inset text-ink-3 shadow-hairline')}>{i + 1}</span>}
                </Button>
              ) : (
                <span className={cx('shrink-0 text-[13px]', rec ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>
                  {o.option}
                  {rec && <span className="font-normal text-ink-3"> (recommended)</span>}
                </span>
              )}
              {o.does && (
                <span className="min-w-0 flex-1 basis-60 text-[12.5px] leading-relaxed text-ink-2">
                  {plainTerms(o.does)}
                  {o.cannot && <span className="text-ink-3"> {plainTerms(o.cannot)}</span>}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {busy && <Why id={savingId}>Saving…</Why>}
      {why.map((t, i) => (
        <RecommendationText key={i} label="Why:" text={plainTerms(t)} />
      ))}
    </>
  );
}

/** The evidence a decision's detail holds, short: findings, confidence, impact, the review level and the categories. */
function Evidence({ d }: { d: DecisionDetail }) {
  if (d.withheld) return <p data-testid="decision-card-withheld">{d.withheld.replace(/^a decision/, 'A decision')}.</p>;
  const f = d.findings;
  const v = d.verdict;
  const c = d.change;
  const flags = (d.impact?.flags ?? []).filter((x) => x.files !== null);
  const categories = [...(d.pr?.why ?? []).map((y) => y.category), ...(d.impact?.others ?? [])];
  const Part = ({ title, testId, children }: { title: string; testId: string; children: ReactNode }) => (
    <div data-testid={testId}>
      <div className="font-medium text-ink">{title}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
  return (
    <div className="space-y-2" data-testid="decision-evidence">
      {f && (
        <Part title={`Findings (${f.list.length})`} testId="decision-card-findings">
          <ul className="space-y-1">
            {f.list.map((x, i) => (
              <li key={i} className="break-words">
                {x.claim}
                {x.file && <code className="ml-1.5 font-mono text-[11.5px] text-ink-3">{`${x.file}:${x.line ?? '?'}`}</code>}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {(f?.confidence || v) && (
        <Part title="Confidence" testId="decision-card-confidence">
          <span className="flex flex-wrap items-center gap-1.5">
            {f?.confidence && <Badge>the findings: confidence {f.confidence}</Badge>}
            {v && <Badge>the evaluator: confidence {v.confidence}</Badge>}
            {v?.confidenceReason && <span className="break-words">{v.confidenceReason}</span>}
          </span>
        </Part>
      )}
      {!!flags.length && (
        <Part title="Impact" testId="decision-card-impact">
          <ul className="space-y-0.5">
            {flags.map((x) => (
              <li key={x.flag} className="break-words" data-flag={x.flag}>
                {FLAG_LABEL[x.flag]}: {x.files!.length ? <>touches it ({x.files!.join(', ')})</> : "doesn't touch it"}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {(c?.level || !!categories.length) && (
        <Part title="Review level and categories" testId="decision-card-level">
          <span className="flex flex-wrap items-center gap-1.5">
            {c?.level && (
              <Badge tone={c.level === 'L3' ? 'danger' : c.level === 'L2' ? 'warn' : 'neutral'}>{LEVEL_MEANING[c.level] ? `${c.level}: ${LEVEL_MEANING[c.level]}` : c.level}</Badge>
            )}
            {categories.map((x) => (
              <Badge key={x} tone="warn">
                {x}
              </Badge>
            ))}
          </span>
          {!!c?.levelReasons.length && <div className="mt-0.5 break-words">{c.levelReasons.join('; ')}</div>}
        </Part>
      )}
    </div>
  );
}

/**
 * A card's Details, closed until opened: the question as asked, the receipts, and (read from the decision's detail
 * when first opened) the findings, confidence, impact, review level and categories. `evidence`: that detail as
 * already read (the render checks).
 */
function CardDetails({ d, receipts, evidence }: { d: Decision; receipts: string[]; evidence?: DecisionDetail | undefined }) {
  const [ev, setEv] = useState<DecisionDetail | { error: string } | 'loading' | null>(evidence ?? null);
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || ev !== null) return;
    setEv('loading');
    api<DecisionDetail>(`/api/decisions/${encodeURIComponent(d.id)}`)
      .then(setEv)
      .catch((x: Error) => setEv({ error: x.message }));
  };
  const to = `/decisions/${d.id}`;
  return (
    <details className="mt-3 rounded-control bg-inset text-[12px] text-ink-2 shadow-hairline" data-testid="decision-card-details" onToggle={onToggle}>
      <summary className="cursor-pointer select-none px-2.5 py-1.5 font-medium text-ink-2 hover:text-ink" data-testid="decision-card-details-toggle">
        Details
      </summary>
      <div className="space-y-2 border-t border-line px-2.5 py-2">
        <p className="whitespace-pre-line break-words">
          <span className="font-medium text-ink">Asked:</span> {d.question}
        </p>
        {!!receipts.length && (
          <ul className="space-y-1" data-testid="decision-card-receipts">
            {receipts.map((r, i) => (
              <li key={i} className="break-words">
                {r}
              </li>
            ))}
          </ul>
        )}
        {ev === 'loading' ? <p className="text-ink-3">Reading the evidence…</p> : ev && 'error' in ev ? <p className="text-red">Can't load the evidence: {ev.error}</p> : ev ? <Evidence d={ev} /> : null}
        <a href={to} onClick={(e) => (e.preventDefault(), navigate(to))} className="inline-block font-medium text-blue-ink hover:underline" data-testid="decision-card-open">
          Everything about this decision
        </a>
      </div>
    </details>
  );
}

/**
 * A decision as an approval card: three plain lines first (what happened, what is recommended, what each option
 * does, each option once and a button where this person may answer), then the evidence behind Details. Only the
 * decision's owner or a writer gets the buttons (canAnswer); everyone else sees whom it waits on.
 * `evidence`: its detail as already read (the render checks).
 */
export function DecisionCard({ d, selected, onAnswered, proposed, sending = null, evidence }: { d: Decision; selected: boolean; onAnswered?: () => void; proposed?: string | null; sending?: string | null; evidence?: DecisionDetail }) {
  const ans = useAnswer(d.id, onAnswered, sending);
  const detail = (d.receipts ?? []).filter(Boolean);
  const receipts = detail.filter((r) => !r.startsWith(RECOMMENDATION_PREFIX));
  const options = d.options.map((option) => ({ option, does: d.effects?.find((e) => e.option === option)?.does }));
  const entrance = useEntrance();
  return (
    <div id={d.id} className={cx('overflow-hidden rounded-card bg-surface shadow-card transition-shadow', selected && 'ring-2 ring-ring')} data-decision={d.id} data-testid="decision-card" style={entrance}>
      <div className="primitive-card-pad" data-testid="decision-body">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3" data-testid="decision-meta">
          <Avatar login={d.owner} size={18} />
          {d.issue !== null && (
            <button className="font-mono text-blue-ink hover:underline" onClick={() => navigate(`/issues/${d.issue}`)}>
              #{d.issue}
            </button>
          )}
          <Badge tone={d.kind === 'land' ? 'danger' : 'warn'}>{d.kind === 'land' ? 'Approve landing' : 'Question'}</Badge>
          <span>for @{d.owner}</span>
          <span>· asked {ago(d.askedAt)}</span>
          <a href={`/decisions/${d.id}`} onClick={(e) => (e.preventDefault(), navigate(`/decisions/${d.id}`))} className="ml-auto font-medium text-blue-ink hover:underline" title="This decision's own page, with everything about it" data-testid="decision-details">
            Open
          </a>
        </div>
        <DecisionLines happened={d.happened ?? d.question} recommendation={d.recommendation} prose={proseOf(d.recommendation, d.options, detail)} options={options} answerable={!d.answer && d.canAnswer !== false} ans={ans} proposed={proposed ?? null} keys testId="decision-option" kind={d.kind} />
        <CardDetails d={d} receipts={receipts} evidence={evidence} />
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
          <span className="text-ink-3">Waiting on @{d.owner}; {d.kind === 'plan' || d.kind === 'land' ? "a held plan or a high-risk merge is for the instance's owners (admin on its repo)" : "the instance's owners and writers (write on its repo) can answer it"}.</span>
        ) : (
          <span className="text-ink-3">Click an option to answer; the coordinator acts on its next tick.</span>
        )}
        {ans.err && <span className="ml-auto text-red">{ans.err}</span>}
      </div>
    </div>
  );
}

export function Decisions({ state }: { state: State }) {
  const [showAnswered, setShowAnswered] = useState(false);
  const open = useMemo(() => state.decisions.filter((d) => !d.answer), [state.decisions]);
  // A decision asked while the page is open goes below those shown, never above them (web/src/arrival-order.ts).
  const list = useArrivalOrder(showAnswered ? state.decisions : open, showAnswered);
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

  // Only when the selection moves (j/k, a link to one): a change to the list (a decision asked or answered) never
  // scrolls the page, which moved every card under the cursor (#455: 329 px, scrolled 150 px down).
  useEffect(() => {
    document.querySelector(`[data-decision="${list[sel]?.id}"]`)?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

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
