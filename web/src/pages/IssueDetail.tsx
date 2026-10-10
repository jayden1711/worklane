import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type State } from '../api';
import { navigate, typing } from '../App';
import { ago, Avatar, Badge, Card, Empty, LevelBadge, StatusBadge, EST_NOTE, estUsd } from '../components/ui';
import { DecisionCard } from './Decisions';
import { Header } from './Overview';
import { areaOf } from './Issues';

interface RawEvent { id: number; ts: string; type: string; actor: string; payload: Record<string, unknown> }

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-2 py-1.5 text-sm">
      <div className="pt-0.5 text-xs text-muted-foreground">{label}</div>
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

export function IssueDetail({ state, issue }: { state: State; issue: number }) {
  const t = state.tasks.find((x) => x.issue === issue);
  const [events, setEvents] = useState<RawEvent[]>([]);
  useEffect(() => {
    api<RawEvent[]>(`/api/events?issue=${issue}`)
      .then(setEvents)
      .catch(() => setEvents([]));
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
            <h2 className="text-lg font-semibold">{t.title}</h2>
            <a href={gh} target="_blank" rel="noreferrer" className="text-xs text-info hover:underline">
              {state.project.repo}#{t.issue} ↗
            </a>
          </div>
          {decision && <DecisionCard d={decision} selected />}
          {t.status === 'blocked' && t.blockedReason && (
            <Card className="border-danger/40 bg-danger/5 p-3 text-sm">
              <div className="text-xs font-medium text-danger">Blocked</div>
              <div className="mt-1 whitespace-pre-wrap">{t.blockedReason}</div>
            </Card>
          )}
          {t.verdict && (
            <Card className="p-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Evaluator verdict</span>
                <Badge tone={t.verdict.patch_correct ? 'ok' : 'danger'}>{t.verdict.patch_correct ? 'patch correct' : 'patch rejected'}</Badge>
                <Badge tone={t.verdict.test_correct ? 'ok' : 'warn'}>{t.verdict.test_correct ? 'test correct' : 'test doubted'}</Badge>
                <Badge>{t.verdict.confidence} confidence</Badge>
              </div>
              {t.verdict.advice && <div className="mt-2 text-sm text-muted-foreground">{t.verdict.advice}</div>}
            </Card>
          )}
          <Card>
            <div className="border-b px-4 py-2.5 text-sm font-medium">Timeline</div>
            {events.length ? (
              <ol className="divide-y">
                {events.map((e) => {
                  const a = state.activity.find((x) => x.id === e.id);
                  return (
                    <li key={e.id} className="flex gap-3 px-4 py-2 text-sm">
                      <span className="w-16 shrink-0 text-xs text-muted-foreground" title={e.ts}>
                        {ago(e.ts)}
                      </span>
                      <span className="min-w-0 flex-1">{a?.summary ?? e.type}</span>
                      <Badge className="hidden shrink-0 sm:inline-flex">{e.type}</Badge>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">No events.</div>
            )}
          </Card>
        </div>
        <aside className="space-y-4">
          <Card className="divide-y px-4 py-2">
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
