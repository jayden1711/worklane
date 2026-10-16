// WHY: Extend -> Experiments (docs/experiments.md). The server sends this view to owners and writers only, with the
// actions this person may use (`actions`): the page shows those buttons and no others. Every action is reviewed first
// (the server says exactly what changes; nothing is written) and confirmed against what that review saw.
import { useState } from 'react';
import { changeExperiment, useView, type ExpAction, type ExpLogRow, type ExpPlan, type ExperimentsView, type ExpStudy, type State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Button, Card, cx, usd } from './ui';

const ACTION_LABEL: Record<ExpAction, string> = { start: 'Start', pause: 'Pause', resume: 'Resume', stop_job: 'Stop job', approve: 'Approve job', decline: 'Decline job', archive: 'Archive' };
type Started = Extract<ExpStudy, { started: true }>;

const EXAMPLE = `version: 1
studies:
  - id: example-speed
    goal: "Lower validation loss at a fixed training budget"
    metric: { name: val_loss, direction: min, min_delta: 0.002 }
    eval:
      predict: "python eval/predict.py --ckpt $OUT/ckpt --inputs $EVAL_INPUTS --out $PRED"
      score: "python eval/score.py --pred $PRED --labels $LABELS"
      files: [eval/score.py, eval/predict.py]
      inputs: eval-inputs
      labels: eval-labels
    train:
      command: "python train.py --config $CONFIG --data $DATA --out $OUT"
      data: [train-set]
      env: { lockfile: uv.lock, build: "uv sync --frozen" }
    editable: ["train.py", "model/**"]
    budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 }
`;

/** What a reviewed change is called: a held result's verdict reads as accept or reject, not as a job's approval. */
const planLabel = (p: ExpPlan) => (p.changes[0]?.startsWith('result #') ? (p.action === 'approve' ? 'accept result' : 'reject result') : ACTION_LABEL[p.action].toLowerCase());
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : String(Number(n.toPrecision(5))));

function CopyButton({ text, label, ...p }: { text: string; label: string; 'data-testid': string }) {
  const [done, setDone] = useState(false);
  return (
    <Button className="mt-4" onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true))} {...p}>
      {done ? 'Copied' : label}
    </Button>
  );
}

export function ExperimentsTab({ state, id }: { state: State; id: string | null }) {
  const { data, error } = useView<ExperimentsView>('/api/experiments', state.lastId);
  if (error) return <p className="text-[12.5px] text-red" data-testid="experiments-error">{error}</p>;
  if (!data) return <p className="text-[12.5px] text-ink-3">Loading…</p>;
  if (data.unavailable) return <p className="text-[12.5px] text-ink-3" data-testid="experiments-unavailable">{data.unavailable}</p>;
  const owner = data.actions.includes('start');
  const selected = id ? (data.studies.find((s) => s.id === id) ?? null) : null;
  if (selected) return <StudyPage s={selected} actions={data.actions} />;
  if (!data.studies.length) {
    // The empty state: one action. Not set up on this machine: the root command; else: an example study to commit.
    const off = data.setup.state !== 'on';
    return (
      <div className="rounded-card bg-inset p-8 text-center shadow-hairline" data-testid="experiments-empty">
        <div className="text-[14px] font-medium text-ink">No experiments yet</div>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-ink-2">A study lets an agent improve one number for you. You fix the goal, the eval and the budget. Each round the agent tries one idea, a sandboxed job runs it on this machine's GPU, and the result is kept only if it beats the best so far.</p>
        <ul className="mx-auto mt-3 max-w-sm space-y-0.5 text-left text-[12px] text-ink-2">
          <li>· The eval and the data are read-only to agents and jobs.</li>
          <li>· Each job has a time cap, no network and its own output folder.</li>
          <li>· You approve big jobs and the first job of every study.</li>
        </ul>
        {off ? (
          owner ? (
            <>
              <CopyButton text={data.setup.commands.install} label="Copy setup command" data-testid="experiments-copy-setup" />
              <p className="mt-2 text-[12px] text-ink-3" data-testid="experiments-setup-why">
                {data.setup.why} Run it in a root shell, then come back.
              </p>
            </>
          ) : (
            <p className="mt-4 text-[12.5px] text-ink-3" data-testid="experiments-owner-only">
              An owner of this machine sets experiments up.
            </p>
          )
        ) : (
          <>
            <CopyButton text={EXAMPLE} label="Copy an example study" data-testid="experiments-copy-example" />
            <p className="mt-2 text-[12px] text-ink-3">Studies are defined in the repo's experiments.yaml (an owner merges it); an owner then starts one here.</p>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="experiments">
      {data.error && <p className="text-[12.5px] text-red" data-testid="experiments-file-error">{data.error}</p>}
      {data.setup.state !== 'on' && (
        <p className="rounded-lg bg-orange-tint p-3 text-[12.5px] text-ink" data-testid="experiments-setup-off">
          {data.setup.why} {owner ? <span className="font-mono text-[11.5px]">{data.setup.commands.install}</span> : 'An owner of this machine sets experiments up.'}
        </p>
      )}
      <ul className="grid gap-2 sm:grid-cols-2" data-testid="experiments-list">
        {data.studies.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => navigate(`/extend/experiments/${s.id}`)} className="w-full rounded-lg bg-surface p-3 text-left shadow-hairline hover:bg-hover" data-testid="experiment-row" data-id={s.id}>
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <span className={cx('size-2 shrink-0 rounded-full', !s.started ? 'bg-ink-3' : s.paused || s.broken ? 'bg-orange' : 'bg-green')} />
                <span className="truncate">{s.id}</span>
                <span className="ml-auto shrink-0 text-[12px] font-normal text-ink-3">{s.started ? (s.best ? `best ${fmt(s.best.value)}` : 'no result yet') : 'not started'}</span>
              </div>
              <div className="mt-0.5 truncate text-[12px] text-ink-3">{s.goal}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StudyPage({ s, actions }: { s: ExpStudy; actions: ExpAction[] }) {
  const [plan, setPlan] = useState<ExpPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const review = async (action: ExpAction) => {
    setErr(null);
    setBusy(true);
    try {
      setPlan(await changeExperiment({ action, study: s.id }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await changeExperiment({ action: plan.action, study: s.id, ...(plan.digest ? { digest: plan.digest } : {}), confirm: true });
      setPlan(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Only the actions that apply right now: no dead buttons.
  const shown = actions.filter((a) => {
    if (!s.started) return a === 'start' && !s.startRefused;
    if (a === 'start') return !!s.hold?.startsWith('the study, its eval or its data changed');
    if (a === 'pause') return !s.paused;
    if (a === 'resume') return s.paused || s.broken;
    if (a === 'stop_job') return s.phase === 'running';
    if (a === 'approve' || a === 'decline') return s.phase === 'awaiting_approval' || !!s.held;
    if (a === 'archive') return s.phase !== 'running';
    return false;
  });
  return (
    <div className="min-w-0 space-y-4" data-testid="experiment-detail" data-id={s.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="w-full text-left text-[12px] text-ink-3 hover:text-ink" onClick={() => navigate('/extend/experiments')} data-testid="experiment-back">
          ← All studies
        </button>
        <h2 className="text-[15px] font-semibold text-ink">{s.id}</h2>
        {s.started ? <Badge tone={s.paused || s.broken || s.phase === 'awaiting_approval' || s.held ? 'warn' : s.phase === 'idle' && s.hold ? 'neutral' : 'ok'}>{s.broken ? 'Paused: 3 failures' : s.paused ? 'Paused' : s.phase === 'running' ? 'Running' : s.phase === 'awaiting_approval' || s.held ? 'Waiting for you' : 'On'}</Badge> : <Badge>Not started</Badge>}
        {s.started && <span className="text-[12px] text-ink-3">version {s.version.slice(0, 8)} · {Math.round(s.exploration.share * 100)}% of runs explore</span>}
        <div className="flex w-full flex-wrap gap-1.5 sm:ml-auto sm:w-auto" data-testid="experiment-actions">
          {shown.map((a) => (
            <Button key={a} size="sm" variant={a === 'start' || a === 'approve' || a === 'resume' ? 'default' : 'outline'} className={cx((a === 'stop_job' || a === 'decline') && 'text-red')} disabled={busy} onClick={() => void review(a)} data-testid={`experiment-${a}`}>
              {s.started && s.held && a === 'approve' ? 'Accept result' : s.started && s.held && a === 'decline' ? 'Reject result' : ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-[12.5px] text-ink-2">
        {s.goal} · <span className="font-mono text-[11.5px]">{s.metric.name}</span> {s.metric.direction === 'min' ? '↓ lower is better' : '↑ higher is better'} · {s.kind.replace('_', '-')} · screen 1 seed, then {s.screen.seeds}+{s.screen.seeds} seeds{s.ladder.length ? ` · sizes ${s.ladder.join(' → ')}` : ''}
      </p>
      {err && <p className="text-[12.5px] text-red" data-testid="experiment-error">{err}</p>}
      {plan && (
        <div className="max-w-xl space-y-2 rounded-lg bg-blue-tint p-3" data-testid="experiment-review">
          <div className="text-[12.5px] font-medium text-ink">Review: {planLabel(plan)}</div>
          <ul className="space-y-0.5 text-[12.5px] text-ink" data-testid="experiment-review-summary">
            {plan.summary.map((l) => (
              <li key={l} className="break-words">
                {l}
              </li>
            ))}
          </ul>
          {plan.changes.length > 0 && (
            <ul className="space-y-0.5 font-mono text-[11.5px] text-ink-2" data-testid="experiment-review-changes">
              {plan.changes.map((c) => (
                <li key={c} className="break-all">
                  {c}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPlan(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void confirm()} disabled={busy} data-testid="experiment-confirm">
              Confirm {planLabel(plan)}
            </Button>
          </div>
        </div>
      )}
      {!s.started ? (
        <Card className="space-y-1 p-4 text-[12.5px] text-ink-2" data-testid="experiment-not-started">
          <p>
            Each job: at most {s.job.max_minutes} min on {s.job.gpus} GPU(s), {s.job.output_gb} GB of output. Budget: {usd(s.budget.agent_usd_per_day)} a day for its sessions, {s.budget.gpu_hours_per_day} GPU-hours a day.
          </p>
          <p>A job may change only: {s.editable.join(', ')}.</p>
          {s.startRefused && <p className="text-orange">Can't start on this machine yet: {s.startRefused}</p>}
        </Card>
      ) : (
        <Started s={s} />
      )}
    </div>
  );
}

function Started({ s }: { s: Started }) {
  const delta = s.best && s.baseline?.value ? ((s.best.value - s.baseline.value) / Math.abs(s.baseline.value)) * 100 : null;
  return (
    <>
      {s.held && (
        <Card className="space-y-1 p-3 text-[12.5px]" data-testid="experiment-held">
          <div className="font-medium text-ink">
            Result #{s.held.n} is held for your review: {s.held.hypothesis}
          </div>
          <div className="text-ink-2">{s.held.why}</div>
          {s.held.stage2.map((x) => (
            <div key={x.size} className="font-mono text-[11.5px] text-ink-2">
              size {x.size + 1}: {fmt(x.meanCandidate)} ± {fmt(x.spread)} vs best {fmt(x.meanBest)} · {x.seeds} seeds each · {x.minutesCandidate.toFixed(1)} / {x.minutesBest.toFixed(1)} GPU-min
            </div>
          ))}
          {s.held.monitor && <div className={s.held.monitor.flagged ? 'text-orange' : 'text-ink-3'}>Monitor: {s.held.monitor.flagged ? s.held.monitor.findings.join(' · ') || 'flagged' : 'nothing found'}</div>}
          <div className="text-ink-3">Accept result shows its change and run record first; nothing counts until you confirm.</div>
        </Card>
      )}
      {s.hold && s.phase === 'idle' && (
        <p className="rounded-lg bg-orange-tint p-3 text-[12.5px] text-ink" data-testid="experiment-hold">
          No new round starts: {s.hold}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="min-w-0 p-3" data-testid="experiment-best">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Best so far</h3>
          {s.best ? (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[22px] font-semibold tabular-nums text-ink">{fmt(s.best.value)}</span>
                {delta !== null && delta !== 0 && <span className="text-[12px] font-medium text-green">{`${delta > 0 ? '+' : ''}${delta.toFixed(1)}% vs baseline`}</span>}
              </div>
              <div className="text-[11.5px] text-ink-2">job #{s.best.n}</div>
              <BestChart points={s.points} direction={s.metric.direction} />
            </>
          ) : (
            <p className="mt-1 text-[12.5px] text-ink-3">No result yet: the first job is the baseline.</p>
          )}
          <div className="mt-1 text-[11.5px] text-ink-2">
            {s.counts.jobs} jobs · {s.counts.kept} kept · {s.counts.screened} screened out · {s.counts.explore} explore · {s.counts.crash} crash
          </div>
        </Card>
        <Card className="min-w-0 p-3" data-testid="experiment-queue">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Queue</h3>
          <ul className="mt-1 space-y-1.5 text-[12px] text-ink">
            {!s.current && <li className="text-ink-3">{s.hold ? 'Nothing: held.' : 'Nothing now: the next round starts at the next pass.'}</li>}
            {s.current && (
              <li data-testid="experiment-current">
                <Badge tone={s.phase === 'awaiting_approval' ? 'warn' : 'info'}>{s.phase === 'awaiting_approval' ? 'needs you' : s.phase.replace('_', ' ')}</Badge> #{s.current.n} {s.current.hypothesis || s.current.kind}
                <div className="text-[11.5px] text-ink-3">
                  {s.phase === 'running' ? `running since ${ago(s.current.since)}, at most ${s.job.max_minutes} min` : s.phase === 'awaiting_approval' ? `why: ${s.current.approval.join('; ')}` : s.phase === 'queued' ? 'waiting for the GPU (test runs share its lock)' : 'the agent is proposing one change'}
                </div>
              </li>
            )}
            {s.current && <li className="text-[11.5px] text-ink-3">Next: a new round starts when #{s.current.n} is recorded.</li>}
          </ul>
        </Card>
        <Card className="min-w-0 p-3" data-testid="experiment-spend">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Spend today</h3>
          <Meter label="Agent" value={s.spend.agentToday} max={s.spend.agentPerDay} text={`${usd(s.spend.agentToday)} of ${usd(s.spend.agentPerDay)}`} />
          <Meter label="GPU" value={s.spend.gpuHoursToday} max={s.spend.gpuHoursPerDay} text={`${s.spend.gpuHoursToday.toFixed(1)} h of ${s.spend.gpuHoursPerDay} h`} />
          <Meter label="Agent, in all" value={s.spend.agentTotal} max={s.spend.agentAll} text={`${usd(s.spend.agentTotal)} of ${usd(s.spend.agentAll)}`} />
          <Meter label="Jobs" value={s.spend.jobs} max={s.spend.maxJobs} text={`${s.spend.jobs} of ${s.spend.maxJobs}`} />
        </Card>
      </div>
      <ResearchLog rows={s.log} />
    </>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="mt-1.5">
      <div className="flex justify-between text-[12px]">
        <span className="text-ink-2">{label}</span>
        <b className="font-medium tabular-nums text-ink">{text}</b>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-hover-2" aria-hidden="true">
        <i className={cx('block h-full rounded', pct >= 90 ? 'bg-orange' : 'bg-blue')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Best over the scored jobs: kept results on the step line, the rest as faint dots. */
function BestChart({ points, direction }: { points: { n: number; value: number | null; kept: boolean }[]; direction: 'min' | 'max' }) {
  const ps = points.filter((p): p is { n: number; value: number; kept: boolean } => p.value !== null);
  if (ps.length < 2) return null;
  const vs = ps.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const W = 240;
  const H = 56;
  const x = (i: number) => 4 + (i / (ps.length - 1)) * (W - 8);
  const y = (v: number) => (hi === lo ? H / 2 : direction === 'min' ? 4 + ((hi - v) / (hi - lo)) * (H - 8) : 4 + ((v - lo) / (hi - lo)) * (H - 8));
  let best: number | null = null;
  const steps: string[] = [];
  ps.forEach((p, i) => {
    if (p.kept && (best === null || (direction === 'min' ? p.value < best : p.value > best))) best = p.value;
    if (best !== null) steps.push(`${steps.length ? 'L' : 'M'}${x(i).toFixed(1)} ${(H - y(best)).toFixed(1)}`);
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-label={`Best ${direction === 'min' ? 'lowest' : 'highest'} result over ${ps.length} scored jobs`} data-testid="experiment-chart">
      {ps.map((p, i) => !p.kept && <circle key={p.n} cx={x(i)} cy={H - y(p.value)} r="1.8" fill="var(--ink-3)" opacity="0.45" />)}
      <path d={steps.join(' ')} fill="none" stroke="var(--blue)" strokeWidth="2" />
      {ps.map((p, i) => p.kept && <circle key={`k${p.n}`} cx={x(i)} cy={H - y(p.value)} r="2.4" fill="var(--blue)" />)}
    </svg>
  );
}

const DECISION_TONE: Record<string, 'ok' | 'neutral' | 'danger' | 'info' | 'warn'> = { keep: 'ok', discard: 'neutral', screened_out: 'neutral', crash: 'danger', refused: 'danger', stopped: 'warn', running: 'info', stage2: 'info', ladder: 'info', seed: 'info', winner: 'ok', held: 'warn', waiting: 'warn', queued: 'info', session: 'info' };

function ResearchLog({ rows }: { rows: ExpLogRow[] }) {
  if (!rows.length) return null;
  return (
    <section data-testid="experiment-log">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Research log</h3>
        <span className="text-[11.5px] text-ink-3">newest first · each entry written by the coordinator from the proposal and the job's record</span>
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              {['#', 'Kind', 'Hypothesis', 'Change', 'Config', 'Budget a run', 'Result', 'Decision'].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n} className="border-b border-line align-top" data-testid="experiment-log-row">
                <td className="px-2 py-1.5 tabular-nums text-ink-3">{r.n}</td>
                <td className="px-2 py-1.5">{r.kind === 'explore' ? <Badge tone="warn">explore</Badge> : r.kind}</td>
                <td className="px-2 py-1.5 text-ink" title={r.motivation}>
                  {r.hypothesis}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11.5px]">
                  {r.change.files.join(', ') || '–'} {r.change.commit?.slice(0, 7)}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11.5px]">{Object.entries(r.config).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}</td>
                <td className="px-2 py-1.5 tabular-nums">
                  {r.minutes === null ? '–' : `${r.minutes.toFixed(0)} GPU-min${r.waited_s ? ` · waited ${Math.round(r.waited_s / 60)}` : ''}`}
                  {r.stage2.map((x) => (
                    <span key={x.size} className="block text-[11px] text-ink-3">
                      {x.minutesCandidate.toFixed(0)} / {x.minutesBest.toFixed(0)} GPU-min ({x.seeds}+{x.seeds} runs)
                    </span>
                  ))}
                </td>
                <td className="px-2 py-1.5 font-mono tabular-nums">
                  {fmt(r.result)}
                  <span className="block text-[11px] text-ink-3">{r.stage === 1 ? 'stage 1 · 1 seed' : r.stage === 0 ? 'baseline' : ''}</span>
                  {r.stage2.map((x) => (
                    <span key={x.size} className="block text-[11px] text-ink-2" data-testid="experiment-stage2">
                      stage 2{r.stage2.length > 1 || x.size > 0 ? ` · size ${x.size + 1}` : ''}: {fmt(x.meanCandidate)} ± {fmt(x.spread)} vs {fmt(x.meanBest)}
                    </span>
                  ))}
                </td>
                <td className="px-2 py-1.5">
                  <Badge tone={DECISION_TONE[r.decision] ?? 'neutral'}>{r.decision.replace('_', ' ')}</Badge>
                  {r.why && <span className="mt-0.5 block text-[11px] text-ink-3">{r.why}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.n} className="rounded-lg p-2.5 shadow-hairline" data-testid="experiment-log-card">
            <div className="text-[12.5px] font-medium text-ink">
              #{r.n} {r.kind} · {r.decision.replace('_', ' ')}
            </div>
            <div className="text-[12px] text-ink-2">
              {r.hypothesis} → {fmt(r.result)}
              {r.stage2.map((x) => ` · stage 2: ${fmt(x.meanCandidate)} ± ${fmt(x.spread)} vs ${fmt(x.meanBest)}`).join('')}
            </div>
            {r.why && <div className="text-[11px] text-ink-3">{r.why}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
