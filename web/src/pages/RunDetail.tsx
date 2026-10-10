import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type RunRecord, type RunSummary } from '../api';
import { navigate } from '../App';
import { ago, Badge, Card, Empty, EST_NOTE, estUsd } from '../components/ui';
import { Header } from './Overview';

const REASON_TONE = (r: string | null) => (r === 'succeeded' ? 'ok' : r === null ? 'neutral' : 'danger');

/** An issue's agent runs, oldest first, each linking to what it did. */
export function RunList({ issue, lastId }: { issue: number; lastId: number }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    api<RunSummary[]>(`/api/runs?issue=${issue}`)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [issue, lastId]);
  return (
    <Card>
      <div className="border-b px-4 py-2.5 text-sm font-medium">Agent runs</div>
      {runs.length ? (
        <ol className="divide-y">
          {runs.map((r) => (
            <li key={r.id}>
              <button className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-accent" onClick={() => navigate(`/runs/${r.id}`)}>
                <span className="w-24 shrink-0 font-medium">{r.role}</span>
                <Badge tone={REASON_TONE(r.reason)}>{r.reason ?? 'running'}</Badge>
                <span className="text-xs text-muted-foreground">
                  {r.commands} command(s){r.failedCommands ? `, ${r.failedCommands} failed` : ''} · {r.files.length} file(s) written
                </span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground" title={EST_NOTE}>
                  {r.costUsd !== null ? estUsd(r.costUsd) : ''}
                </span>
                <span className="w-16 text-right text-xs text-muted-foreground" title={r.startedAt}>
                  {ago(r.startedAt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">No recorded runs.</div>
      )}
    </Card>
  );
}

/** One agent run: every command with how it ended and its first output lines, the files written, the final message. */
export function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord | null | undefined>(undefined);
  useEffect(() => {
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`)
      .then(setRun)
      .catch(() => setRun(null));
  }, [id]);
  const back = run?.issue ? `/issues/${run.issue}` : '/agents';
  return (
    <div>
      <Header title={run ? `${run.role} run` : 'Run'} sub={run ? `${run.issue ? `#${run.issue} · ` : ''}${run.model} · started ${ago(run.startedAt)}` : ''}>
        <button onClick={() => navigate(back)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back
        </button>
      </Header>
      <div className="space-y-4 p-6">
        {run === undefined && <div className="text-sm text-muted-foreground">Loading…</div>}
        {run === null && <Empty title="No such run" hint="Runs are kept for the most recent 500." />}
        {run && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={REASON_TONE(run.reason)}>{run.reason ?? 'running'}</Badge>
              {run.turns !== null && <span className="text-muted-foreground">{run.turns} turn(s)</span>}
              {run.costUsd !== null && (
                <span className="text-muted-foreground" title={EST_NOTE}>
                  {estUsd(run.costUsd)}
                </span>
              )}
              {run.otherTools > 0 && <span className="text-muted-foreground">{run.otherTools} read/search call(s) not listed</span>}
              {run.truncated && <Badge tone="warn">long run: later steps not recorded</Badge>}
            </div>
            <Card>
              <div className="border-b px-4 py-2.5 text-sm font-medium">Steps</div>
              {run.steps.length ? (
                <ol className="divide-y">
                  {run.steps.map((s, i) => (
                    <li key={i} className="px-4 py-2">
                      <div className="flex items-start gap-2">
                        <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>{s.kind === 'write' ? s.tool : s.exitCode !== null ? `exit ${s.exitCode}` : s.status}</Badge>
                        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs">{s.kind === 'command' ? `$ ${s.what}` : s.what}</code>
                      </div>
                      {s.kind === 'command' && s.output && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-snug">{s.output}</pre>}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="p-4 text-sm text-muted-foreground">No commands or writes.</div>
              )}
            </Card>
            <Card className="p-4">
              <div className="text-xs font-medium text-muted-foreground">Files written</div>
              {run.files.length ? (
                <ul className="mt-1 space-y-0.5 font-mono text-xs">
                  {run.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 text-sm text-muted-foreground">none</div>
              )}
            </Card>
            <Card className="p-4">
              <div className="text-xs font-medium text-muted-foreground">Final message</div>
              <div className="mt-1 whitespace-pre-wrap text-sm">{run.final || <span className="text-muted-foreground">none</span>}</div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
