import { Fragment, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type CheckRun, type State } from '../api';
import { navigate, typing } from '../App';
import { DotPill, Meter, RecordsTable } from '../components/patterns';
import { ago, Avatar, Badge, Card, Empty, LevelBadge, StatusBadge, EST_NOTE, estUsd } from '../components/ui';
import { DecisionCard } from './Decisions';
import { Header } from './Overview';
import { RunList } from './RunDetail';
import { areaOf } from './Issues';

interface RawEvent { id: number; ts: string; type: string; actor: string; payload: Record<string, unknown> }

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-2 py-2 text-[13px]">
      <div className="pt-0.5 text-[12px] text-ink-3">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function check(d: Record<string, unknown>): string {
  if ('command' in d) return `command: ${d.command}`;
  if ('test' in d) return `test: ${d.test}`;
  if ('suite' in d) return `suite: ${d.suite} (no new failures vs main)`;
  if ('repro' in d) return 'reproduction test first';
  if ('manual' in d) return `manual: ${d.manual}`;
  return JSON.stringify(d);
}

const CHECK_DOT = { pass: 'green', fail: 'red', unavailable: 'orange', skipped: 'ink' } as const;

/**
 * Every run of the coordinator's own checks, newest first, each as a records table
 * (Beautiful UI's diff and records tables): a failing row is tinted red and carries
 * the end of its output, open on the latest run.
 */
export function Checks({ runs }: { runs: CheckRun[] }) {
  return (
    <section className="space-y-2" aria-label="Checks run by the coordinator">
      <div className="text-[13px] font-medium text-ink">Checks run by the coordinator</div>
      {runs.length ? (
        runs.map((r, i) => (
          <div key={r.id} data-check-run={r.id} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
              <span className="font-medium text-ink-2">{r.stage}</span>
              {r.head && <span className="font-mono">{r.head.slice(0, 8)}</span>}
              <span title={r.at}>{ago(r.at)}</span>
              {i === 0 && <Badge tone="info">latest</Badge>}
            </div>
            <RecordsTable head={['Check', 'Result', 'Exit']} className="[&_th:nth-child(2)]:w-32 [&_th:nth-child(3)]:w-20">
              {r.checks.map((c, j) => {
                const failed = c.status === 'fail';
                return (
                  <Fragment key={j}>
                    <tr className="border-b border-line last:border-0" style={{ background: failed ? 'var(--red-tint)' : undefined }} data-check={c.status}>
                      <td className="primitive-table-cell truncate font-mono text-[12px]" style={{ color: failed ? 'var(--red)' : 'var(--ink)' }} title={c.check}>
                        {c.check}
                      </td>
                      <td className="primitive-table-cell">
                        <DotPill tone={CHECK_DOT[c.status as keyof typeof CHECK_DOT] ?? 'ink'}>{c.status}</DotPill>
                      </td>
                      <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{c.exitCode ?? '-'}</td>
                    </tr>
                    {c.tail && (
                      <tr className="border-b border-line last:border-0">
                        <td colSpan={3} className="px-3 pb-2.5">
                          <details open={i === 0 && failed}>
                            <summary className="cursor-pointer py-1 text-[12px] text-ink-3">output (end)</summary>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-inset p-2 font-mono text-[11px] leading-snug text-ink-2 shadow-hairline">{c.tail}</pre>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </RecordsTable>
          </div>
        ))
      ) : (
        <Card className="p-4 text-[13px] text-ink-3">No checks run yet.</Card>
      )}
    </section>
  );
}

export function IssueDetail({ state, issue }: { state: State; issue: number }) {
  const t = state.tasks.find((x) => x.issue === issue);
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [checks, setChecks] = useState<CheckRun[]>([]);
  useEffect(() => {
    api<RawEvent[]>(`/api/events?issue=${issue}`)
      .then(setEvents)
      .catch(() => setEvents([]));
    api<CheckRun[]>(`/api/checks?issue=${issue}`)
      .then(setChecks)
      .catch(() => setChecks([]));
  }, [issue, state.lastId]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !typing(e)) navigate('/issues');
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  if (!t)
    return (
      <div>
        <Header title={`#${issue}`} />
        <div className="p-6">
          <Empty title="Not in the event log" hint="The coordinator hasn't seen this issue yet." />
        </div>
      </div>
    );
  const decision = state.decisions.find((d) => d.id === t.openDecision);
  const gh = `https://github.com/${state.project.repo}/issues/${t.issue}`;
  return (
    <div>
      <Header title={`#${t.issue}`} sub={t.title}>
        <button onClick={() => navigate('/issues')} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Issues <span className="ml-1 rounded border px-1 font-mono text-[10px]">Esc</span>
        </button>
      </Header>
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <div>
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">{t.title}</h2>
            <a href={gh} target="_blank" rel="noreferrer" className="text-[12px] text-blue-ink hover:underline">
              {state.project.repo}#{t.issue} ↗
            </a>
          </div>
          {decision && <DecisionCard d={decision} selected />}
          {t.status === 'blocked' && t.blockedReason && (
            <div className="rounded-card bg-red-tint p-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]">
              <div className="text-[12px] font-medium text-red">Blocked</div>
              <div className="mt-1 whitespace-pre-wrap text-ink">{t.blockedReason}</div>
            </div>
          )}
          {t.verdict && (
            <Card className="overflow-hidden">
              <div className="primitive-card-pad">
                <div className="text-[13px] font-medium text-ink">Evaluator verdict</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone={t.verdict.patch_correct ? 'ok' : 'danger'}>{t.verdict.patch_correct ? 'patch correct' : 'patch rejected'}</Badge>
                  <Badge tone={t.verdict.test_correct ? 'ok' : 'warn'}>{t.verdict.test_correct ? 'test correct' : 'test doubted'}</Badge>
                </div>
                {t.verdict.advice && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{t.verdict.advice}</p>}
              </div>
              <div className="primitive-card-footer flex items-center gap-2 border-t border-line">
                <Meter signal={t.verdict.confidence === 'high' ? 3 : t.verdict.confidence === 'medium' ? 2 : 1} tone={t.verdict.confidence === 'high' ? 'var(--green)' : t.verdict.confidence === 'medium' ? 'var(--orange)' : 'var(--red)'} />
                <span className="text-[12.5px] font-medium text-ink-2">{t.verdict.confidence} confidence</span>
              </div>
            </Card>
          )}
          <Checks runs={checks} />
          <RunList issue={t.issue} lastId={state.lastId} />
          <Card className="overflow-hidden">
            <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Timeline</div>
            {events.length ? (
              <ol className="divide-y">
                {events.map((e) => {
                  const a = state.activity.find((x) => x.id === e.id);
                  return (
                    <li key={e.id} className="flex gap-3 border-line px-3 py-2 text-[13px] text-ink">
                      <span className="w-16 shrink-0 text-[12px] text-ink-3" title={e.ts}>
                        {ago(e.ts)}
                      </span>
                      <span className="min-w-0 flex-1">{a?.summary ?? e.type}</span>
                      <Badge className="hidden shrink-0 sm:inline-flex">{e.type}</Badge>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="p-4 text-[13px] text-ink-3">No events.</div>
            )}
          </Card>
        </div>
        <aside className="space-y-4">
          <Card className="divide-y divide-line px-3 py-1">
            <Prop label="Status">
              <StatusBadge status={t.status} />
            </Prop>
            <Prop label="Owner">
              <span className="flex items-center gap-2">
                <Avatar login={t.owner} /> {t.owner ? `@${t.owner}` : 'unassigned'}
              </span>
            </Prop>
            <Prop label="Agent delegate">
              {t.delegate ? (
                <span className="flex items-center gap-2">
                  <Avatar login={`${t.delegate.role}@${t.delegate.instance}`} /> {t.delegate.role} <span className="text-xs text-muted-foreground">on {t.delegate.instance}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Prop>
            <Prop label="Review level">
              <div className="space-y-1">
                <LevelBadge level={t.level} />
                {t.levelReasons.map((r, i) => (
                  <div key={i} className="text-xs text-muted-foreground">
                    {r}
                  </div>
                ))}
              </div>
            </Prop>
            <Prop label="done_when">
              {t.doneWhen.length ? (
                <ul className="space-y-1 text-xs">
                  {t.doneWhen.map((d, i) => (
                    <li key={i} className="font-mono">
                      {check(d)}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-xs text-muted-foreground">{t.why || 'no contract yet'}</span>
              )}
            </Prop>
            <Prop label="Repro test">{t.repro ? <span className="font-mono text-xs">{t.repro}</span> : <span className="text-xs text-muted-foreground">none</span>}</Prop>
            <Prop label="Est. cost">
              <span className="tabular-nums" title={EST_NOTE}>{estUsd(t.costUsd)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{t.attempts ? `${t.attempts} attempt(s)` : ''}</span>
            </Prop>
            <Prop label="Change">
              <div className="space-y-0.5 font-mono text-xs">
                {t.head && <div>head {t.head.slice(0, 10)}</div>}
                {t.landed && <div className="text-ok">landed {t.landed.slice(0, 10)}</div>}
                {t.deployed && <div className="text-ok">serving on {t.deployed}</div>}
                {!t.head && !t.landed && <span className="text-muted-foreground">none yet</span>}
              </div>
            </Prop>
            <Prop label="Area">{areaOf(t, state)}</Prop>
            <Prop label="Labels">
              <div className="flex flex-wrap gap-1">
                {t.labels.map((l) => (
                  <Badge key={l}>{l}</Badge>
                ))}
              </div>
            </Prop>
            <Prop label="Updated">{ago(t.lastActivity)}</Prop>
          </Card>
        </aside>
      </div>
    </div>
  );
}
