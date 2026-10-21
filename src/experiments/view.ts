// The Experiments page, the dashboard's side: what a study's page shows (its log, best so far, queue and spend) and
// every change a person makes, as a plan that writes nothing and a confirm that re-plans against what the plan saw.
// Who may do what is here too, so the page and the tests share one rule: owners start, resume, approve, decline and
// archive; writers (and owners) pause and stop a running job, the safe direction; viewers nothing (403, no nav item).
import { createHash } from 'node:crypto';
import { execFileSync } from '../os/child-process.js';
import type { Role } from '../dashboard-auth.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { commitText } from '../coordinator/change-files.js';
import { currentPin, readStudies, usedBy } from '../coordinator/experiments.js';
import { BRAND } from '../brand.js';
import { rootRefusal } from './approval.js';
import { readRootFile, rootCommands, type RootState } from './root-file.js';
import { foldStudy, sessionHold, type LogEntry, type StudyState } from './state.js';
import { applyPins, loadPins, planPins, type Pin } from './store.js';
import type { Study } from './study.js';

export const EXP_ACTIONS = ['start', 'pause', 'resume', 'stop_job', 'approve', 'decline', 'archive'] as const;
export type ExpAction = (typeof EXP_ACTIONS)[number];

/** INVARIANT: the one rule for who may do what. */
export function mayDoExp(action: ExpAction, role: Role | null | undefined): boolean {
  if (role === 'owner') return true;
  if (role === 'writer') return action === 'pause' || action === 'stop_job';
  return false;
}

export class ExperimentsError extends Error {}

export interface ExpSite {
  /** The coordinator's checkout: studies are read from its default branch's tip, as fetched. */
  repo: string;
  branch: string;
  instance: string;
  pinsFile: string;
  root?: () => RootState;
}

/**
 * Whether experiments are on for this dashboard's instance: root's file lists it (`setup.state === 'on'`). Off, unknown
 * or no experiments site at all (a checkout, a same-user instance): false, so the sidebar hides Experiments (fail closed).
 */
export function experimentsOn(site: ExpSite | undefined): boolean {
  return !!site && (site.root ?? (() => readRootFile(site.instance)))().state === 'on';
}

/** Why a dashboard has no experiments: only a checkout or a same-user instance has none (#563), and it says which. */
export const noExperimentsHere = (instance: string | undefined) =>
  `experiments are a server instance's (separate users): ${instance ? `the instance ${instance} runs as this dashboard's user` : 'this dashboard serves a checkout'}`;

const show = (repo: string) => (commit: string, path: string) => {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};
/** A commit's change as Review shows it: the stat and the patch, cut to 120 lines. */
const diffOf = (repo: string, commit: string | null): string[] => {
  if (!commit) return [];
  try {
    return commitText(repo, commit).split('\n').slice(0, 120);
  } catch {
    return [`(the commit ${commit.slice(0, 12)} isn't in this checkout)`];
  }
};
const tipOf = (site: ExpSite) => {
  try {
    return execFileSync('git', ['rev-parse', `origin/${site.branch}`], { cwd: site.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const finiteOr = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : x);
/** A log row: stage 1's one run, and each stage-2 size's mean ± spread of both arms with the budget each used. */
const row = (e: LogEntry, entries: LogEntry[]) => ({
  n: e.n,
  kind: e.kind,
  at: e.ts,
  hypothesis: e.hypothesis,
  variable: e.variable,
  motivation: e.motivation,
  change: { commit: e.commit, files: e.files },
  config: e.config,
  minutes: e.gpu_minutes,
  waited_s: e.waited_s,
  result: e.result,
  decision: e.decision,
  why: e.why,
  step: e.step,
  parent: e.parent,
  stage: e.stage2?.length ? 2 : e.kind === 'baseline' ? 0 : 1,
  stage2: (e.stage2 ?? []).map((x) => ({ ...x, meanCandidate: finiteOr(x.meanCandidate), meanBest: finiteOr(x.meanBest), spread: finiteOr(x.spread) })),
  seeds: entries.filter((x) => x.kind === 'seed' && x.of === e.n).length,
});

/** The study's state now, and why no session would start (null: one would, at the next pass). */
function stateOf(events: StoredEvent[], _s: Study, pin: Pin): StudyState {
  return foldStudy(events, _s.id, pin.version);
}

/** The page's data: the machine's setup, each study (started or not), and this person's actions. */
export function experimentsView(o: { site: ExpSite; events: StoredEvent[]; role: Role; now: Date }) {
  const root = (o.site.root ?? (() => readRootFile(o.site.instance)))();
  const pins = loadPins(o.site.pinsFile);
  const tip = tipOf(o.site);
  const defs = tip ? readStudies({ show: show(o.site.repo), configDir: BRAND.configDir }, tip) : { error: 'the default branch is not fetched yet' };
  const pinned = 'error' in pins ? {} : pins.pins.studies;
  const studies = 'error' in defs ? [] : defs.studies;
  return {
    setup: { state: root.state, why: root.state === 'on' ? null : root.why, commands: rootCommands(o.site.instance), devices: root.state === 'on' ? root.file.devices : [] },
    error: 'error' in pins ? pins.error : 'error' in defs ? defs.error : null,
    actions: EXP_ACTIONS.filter((a) => mayDoExp(a, o.role)),
    approve: 'error' in pins ? null : pins.pins.approve,
    studies: studies.map((s) => {
      const pin = pinned[s.id];
      const base = { id: s.id, goal: s.goal, kind: s.kind, metric: s.metric, job: s.job, budget: s.budget, exploration: s.exploration, screen: s.screen, ladder: s.ladder.map((z) => z.name), editable: s.editable };
      const canStart = rootRefusal(s, root.state === 'on' ? root.file : null);
      if (!pin) return { ...base, started: false as const, startRefused: canStart };
      const st = stateOf(o.events, s, pin);
      const now = tip ? currentPin({ show: show(o.site.repo) }, s, tip, root) : { error: 'not fetched' };
      const drift = 'error' in now ? now.error : now.pin.version !== pin.version ? 'the study, its eval or its data changed since it was started: review the new version to go on' : null;
      const used = usedBy(o.events, s.id, st, o.now);
      const cur = st.entries.find((e) => e.n === st.current) ?? null;
      const started = o.events.filter((e) => e.type === 'experiment.job_started' && (e.payload as EventPayload<'experiment.job_started'>).study === s.id).at(-1);
      const kept = st.entries.filter((e) => e.decision === 'keep');
      return {
        ...base,
        started: true as const,
        version: pin.version,
        startedBy: pin.started_by,
        phase: st.phase,
        paused: st.paused,
        archived: st.archived,
        broken: st.broken,
        hold: drift ?? sessionHold(st) ?? canStart,
        best: st.best,
        baseline: kept[0] ? { n: kept[0].n, value: kept[0].value ?? kept[0].result } : null,
        current: cur ? { n: cur.n, job: cur.job, kind: cur.kind, hypothesis: cur.hypothesis, approval: cur.approval, since: st.phase === 'running' && started ? started.ts : cur.ts } : null,
        // A result held for review: what the owner reads before accepting it (the run record, the change, the monitor).
        held: (() => {
          const h = st.entries.find((e) => e.decision === 'held');
          if (!h) return null;
          const mon = o.events.filter((e) => e.type === 'experiment.monitor' && (e.payload as { study?: string; n?: number }).study === s.id && (e.payload as { n?: number }).n === h.n).map((e) => e.payload as { flagged: boolean; findings: string[] });
          return { n: h.n, hypothesis: h.hypothesis, variable: h.variable, why: h.why, commit: h.commit, files: h.files, stage2: row(h, st.entries).stage2, monitor: mon.at(-1) ?? null };
        })(),
        spend: { agentToday: used.agent_usd_today, agentPerDay: s.budget.agent_usd_per_day, agentTotal: used.agent_usd_total, agentAll: s.budget.agent_usd_total, gpuHoursToday: used.gpu_hours_today, gpuHoursPerDay: s.budget.gpu_hours_per_day, jobs: used.jobs, maxJobs: s.budget.max_jobs },
        counts: { jobs: st.entries.filter((e) => e.job).length, kept: kept.length, explore: st.entries.filter((e) => e.kind === 'explore').length, crash: st.entries.filter((e) => e.decision === 'crash').length, screened: st.entries.filter((e) => e.decision === 'screened_out').length },
        // The best's steps over the entries (kept points), and every scored result, for the chart.
        points: st.entries.filter((e) => e.kind !== 'seed' && e.result !== null).map((e) => ({ n: e.n, value: e.value ?? e.result, kept: e.decision === 'keep' })),
        // The entry in flight says where it is (waiting for approval, queued, running), not just "running". Seeds
        // are folded into their candidate's row (its stage-2 numbers), so the log reads one row per hypothesis.
        log: [...st.entries].filter((e) => e.kind !== 'seed' || e.n === st.current).reverse().slice(0, 100).map((e) => ({ ...row(e, st.entries), ...(e.n === st.current ? { decision: st.phase === 'awaiting_approval' ? 'waiting' : st.phase } : {}) })),
      };
    }),
  };
}

export interface ExpChange {
  action: ExpAction;
  study: string;
}

/** A study's events' last id: a review of an event-only change is pinned to it. */
const stamp = (events: StoredEvent[], study: string) => String(events.filter((e) => (e.payload as { study?: string }).study === study).at(-1)?.id ?? 0);
const digest = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

/** What a change would do, in plain words, and the digest a confirm must carry. Writes nothing. */
export function planExperiment(o: { site: ExpSite; events: StoredEvent[]; req: ExpChange; by: string; now: Date }): { summary: string[]; changes: string[]; digest: string } {
  const { site, events, req } = o;
  const tip = tipOf(site);
  if (!tip) throw new ExperimentsError('the default branch is not fetched yet');
  const defs = readStudies({ show: show(site.repo), configDir: BRAND.configDir }, tip);
  if ('error' in defs) throw new ExperimentsError(defs.error);
  const s = defs.studies.find((x) => x.id === req.study);
  if (!s) throw new ExperimentsError(`no study ${req.study} in ${BRAND.configDir}/experiments.yaml on the default branch`);
  const pins = loadPins(site.pinsFile);
  if ('error' in pins) throw new ExperimentsError(pins.error);
  const pin = pins.pins.studies[s.id];
  if (req.action === 'start') {
    const root = (site.root ?? (() => readRootFile(site.instance)))();
    const why = rootRefusal(s, root.state === 'on' ? root.file : null);
    if (why) throw new ExperimentsError(why);
    const now = currentPin({ show: show(site.repo) }, s, tip, root);
    if ('error' in now) throw new ExperimentsError(now.error);
    if (pin?.version === now.pin.version) throw new ExperimentsError(`${s.id} is started at this version already`);
    const plan = planPins(site.pinsFile, (p) => ({ ...p, studies: { ...p.studies, [s.id]: { ...now.pin, started_by: o.by, started_at: o.now.toISOString() } } }));
    if ('error' in plan) throw new ExperimentsError(plan.error);
    return {
      summary: [
        `${pin ? 'Starts a new version of' : 'Starts'} ${s.id}: ${s.goal}`,
        `Metric ${s.metric.name}, ${s.metric.direction === 'min' ? 'lower' : 'higher'} is better; kept only when it beats the best by more than ${s.metric.min_delta}.`,
        `Each job: at most ${s.job.max_minutes} min on ${s.job.gpus} GPU(s), ${s.job.output_gb} GB of output, no network.`,
        `Budget: $${s.budget.agent_usd_per_day} a day and $${s.budget.agent_usd_total} in all for its sessions, ${s.budget.gpu_hours_per_day} GPU-hours a day, ${s.budget.max_jobs} jobs.`,
        `${Math.round(s.exploration.share * 100)}% of its sessions explore. A candidate is screened on one seed (it must beat the best by ${s.screen.margin}), then run ${s.screen.seeds} times against ${s.screen.seeds} runs of the best at the same budget${s.ladder.length ? `, at each size (${s.ladder.map((z) => z.name).join(', ')})` : ''}; it counts only past the seeds' spread.`,
        `Kind: ${s.kind.replace('_', '-')}. The scorer reads only safetensors, npy/npz (numeric), csv, json, jsonl or txt predictions.`,
        'The first job (the baseline) waits for your approval; so does any job with more than one GPU, an output quota over 20 GB or a lockfile change.',
        ...(pin ? ['The best starts over at the new version; the old log stays.'] : []),
      ],
      changes: [`version: ${pin?.version ?? '(none)'} -> ${now.pin.version}`, `commit: ${now.pin.commit.slice(0, 12)}`, ...Object.entries(now.pin.eval_files).map(([f, h]) => `eval ${f}: sha256 ${h.slice(0, 16)}`), ...Object.entries(now.pin.sources).map(([id, h]) => `data ${id}: sha256 ${h.slice(0, 16)}`)],
      digest: digest(plan.before, now.pin.version),
    };
  }
  if (!pin) throw new ExperimentsError(`${s.id} is not started`);
  const st = stateOf(events, s, pin);
  const cur = st.entries.find((e) => e.n === st.current);
  const d = digest(stamp(events, s.id), req.action);
  switch (req.action) {
    case 'pause':
      if (st.paused) throw new ExperimentsError(`${s.id} is paused already`);
      return { summary: [`Pauses ${s.id}: no new session or job starts.`, st.phase === 'running' ? `The running job #${cur?.n} is stopped now (recorded as stopped; never run again by itself).` : 'Nothing is running now.'], changes: ['paused: no -> yes'], digest: d };
    case 'stop_job':
      if (st.phase !== 'running' || !cur?.job) throw new ExperimentsError(`no job of ${s.id} is running`);
      return { summary: [`Stops job #${cur.n} now; it is recorded as stopped and never run again by itself.`, `${s.id} pauses until someone resumes it.`], changes: [`job ${cur.job}: running -> stopped`, 'paused: no -> yes'], digest: d };
    case 'resume':
      if (!st.paused && !st.broken && !st.archived) throw new ExperimentsError(`${s.id} is not paused`);
      return { summary: [`Resumes ${s.id}: the next session starts at the next pass, within its budget.`], changes: ['paused: yes -> no'], digest: d };
    case 'approve':
    case 'decline': {
      // A result held for review first: the owner accepts it (it counts) or rejects it (discarded), having read its
      // run record, its change and the monitor's findings.
      const held = st.entries.find((e) => e.decision === 'held');
      if (held) {
        const mon = events.filter((e) => e.type === 'experiment.monitor' && (e.payload as { study?: string; n?: number }).study === s.id && (e.payload as { n?: number }).n === held.n).map((e) => e.payload as { flagged: boolean; findings: string[] }).at(-1);
        const diff = diffOf(site.repo, held.commit);
        const s2 = (held.stage2 ?? []).map((x) => `size ${x.size + 1}: ${x.meanCandidate.toPrecision(5)} ± ${x.spread.toPrecision(3)} vs best ${x.meanBest.toPrecision(5)} (${x.seeds} seeds each; ${x.minutesCandidate.toFixed(1)} vs ${x.minutesBest.toFixed(1)} GPU-min)`);
        return req.action === 'approve'
          ? { summary: [`Accepts result #${held.n} (${held.hypothesis}): it becomes ${held.after === 'winner' ? 'a winner to combine onto the best' : 'the best'}.`, `Why it was held: ${held.why}`, ...s2, ...(mon ? [`Monitor: ${mon.flagged ? 'flagged' : 'nothing found'}${mon.findings.length ? `: ${mon.findings.join(' | ')}` : ''}`] : [])], changes: [`result #${held.n}: held -> accepted`, ...diff], digest: d }
          : { summary: [`Rejects result #${held.n}: it is discarded and never counts.`], changes: [`result #${held.n}: held -> rejected`], digest: d };
      }
      if (st.phase !== 'awaiting_approval' || !cur?.job) throw new ExperimentsError(`no job of ${s.id} is waiting for approval`);
      return req.action === 'approve'
        ? { summary: [`Approves job #${cur.n}: ${cur.hypothesis}`, `Why it waited: ${cur.approval.join('; ')}.`, `It runs for at most ${s.job.max_minutes} min on ${s.job.gpus} GPU(s); nothing else changes.`], changes: [`job ${cur.job}: waiting -> queued`], digest: d }
        : { summary: [`Declines job #${cur.n}: it never runs; the log records it as declined.`], changes: [`job ${cur.job}: waiting -> declined`], digest: d };
    }
    case 'archive':
      if (st.phase === 'running') throw new ExperimentsError(`stop job #${cur?.n} first`);
      return { summary: [`Archives ${s.id}: it stops for good; its log stays readable.`], changes: [`${s.id}: started -> archived`], digest: digest(pins.text, 'archive') };
  }
  throw new ExperimentsError(`no action ${String(req.action)}`);
}

/** Carry out a change the person reviewed: planned again now, refused if anything moved since (the digest). */
export function applyExperiment(o: { site: ExpSite; events: StoredEvent[]; req: ExpChange; digest: string; by: string; role: Role; now: Date; log: EventLog }): { summary: string[]; changes: string[] } {
  const plan = planExperiment(o);
  if (plan.digest !== o.digest) throw new ExperimentsError('the study changed since you reviewed it; review again');
  const { site, req, by, role, log } = o;
  const emit = <T extends 'experiment.changed' | 'experiment.approval'>(type: T, payload: EventPayload<T>) => log.append(type, payload, by);
  const detail = plan.changes.join('; ').slice(0, 1000);
  if (req.action === 'start') {
    const tip = tipOf(site)!;
    const defs = readStudies({ show: show(site.repo), configDir: BRAND.configDir }, tip) as { studies: Study[] };
    const s = defs.studies.find((x) => x.id === req.study)!;
    const root = (site.root ?? (() => readRootFile(site.instance)))();
    const now = currentPin({ show: show(site.repo) }, s, tip, root) as { pin: Omit<Pin, 'started_by' | 'started_at'> };
    const p = planPins(site.pinsFile, (x) => ({ ...x, studies: { ...x.studies, [s.id]: { ...now.pin, started_by: by, started_at: o.now.toISOString() } } }));
    if ('error' in p) throw new ExperimentsError(p.error);
    const w = applyPins(site.pinsFile, p);
    if ('error' in w) throw new ExperimentsError(w.error);
    emit('experiment.changed', { study: req.study, action: 'start', by, role, detail });
  } else if (req.action === 'archive') {
    const p = planPins(site.pinsFile, (x) => {
      const { [req.study]: _gone, ...rest } = x.studies;
      return { ...x, studies: rest };
    });
    if ('error' in p) throw new ExperimentsError(p.error);
    const w = applyPins(site.pinsFile, p);
    if ('error' in w) throw new ExperimentsError(w.error);
    emit('experiment.changed', { study: req.study, action: 'archive', by, role, detail });
  } else if (req.action === 'approve' || req.action === 'decline') {
    const held = /^result #(\d+): held/.exec(plan.changes[0]!);
    if (held) log.append('experiment.verdict', { study: req.study, n: Number(held[1]), answer: req.action === 'approve' ? 'accept' : 'reject', by }, by);
    else emit('experiment.approval', { study: req.study, job: /^job (\S+):/.exec(plan.changes[0]!)![1]!, answer: req.action, by });
  } else {
    emit('experiment.changed', { study: req.study, action: req.action, by, role, detail });
  }
  return { summary: plan.summary, changes: plan.changes };
}
