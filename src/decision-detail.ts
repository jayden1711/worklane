// A decision's detail view (GET /api/decisions/:id, the dashboard's /decisions/:id page): everything the owner needs
// to decide from the dashboard alone. That covers what happened, what each option does, the findings, the change
// with its level and why, the evaluator's verdict, the tests, the PR's CI, the runs, the impact flags, and what
// happens if nothing is picked. It is built from the event log when asked, never stored. A field the log doesn't have
// is null, and the page leaves it out; nothing is made up. What happened and what each option does are in plain words
// from src/decision-effects.ts, which the decision cards' state uses too.
//
// Who gets what (roles from src/dashboard-auth.ts, never a new rule):
//   - a viewer gets only the fields VIEWER_DECISION_FIELDS allows (src/viewer-events.ts), never the context;
//   - a writer gets the context too, as the agent runs it comes from (mayReadRuns), minus the owner-only parts;
//   - the owners also get the owner-only parts: raw check output, the tamper guard's flags, and the diff.
import { gitExecFile } from './os/git.js';
import { BRAND } from './brand.js';
import { DEFAULT_REVIEW } from './coordinator/shared.js';
import { isOwner, isWriter, mayAnswerKind, type Role } from './dashboard-auth.js';
import type { DecisionContext } from './decision-context.js';
import { happened, isInvestigation, optionEffects, type DetailKind } from './decision-effects.js';
import { redactCut } from './events/redact.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import type { PrView } from './projection.js';
import { computeLevel, loadMoneyPaths, selfModificationPart } from './review.js';
import type { ReviewConfig } from './config/schema.js';
import type { RunSummary } from './run-record.js';
import { withToolPath } from './tool-path.js';
import { VIEWER_DECISION_FIELDS } from './viewer-events.js';

/** The detail line a recommendation's reasoning is on (src/decision-ask.ts writes it; the Decisions page reads it). */
const RECOMMENDATION_PREFIX = 'Recommendation: ';

/** A held PR's detail id: `pr-<number>` (a decision's own id is `d-…`, so the two never meet). */
export const PR_DECISION = /^pr-([1-9]\d{0,8})$/;
/** Ids a detail is asked by: a decision's (letters, digits, `.`, `_`, `-`) or a held PR's. */
export const DECISION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export { optionEffect, type DetailKind } from './decision-effects.js';

export interface OptionView {
  option: string;
  /** What picking it does, in plain words. */
  does: string;
  /** What it can't do: the limit of that answer. */
  cannot: string;
  recommended: boolean;
}

export interface ImpactFlag {
  flag: 'money-path' | 'auth' | 'secrets';
  /** The files that fall in it (empty: none do); null when the change's files aren't recorded. */
  files: string[] | null;
}

export interface DecisionDetail {
  id: string;
  kind: DetailKind;
  issue: number | null;
  owner: string;
  question: string;
  options: OptionView[];
  recommendation: string;
  askedAt: string;
  answer: { by: string; answer: string; at: string } | null;
  canAnswer: boolean;
  /** What happens if nobody answers: there's no timeout anywhere; it waits. */
  ifNothing: string;
  /** For a viewer: why nothing else is here. Null for the owners and writers. */
  withheld: string | null;
  // Everything below is the owners' and writers' (absent for a viewer).
  title?: string | null;
  /** The plain summary: what happened, and the asking agent's own words when it gave any. */
  summary?: { happened: string; agent: string | null };
  /** A free-text recommendation's prose, and the reasoning the detail lines carry. */
  reasoning?: string[];
  /** The decision's other detail lines (receipts). */
  receipts?: string[];
  /** The agent's findings, each with its file and line when its evidence names one. Null: not recorded. */
  findings?: { list: NonNullable<DecisionContext['findings']>; confidence: string | null; unverified: string[] } | null;
  /** The change asked about. Null: no change is recorded for this decision. */
  change?: {
    base: string | null;
    head: string | null;
    files: { path: string; added: number | null; removed: number | null }[];
    filesMore: number;
    level: string | null;
    levelReasons: string[];
    /** `asked`: recorded with the decision; `log`: joined from the issue's events (change.proposed, review.level_set). */
    source: 'asked' | 'log';
  } | null;
  /** The evaluator's verdict. Null: none recorded. */
  verdict?: { patch_correct: boolean; test_correct: boolean; confidence: string; confidenceReason: string | null; advice: string; unread: string[]; unverifiedClaims: string[]; designChange: boolean | null; designReason: string | null } | null;
  /** The checks the harness ran (pass/fail per check; the output is owner-only). Null: none recorded. */
  tests?: { check: string; status: string; duration_ms: number | null; tail?: string }[] | null;
  /** The tamper guard's flags on the change (owner-only; absent for a writer). */
  tampered?: string[];
  /** The PR, its CI per required check on its current head, and why it waits. Null: no PR. */
  pr?: { number: number; url: string; head: string; phase: string; draft: boolean; checks: { name: string; outcome: string }[]; checksOnHead: boolean; waitReasons: string[]; why: { category: string; text: string }[] } | null;
  /** Money path, auth and secrets: whether the change touches each, and where. */
  impact?: { flags: ImpactFlag[]; others: string[]; note: string | null };
  /** The issue's agent runs; null when none can be listed (no issue). */
  runs?: Pick<RunSummary, 'id' | 'role' | 'model' | 'startedAt' | 'endedAt' | 'reason'>[] | null;
  /** Runs on this issue Claude refused the login on (#473), and a login held now on this instance. */
  auth?: { failed: { at: string; role: string; detail: string }[]; held: { login: string; detail: string; since: string } | null };
  /** Whether a diff can be asked for: `owner` (GET …/diff), `owners-only` (this person isn't one), or `none` (no change). */
  diff?: 'owner' | 'owners-only' | 'none';
  /** Whether the PR body's fail-without and never sections can be read (GET …/pr): a PR exists. */
  prBody?: boolean;
  /** For a writer: the parts that are the owners' alone. */
  ownerOnly?: string | null;
}

/** What happens if nobody picks anything: nothing times out. */
export function ifNothing(kind: DetailKind, issue: number | null): string {
  if (kind === 'automation') return "It expires: unanswered for a day, the automation doesn't run for this trigger. Only an owner answers it, here on the dashboard (never from chat).";
  const where = issue !== null && kind !== 'intake' && kind !== 'delegation' && kind !== 'pr' ? `, here, or in a comment on #${issue} (\`/${BRAND.cli} <option>\`)` : kind === 'pr' ? ' on GitHub' : ', here';
  const what: Record<DetailKind, string> = {
    land: "the change doesn't land",
    question: 'the task stays stopped at this question',
    domain: 'the host stays refused',
    plan: 'nothing is built',
    intake: 'the report is neither filed nor dropped',
    delegation: 'the review settings stay as they are',
    automation: 'the automation does not run for this trigger',
    pr: 'the PR stays open, unmerged',
  };
  return `No timeout: it waits. Until someone with the right role answers${where}, ${what[kind]}. It stays in Waiting on you and in the daily digest.`;
}

/** A PR body's "fail-without" and "What this can never do" sections, whole; null for each the body hasn't. */
export function prSections(body: string | null | undefined): { failWithout: string | null; never: string | null } {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const heads: { at: number; level: number; title: string }[] = [];
  lines.forEach((l, at) => {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) return void heads.push({ at, level: h[1]!.length, title: h[2]! });
    // A bold line alone is a heading too ("**Fail-without**"), below any # heading.
    const b = /^\*\*(.+?)\*\*:?\s*$/.exec(l.trim());
    if (b) heads.push({ at, level: 7, title: b[1]! });
  });
  const section = (re: RegExp) => {
    const i = heads.findIndex((h) => re.test(h.title));
    if (i < 0) return null;
    const h = heads[i]!;
    const end = heads.slice(i + 1).find((n) => n.level <= h.level)?.at ?? lines.length;
    const s = lines.slice(h.at + 1, end).join('\n').trim();
    // Redacted before it is cut, over the kept part and a margin only (#889): a cut first leaves a token or a key's
    // body unfound, and the whole text could be any size.
    return s ? redactCut(s, 20_000) : null;
  };
  return { failWithout: section(/fail[- ]?without/i), never: section(/\bnever\b/i) };
}

type Asked = EventPayload<'decision.asked'>;

/** The latest event of a type for an issue (and head, when given). */
function latest<T extends Record<string, unknown>>(events: readonly StoredEvent[], type: string, issue: number, head?: string): (T & { ts: string }) | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== type) continue;
    const p = e.payload as Record<string, unknown>;
    if (p.issue === issue && (head === undefined || p.head === head)) return { ...(p as T), ts: e.ts };
  }
  return null;
}

/** Categories a change's files fall in, as review.yaml (or the default) and the money paths say, now. */
function categoriesNow(files: string[], o: { root: string; mainRef: string; review: ReviewConfig | undefined }): { categories: Record<string, string[]>; note: string | null } {
  const review = (o.review ?? DEFAULT_REVIEW) as ReviewConfig;
  let money: RegExp[] = [];
  let note: string | null = null;
  try {
    money = loadMoneyPaths(o.root, review.money_path_source, o.mainRef);
  } catch (e) {
    note = `money paths not checked: ${(e as Error).message}`;
  }
  // The dashboard doesn't read root's managed-app file: the engine's scope, the stricter labels (#665).
  return { categories: computeLevel({ files: files.map((path) => ({ path, added: 0, removed: 0 })), labels: [], moneyPaths: money, scope: undefined }, review).categories, note };
}

const IMPACT: ImpactFlag['flag'][] = ['money-path', 'auth', 'secrets'];
const SECRETS_PART = 'sign-in, credentials or secrets';

function impactOf(categories: Record<string, string[]> | null, files: string[] | null, note: string | null): NonNullable<DecisionDetail['impact']> {
  if (!categories || !files) return { flags: IMPACT.map((flag) => ({ flag, files: null })), others: [], note };
  const secrets = new Set([...(categories.secrets ?? []), ...files.filter((f) => selfModificationPart(f) === SECRETS_PART)]);
  return {
    flags: [
      { flag: 'money-path', files: categories['money-path'] ?? [] },
      { flag: 'auth', files: categories.auth ?? [] },
      { flag: 'secrets', files: [...secrets] },
    ],
    others: Object.keys(categories).filter((k) => !IMPACT.includes(k as ImpactFlag['flag']) && (categories[k] ?? []).length).sort(),
    note,
  };
}

/** The instance's held Claude logins now (#473): a claude_auth.failed with no later recovered for its key. */
function heldLogin(events: readonly StoredEvent[]): { login: string; detail: string; since: string } | null {
  const held = new Map<string, { login: string; detail: string; since: string }>();
  for (const e of events) {
    if (e.type === 'claude_auth.failed') {
      const p = e.payload as EventPayload<'claude_auth.failed'>;
      if (!held.has(p.key)) held.set(p.key, { login: p.login, detail: p.detail, since: e.ts });
    } else if (e.type === 'claude_auth.recovered') held.delete((e.payload as EventPayload<'claude_auth.recovered'>).key);
  }
  return [...held.values()].at(-1) ?? null;
}

export interface DetailDeps {
  events: readonly StoredEvent[];
  role: Role;
  /** Every PR the harness opened (projection.ts prsView), for a held PR's detail and a decision's PR. */
  prs: readonly PrView[];
  /** The checkout, for the money paths, read there at `mainRef` (the default branch's remote ref), never its working tree (#715). */
  root: string;
  mainRef: string;
  /** Who may approve a high-risk merge, as review.yaml on the default branch says (decide.ts approvalsAt). */
  approvals: ReviewConfig['approvals'];
  review: ReviewConfig | undefined;
  /** The issue's runs (run-record.ts runsForIssue); asked only for the owners and writers. */
  runs: (issue: number) => RunSummary[];
}

/** The decision (or held PR) with this id, as this role may have it; null when there's none. */
export function decisionDetail(id: string, d: DetailDeps): DecisionDetail | null {
  if (!DECISION_ID.test(id)) return null;
  const { events } = d;
  const prMatch = PR_DECISION.exec(id);
  let asked: (Asked & { ts: string }) | null = null;
  let answer: DecisionDetail['answer'] = null;
  let pr: PrView | null = null;
  if (prMatch) {
    pr = d.prs.find((p) => p.number === Number(prMatch[1])) ?? null;
    if (!pr) return null;
  } else {
    for (const e of events) {
      if (e.type === 'decision.asked' && (e.payload as Asked).id === id) asked = { ...(e.payload as Asked), ts: e.ts };
      else if (asked && e.type === 'decision.answered' && (e.payload as { id: string }).id === id) {
        const p = e.payload as EventPayload<'decision.answered'>;
        answer = { by: p.by, answer: p.answer, at: e.ts };
      }
    }
    if (!asked) return null;
    if (asked.issue !== null) pr = [...d.prs].filter((p) => p.issue === asked!.issue).sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0] ?? null;
  }
  const kind: DetailKind = asked ? asked.kind : 'pr';
  const issue = asked ? asked.issue : pr!.issue;
  const options = asked ? asked.options : [];
  const recommendation = asked ? asked.recommendation : '';
  const investigation = isInvestigation(kind, options);
  const base: DecisionDetail = {
    id,
    kind,
    issue,
    owner: asked ? asked.owner : '',
    question: asked ? asked.question : `Review and merge PR #${pr!.number}?`,
    options: optionEffects(kind, options).map((o) => ({ ...o, recommended: o.option === recommendation })),
    recommendation,
    askedAt: asked ? asked.ts : (pr!.decision?.at ?? pr!.openedAt),
    answer: answer ?? (pr && kind === 'pr' && pr.state !== 'open' ? { by: '', answer: pr.state, at: pr.merged?.at ?? '' } : null),
    // A held PR is answered on GitHub (review and merge, or close), never here.
    canAnswer: asked ? mayAnswerKind(kind, d.role, d.approvals) : false,
    ifNothing: ifNothing(kind, issue),
    withheld: null,
  };
  if (!isWriter(d.role)) {
    // Exactly the fields a viewer's state has for a decision, plus what is the same for everyone.
    const allowed = new Set(VIEWER_DECISION_FIELDS);
    const out = Object.fromEntries(Object.entries(base).filter(([k]) => allowed.has(k) || k === 'ifNothing')) as unknown as DecisionDetail;
    return { ...out, options: base.options, withheld: `a decision's evidence, change, checks and runs are for the instance's owners and writers (admin or write on its repo); you are a ${d.role}` };
  }

  const ctx = asked?.context;
  const owner = isOwner(d.role);
  const title = issue !== null ? ((latest<{ title: string }>(events, 'issue.seen', issue)?.title as string | undefined) ?? null) : null;
  const detail = asked ? asked.receipts.filter(Boolean) : [];
  const reasoning = [...(asked && !options.includes(recommendation) && recommendation.trim() ? [recommendation.trim()] : []), ...detail.filter((r) => r.startsWith(RECOMMENDATION_PREFIX)).map((r) => r.slice(RECOMMENDATION_PREFIX.length))];

  // The change: as recorded with the decision; for a held PR (or a decision before #475), joined from the issue's log.
  let change: DecisionDetail['change'] = null;
  if (ctx?.files || ctx?.level) {
    change = { base: ctx.base ?? null, head: ctx.head ?? null, files: (ctx.files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed })), filesMore: ctx.files_more ?? 0, level: ctx.level ?? null, levelReasons: ctx.level_reasons ?? [], source: 'asked' };
  } else if (issue !== null && (kind === 'land' || kind === 'pr')) {
    const proposed = latest<EventPayload<'change.proposed'>>(events, 'change.proposed', issue);
    const level = latest<EventPayload<'review.level_set'>>(events, 'review.level_set', issue);
    if (proposed || level) change = { base: proposed?.base ?? null, head: pr?.head ?? proposed?.head ?? level?.head ?? null, files: (proposed?.files ?? []).map((path) => ({ path, added: null, removed: null })), filesMore: 0, level: level?.level ?? null, levelReasons: level?.reasons ?? [], source: 'log' };
  }

  let verdict: DecisionDetail['verdict'] = null;
  if (ctx?.verdict) {
    const v = ctx.verdict;
    verdict = { patch_correct: v.patch_correct, test_correct: v.test_correct, confidence: v.confidence, confidenceReason: v.confidence_reason ?? null, advice: v.advice, unread: v.unread ?? [], unverifiedClaims: v.unverified_claims ?? [], designChange: v.design_change ?? null, designReason: v.design_reason ?? null };
  } else if (issue !== null && (kind === 'land' || kind === 'pr')) {
    const v = latest<EventPayload<'eval.verdict'>>(events, 'eval.verdict', issue);
    if (v) verdict = { patch_correct: v.patch_correct, test_correct: v.test_correct, confidence: v.confidence, confidenceReason: (v as { confidence_reason?: string }).confidence_reason ?? null, advice: v.advice, unread: v.unread ?? [], unverifiedClaims: v.unverified_claims ?? [], designChange: v.design_change ?? null, designReason: v.design_reason ?? null };
  }

  let tests: DecisionDetail['tests'] = null;
  if (ctx?.checks) tests = ctx.checks.map((c) => ({ check: c.check, status: c.status, duration_ms: c.duration_ms ?? null, ...(owner && c.tail ? { tail: c.tail } : {}) }));
  else if (issue !== null && (kind === 'land' || kind === 'pr')) {
    const r = latest<EventPayload<'check.result'>>(events, 'check.result', issue);
    if (r) tests = r.checks.map((c) => ({ check: c.check, status: c.status, duration_ms: c.duration_ms ?? null, ...(owner && c.tail ? { tail: c.tail } : {}) }));
  }

  // Impact: the categories recorded with the decision; else the change's files, categorised now.
  const files = change ? change.files.map((f) => f.path) : null;
  let impact: NonNullable<DecisionDetail['impact']>;
  if (ctx?.categories && files) impact = impactOf(ctx.categories, files, null);
  else if (files?.length) {
    // Categorised now, plus what the level's reasons recorded then ("money-path: a.js, b.js"): a later review.yaml or
    // money-path change can't hide what the change was held for.
    const now = categoriesNow(files, { root: d.root, mainRef: d.mainRef, review: d.review });
    for (const r of change?.levelReasons ?? []) {
      const m = /^([a-z][a-z-]*): (.+)$/.exec(r);
      if (!m) continue;
      const list = (now.categories[m[1]!] ??= []);
      for (const f of m[2]!.split(', ')) if (files.includes(f) && !list.includes(f)) list.push(f);
    }
    impact = impactOf(now.categories, files, now.note);
  } else impact = impactOf(null, null, null);

  const why = pr && prMatch ? ((latest<EventPayload<'merge.decided'>>(events, 'merge.decided', pr.issue)?.why as { category: string; text: string }[] | undefined) ?? []) : [];
  const failed = issue === null ? [] : events.filter((e) => e.type === 'run.finished' && (e.payload as EventPayload<'run.finished'>).issue === issue && (e.payload as EventPayload<'run.finished'>).reason === 'auth_failed').map((e) => ({ at: e.ts, role: (e.payload as EventPayload<'run.finished'>).role, detail: (e.payload as EventPayload<'run.finished'>).detail }));
  const hasDiff = !!(change?.base && change.head && SHA.test(change.base) && SHA.test(change.head));

  return {
    ...base,
    title,
    summary: { happened: happened(kind, issue, base.question, { investigation, pr }), agent: ctx?.summary ?? null },
    reasoning,
    receipts: detail.filter((r) => !r.startsWith(RECOMMENDATION_PREFIX)),
    findings: ctx?.findings ? { list: ctx.findings, confidence: ctx.confidence ?? null, unverified: ctx.unverified ?? [] } : null,
    change,
    verdict,
    tests,
    ...(owner ? { tampered: ctx?.tampered ?? [] } : {}),
    pr: pr
      ? { number: pr.number, url: pr.url, head: pr.head, phase: pr.phase, draft: pr.draft, checks: pr.status?.checks ?? [], checksOnHead: pr.status?.head === pr.head, waitReasons: pr.waitReasons, why }
      : null,
    impact,
    runs: issue !== null ? d.runs(issue).map((r) => ({ id: r.id, role: r.role, model: r.model, startedAt: r.startedAt, endedAt: r.endedAt, reason: r.reason })) : null,
    auth: { failed, held: heldLogin(events) },
    diff: !hasDiff ? 'none' : owner ? 'owner' : 'owners-only',
    prBody: !!pr,
    ownerOnly: owner ? null : "the checks' output, the tamper guard's flags and the diff are for the instance's owners (admin on its repo)",
  };
}

/** The change's diff, base..head, from the checkout's git (owners only: the route checks); redacted, capped. */
export async function decisionDiff(root: string, base: string, head: string): Promise<{ diff: string; truncated: boolean } | { diff: null; why: string }> {
  if (!SHA.test(base) || !SHA.test(head)) return { diff: null, why: 'no commits recorded for this change' };
  const MAX = 512 * 1024;
  // Every file's lines whatever the change's attributes say (#807): a file its .gitattributes marks `-diff` or
  // `binary` (or gives a textconv or an external diff) shows as it is, not as "Binary files differ"; the user's
  // attributes file is not read. Output past the buffer is shown cut, like output past MAX.
  const args = ['-c', 'core.attributesFile=/dev/null', 'diff', '--no-color', '--text', '--no-textconv', '--no-ext-diff', '--ignore-submodules=none', `${base}..${head}`];
  return new Promise((done) => {
    gitExecFile(args, { cwd: root, env: { ...withToolPath(), GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && stdout)) return done({ diff: null, why: `not in this checkout's git: ${(stderr || err.message).trim().split('\n')[0]}` });
      // Redacted before it is cut, over the kept part and a margin only (#889): up to 8 MB of diff, and the redaction is
      // synchronous on the dashboard. Output past the buffer the same way: a token across the cut is redacted whole.
      if (err) return done({ diff: redactCut(stdout, MAX), truncated: true });
      const truncated = stdout.length > MAX;
      done({ diff: redactCut(stdout, MAX), truncated });
    });
  });
}
