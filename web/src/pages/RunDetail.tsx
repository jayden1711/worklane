import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type RunRecord, type RunSummary } from '../api';
import { navigate } from '../App';
import { FileChip, Loading, StatusMark, TaskRow, ToolRow, type MarkState } from '../components/patterns';
import { ago, Badge, Card, Empty, EST_NOTE, estUsd } from '../components/ui';
import { LiveRun } from '../components/LiveRun';
import { Header } from './Overview';

const markFor = (reason: string | null): MarkState => (reason === null ? 'running' : reason === 'succeeded' ? 'done' : 'failed');

/** An issue's agent runs as task rows (Beautiful UI's task rows), oldest first; each opens what it did. */
export function RunList({ issue, lastId }: { issue: number; lastId: number }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    api<RunSummary[]>(`/api/runs?issue=${issue}`)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [issue, lastId]);
  return (
    <Card className="overflow-hidden" data-testid="runs-card">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Agent runs</div>
      {runs.length ? (
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
export function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord | null | undefined>(undefined);
  // Live while the coordinator runs it (its record is written when it ends); the stored record afterwards.
  const [live, setLive] = useState<boolean | undefined>(undefined);
  const loadRecord = () =>
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`)
      .then(setRun)
      .catch(() => setRun(null));
  useEffect(() => {
    void loadRecord();
    api<{ live: boolean }>(`/api/runs/${encodeURIComponent(id)}/console`)
      .then((c) => setLive(c.live))
      .catch(() => setLive(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const showLive = live === true && !run;
  const back = run?.issue ? `/issues/${run.issue}` : '/agents';
  const commands = run?.steps.filter((s) => s.kind === 'command').length ?? 0;
  return (
    <div data-testid="page-run-detail">
      <Header title={run ? `${run.role} run` : showLive ? 'Live run' : 'Run'} sub={run ? `${run.issue ? `#${run.issue} · ` : ''}${run.model} · started ${ago(run.startedAt)}` : showLive ? 'live: what the agent does, as it does it' : ''}>
        <button onClick={() => navigate(back)} className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Back
        </button>
      </Header>
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {showLive && <LiveRun run={id} onEnded={() => void loadRecord()} />}
        {!showLive && (run === undefined || live === undefined) && <Loading />}
        {!showLive && run === null && live === false && <Empty title="No such run" hint="Runs are kept for the most recent 500." />}
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
