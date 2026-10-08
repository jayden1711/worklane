// Optional roles, each off by default (agents.yaml roles.<name>.enabled).
// Every one is read-only: an agent with Read/Glob/Grep and read-only git,
// whose structured output the coordinator turns into issues, comments or a
// higher review level. None writes code, holds a write token, deploys or
// tags. Each run is keyed by its trigger, so a trigger fires a role once.
import { createHash } from 'node:crypto';
import { BRAND } from './brand.js';
import type { Backlog } from './backlog/types.js';
import type { Config } from './config/load.js';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import type { Level } from './review.js';
import type { AgentRunner, RunResult } from './runner.js';

export type ExtraRoleName = 'security' | 'red_attributor' | 'ci_repair' | 'qa_playtester' | 'monitor' | 'release_prep';

/** What the coordinator lends a role: never a token, never a writable checkout. */
export interface ExtraCtx {
  cfg: Config;
  log: EventLog;
  backlog: Backlog;
  runner: AgentRunner;
  repo: string;
  stateDir: string;
  branch: string;
  remote: string;
  emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>): StoredEvent;
  git(cwd: string, ...args: string[]): string;
  sh(command: string, cwd: string): Promise<{ code: number | null; tail: string }>;
  /** Why no agent may start now (budget, load, disk), or null. */
  hold(): string | null;
  budgetLeft(): number;
  now(): Date;
}

const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)'];

const PROMPTS: Record<ExtraRoleName, string> = {
  security: `You are a security reviewer with read-only access. Review the change on this branch (git diff BASE..HEAD) for vulnerabilities a careful attacker could use: injection, missing authorization or ownership checks, secrets in code or logs, unsafe deserialization, races on money or balances, replay, trusting client input, and unsafe defaults.
- Report only real, specific problems with evidence (file and line, and why it is exploitable). No style notes.
- verdict: "block" if anything is high or critical, "concerns" for medium, "clear" otherwise.
- Do not edit anything.`,
  red_attributor: `New tests are failing on main that were passing before. Using read-only git (log, show, diff) and the failure output below, work out which landed commit most likely caused each new failure.
- Give evidence for each attribution: the lines in that commit that the failing test exercises. Say "unknown" rather than guess.
- Do not edit anything.`,
  ci_repair: `CI is red on main. Using read-only access and the failing check names below, diagnose why: the failing step, the likely cause, and the smallest fix.
- Write it as an issue a worker could pick up: a title, a body with evidence, and a done_when contract (tests or commands that pass once it's fixed).
- Do not edit anything.`,
  qa_playtester: `You are playtesting a test deployment of this project as a real user would. Follow the project's playtest instructions. Report bugs only: each with steps to reproduce, what you expected, what happened, and evidence (a screenshot path, console output, or a response).
- Never use real money, real accounts, or production. Stop if anything looks like production.
- Do not edit the repository.`,
  monitor: `A deployment check just failed. Using read-only access, diagnose what is most likely wrong from the check output and recent landed commits. Recommend what a human should check first. Never change anything, and never touch production yourself.`,
  release_prep: `Draft release notes for the changes landed since the last release tag, grouped as Added, Changed, Fixed, and Security, written for the project's users. One line per change, linking the issue number. Leave out internal-only changes. Do not edit anything; return the notes.`,
};

const SCHEMAS: Record<ExtraRoleName, object> = {
  security: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings'],
    properties: {
      verdict: { type: 'string', enum: ['clear', 'concerns', 'block'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'file', 'issue', 'evidence'],
          properties: { severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, file: { type: 'string' }, issue: { type: 'string' }, evidence: { type: 'string' } },
        },
      },
    },
  },
  red_attributor: {
    type: 'object',
    additionalProperties: false,
    required: ['attributions'],
    properties: {
      attributions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['failure', 'commit', 'confidence', 'evidence'],
          properties: { failure: { type: 'string' }, commit: { type: 'string', description: 'full or short sha, or "unknown"' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'string' } },
        },
      },
    },
  },
  ci_repair: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'body', 'done_when'],
    properties: { title: { type: 'string' }, body: { type: 'string' }, done_when: { type: 'array', items: { type: 'string' }, description: 'one check per line, e.g. "test: test/foo.test.js" or "command: npm run lint"' } },
  },
  qa_playtester: {
    type: 'object',
    additionalProperties: false,
    required: ['bugs'],
    properties: {
      bugs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'steps', 'expected', 'actual', 'severity', 'evidence'],
          properties: { title: { type: 'string' }, steps: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] }, evidence: { type: 'string' } },
        },
      },
    },
  },
  monitor: { type: 'object', additionalProperties: false, required: ['diagnosis', 'check_first'], properties: { diagnosis: { type: 'string' }, check_first: { type: 'string' } } },
  release_prep: { type: 'object', additionalProperties: false, required: ['notes'], properties: { notes: { type: 'string', description: 'markdown' } } },
};

export function enabled(cfg: Config, role: ExtraRoleName) {
  const r = cfg.agents.roles[role];
  return r?.enabled ? r : null;
}

function done(log: EventLog, role: string, key: string) {
  return log.read(0, ['extra.run']).some((e) => (e.payload as { role: string; key: string }).role === role && (e.payload as { key: string }).key === key);
}

const runsToday = (log: EventLog, role: string, now: Date) => {
  const day = now.toISOString().slice(0, 10);
  return log.read(0, ['extra.run']).filter((e) => (e.payload as { role: string }).role === role && e.ts.startsWith(day)).length;
};

/** Run a role's agent read-only and record its cost. Null when the governor holds or the run produced nothing usable. */
async function runRole<T>(ctx: ExtraCtx, role: ExtraRoleName, prompt: string, cwd: string, issue: number | null): Promise<{ out: T; r: RunResult } | { held: string } | null> {
  const r0 = enabled(ctx.cfg, role)!;
  const held = ctx.hold();
  if (held) return { held };
  const r = await ctx.runner.run({
    role,
    stateDir: ctx.stateDir,
    prompt,
    appendSystemPrompt: PROMPTS[role],
    cwd,
    model: r0.model,
    allowedTools: [...READ_ONLY, ...(r0.tools ?? [])],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    maxTurns: 60,
    maxBudgetUsd: Math.min(r0.budget_usd ?? 3, Math.max(0.25, ctx.budgetLeft())),
    jsonSchema: SCHEMAS[role],
    stallMs: 10 * 60_000,
    timeoutMs: 30 * 60_000,
  });
  ctx.emit('run.cost', { issue, role, model: r.model, usd: r.costUsd, turns: r.turns });
  if (r.reason !== 'succeeded' || !r.structured) return null;
  return { out: r.structured as T, r };
}

const record = (ctx: ExtraCtx, role: ExtraRoleName, key: string, reason: string, summary: string, actions: string[]) => ctx.emit('extra.run', { role, key, reason, summary: summary.slice(0, 2000), actions });

// ------------------------------------------------------------- security

export interface SecurityFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  issue: string;
  evidence: string;
}

/**
 * Review a change in the categories the role applies to (default: money
 * paths). Returns the review level the result requires: block -> L3,
 * concerns -> L2. A reviewer that moved HEAD or left changes counts as a
 * block: a read-only role that writes is not trusted.
 */
export async function securityReview(ctx: ExtraCtx, t: { issue: number; path: string; base: string; head: string; categories: string[] }): Promise<{ requested: Level | null; receipts: string[] }> {
  const role = enabled(ctx.cfg, 'security');
  const applies = role?.applies_to ?? ['money-path'];
  if (!role || !t.categories.some((c) => applies.includes(c))) return { requested: null, receipts: [] };
  const res = await runRole<{ verdict: 'clear' | 'concerns' | 'block'; findings: SecurityFinding[] }>(ctx, 'security', `Change for issue #${t.issue}. BASE=${t.base} HEAD=${t.head}. Review git diff ${t.base}..${t.head}.`, t.path, t.issue);
  if (res && 'held' in res) return { requested: 'L3', receipts: [`security review could not run (${res.held}); needs a human`] };
  const moved = ctx.git(t.path, 'rev-parse', 'HEAD') !== t.head || ctx.git(t.path, 'status', '--porcelain') !== '';
  if (!res || moved) {
    const why = moved ? 'the security reviewer changed the worktree' : 'the security review did not finish';
    ctx.emit('security.review', { issue: t.issue, head: t.head, verdict: 'block', findings: [{ severity: 'high', file: '-', issue: why, evidence: '-' }] });
    return { requested: 'L3', receipts: [`security: ${why}`] };
  }
  const findings = res.out.findings.slice(0, 20).map((f) => ({ ...f, issue: f.issue.slice(0, 500), evidence: f.evidence.slice(0, 500) }));
  // The verdict can't be milder than its own findings.
  const worst = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'block' : findings.some((f) => f.severity === 'medium') ? 'concerns' : 'clear';
  const order = ['clear', 'concerns', 'block'] as const;
  const verdict = order[Math.max(order.indexOf(res.out.verdict), order.indexOf(worst))]!;
  ctx.emit('security.review', { issue: t.issue, head: t.head, verdict, findings });
  const receipts = [`security: ${verdict}`, ...findings.filter((f) => f.severity !== 'low').map((f) => `security ${f.severity}: ${f.file}: ${f.issue}`)];
  return { requested: verdict === 'block' ? 'L3' : verdict === 'concerns' ? 'L2' : null, receipts };
}

// ------------------------------------------------------- red attributor

/** When main's baseline grows, attribute each new failure to a landed change and tell its owner. */
async function redAttributor(ctx: ExtraCtx): Promise<void> {
  const baselines = ctx.log.read(0, ['baseline.recorded']);
  const cur = baselines.at(-1);
  const prev = baselines.at(-2);
  if (!cur || !prev) return;
  const key = `baseline-${cur.id}`;
  if (done(ctx.log, 'red_attributor', key)) return;
  const was = new Set((prev.payload as { failing: string[] }).failing);
  const fresh = (cur.payload as { failing: string[] }).failing.filter((f) => !was.has(f));
  const from = (prev.payload as { sha: string }).sha;
  const to = (cur.payload as { sha: string }).sha;
  if (!fresh.length) return void record(ctx, 'red_attributor', key, 'no new failures', '', []);
  // Landed changes between the two baselines, and who owns them.
  const landed = ctx.log
    .read(prev.id, ['land.result'])
    .filter((e) => e.id < cur.id)
    .map((e) => e.payload as EventPayload<'land.result'>)
    .filter((p) => p.outcome === 'landed' && p.landed);
  const issueOf = (sha: string) => landed.find((l) => l.landed!.startsWith(sha) || sha.startsWith(l.landed!.slice(0, 7)))?.issue ?? null;
  // One landing in the window: no agent needed, it is the only candidate.
  let attributions: { failure: string; commit: string; confidence: string; evidence: string }[];
  const distinct = [...new Set(landed.map((l) => l.landed!))];
  if (distinct.length === 1) attributions = fresh.map((f) => ({ failure: f, commit: distinct[0]!, confidence: 'high', evidence: `the only change landed between ${from.slice(0, 8)} and ${to.slice(0, 8)}` }));
  else {
    const log = ctx.git(ctx.repo, 'log', '--oneline', '--no-decorate', `${from}..${to}`).split('\n').slice(0, 200).join('\n');
    const res = await runRole<{ attributions: typeof attributions }>(ctx, 'red_attributor', `New failures on main between ${from} and ${to}:\n${fresh.map((f) => `- ${f}`).join('\n')}\n\nCommits in that range:\n${log}`, ctx.repo, null);
    if (res && 'held' in res) return; // try again next tick
    attributions = res?.out.attributions ?? fresh.map((f) => ({ failure: f, commit: 'unknown', confidence: 'low', evidence: 'attribution run failed' }));
  }
  const actions: string[] = [];
  const byIssue = new Map<number | null, typeof attributions>();
  for (const a of attributions) {
    const n = a.commit === 'unknown' ? null : issueOf(a.commit);
    (byIssue.get(n) ?? byIssue.set(n, []).get(n)!).push(a);
  }
  for (const [n, as] of byIssue) {
    const lines = as.map((a) => `- **${a.failure}**: ${a.commit === 'unknown' ? 'cause unknown' : `\`${a.commit.slice(0, 8)}\``} (${a.confidence}): ${a.evidence}`).join('\n');
    if (n !== null) {
      const owner = ownerOfIssue(ctx, n);
      await ctx.backlog.comment(n, `[${BRAND.cli}] @${owner} main has new failures attributed to this change:\n\n${lines}`);
      actions.push(`commented on #${n}`);
    }
    const title = n !== null ? `New failures on main after #${n}` : `New failures on main (cause unknown)`;
    const created = await ctx.backlog.createIssue(title, `Main's baseline grew between \`${from.slice(0, 8)}\` and \`${to.slice(0, 8)}\`.\n\n${lines}\n\nA writer adds \`ready\` (with a done_when contract) to have an agent fix it.`, ['red', 'triage']);
    actions.push(`opened #${created}`);
  }
  record(ctx, 'red_attributor', key, 'baseline grew', `${fresh.length} new failure(s)`, actions);
}

function ownerOfIssue(ctx: ExtraCtx, n: number): string {
  const c = ctx.log.read(0, ['issue.claimed']).filter((e) => (e.payload as { issue: number }).issue === n).at(-1);
  return (c?.payload as { owner?: string } | undefined)?.owner ?? ctx.cfg.project.owners.default;
}

// -------------------------------------------------------------- CI repair

/** CI red on the tip of main: diagnose it and file an issue for a writer to approve. */
async function ciRepair(ctx: ExtraCtx): Promise<void> {
  const role = enabled(ctx.cfg, 'ci_repair')!;
  ctx.git(ctx.repo, 'fetch', '-q', ctx.remote, ctx.branch);
  const tip = ctx.git(ctx.repo, 'rev-parse', `${ctx.remote}/${ctx.branch}`);
  const key = `ci-${tip}`;
  if (done(ctx.log, 'ci_repair', key)) return;
  const ci = await ctx.backlog.ciStatus(tip);
  if (ci.state !== 'failure') return; // pending or green: look again next tick
  // One diagnosis per failing tip, and at most max_fixes_per_pr open CI issues at a time.
  const open = (await ctx.backlog.list('ci')).length;
  if (open >= (role.max_fixes_per_pr ?? 2)) return void record(ctx, 'ci_repair', key, 'skipped', `${open} CI issue(s) already open`, []);
  const checks = ci.failing.map((c) => `- ${c.name}: ${c.url}`).join('\n');
  const res = await runRole<{ title: string; body: string; done_when: string[] }>(ctx, 'ci_repair', `CI failed on ${ctx.branch} at ${tip}.\nFailing checks:\n${checks}`, ctx.repo, null);
  if (res && 'held' in res) return;
  const title = res?.out.title ?? `CI is red on ${ctx.branch} at ${tip.slice(0, 8)}`;
  const contract = res?.out.done_when.length ? `\n\n\`\`\`done_when\n${res.out.done_when.map((d) => `- ${d}`).join('\n')}\n\`\`\`` : '';
  const n = await ctx.backlog.createIssue(title.slice(0, 200), `${res?.out.body ?? 'The diagnosis run did not finish; see the failing checks.'}\n\nFailing checks at \`${tip.slice(0, 8)}\`:\n${checks}${contract}\n\nProposed by the CI repair role. A writer adds \`ready\` to have an agent work it.`, ['ci', 'triage']);
  record(ctx, 'ci_repair', key, 'ci red', title, [`opened #${n}`]);
}

// ---------------------------------------------------------- QA playtester

/** After a test environment verifies a new commit, playtest it and file what breaks. */
async function qaPlaytester(ctx: ExtraCtx): Promise<void> {
  const role = enabled(ctx.cfg, 'qa_playtester')!;
  const test = new Set((ctx.cfg.deploy?.environments ?? []).filter((e) => !e.production).map((e) => e.name));
  const last = ctx.log.read(0, ['deploy.verified']).filter((e) => test.has((e.payload as { env: string }).env)).at(-1);
  if (!last) return;
  const { env, sha } = last.payload as { env: string; sha: string };
  const key = `${env}-${sha}`;
  if (done(ctx.log, 'qa_playtester', key)) return;
  if (role.max_per_day !== undefined && runsToday(ctx.log, 'qa_playtester', ctx.now()) >= role.max_per_day) return;
  const res = await runRole<{ bugs: { title: string; steps: string; expected: string; actual: string; severity: string; evidence: string }[] }>(ctx, 'qa_playtester', `Playtest the ${env} deployment, which is serving ${sha}.`, ctx.repo, null);
  if (res && 'held' in res) return;
  const actions: string[] = [];
  const known = new Set((await ctx.backlog.list('qa')).map((i) => i.body.match(/qa-key: ([0-9a-f]{12})/)?.[1]));
  for (const b of (res?.out.bugs ?? []).slice(0, 10)) {
    const k = createHash('sha256').update(b.title.toLowerCase().replace(/\W+/g, ' ').trim()).digest('hex').slice(0, 12);
    if (known.has(k)) continue;
    const n = await ctx.backlog.createIssue(`QA: ${b.title}`.slice(0, 200), `Found on **${env}** at \`${sha.slice(0, 8)}\` (${b.severity}).\n\n**Steps**\n${b.steps}\n\n**Expected**\n${b.expected}\n\n**Actual**\n${b.actual}\n\n**Evidence**\n${b.evidence}\n\n<!-- qa-key: ${k} -->`, ['qa', 'triage']);
    known.add(k);
    actions.push(`opened #${n}`);
  }
  record(ctx, 'qa_playtester', key, res ? 'playtested' : 'run failed', `${actions.length} new bug(s)`, actions);
}

// ----------------------------------------------------------------- monitor

/**
 * On a schedule, re-run each environment's verify check against the commit
 * it last verified. A pass-to-fail change opens an incident (diagnosed
 * read-only by the agent); fail-to-pass comments that it recovered.
 */
async function monitor(ctx: ExtraCtx): Promise<void> {
  const role = enabled(ctx.cfg, 'monitor')!;
  const every = (role.every_minutes ?? 30) * 60_000;
  // Scheduled from the time each pass checked (its key), on the same clock as now().
  const lastRun = ctx.log.read(0, ['extra.run']).filter((e) => (e.payload as { role: string }).role === 'monitor').at(-1);
  const lastAt = lastRun ? Number((lastRun.payload as { key: string }).key.slice(2)) : 0;
  if (lastRun && ctx.now().getTime() - lastAt < every) return;
  const actions: string[] = [];
  const results: string[] = [];
  for (const env of ctx.cfg.deploy?.environments ?? []) {
    const lastVerified = ctx.log.read(0, ['deploy.verified']).filter((e) => (e.payload as { env: string }).env === env.name).at(-1);
    if (!lastVerified) continue;
    const sha = (lastVerified.payload as { sha: string }).sha;
    const r = await ctx.sh(env.verify.replaceAll('{sha}', sha), ctx.repo);
    const ok = r.code === 0;
    results.push(`${env.name}:${ok ? 'ok' : 'fail'}`);
    const prev = ctx.log
      .read(0, ['extra.run'])
      .filter((e) => (e.payload as { role: string }).role === 'monitor')
      .map((e) => (e.payload as { summary: string }).summary)
      .reverse()
      .find((s) => s.includes(`${env.name}:`));
    const wasOk = !prev || prev.includes(`${env.name}:ok`);
    if (wasOk && !ok) {
      const res = await runRole<{ diagnosis: string; check_first: string }>(ctx, 'monitor', `The ${env.name} check failed (it verified ${sha} before).\nCheck output:\n${r.tail.slice(-3000)}`, ctx.repo, null);
      const diag = res && !('held' in res) ? `\n\n**Likely cause:** ${res.out.diagnosis}\n\n**Check first:** ${res.out.check_first}` : '';
      const n = await ctx.backlog.createIssue(`${env.name} check failing`, `The ${env.name} verify check started failing (last verified \`${sha.slice(0, 8)}\`).${env.production ? ' **Production:** a human must act; agents never touch it.' : ''}\n\n\`\`\`\n${r.tail.slice(-1500)}\n\`\`\`${diag}`, ['incident', 'triage']);
      actions.push(`opened #${n}`);
    } else if (!wasOk && ok) {
      const open = (await ctx.backlog.list('incident')).find((i) => i.title === `${env.name} check failing`);
      if (open) {
        await ctx.backlog.comment(open.number, `[${BRAND.cli}] ${env.name} check passes again.`);
        actions.push(`recovered #${open.number}`);
      }
    }
  }
  record(ctx, 'monitor', `t-${ctx.now().getTime()}`, 'scheduled', results.join(' '), actions);
}

// ------------------------------------------------------------ release prep

/** Once a day, when changes landed since the last tag: release notes as a PR. Never tags or deploys. */
async function releasePrep(ctx: ExtraCtx, pr: (branch: string, file: string, content: string, title: string, body: string) => Promise<string>): Promise<void> {
  const day = ctx.now().toLocaleDateString('en-CA');
  ctx.git(ctx.repo, 'fetch', '-q', '--tags', ctx.remote, ctx.branch);
  const tip = ctx.git(ctx.repo, 'rev-parse', `${ctx.remote}/${ctx.branch}`);
  let tag = '';
  try {
    tag = ctx.git(ctx.repo, 'describe', '--tags', '--abbrev=0', tip);
  } catch {
    // no tags yet: everything is unreleased
  }
  const key = `${tag || 'none'}..${tip}`;
  if (done(ctx.log, 'release_prep', key) || runsToday(ctx.log, 'release_prep', ctx.now()) > 0) return;
  const range = tag ? `${tag}..${tip}` : tip;
  const commits = ctx.git(ctx.repo, 'log', '--oneline', '--no-decorate', range).split('\n').filter(Boolean);
  if (!commits.length) return;
  const res = await runRole<{ notes: string }>(ctx, 'release_prep', `Changes since ${tag || 'the beginning'} (${commits.length} commits):\n${commits.slice(0, 300).join('\n')}`, ctx.repo, null);
  if (!res || 'held' in res) return;
  const url = await pr(`${BRAND.cli}/release-notes-${day}`, `${BRAND.configDir}/releases/unreleased-${day}.md`, `# Unreleased (since ${tag || 'the first commit'})\n\n${res.out.notes.trim()}\n`, `Release notes draft, ${day}`, `Drafted from ${commits.length} commit(s) since ${tag || 'the first commit'}. Edit freely; merging this does not tag or deploy anything.`);
  record(ctx, 'release_prep', key, 'drafted', `${commits.length} commits`, [url]);
}

/** One pass over the enabled scheduled roles (security runs inside each task's pipeline instead). */
export async function runExtras(ctx: ExtraCtx, pr: Parameters<typeof releasePrep>[1]): Promise<void> {
  if (enabled(ctx.cfg, 'red_attributor')) await redAttributor(ctx);
  if (enabled(ctx.cfg, 'ci_repair')) await ciRepair(ctx);
  if (enabled(ctx.cfg, 'qa_playtester')) await qaPlaytester(ctx);
  if (enabled(ctx.cfg, 'monitor')) await monitor(ctx);
  if (enabled(ctx.cfg, 'release_prep')) await releasePrep(ctx, pr);
}
