// A decision's detail (/decisions/<id>, from the Inbox, Decisions, Waiting on you and PR cards): everything needed to
// decide from the dashboard alone, each part in its own card, in a fixed order. It opens with the decision card's three
// lines (what happened, the recommendation by name, what each option does, each option once); a part the log doesn't
// have is left out, never shown as "not recorded". The page's data is one request (GET /api/decisions/:id,
// src/decision-detail.ts); the PR body's sections are a second, shown last so their arrival moves nothing above them,
// and the diff is asked for on a click.
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, useView, type DecisionDetail, type DecisionDiff, type DecisionPrBody, type State } from '../api';
import { navigate } from '../App';
import { DotPill, FileChip, Loading, StatusMark, type MarkState } from '../components/patterns';
import { ago, Badge, Button, Card, cx, Empty } from '../components/ui';
import { Header } from '../components/Header';
import { shownPath } from '../path-text';
import { DecisionLines, FLAG_LABEL, LEVEL_MEANING, proseOf, useAnswer } from './Decisions';

/** Every section, in page order (the render checks render each for every kind); one with nothing recorded isn't drawn. */
export const DETAIL_SECTIONS = ['summary', 'asked', 'impact', 'if-nothing', 'findings', 'change', 'verdict', 'tests', 'ci', 'runs', 'links', 'diff', 'pr-body'] as const;
type SectionId = (typeof DETAIL_SECTIONS)[number];
/** How a drawn section stands: shown, not one this kind of decision has, or not this person's. */
type SectionState = 'shown' | 'not-applicable' | 'withheld';

const KIND_LABEL: Record<DecisionDetail['kind'], string> = { land: 'Approve landing', question: 'Question', domain: 'Network access', plan: 'Plan', intake: 'Intake report', delegation: 'Review settings', automation: 'Automation run', pr: 'PR held for you' };
const OUTCOME_DOT: Record<string, 'green' | 'red' | 'orange' | 'ink'> = { pass: 'green', fail: 'red', cancelled: 'red', pending: 'orange', missing: 'orange', skipped: 'ink', unavailable: 'orange' };
const CONF_TONE: Record<string, 'ok' | 'warn' | 'danger'> = { high: 'ok', medium: 'warn', low: 'danger' };

function Section({ id, testId, title, state, children }: { id: SectionId; testId: `decision-${SectionId}`; title: string; state: SectionState; children: ReactNode }) {
  return (
    <Card className="primitive-card-pad" data-testid={testId} data-section={id} data-section-state={state}>
      <h2 className="text-[12px] font-medium text-ink-3">{title}</h2>
      <div className="mt-1.5 min-w-0 text-[13px] leading-relaxed text-ink">{children}</div>
    </Card>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <span className="text-ink-3">{children}</span>;
const Lines = ({ items, testId }: { items: string[]; testId?: string }) => (
  <ul className="mt-1 space-y-1 rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink-2 shadow-hairline" data-testid={testId}>
    {items.map((x, i) => (
      <li key={i} className="whitespace-pre-line break-words">
        {x}
      </li>
    ))}
  </ul>
);
const internal = (to: string) => ({ href: to, onClick: (e: React.MouseEvent) => (e.preventDefault(), navigate(to)) });
const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;
const runMark = (reason: string | null): MarkState => (reason === null ? 'running' : reason === 'succeeded' ? 'done' : 'failed');

/** The diff, asked for on a click (the owners'); shown in a box of its own height, scrolled inside. */
function DiffSection({ d, initial = null }: { d: DecisionDetail; initial?: DecisionDiff | { error: string } | 'loading' | null }) {
  const [diff, setDiff] = useState(initial);
  // No change with its commits recorded: nothing to show.
  if (d.diff === 'none' || !d.diff) return null;
  const state: SectionState = d.diff === 'owner' ? 'shown' : 'withheld';
  const load = () => {
    setDiff('loading');
    api<DecisionDiff>(`/api/decisions/${encodeURIComponent(d.id)}/diff`)
      .then(setDiff)
      .catch((e: Error) => setDiff({ error: e.message }));
  };
  return (
    <Section id="diff" testId="decision-diff" title="The diff" state={state}>
      {d.diff === 'owners-only' ? (
        <Quiet>The diff is for the instance's owners{d.pr ? '; it is on the PR on GitHub' : ''}.</Quiet>
      ) : diff === null ? (
        <Button size="sm" variant="outline" onClick={load} data-testid="decision-diff-show">
          Show the diff ({d.change?.base?.slice(0, 8)}..{d.change?.head?.slice(0, 8)})
        </Button>
      ) : diff === 'loading' ? (
        <Quiet>Reading the diff…</Quiet>
      ) : 'error' in diff ? (
        <span className="text-red">Can't load the diff: {diff.error}</span>
      ) : diff.diff === null ? (
        <Quiet>No diff: {diff.why}.</Quiet>
      ) : (
        <>
          <pre className="max-h-[480px] overflow-auto rounded-control bg-inset p-3 font-mono text-[11.5px] leading-5 shadow-hairline" data-testid="decision-diff-text">
            {diff.diff.split('\n').map((l, i) => (
              <div key={i} className={cx(l.startsWith('+') && !l.startsWith('+++') ? 'text-green' : l.startsWith('-') && !l.startsWith('---') ? 'text-red' : l.startsWith('@@') ? 'text-blue-ink' : 'text-ink-2')}>
                {l || ' '}
              </div>
            ))}
          </pre>
          {diff.truncated && <div className="mt-1 text-[12px] text-ink-3">Cut at 512 KB: the rest is on the PR or in git.</div>}
        </>
      )}
    </Section>
  );
}

function PrPart({ label, text, testId }: { label: string; text: string | null | undefined; testId: string }) {
  if (!text) return null;
  return (
    <div className="mt-1.5 first:mt-0" data-testid={testId}>
      <div className="text-[12px] font-medium text-ink-3">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap break-words rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink-2 shadow-hairline">{text}</div>
    </div>
  );
}

/** The PR body's fail-without and "never" sections: the last part of the page, read after the rest. */
function PrBodySection({ d, initial }: { d: DecisionDetail; initial?: DecisionPrBody | { error: string } | null }) {
  const [body, setBody] = useState<DecisionPrBody | { error: string } | null>(initial ?? null);
  useEffect(() => {
    if (!d.prBody || initial !== undefined) return;
    let live = true;
    api<DecisionPrBody>(`/api/decisions/${encodeURIComponent(d.id)}/pr`)
      .then((b) => live && setBody(b))
      .catch((e: Error) => live && setBody({ error: e.message }));
    return () => {
      live = false;
    };
  }, [d.id, d.prBody, initial]);
  const loaded = body && !('error' in body) ? body : null;
  // No PR for this decision: nothing to read.
  if (!d.prBody) return null;
  return (
    <Section id="pr-body" testId="decision-pr-body" title="From the PR: fail-without and what it can never do" state="shown">
      {body === null ? (
        <Quiet>Reading the PR body…</Quiet>
      ) : 'error' in body ? (
        <span className="text-red">Can't read the PR body: {body.error}</span>
      ) : (
        <>
          {loaded?.why && <div className="text-[12px] text-ink-3">{loaded.why}</div>}
          <PrPart label="Fail-without" text={loaded?.failWithout} testId="decision-fail-without" />
          <PrPart label="What this can never do" text={loaded?.never} testId="decision-never" />
          {!loaded?.why && !loaded?.failWithout && !loaded?.never && <Quiet>The PR body has neither section.</Quiet>}
        </>
      )}
    </Section>
  );
}

/** The detail from its data (also what the render checks render). `prBody` and `diff`: as already read, for the checks. */
export function DecisionDetailView({ d, prBody, diff }: { d: DecisionDetail; prBody?: DecisionPrBody | { error: string } | null; diff?: DecisionDiff | { error: string } | null }) {
  const viewer = d.withheld !== null;
  const ans = useAnswer(d.id);
  const options = d.options.map((o) => ({ option: o.option, does: o.does, cannot: o.cannot }));
  // A viewer's has no reasoning: an older event's free-text recommendation is its only prose.
  const prose = d.reasoning ?? proseOf(d.recommendation, options.map((o) => o.option), []);
  return (
    <div className="space-y-3" data-testid="decision-detail" data-kind={d.kind}>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <Badge tone={d.kind === 'land' || d.kind === 'pr' ? 'danger' : 'warn'}>{KIND_LABEL[d.kind]}</Badge>
        {d.issue !== null && (
          <a {...internal(`/issues/${d.issue}`)} className="font-mono text-blue-ink hover:underline">
            #{d.issue}
          </a>
        )}
        {d.title && <span className="min-w-0 truncate text-ink-2">{d.title}</span>}
        {d.owner && <span>for @{d.owner}</span>}
        <span>· asked {ago(d.askedAt)}</span>
        {d.answer && (
          <Badge tone="ok">
            answered {d.answer.answer}
            {d.answer.by ? ` by @${d.answer.by}` : ''}
          </Badge>
        )}
      </div>

      <Section id="summary" testId="decision-summary" title="In short" state="shown">
        {options.length ? (
          <DecisionLines happened={d.summary?.happened ?? d.question} recommendation={d.recommendation} prose={prose} options={options} answerable={!d.answer && d.canAnswer} ans={ans} testId="decision-detail-option" kind={d.kind} />
        ) : (
          <>
            <p className="text-[14px] font-medium leading-snug text-ink" data-line="happened" data-testid="decision-happened">
              {d.summary?.happened ?? d.question}
            </p>
            <p className="mt-1.5 text-ink-2" data-line="effects" data-testid="decision-effects">
              Answered on GitHub: merging the PR lands it; closing it (or asking for changes) doesn't. Nothing here can merge it.
            </p>
          </>
        )}
        {ans.err && <p className="mt-1.5 text-[12px] text-red">{ans.err}</p>}
        {!d.answer && !d.canAnswer && options.length > 0 && (
          <p className="mt-2 text-[12px] text-ink-3">Waiting on @{d.owner}; {d.kind === 'plan' || d.kind === 'land' ? "a held plan or a high-risk merge is for the instance's owners (admin on its repo)" : "the instance's owners and writers (write on its repo) can answer it"}.</p>
        )}
      </Section>

      {viewer ? (
        <div className="rounded-control bg-inset px-3 py-2 text-[12.5px] text-ink-2 shadow-hairline" data-testid="decision-withheld">
          {d.withheld!.replace(/^a decision/, 'A decision')}.
        </div>
      ) : (
        <Section id="asked" testId="decision-asked" title="As asked: the question, the agent's words and the receipts" state="shown">
          <p className="whitespace-pre-line break-words font-medium" data-testid="decision-question">
            {d.question}
          </p>
          {d.summary?.agent && (
            <div className="mt-1.5" data-testid="decision-agent-summary">
              <div className="text-[12px] font-medium text-ink-3">In the agent's words</div>
              <div className="whitespace-pre-line break-words text-ink-2">{d.summary.agent}</div>
            </div>
          )}
          {!!(d.receipts ?? []).length && <Lines items={d.receipts!} testId="decision-receipts" />}
        </Section>
      )}

      {!viewer && <Impact d={d} />}

      <Section id="if-nothing" testId="decision-if-nothing" title="If nothing is picked" state="shown">
        <p data-testid="decision-if-nothing-text">{d.ifNothing}</p>
      </Section>

      {!viewer && (
        <>
          <Findings d={d} />
          <Change d={d} />
          <Verdict d={d} />
          <Tests d={d} />
          <Ci d={d} />
          <Runs d={d} />
        </>
      )}
      <Links d={d} />
      {!viewer && (
        <>
          {d.ownerOnly && (
            <div className="px-1 text-[12px] text-ink-3" data-testid="decision-owner-only">
              Not shown to you: {d.ownerOnly}.
            </div>
          )}
          <DiffSection d={d} {...(diff !== undefined ? { initial: diff } : {})} />
          <PrBodySection d={d} {...(prBody !== undefined ? { initial: prBody } : {})} />
        </>
      )}
    </div>
  );
}

function Impact({ d }: { d: DecisionDetail }) {
  const i = d.impact;
  // Only the flags whose files are known: one that isn't recorded isn't drawn, and neither is the section when none is.
  const known = (i?.flags ?? []).filter((f): f is typeof f & { files: string[] } => f.files !== null);
  if (!i || !known.length) return null;
  return (
    <Section id="impact" testId="decision-impact" title="Impact: money path, auth, secrets" state="shown">
      <ul className="space-y-1">
        {known.map((f) => (
          <li key={f.flag} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="decision-impact-flag" data-flag={f.flag} data-touches={f.files.length ? 'yes' : 'no'}>
            <span className="w-24 shrink-0 font-medium">{FLAG_LABEL[f.flag]}</span>
            {f.files.length ? <Badge tone="danger">touches it</Badge> : <Badge tone="ok">doesn't touch it</Badge>}
            {f.files.map((p) => <FileChip key={p} file={p} />)}
          </li>
        ))}
      </ul>
      {!!i?.others.length && <p className="mt-1.5 text-[12.5px] text-ink-2">Also falls in: {i.others.join(', ')}.</p>}
      {i?.note && <p className="mt-1 text-[12px] text-orange">{i.note}</p>}
    </Section>
  );
}

function Findings({ d }: { d: DecisionDetail }) {
  const f = d.findings;
  const applies = d.kind === 'question';
  if (!f && applies) return null;
  return (
    <Section id="findings" testId="decision-findings" title="Findings" state={f ? 'shown' : 'not-applicable'}>
      {!f ? (
        <Quiet>None: this kind of decision isn't based on an agent's findings.</Quiet>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <span>{f.list.length} finding(s)</span>
            {f.confidence && <Badge tone={CONF_TONE[f.confidence] ?? 'neutral'}>confidence {f.confidence}</Badge>}
          </div>
          {f.list.length ? (
            <ol className="mt-1.5 space-y-2">
              {f.list.map((x, i) => (
                <li key={i} className="rounded-control bg-inset px-2.5 py-2 shadow-hairline" data-testid="decision-finding">
                  <div className="whitespace-pre-line break-words font-medium">{x.claim}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
                    {x.file && (
                      <span data-testid="decision-finding-at">
                        <FileChip file={x.file} line={x.line ?? '?'} />
                      </span>
                    )}
                    {x.severity && <Badge>severity {x.severity}</Badge>}
                    {x.confidence && <Badge tone={CONF_TONE[x.confidence] ?? 'neutral'}>confidence {x.confidence}</Badge>}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink-2">{x.evidence}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-ink-3">No findings.</p>
          )}
          {!!f.unverified.length && (
            <>
              <div className="mt-2 text-[12px] font-medium text-ink-3">What it couldn't confirm</div>
              <Lines items={f.unverified} />
            </>
          )}
        </>
      )}
    </Section>
  );
}

function Change({ d }: { d: DecisionDetail }) {
  const c = d.change;
  if (!c) return null;
  return (
    <Section id="change" testId="decision-change" title="The change: files, review level and why" state="shown">
      <>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            {c.level && (
              <Badge tone={c.level === 'L3' ? 'danger' : c.level === 'L2' ? 'warn' : 'neutral'}>{`review level ${c.level}${LEVEL_MEANING[c.level] ? `: ${LEVEL_MEANING[c.level]}` : ''}`}</Badge>
            )}
            <span>
              {c.files.length + c.filesMore} file(s){c.base && c.head ? ` · ${c.base.slice(0, 8)}..${c.head.slice(0, 8)}` : ''}
            </span>
            {c.source === 'log' && <Quiet>(from the issue's log)</Quiet>}
          </div>
          {!!c.levelReasons.length && (
            <>
              <div className="mt-1.5 text-[12px] font-medium text-ink-3">Why this level</div>
              <Lines items={c.levelReasons} testId="decision-level-reasons" />
            </>
          )}
          {!!c.files.length && (
            <ul className="mt-2 flex max-w-full flex-wrap gap-1.5" aria-label="Files changed">
              {c.files.map((f) => (
                <li key={f.path} className="flex max-w-full items-center gap-1">
                  <FileChip file={f.path} />
                  {f.added !== null && (
                    <span className="font-mono text-[11px] tabular-nums">
                      <span className="text-green">+{f.added}</span> <span className="text-red">−{f.removed}</span>
                    </span>
                  )}
                </li>
              ))}
              {c.filesMore > 0 && <li className="self-center text-[12px] text-ink-3">and {c.filesMore} more</li>}
            </ul>
          )}
      </>
    </Section>
  );
}

function Verdict({ d }: { d: DecisionDetail }) {
  const v = d.verdict;
  const applies = d.kind === 'land' || d.kind === 'pr';
  if (!v && applies) return null;
  return (
    <Section id="verdict" testId="decision-verdict" title="The evaluator's verdict and confidence" state={v ? 'shown' : 'not-applicable'}>
      {!v ? (
        <Quiet>None: this kind of decision isn't evaluated.</Quiet>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={v.patch_correct ? 'ok' : 'danger'}>{v.patch_correct ? 'patch correct' : 'patch not correct'}</Badge>
            <Badge tone={v.test_correct ? 'ok' : 'danger'}>{v.test_correct ? 'test correct' : 'test not correct'}</Badge>
            <Badge tone={CONF_TONE[v.confidence] ?? 'neutral'}>confidence {v.confidence}</Badge>
            {v.designChange !== null && <Badge tone={v.designChange ? 'warn' : 'neutral'}>{v.designChange ? 'design change' : 'no design change'}</Badge>}
          </div>
          {v.confidenceReason && (
            <p className="mt-1.5" data-testid="decision-confidence-reason">
              <span className="font-medium">Why this confidence: </span>
              <span className="whitespace-pre-line break-words text-ink-2">{v.confidenceReason}</span>
            </p>
          )}
          {v.advice && <p className="mt-1 whitespace-pre-line break-words text-ink-2">{v.advice}</p>}
          {v.designReason && <p className="mt-1 text-ink-2">Design: {v.designReason}</p>}
          {!!v.unread.length && (
            <>
              <div className="mt-2 text-[12px] font-medium text-ink-3">Files it didn't read</div>
              <Lines items={v.unread.map(shownPath)} />
            </>
          )}
          {!!v.unverifiedClaims.length && (
            <>
              <div className="mt-2 text-[12px] font-medium text-ink-3">Claims nothing recorded backs</div>
              <Lines items={v.unverifiedClaims} />
            </>
          )}
        </>
      )}
    </Section>
  );
}

function Tests({ d }: { d: DecisionDetail }) {
  const t = d.tests;
  const applies = d.kind === 'land' || d.kind === 'pr';
  if (!t && applies && !d.tampered?.length) return null;
  return (
    <Section id="tests" testId="decision-tests" title="Tests the harness ran" state={t ? 'shown' : applies ? 'shown' : 'not-applicable'}>
      {!t ? (
        applies ? null : <Quiet>None: this kind of decision has no change to test.</Quiet>
      ) : !t.length ? (
        <Quiet>No checks ran.</Quiet>
      ) : (
        <ul className="divide-y divide-line">
          {t.map((c, i) => (
            <li key={i} className="py-1.5" data-testid="decision-test" data-status={c.status}>
              <div className="flex flex-wrap items-center gap-2">
                <DotPill tone={OUTCOME_DOT[c.status] ?? 'ink'}>
                  {c.check}: {c.status}
                </DotPill>
                {c.duration_ms !== null && <span className="text-[12px] tabular-nums text-ink-3">{(c.duration_ms / 1000).toFixed(1)} s</span>}
              </div>
              {c.tail && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-control bg-inset p-2 font-mono text-[11.5px] text-ink-2 shadow-hairline">{c.tail}</pre>}
            </li>
          ))}
        </ul>
      )}
      {!!d.tampered?.length && (
        <>
          <div className="mt-2 text-[12px] font-medium text-red">The tamper guard flagged</div>
          <Lines items={d.tampered} testId="decision-tampered" />
        </>
      )}
    </Section>
  );
}

function Ci({ d }: { d: DecisionDetail }) {
  const pr = d.pr;
  if (!pr) return null;
  return (
    <Section id="ci" testId="decision-ci" title="CI on the PR, per required check" state="shown">
      {(
        <>
          {pr.checksOnHead && pr.checks.length ? (
            <span className="flex flex-wrap gap-1.5" data-testid="decision-ci-checks">
              {pr.checks.map((c) => (
                <DotPill key={c.name} tone={OUTCOME_DOT[c.outcome] ?? 'ink'}>
                  {c.name}: {c.outcome}
                </DotPill>
              ))}
            </span>
          ) : (
            <Quiet>No check results on {pr.head.slice(0, 8)} yet.</Quiet>
          )}
          {!!pr.waitReasons.length && (
            <>
              <div className="mt-2 text-[12px] font-medium text-ink-3">Why it waits for you</div>
              <Lines items={pr.waitReasons} testId="decision-wait-reasons" />
            </>
          )}
          {!!pr.why.length && (
            <ul className="mt-1.5 space-y-1">
              {pr.why.map((y) => (
                <li key={y.category} className="flex flex-wrap items-baseline gap-x-2">
                  <Badge tone="warn">{y.category}</Badge>
                  <span className="break-words">{y.text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function Runs({ d }: { d: DecisionDetail }) {
  const runs = d.runs;
  const auth = d.auth;
  // Not on an issue, so no runs to list: drawn only for a login refused or held.
  if (!runs && !auth?.held && !auth?.failed.length) return null;
  return (
    <Section id="runs" testId="decision-runs" title="The agent's runs" state="shown">
      {auth?.held && (
        <div role="alert" className="mb-2 rounded-control bg-red-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="decision-auth-held">
          <span className="font-medium text-red">Claude sign-in failed on this machine</span> ({auth.held.login}), since {ago(auth.held.since)}: no new runs on that login until a check call works. {auth.held.detail}
        </div>
      )}
      {!!auth?.failed.length && (
        <div role="alert" className="mb-2 rounded-control bg-red-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="decision-auth-failed">
          <span className="font-medium text-red">auth_failed:</span> Claude refused the login on {auth.failed.length} run(s) of this task. Last, {ago(auth.failed.at(-1)!.at)} ({auth.failed.at(-1)!.role}){auth.failed.at(-1)!.detail ? `: ${auth.failed.at(-1)!.detail}` : '.'}
        </div>
      )}
      {!runs ? null : runs.length ? (
        <ul className="divide-y divide-line">
          {runs.map((r) => (
            <li key={r.id}>
              <a {...internal(`/runs/${r.id}`)} className="flex min-h-11 items-center gap-2.5 py-1 hover:bg-inset" data-testid="decision-run">
                <StatusMark state={runMark(r.reason)} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {r.role} <span className="font-normal text-ink-3">· {r.model} · {ago(r.startedAt)}</span>
                </span>
                <Badge tone={r.reason === 'succeeded' ? 'ok' : r.reason === null ? 'neutral' : 'danger'}>{r.reason ?? 'running'}</Badge>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Quiet>No recorded runs.</Quiet>
      )}
    </Section>
  );
}

function Links({ d }: { d: DecisionDetail }) {
  return (
    <Section id="links" testId="decision-links" title="Links" state="shown">
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {d.issue !== null && (
          <li>
            <a {...internal(`/issues/${d.issue}`)} className="text-blue-ink hover:underline" data-testid="decision-link-issue">
              Issue #{d.issue}
            </a>
          </li>
        )}
        {d.pr && (
          <li>
            <a href={d.pr.url} {...ext} className="text-blue-ink hover:underline" data-testid="decision-link-pr">
              PR #{d.pr.number} on GitHub
            </a>
          </li>
        )}
        {(d.runs ?? []).slice(-1).map((r) => (
          <li key={r.id}>
            <a {...internal(`/runs/${r.id}`)} className="text-blue-ink hover:underline" data-testid="decision-link-run">
              The last run ({r.role})
            </a>
          </li>
        ))}
        <li>
          <a {...internal('/waiting')} className="text-blue-ink hover:underline">
            Waiting on you
          </a>
        </li>
      </ul>
    </Section>
  );
}

/** The page: the detail read once it opens, and again when the log changes. */
export function DecisionDetailPage({ state, id }: { state: State; id: string }) {
  const { data, error } = useView<DecisionDetail>(`/api/decisions/${encodeURIComponent(id)}`, state.lastId);
  return (
    <div data-testid="page-decision-detail">
      <Header title="Decision">
        <button onClick={() => (window.history.length > 1 ? window.history.back() : navigate('/decisions'))} className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Back
        </button>
      </Header>
      <div className="mx-auto max-w-3xl p-6">
        {data ? <DecisionDetailView key={data.id} d={data} /> : error ? /no such decision/.test(error) ? <Empty title="No such decision" hint="It may be from another instance; the Decisions page lists this one's." /> : <div className="text-[13px] text-red">Can't load the decision: {error}</div> : <Loading />}
      </div>
    </div>
  );
}
