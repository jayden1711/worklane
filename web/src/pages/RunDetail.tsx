import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type RunRecord, type RunSummary, type State } from '../api';
import { navigate } from '../App';
import { FileChip, Loading, StatusMark, TaskRow, ToolRow, type MarkState } from '../components/patterns';
import { ago, Badge, Card, Empty, EST_NOTE, estUsd } from '../components/ui';
import { LiveRun } from '../components/LiveRun';
import { Header } from '../components/Header';

const markFor = (reason: string | null): MarkState => (reason === null ? 'running' : reason === 'succeeded' ? 'done' : 'failed');

/** The server's refusal of agent runs to someone who is neither the owner nor a writer (see mayReadRuns). */
export const runsRefused = (message: string) => (/^agent runs are for /.test(message) ? message : null);

/** For a viewer the state says may not read runs, the refusal the server would give; null for the owner and writers. */
export { runsRefusal } from '../refusals';

/** Agent runs are the owner's and the writers': anyone else is told so, not shown an empty list. */
export function RunsRefused({ message }: { message: string }) {
  return (
    <div className="p-4 text-[13px] text-ink-3" data-testid="runs-refused">
      {message.replace(/^agent runs/, 'Agent runs')}.
    </div>
  );
}

/** An issue's agent runs as task rows (Beautiful UI's task rows), oldest first; each opens what it did. */
export function RunList({ issue, lastId, refused: known = null }: { issue: number; lastId: number; refused?: string | null }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [fromServer, setRefused] = useState<string | null>(null);
  // Refused up front (the state says so): not asked for at all, so no request is turned away.
  useEffect(() => {
    if (known) return;
    api<RunSummary[]>(`/api/runs?issue=${issue}`)
      .then((r) => (setRuns(r), setRefused(null)))
      .catch((e: Error) => (setRuns([]), setRefused(runsRefused(e.message))));
  }, [issue, lastId, known]);
  const refused = known ?? fromServer;
  return (
    <Card className="overflow-hidden" data-testid="runs-card">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Agent runs</div>
      {refused ? (
        <RunsRefused message={refused} />
      ) : runs.length ? (
        <div>
          {runs.map((r, i) => (
            <TaskRow
              key={r.id}
              index={i}
              testId={r.id}
              dataTestId="run-row"
              mark={<StatusMark state={markFor(r.reason)} />}
              label={
                <>
                  {r.role} <span className="font-normal text-ink-3">· {ago(r.startedAt)}</span>
                </>
              }
              amount={
                <>
                  {r.commands} command(s){r.failedCommands ? `, ${r.failedCommands} failed` : ''} · {r.files.length} file(s) written
                  {r.costUsd !== null && (
                    <span className="ml-2 text-ink-3" title={EST_NOTE}>
                      {estUsd(r.costUsd)}
                    </span>
                  )}
                </>
              }
              pill={<Badge tone={r.reason === 'succeeded' ? 'ok' : r.reason === null ? 'neutral' : 'danger'}>{r.reason ?? 'running'}</Badge>}
              onClick={() => navigate(`/runs/${r.id}`)}
            />
          ))}
        </div>
      ) : (
        <div className="p-4 text-[13px] text-ink-3">No recorded runs.</div>
      )}
    </Card>
  );
}

/** One agent run as tool chips (Beautiful UI's tool chips): every command and write, then the files and the final message. */
export function RunDetail({ id, refused: known = null }: { id: string; refused?: string | null }) {
  const [run, setRun] = useState<RunRecord | null | undefined>(known ? null : undefined);
  const [fromServer, setRefused] = useState<string | null>(null);
  // Live while the coordinator runs it (its record is written when it ends); the stored record afterwards.
  const [live, setLive] = useState<boolean | undefined>(known ? false : undefined);
  const loadRecord = () =>
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`)
      .then(setRun)
      .catch((e: Error) => (setRun(null), setRefused(runsRefused(e.message))));
  useEffect(() => {
    // Refused up front (the state says so): neither the record nor the console is asked for.
    if (known) return;
    void loadRecord();
    api<{ live: boolean }>(`/api/runs/${encodeURIComponent(id)}/console`)
      .then((c) => setLive(c.live))
      .catch(() => setLive(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, known]);
  const refused = known ?? fromServer;
  const showLive = live === true && !run;
  const back = run?.issue ? `/issues/${run.issue}` : '/agents';
  const commands = run?.steps.filter((s) => s.kind === 'command').length ?? 0;
  return (
    <div data-testid="page-run-detail">
      <Header title={run ? `${run.role} run` : showLive ? 'Live run' : 'Agent run'} sub={run ? `${run.issue ? `#${run.issue} · ` : ''}${run.model} · started ${ago(run.startedAt)}` : showLive ? 'live: what the agent does, as it does it' : ''}>
        <button onClick={() => navigate(back)} className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Back
        </button>
      </Header>
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {showLive && <LiveRun run={id} onEnded={() => void loadRecord()} />}
        {!showLive && (run === undefined || live === undefined) && <Loading />}
        {!showLive && run === null && live === false && (refused ? <Card><RunsRefused message={refused} /></Card> : <Empty title="No such run" hint="Runs are kept for the most recent 500." />)}
        {run && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
              <StatusMark state={markFor(run.reason)} />
              <Badge tone={run.reason === 'succeeded' ? 'ok' : run.reason === null ? 'neutral' : 'danger'}>{run.reason ?? 'running'}</Badge>
              {run.turns !== null && <span>{run.turns} turn(s)</span>}
              {run.costUsd !== null && <span title={EST_NOTE}>{estUsd(run.costUsd)}</span>}
              {run.otherTools > 0 && <span>{run.otherTools} read/search call(s) not listed</span>}
              {run.truncated && <Badge tone="warn">long run: later steps not recorded</Badge>}
            </div>
            <Card className="primitive-card-pad">
              <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                <span className="tabular-nums">
                  {commands} command(s), {run.files.length} file(s) written
                </span>
              </div>
              {run.steps.length ? (
                <div className="mt-2 flex flex-col gap-1" data-testid="run-steps">
                  {run.steps.map((s, i) => (
                    <ToolRow
                      key={i}
                      icon={s.kind === 'write' ? 'write' : 'run'}
                      label={s.kind === 'write' ? s.tool : 'Run'}
                      chip={s.what}
                      detail={s.kind === 'command' && s.output ? s.output : undefined}
                      end={s.kind === 'command' ? <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>{s.exitCode !== null ? `exit ${s.exitCode}` : s.status}</Badge> : undefined}
                    />
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-[13px] text-ink-3">No commands or writes.</div>
              )}
              {!!run.files.length && (
                <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5" aria-label="Files written">
                  {run.files.map((f) => (
                    <FileChip key={f} file={f} />
                  ))}
                </div>
              )}
            </Card>
            {run.role === 'researcher' && <RunResearch id={run.id} />}
            <Card className="primitive-card-pad" data-testid="run-final">
              <div className="text-[12px] font-medium text-ink-3">Final message</div>
              <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{run.final || <span className="text-ink-3">none</span>}</div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/** What a research run searched and fetched (GET /api/runs/:id/research): the owner's only. */
export interface RunResearchData {
  searches: string[];
  fetches: { url: string; host: string; refused: string | null }[];
  capped: string[];
}

/** Only http(s) addresses become links; anything else an agent asked for is shown as text. */
const linkable = (url: string) => /^https?:\/\//i.test(url);

/** The research section from its data; null while loading. Who may see it is the run page's (the runs gate). */
export function RunResearchView({ data }: { data: RunResearchData | { error: string } | null }) {
  if (data === null) return null;
  if ('error' in data) {
    return (
      <Card className="primitive-card-pad text-[13px] text-red" data-testid="run-research">
        Can't load the research: {data.error}
      </Card>
    );
  }
  const refused = data.fetches.filter((f) => f.refused).length;
  return (
    <Card className="primitive-card-pad space-y-3" data-testid="run-research">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <span className="text-[13px] font-medium text-ink">Research</span>
        <span className="tabular-nums">
          {data.searches.length} search(es), {data.fetches.length - refused} page(s) fetched{refused ? `, ${refused} refused` : ''}
        </span>
      </div>
      {data.capped.map((why, i) => (
        <div key={i} role="alert" className="rounded-control bg-orange-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="run-research-capped">
          <span className="font-medium text-orange">Stopped at a cap:</span> {why}
        </div>
      ))}
      {!data.searches.length && !data.fetches.length ? (
        <div className="text-[13px] text-ink-3">No searches or fetches recorded.</div>
      ) : (
        <>
          {!!data.searches.length && (
            <div>
              <div className="text-[12px] font-medium text-ink-3">Searches</div>
              <ol className="mt-1 space-y-0.5 text-[13px] text-ink">
                {data.searches.map((q, i) => (
                  <li key={i} className="break-words" data-testid="run-research-search">
                    {q}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!!data.fetches.length && (
            <div>
              <div className="text-[12px] font-medium text-ink-3">Pages</div>
              <ul className="mt-1 divide-y divide-line">
                {data.fetches.map((f, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-2 py-1.5 text-[12.5px]" data-testid="run-research-fetch" {...(f.refused ? { 'data-refused': '' } : {})}>
                    <Badge tone={f.refused ? 'danger' : 'ok'}>{f.refused ? 'refused' : 'fetched'}</Badge>
                    <div className="min-w-0 flex-1">
                      {linkable(f.url) && !f.refused ? (
                        <a href={f.url} target="_blank" rel="noopener noreferrer" className="break-all text-blue-ink hover:underline">
                          {f.url}
                        </a>
                      ) : (
                        <span className="break-all font-mono text-[12px] text-ink-2">{f.url}</span>
                      )}
                      {f.refused && <div className="text-[11.5px] text-ink-3">{f.refused}</div>}
                    </div>
                    <span className="text-[11.5px] text-ink-3">{f.host}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function RunResearch({ id }: { id: string }) {
  const [data, setData] = useState<RunResearchData | { error: string } | null>(null);
  useEffect(() => {
    api<RunResearchData>(`/api/runs/${encodeURIComponent(id)}/research`)
      .then(setData)
      .catch((e: Error) => setData({ error: e.message }));
  }, [id]);
  return <RunResearchView data={data} />;
}
