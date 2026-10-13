// Render checks for the web UI: every page, rendered on the server from the
// state a real dashboard serves for the seeded demo project, still shows its
// data; decisions are still answerable only where the server says so.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { seedDemo } from '../src/demo.js';
import { SETTING_KEYS } from '../src/settings.js';
import { writeLive } from '../src/console.js';
import { EventLog } from '../src/events/log.js';
import { tryAgentSlot } from '../src/slots.js';
import { tryTestSlot } from '../src/testrun/slots.js';
import { asPerson, exampleProject, exampleRoles, ownerRequester, machineOwnersFile, marksOf, repoRoot, seedInstanceItems, type InstanceMarks } from './helpers.js';
import { addProjectView } from '../src/console/add-project.js';
import { addProjectNameOk, addProjectRepoOk } from '../src/machine.js';
import { asks } from '../src/console/asks.js';
import { claudeAccountView } from '../src/claude-account.js';
import { raiseIncident, resolveIncident } from '../src/watchdog/incidents.js';
import { METRICS_DEFINITIONS, trustForViewer, trustView } from '../src/trust.js';
import { deliveryMetrics } from '../src/merge-metrics.js';
import { VIEWER_EVENTS } from '../src/viewer-events.js';
import { firstRunView } from '../src/init.js';

type State = { tasks: { issue: number; title: string; status: string }[]; decisions: { id: string; question: string; options: string[]; answer: unknown; canAnswer?: boolean }[]; activity: { summary: string }[]; emergency: unknown };
interface Render {
  renderPage(name: string, state: State): string;
  renderIssue(state: State, issue: number): string;
  renderChecks(runs: unknown[]): string;
  renderRunList(issue: number): string;
  renderIntake(data: unknown, view?: string): string;
  renderIntakeHealth(health: unknown): string;
  renderIntakePage(state: unknown): string;
  intakeRefusal(state: unknown): string | null;
  renderThroughput(t: unknown): string;
  renderThroughputPanel(state: unknown): string;
  renderTrust(t: unknown): string;
  renderMetrics(m: unknown): string;
  renderMetricsPanel(state: unknown): string;
  renderFlaky(f: unknown): string;
  renderWaiting(w: unknown, now?: number): string;
  renderWaitingPage(state: unknown): string;
  renderFirstRun(f: unknown): string;
  renderFirstRunPage(state: unknown): string;
  renderSetup(data: unknown): string;
  renderAddProject(data: unknown): string;
  renderClaudeAccount(data: unknown, now?: number): string;
  addProjectInvalid(name: string, repo: string): string | null;
  keyData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null;
  renderRunsRefused(message: string): string;
  runsRefused(message: string): string | null;
  runsRefusal(state: unknown): string | null;
  renderRunResearch(data: unknown): string;
  renderStopBanner(state: State): string;
  renderUsageBanner(usage: unknown[], now: number): string;
  renderUsageLines(usage: unknown[], now: number): string;
  renderOverviewWithUsage(state: State, usage: unknown[], now: number): string;
  countdown(resetAt: string, now: number): string;
  renderProtection(protection: unknown, brand: string): string;
  renderDeployGate(gate: unknown): string;
  renderMainWatchAlert(protection: unknown): string;
  renderPrs(view: unknown): string;
  renderLiveFeed(items: unknown[], ended: boolean): string;
  renderConsole(data: unknown): string;
  renderAgents(state: State, live: unknown): string;
  renderHealth(view: unknown, instances?: unknown[]): string;
  renderMachine(data: unknown): string;
  renderUpdatesPanel(data: unknown): string;
  duration(ms: number | null): string;
  renderInstanceSettings(data: unknown): string;
  parseEntry(key: string, raw: string): unknown;
  showValue(key: string, v: unknown): string;
  boundsOf(key: string, d: unknown): string;
  LABEL: Record<string, string>;
  probeHub(servedByHub: boolean, get: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>, auth?: string): Promise<unknown>;
  probeMe(servedByHub: boolean, get: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>, auth?: string): Promise<unknown>;
  renderBoard(boards: { name: string | null; data: unknown; error: string | null }[], now?: number): string;
  renderBoardTestRuns(boards: { name: string | null; data: unknown; error: string | null }[]): string;
  renderTestRuns(data: unknown, compact?: boolean): string;
  renderInstances(hub: unknown, current: string, all?: boolean, status?: Record<string, string>): string;
  renderHealthPage(all: unknown[], target?: string): string;
  loadIncidents(hub: unknown, get: (name: string | null, path: string) => Promise<unknown>): Promise<unknown[]>;
  scopeOf(hub: unknown, saved: string | null, all: boolean): { current: string | null; all: boolean; instances: (string | null)[] };
  loadBoards(scope: unknown, get: (instance: string | null, path: string) => Promise<unknown>): Promise<{ name: string | null; data: unknown; error: string | null }[]>;
  onInstance(instance: string | null, path: string, init: unknown, scope: Promise<unknown>): Promise<unknown>;
  renderMachineSlots(slots: unknown): string;
  elapsed(since: string, now?: number): string;
  renderSignIn(): string;
  renderWhoAmI(state: { user: string; role?: string; via?: string }): string;
  renderNavDrawer(state: State, o?: { open?: boolean; hub?: unknown; status?: Record<string, string> }): string;
  renderHeader(title: string): string;
  navRows: { to: string; label: string; testId: string }[];
  renderAudit(entries: unknown[]): string;
  renderChatAnswer(f: unknown, cli: string): string;
  renderProposedSetting(data: unknown, proposed: { key: string; value: unknown }): string;
  actionHref(a: unknown): string | null;
  citationHref(c: unknown): string;
  proposedSetting(search: string): unknown;
  pages: Record<string, unknown>;
}

/** A long prose recommendation (the kind once cut mid-sentence in a one-line pill). */
const LONG_PROSE =
  'Release the stale claim in the first sweep instead of the second: the lock is only freed in reconcile.js:472 (pinned by the lease check) after a second sweep, so a coordinator that crashes between sweeps leaves the task claimed until its lease expires an hour later. ' +
  'Free it as soon as the lease holder is gone, keep the lease check for live holders, and add a test that stops the holder between two sweeps and expects the next sweep to free the task.';

let r: Render;
let asOwner: State;
let asOther: State;
let asWriter: State;
type Board = { role: string; instance: string; cards: { issue: number; column: string; actions: { watch: string | null; steer: boolean; answer: boolean; approve: unknown } }[] };
/** The board each role gets from a real dashboard over the demo, with an agent running live on one task. */
const boards: Record<'owner' | 'writer' | 'viewer', Board> = {} as never;

/** What a page reads from the browser while rendering: a location and preference storage. */
function browserStubs() {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { location: { pathname: '/', search: '', hash: '' }, matchMedia: () => ({ matches: false }) };
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  // Defined outright: newer Node has a localStorage getter of its own that warns when read.
  for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(g, k, { value: storage, configurable: true, writable: true });
}

before(async () => {
  // Bundle the render entry for Node with the project's own vite (a dev dependency), React included.
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'web-render-'));
  await build({
    configFile: false,
    root: join(repoRoot, 'web'),
    logLevel: 'silent',
    plugins: [react()],
    ssr: { noExternal: true },
    build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } },
  });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as Render;

  // The demo's coordinator keeps its state under the state dir: a temporary one, not the user's.
  const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'web-render-statedir-'));
  const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'web-render-demo-')), 'demo')).finally(() => {
    if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
    else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
  });
  // An event an older engine stored: an agent's prose straight in the recommendation, not one of the options.
  const older = new EventLog(demo.eventsDb);
  older.append('decision.asked', { id: 'demo-old-prose', kind: 'question', issue: null, owner: 'example-owner', question: 'What should happen to the stale claim?', options: ['fix-it', 'look-further', 'leave-it'], recommendation: LONG_PROSE, receipts: ['confidence high'] }, 'demo@local');
  older.close();
  const state = async (user: string) => {
    const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'web-render-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'web-render-slots-')) });
    try {
      return (await (await fetch(`${d.url.split('/?')[0]}/api/state`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } })).json()) as State;
    } finally {
      await d.close();
    }
  };
  asOwner = await state('example-owner');
  asOther = await state('someone-else');
  asWriter = await state('example-collaborator');

  // An agent running live on the demo's ready task, so the board has something to watch and steer; and a
  // high-risk landing waiting for the owner on its migration, so it has something only the owner approves.
  const ready = asOwner.tasks.find((t) => t.status === 'ready')!;
  const migration = asOwner.tasks.find((t) => /orders table/.test(t.title))!;
  const log = new EventLog(demo.eventsDb);
  log.append('run.started', { issue: ready.issue, role: 'worker', model: 'sonnet', worktree: '/w', pid: process.pid, pgid: process.pid, attempt: 1 }, 'demo@local');
  log.append('review.level_set', { issue: migration.issue, head: 'c'.repeat(40), level: 'L3', reasons: ['migrations'] }, 'demo@local');
  log.append('decision.asked', { id: 'demo-land', kind: 'land', issue: migration.issue, owner: 'example-owner', question: `Approve landing #${migration.issue} (L3)?`, options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'demo@local');
  log.close();
  const liveDir = mkdtempSync(join(tmpdir(), 'web-render-board-'));
  writeLive(liveDir, [{ run: 'demo-live-run', issue: ready.issue, role: 'worker', model: 'sonnet', startedAt: new Date().toISOString(), pending: [] }]);
  const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: liveDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'web-render-slots-')), instance: 'demo' });
  try {
    for (const [role, login] of [['owner', 'example-owner'], ['writer', 'example-collaborator'], ['viewer', 'someone-else']] as const) {
      boards[role] = (await (await fetch(`${d.url.split('/?')[0]}/api/board`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(login) } })).json()) as Board;
    }
  } finally {
    await d.close();
  }
  browserStubs();
});

test('every page renders with the demo\'s state, and shows its data', () => {
  assert.ok(asOwner.tasks.length >= 5 && asOwner.decisions.some((d) => !d.answer), 'the demo has tasks and open decisions');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const html: Record<string, string> = {};
  for (const name of Object.keys(r.pages)) {
    html[name] = r.renderPage(name, asOwner);
    assert.match(html[name]!, /<h1[^>]*>/, `${name} renders its page`);
  }
  // The Issues page opens on its Current tab: everything in flight, waiting on a decision, queued or blocked.
  const current = new Set(['claimed', 'reproducing', 'building', 'verifying', 'evaluating', 'awaiting_decision', 'queued', 'blocked']);
  const inFlight = asOwner.tasks.filter((t) => current.has(t.status));
  assert.ok(inFlight.length >= 2, 'the demo has current work');
  for (const t of inFlight) assert.ok(html.issues!.includes(esc(t.title)), `issues lists "${t.title}"`);
  for (const d of asOwner.decisions.filter((x) => !x.answer)) assert.ok(html.decisions!.includes(esc(d.question)), `decisions shows "${d.question}"`);
  assert.ok(html.overview!.includes(esc(asOwner.activity[0]!.summary)), 'overview shows recent activity');
  assert.ok(html.activity!.includes(esc(asOwner.activity[0]!.summary)), 'activity shows the log');
  assert.match(html.overview!, /Agents running/);
  assert.match(html.agents!, /Recent runs/);
  for (const t of asOwner.tasks.slice(0, 3)) {
    const page = r.renderIssue(asOwner, t.issue);
    assert.ok(page.includes(esc(t.title)), `issue #${t.issue} shows its title`);
    assert.match(page, /Checks run by the coordinator/);
    assert.match(page, /Agent runs/);
  }
});

test('a prose recommendation is wrapped text, whole, clamped with Show more; only an option is a pill (Decisions and Inbox)', () => {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  /** One decision card's markup, from its own tag to the next card. */
  const cardOf = (html: string, id: string) => {
    const at = html.indexOf(`data-decision="${id}"`);
    assert.ok(at >= 0, `the card for ${id}`);
    const next = html.indexOf('data-decision="', at + 1);
    return html.slice(at, next < 0 ? undefined : next);
  };
  const open = asOwner.decisions.filter((d) => !d.answer) as unknown as { id: string; options: string[]; recommendation: string; receipts: string[] }[];
  assert.ok(open.some((d) => d.id === 'demo-old-prose'));
  for (const page of ['decisions', 'inbox']) {
    const html = r.renderPage(page, asOwner);
    const prose = cardOf(html, 'demo-old-prose');
    assert.ok(prose.includes(esc(LONG_PROSE)), `${page}: the whole recommendation, never cut`);
    assert.doesNotMatch(prose, /data-testid="decision-recommended"/, `${page}: prose is not a pill`);
    assert.match(prose, /<p[^>]*class="[^"]*\bline-clamp-4\b[^"]*\bbreak-words\b|<p[^>]*class="[^"]*\bbreak-words\b[^"]*\bline-clamp-4\b/, `${page}: wrapped and clamped by CSS`);
    assert.match(prose, /data-testid="decision-recommendation-toggle"[^>]*>Show more</, `${page}: Show more`);
    assert.doesNotMatch(prose, /…|\.\.\./, `${page}: not truncated in the string`);
    // Every option recommendation is the pill; no other card has one.
    for (const d of open) {
      const card = cardOf(html, d.id);
      if (d.options.includes(d.recommendation)) assert.match(card, new RegExp(`data-testid="decision-recommended"[^>]*>Recommended: <span[^>]*>${esc(d.recommendation).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`), `${page}: ${d.id}'s option is a pill`);
      else assert.doesNotMatch(card, /data-testid="decision-recommended"/, `${page}: ${d.id} recommends no option: no pill`);
      // A reasoning line in the detail is shown as prose too, not as a one-line receipt.
      for (const x of d.receipts.filter((x) => x.startsWith('Recommendation: '))) {
        assert.ok(card.includes(esc(x.slice('Recommendation: '.length))), `${page}: ${d.id}'s reasoning is shown`);
        assert.ok(!card.includes(`title="${esc(x)}"`), `${page}: ${d.id}'s reasoning isn't a truncated receipt`);
      }
    }
  }
});

test('decisions are answerable only where the server allows it (canAnswer)', () => {
  const open = asOwner.decisions.filter((d) => !d.answer);
  const mine = r.renderPage('decisions', asOwner);
  const options = open.reduce((n, d) => n + d.options.length, 0);
  // Every option is a button (an action that answers), not a radio or a row in a list.
  const buttons = [...mine.matchAll(/<button\b[^>]*data-option="([^"]*)"[^>]*>/g)];
  assert.equal(buttons.length, options, 'the owner gets one button per option');
  for (const [tag] of buttons) assert.match(tag, /type="button"/);
  assert.equal((mine.match(/data-option=/g) ?? []).length, options, 'nothing but buttons carries an option');
  assert.doesNotMatch(mine, /type="radio"|role="radio"/);
  // Only an option equal to the recommendation is primary; a free-text recommendation marks none.
  let freeText = 0;
  for (const d of open) {
    const rec = (d as { recommendation?: string }).recommendation ?? '';
    if (!d.options.includes(rec)) freeText++;
    for (const o of d.options) {
      const tag = buttons.find(([, x]) => x === o)?.[0] ?? '';
      if (o === rec) assert.match(tag, /bg-ink/, `"${o}" is the recommendation: the primary button`);
      else {
        assert.doesNotMatch(tag, /\bbg-ink\b/, `"${o}" isn't the recommendation ("${rec}"): not primary`);
        assert.doesNotMatch(tag, /title="recommended"/, `"${o}" isn't marked recommended`);
      }
    }
  }
  assert.ok(freeText >= 1, 'the demo has a decision whose recommendation is free text');
  for (const [tag, o] of buttons) if (/reject|close/.test(o!)) assert.match(tag, /text-red/, `"${o}" is marked destructive`);
  assert.ok(asOther.decisions.every((d) => d.canAnswer === false), 'the server says another user may not answer');
  const theirs = r.renderPage('decisions', asOther);
  assert.equal((theirs.match(/data-option=/g) ?? []).length, 0, 'no option buttons for someone who can\'t answer');
  assert.match(theirs, /Waiting on @example-owner/);
  // A viewer's decision cards show no receipts (the server sends none); the owner's do.
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const receipts = (asOwner.decisions as { receipts?: string[] }[]).flatMap((d) => d.receipts ?? []).filter((x) => x.length > 8);
  assert.ok(receipts.length, 'the demo has decisions with receipts');
  const ownerCards = r.renderPage('decisions', asOwner);
  assert.ok(receipts.some((x) => ownerCards.includes(esc(x))), "the owner's cards show them");
  for (const x of receipts) assert.ok(!theirs.includes(esc(x)), `a viewer's card doesn't show "${x}"`);
});

test('the PR page: what waits for you and exactly why, what is moving, what auto-merged (with links and reasons), refused pushes, the auto-merge state', () => {
  const pr = (number: number, phase: string, extra: Record<string, unknown> = {}) => ({ number, issue: number - 100, title: `Change ${number}`, url: `https://example.test/pr/${number}`, openedAt: new Date().toISOString(), head: 'a'.repeat(40), state: 'open', draft: true, status: null, unready: null, fixes: [], gaveUp: null, decision: null, waitReasons: [], merged: null, mergeFailed: null, mainResult: null, phase, ...extra });
  const view = {
    prs: [
      // A CI fix gave up, then (after a person's push) the merge policy still left it to a person: both reasons show.
      pr(108, 'gave_up', { gaveUp: { at: '', reason: 'gave up: the same test fails on main' }, waitReasons: ['high-risk: migrations'] }),
      pr(101, 'waiting', { draft: false, waitReasons: ['touches a migration (L3)'], decision: { at: '', head: 'a'.repeat(40), auto: false, reasons: ['touches a migration (L3)'] }, status: { head: 'a'.repeat(40), at: '', ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }] } }),
      pr(102, 'gave_up', { gaveUp: { at: '', reason: 'a flaky test, not this change' } }),
      pr(103, 'fixing', { fixes: [{ attempt: 1, at: new Date().toISOString(), checks: ['lint'], outcome: 'running', detail: '' }] }),
      pr(104, 'auto_merged', { state: 'merged', decision: { at: '', head: 'a'.repeat(40), auto: true, reasons: ['docs only, 12 lines'] }, merged: { at: new Date().toISOString(), sha: 'f'.repeat(40), url: 'https://example.test/commit/f', auto: true }, mainResult: { at: '', outcome: 'green', failed: [] } }),
    ],
    refused: [{ at: new Date().toISOString(), issue: 18, title: 'Too big', head: 'b'.repeat(40), stage: 'push', reasons: ['900 changed lines, over the 800 limit'] }],
    stops: [{ at: new Date().toISOString(), kind: 'stopped', reason: 'main went red', number: 104, revert: 'https://example.test/pr/200' }],
    autoMerge: { on: false, policy: true, repo: true, stopped: 'main went red', why: 'stopped: main went red; the operator clears it' },
  };
  const html = r.renderPrs(view);
  assert.match(html, /data-auto-merge="stopped"/);
  assert.match(html, /stopped: main went red; the operator clears it/);
  assert.match(html, /href="https:\/\/example.test\/pr\/200"/, 'the revert PR is linked');
  assert.match(html, /data-pr-reasons="101"[^>]*>[\s\S]*touches a migration \(L3\)/, 'exactly why it waits');
  assert.match(html, /data-pr-reasons="102"[^>]*>[\s\S]*a flaky test, not this change/, 'why the CI fix gave up');
  // Both reasons, each under its own heading, on one card.
  const card108 = html.slice(html.indexOf('data-pr="108"'), html.indexOf('data-pr="101"'));
  assert.match(card108, /Why the CI fix stopped[\s\S]*data-testid="pr-gave-up-reasons"[\s\S]*gave up: the same test fails on main/);
  assert.match(card108, /Why it waits for you[\s\S]*data-testid="pr-wait-reasons"[\s\S]*high-risk: migrations/);
  assert.match(html, /data-pr-checks="101"[\s\S]*test: pass/, 'checks on the current head');
  assert.match(html, /data-task-row="pr-103"[\s\S]*fixing CI/);
  assert.match(html, /data-pr="104" data-phase="auto_merged"[\s\S]*href="https:\/\/example.test\/commit\/f"[\s\S]*docs only, 12 lines/, 'auto-merged: the merge commit linked, and why');
  assert.match(html, /data-refused="18"[\s\S]*900 changed lines, over the 800 limit/);
  assert.match(r.renderPage('prs', asOwner), /<h1[^>]*>Pull requests/);
  // Stable hooks for every section and action on the page (kebab-case data-testid).
  for (const id of ['prs-page', 'prs-auto-merge', 'prs-auto-merge-state', 'prs-auto-merge-why', 'prs-revert-link', 'prs-waiting', 'pr-wait-card', 'pr-wait-reasons', 'pr-gave-up-reasons', 'pr-checks', 'pr-link', 'pr-issue-link', 'pr-review-link', 'prs-in-progress', 'pr-row', 'pr-fixes', 'pr-github-link', 'prs-auto-merged', 'prs-auto-merged-table', 'pr-merged-row', 'pr-merge-commit-link', 'pr-merge-reasons', 'prs-refused', 'prs-refused-table', 'refused-row', 'refused-issue-link']) {
    assert.match(html, new RegExp(`data-testid="${id}"`), `data-testid ${id}`);
  }
});

test('sign-in: the hub page shows a GitHub sign-in when nobody is signed in; the signed-in person, their role and a sign-out; the owners\' audit log', async () => {
  // Who is signed in is asked only on a hub page; a 401 there means: show the sign-in.
  const asked: string[] = [];
  const signedOut = async (url: string) => (asked.push(url), { ok: true, json: async () => ({ login: null, csrf: null, breakGlass: false }) });
  assert.equal(await r.probeMe(false, signedOut), null);
  assert.deepEqual(asked, [], "an instance's own dashboard has no sign-in: nothing asked");
  assert.equal(await r.probeMe(true, signedOut, ''), null, 'not signed in');
  assert.deepEqual(asked, ['/api/me']);
  const signedIn = async () => ({ ok: true, json: async () => ({ login: 'example-collaborator', csrf: 'c', breakGlass: false }) });
  assert.deepEqual(await r.probeMe(true, signedIn, ''), { login: 'example-collaborator', csrf: 'c', breakGlass: false });

  const page = r.renderSignIn();
  assert.match(page, /data-testid="sign-in"/);
  assert.match(page, /<a href="\/auth\/login" data-testid="sign-in-github"[^>]*>Sign in with GitHub<\/a>/);

  // The state the server gives each person: their login and role, read from the repo.
  assert.equal(asOther.decisions.some((d) => d.canAnswer), false, 'a viewer may answer nothing');
  const me = r.renderWhoAmI({ user: 'example-collaborator', role: 'writer', via: 'session' });
  assert.match(me, /data-testid="who-login">@example-collaborator</);
  assert.match(me, /data-testid="who-role"> · writer</);
  assert.match(me, /data-testid="sign-out"/, 'a signed-in person can sign out');
  const viewer = r.renderWhoAmI({ user: 'someone-else', role: 'viewer', via: 'session' });
  assert.match(viewer, /data-testid="who-role"> · viewer</);
  const glass = r.renderWhoAmI({ user: 'example-owner', role: 'owner', via: 'break-glass' });
  assert.match(glass, /owner \(break-glass\)/);
  assert.doesNotMatch(glass, /sign-out/, 'the break-glass has no session to end');

  const audit = r.renderAudit([{ id: 2, at: new Date().toISOString(), login: 'example-collaborator', role: 'writer', via: 'session', instance: 'a', action: 'decision.answered', detail: { id: 'd-1', answer: 'approve' } }]);
  assert.match(audit, /data-testid="audit-log"/);
  assert.match(audit, /@example-collaborator/);
  assert.match(audit, /decision\.answered/);
  assert.match(audit, /id d-1, answer approve/);
  assert.match(r.renderAudit([]), /No writes recorded yet/);
});

test('narrow screens: the page header\'s menu button opens a drawer with every page, the instance list and the status dots', () => {
  // Rendered as on the server, with no window: the drawer's scroll lock measures the page only in a browser.
  const g = globalThis as Record<string, unknown>;
  const stub = g.window;
  delete g.window;
  const drawerOf = (o?: Parameters<Render['renderNavDrawer']>[1]) => r.renderNavDrawer(asOwner as never, o);
  let open: string, amber: string, hub: string, closed: string;
  try {
    open = drawerOf();
    amber = drawerOf({ status: { '': 'amber' } });
    hub = drawerOf({ hub: { instances: [{ name: 'shop', up: true, error: null }, { name: 'web', up: false, error: 'down' }] }, status: { shop: 'red' } });
    closed = drawerOf({ open: false });
  } finally {
    g.window = stub;
  }
  // The menu button: named, says the drawer is open, and points at it.
  const button = open.match(/<button[^>]*data-testid="nav-menu"[^>]*>/)?.[0] ?? '';
  assert.ok(button, 'the header has a menu button');
  assert.match(button, /aria-label="Open navigation"/);
  assert.match(button, /aria-expanded="true"/);
  assert.match(button, /aria-controls="nav-drawer"/);
  assert.match(button, /md:hidden/, 'only on a narrow screen: the sidebar is there on a wide one');
  // The drawer: a dialog with that id, a title and a close button.
  const drawer = open.slice(open.indexOf('id="nav-drawer"'));
  assert.match(open, /<div[^>]*role="dialog"[^>]*id="nav-drawer"|<div[^>]*id="nav-drawer"[^>]*role="dialog"/, 'the drawer is a dialog with the id the button controls');
  assert.match(drawer, /data-testid="nav-drawer-close"[^>]*aria-label="Close navigation"|aria-label="Close navigation"[^>]*data-testid="nav-drawer-close"/);
  assert.match(drawer, />Navigation</);
  // Every page of the sidebar, as a link to its route.
  assert.ok(r.navRows.length >= 18, 'the sidebar rows were read');
  for (const n of r.navRows) assert.match(drawer, new RegExp(`<a href="${n.to.replace(/[/]/g, '\\/')}"[^>]*data-testid="${n.testId}"`), `the drawer links to ${n.label}`);
  assert.match(drawer, /data-testid="search-button"/);
  assert.match(drawer, /data-testid="theme-toggle"/);
  assert.match(drawer, /data-testid="live-indicator"/);
  // Off a hub: this instance's status dot, linking to Health.
  assert.match(amber.slice(amber.indexOf('id="nav-drawer"')), /<a href="\/health"[^>]*>.*?data-status="amber" data-testid="instance-status-dot"/);
  // On a hub: the instance list, each with its dot.
  const hubDrawer = hub.slice(hub.indexOf('id="nav-drawer"'));
  assert.match(hubDrawer, /data-testid="instance-switcher"/);
  assert.deepEqual([...hubDrawer.matchAll(/data-status="([a-z]+)" data-testid="instance-dot"/g)].map((m) => m[1]), ['red', 'red'], 'each instance has its dot (one not answering is red)');
  // Closed: the button says so, and there's no drawer.
  assert.match(closed, /data-testid="nav-menu"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-testid="nav-menu"/);
  assert.doesNotMatch(closed, /id="nav-drawer"/);
  // A header outside the dashboard (no drawer to open) has no menu button.
  assert.doesNotMatch(r.renderHeader('Board'), /nav-menu/);
});

test('the UI asks for hub instances only when a hub served the page (no 404 on an instance\'s own dashboard)', async () => {
  const asked: string[] = [];
  const get = async (url: string) => (asked.push(url), { ok: true, json: async () => ({ instances: [{ name: 'a', up: true, error: null }] }) });
  assert.equal(await r.probeHub(false, get), null);
  assert.deepEqual(asked, [], 'not served by a hub: no request at all');
  assert.deepEqual(await r.probeHub(true, get, 't'), { instances: [{ name: 'a', up: true, error: null }] });
  assert.deepEqual(asked, ['/api/hub']);
});

test('the health panel: suggestions, machine figures, services, check times with slowdowns, usage per day, and the instances side by side on a hub', () => {
  const today = new Date().toISOString().slice(0, 10);
  const series = Array.from({ length: 8 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), ms: 60_000 + i * 5_000, status: 'pass' }));
  const view = {
    instance: 'shop@box',
    machine: {
      at: new Date().toISOString(),
      platform: 'linux',
      memory: { totalBytes: 32e9, availableBytes: 2e9, swapTotalBytes: 8e9, swapFreeBytes: 4e9 },
      load: [3, 9, 8] as [number, number, number],
      units: [
        { unit: 'harness.slice', memoryCurrent: 6e9, memoryMax: null, memorySwapCurrent: 0, cpuUsageNSec: 7_200e9, activeState: 'active' },
        { unit: 'harness-shop.service', memoryCurrent: 9.5e9, memoryMax: 10e9, memorySwapCurrent: 1e9, cpuUsageNSec: 600e9, activeState: 'active' },
        { unit: 'gone.service', error: 'not loaded' },
      ],
      disks: [{ path: '/srv', freeBytes: 6e9, totalBytes: 100e9 }, { path: '/missing', error: 'ENOENT' }],
      unavailable: ['swap: example'],
    },
    cores: 4,
    checks: {
      timings: [
        { check: 'make test-full', runs: 25, series, recentMedianMs: 90_000, priorMedianMs: 60_000, regression: { slowerPct: 50 } },
        { check: 'make lint', runs: 3, series: series.slice(0, 3), recentMedianMs: 2_000, priorMedianMs: null, regression: null },
      ],
      slowest: ['make test-full', 'make lint'],
      regressions: ['make test-full'],
      rule: 'slower: the median of the last 5 runs is more than 25% (and 2 s) over the median of up to 20 runs before them',
    },
    usage: { days: [{ day: today, runs: 7, estimatedUsd: 3.2, turns: 90, rateLimited: 3, authProblems: 1, retries: { token_refresh: 1, overloaded: 2 }, retryWaitMs: 30_000, lockWaits: 2, lockWaitMs: 95_000 }], quotaNote: "How much of the Claude subscription's usage limit is left isn't visible to this harness." },
    suggestions: ['Consider running fewer agents at once (the policy\'s max_workers): only 6% of memory (2.0 GB) is available.', 'Consider looking at why "make test-full" got slower.'],
  };
  const html = r.renderHealth(view, [
    { name: 'shop', view, error: null },
    { name: 'site', view: null, error: 'connection refused' },
  ]);
  for (const id of ['health-panel', 'health-suggestions', 'health-machine', 'health-memory', 'health-swap', 'health-load', 'health-disk', 'health-units', 'health-instances', 'health-checks', 'health-checks-table', 'health-usage', 'health-usage-table', 'health-quota-note', 'health-unavailable', 'health-sparkline', 'health-regression']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.equal((html.match(/data-testid="health-suggestion"/g) ?? []).length, 2);
  assert.match(html, /2 to consider/);
  assert.match(html, /Suggestions only: nothing is changed for you/);
  assert.match(html, /2\.0 GB[\s\S]*of 32\.0 GB/, 'memory available');
  assert.match(html, /4\.0 GB[\s\S]*of 8\.0 GB/, 'swap in use');
  assert.match(html, /9\.0[\s\S]*4 cores/, '5-minute load, cores');
  assert.match(html, /6\.0 GB[\s\S]*6% of 100\.0 GB · \/srv/, 'free disk');
  assert.match(html, /not read[\s\S]*ENOENT/, 'a volume that couldn\'t be read says so');
  assert.equal((html.match(/data-testid="health-unit-row"/g) ?? []).length, 3);
  assert.match(html, /harness-shop\.service[\s\S]*9\.5 GB of 10\.0 GB/);
  assert.match(html, /not read: not loaded/);
  assert.match(html, /data-testid="health-check-row"[^>]*style="background:var\(--orange-tint\)"[\s\S]*make test-full[\s\S]*slower \+50%/, 'the slower check is flagged');
  assert.match(html, /not enough runs/);
  assert.match(html, /<title>[^<]*: 1 min 0 s \(pass\)<\/title>/, 'hovering a point gives its time');
  assert.match(html, new RegExp(`data-testid="health-usage-row"[\\s\\S]*${today}[\\s\\S]*~\\$3\\.20[\\s\\S]*3 \\(token_refresh 1, overloaded 2\\)[\\s\\S]*2, 1 min 35 s`));
  assert.match(html, /isn&#x27;t visible to this harness/);
  assert.equal((html.match(/data-testid="health-instance-row"/g) ?? []).length, 2);
  assert.match(html, /not answering: connection refused/);
  // Nothing measured (not Linux): it says so rather than showing zeros; and a quiet machine has nothing to do.
  const bare = r.renderHealth({ ...view, machine: null, suggestions: ['Nothing to suggest: memory, disk, load, usage and check times are within the usual limits.'], checks: { ...view.checks, timings: [], slowest: [], regressions: [] }, usage: { ...view.usage, days: [] } });
  assert.match(bare, /not measured/);
  assert.match(bare, /nothing to do/);
  assert.match(bare, /No timed check runs yet/);
  assert.doesNotMatch(bare, /data-testid="health-instances"/, 'no hub: no instances table');
});

test('the off-machine backup on the health panel: not set up with the docs link; the last verified copy; stale in red with the latest error; per instance on a hub', () => {
  const base = { instance: 'shop@box', machine: null, cores: 4, checks: { timings: [], slowest: [], regressions: [], rule: '' }, usage: { days: [], quotaNote: '' }, suggestions: ['Nothing to suggest.'] };
  const docs = { backups: 'https://example.org/acme/engine/blob/main/docs/backups.md' };
  const none = r.renderHealth({ ...base, offsiteBackup: null, docs });
  assert.match(none, /data-testid="health-offsite"[\s\S]*not set up/);
  assert.match(none, /data-testid="health-offsite-none"[\s\S]*Nothing is copied off this machine[\s\S]*offsite-backup\.yaml/);
  assert.match(none, /href="https:\/\/example\.org\/acme\/engine\/blob\/main\/docs\/backups\.md"[^>]*data-testid="health-offsite-docs"/);
  assert.match(r.renderHealth({ ...base, offsiteBackup: null }), /<code[^>]*>docs\/backups\.md<\/code>/, 'no repository: the doc is named, not linked');
  // An engine update the machine rolled back and holds: red, on the instance's panel and on the hub's.
  const updateHold = { at: '2026-10-12T03:00:00.000Z', sha: 'b'.repeat(40), reason: 'rollback: migration failed: bob: disk full', migration: true };
  assert.match(r.renderHealth({ ...base, offsiteBackup: null, updateHold }), /role="alert"[^>]*data-testid="health-update-held"[\s\S]*?Engine update rolled back: a migration failed[\s\S]*?2026-10-12 03:00 UTC, bbbbbbbbbbbb[\s\S]*?rollback: migration failed: bob: disk full/);
  assert.doesNotMatch(r.renderHealth({ ...base, offsiteBackup: null, updateHold: null }), /health-update-held/);
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const fresh = { destination: 'rclone remote, backups bucket', lastOkAt: at, lastOkKey: 'events-41.db.age', lastAttemptAt: at, lastError: null, ageHours: 3, stale: false };
  const ok = r.renderHealth({ ...base, offsiteBackup: fresh, docs });
  assert.match(ok, /verified 3 h ago/);
  assert.match(ok, new RegExp(`data-testid="health-offsite-last"[^>]*>3h ago \\(${at.slice(0, 10)} ${at.slice(11, 16)} UTC\\)`));
  assert.match(ok, /data-testid="health-offsite-destination"[^>]*>rclone remote, backups bucket</);
  assert.match(ok, /data-testid="health-offsite-key"[^>]*>events-41\.db\.age</);
  assert.doesNotMatch(ok, /data-testid="health-offsite-stale"/);
  const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const stale = r.renderHealth({ ...base, offsiteBackup: { ...fresh, lastOkAt: old, ageHours: 30, lastAttemptAt: new Date().toISOString(), lastError: 'put exited 1: remote unreachable', stale: true }, docs });
  assert.match(stale, />stale</);
  assert.match(stale, /role="alert"[^>]*data-testid="health-offsite-stale"[\s\S]*text-red[^>]*>The last verified copy is 30 h old\./);
  assert.match(stale, /data-testid="health-offsite-error"[^>]*>put exited 1: remote unreachable</);
  const never = r.renderHealth({ ...base, offsiteBackup: { ...fresh, lastOkAt: null, lastOkKey: null, ageHours: null, lastError: 'encrypt left the snapshot readable', stale: true }, docs });
  assert.match(never, /No copy has been verified yet\./);
  assert.match(never, /data-testid="health-offsite-last"[^>]*>never</);
  assert.doesNotMatch(never, /data-testid="health-offsite-key"/);
  // On a hub, each instance's backup in the side-by-side table.
  const hubHtml = r.renderHealth({ ...base, offsiteBackup: fresh }, [
    { name: 'shop', view: { ...base, offsiteBackup: fresh }, error: null },
    { name: 'site', view: { ...base, offsiteBackup: null }, error: null },
    { name: 'code', view: { ...base, offsiteBackup: { ...fresh, lastOkAt: null, ageHours: null, stale: true } }, error: null },
  ]);
  const cells = [...hubHtml.matchAll(/data-testid="health-instance-offsite">([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
  assert.deepEqual(cells, ['3 h ago', 'not set up', 'never verified']);
});

test('the instance settings: the owner gets a new-value input and a review step per setting; anyone else sees who can change them', () => {
  const data = {
    owner: 'example-owner',
    user: 'example-owner',
    canChange: true,
    keys: ['workers', 'daily_budget_usd', 'ci_repair.enabled', 'ci_repair.max_fixes_per_pr', 'run_windows'],
    available: true,
    limits: { workers: { min: 1, max: 4 }, daily_budget_usd: { max: 20 }, max_fixes_per_pr: { max: 3 } },
    limitsError: null,
    ceilings: { max_workers: 3, daily_usd: 30 },
    settings: [
      { key: 'workers', value: 2, source: 'instance' },
      { key: 'daily_budget_usd', value: 12, source: 'instance' },
      { key: 'ci_repair.enabled', value: false, source: 'repo' },
      { key: 'ci_repair.max_fixes_per_pr', value: 2, source: 'engine' },
      { key: 'run_windows', value: [{ from: '22:00', to: '06:00' }], source: 'instance' },
    ],
  };
  const html = r.renderInstanceSettings(data);
  assert.equal((html.match(/data-testid="setting-row"/g) ?? []).length, 5);
  assert.match(html, /data-setting="workers"[\s\S]*?data-testid="setting-current"[^>]*>2<[\s\S]*?this instance(&#x27;|')s[\s\S]*?1–3 \(machine 1–4, policy max 3\)/, 'current value, source, bounds (the tighter of machine and policy)');
  assert.match(html, /up to \$20 \(machine \$20, policy \$30\)/);
  assert.match(html, /data-setting="run_windows"[\s\S]*?22:00-06:00/);
  assert.match(html, /the repo(&#x27;|')s default/);
  assert.match(html, /data-setting="ci_repair.max_fixes_per_pr"[\s\S]*?>engine default</, 'a key the repo\'s config doesn\'t define: the engine\'s own default');
  assert.equal((html.match(/data-testid="setting-review-button"/g) ?? []).length, 5, 'a review step for each, before anything is written');
  assert.doesNotMatch(html, /data-testid="setting-confirm"/, 'confirm appears only after Review change');
  assert.doesNotMatch(html, /data-testid="settings-read-only"/);
  const theirs = r.renderInstanceSettings({ ...data, user: 'example-collaborator', canChange: false });
  assert.match(theirs, /data-testid="settings-read-only"[^>]*>Only the owner, @example-owner, can change these; you are @example-collaborator\./);
  assert.doesNotMatch(theirs, /data-testid="setting-input"|data-testid="setting-review-button"/, 'no inputs for anyone but the owner');
  assert.match(r.renderInstanceSettings({ ...data, available: false, why: 'settings belong to an instance' }), /settings belong to an instance/);
  // What's typed becomes a typed value, or says why it can't.
  assert.deepEqual(r.parseEntry('workers', '3'), { value: 3 });
  assert.deepEqual(r.parseEntry('workers', '2.5'), { error: 'a whole number' });
  assert.deepEqual(r.parseEntry('daily_budget_usd', '12.5'), { value: 12.5 });
  assert.deepEqual(r.parseEntry('ci_repair.enabled', 'on'), { value: true });
  assert.deepEqual(r.parseEntry('run_windows', '22:00-06:00, 12:00 - 13:00'), { value: [{ from: '22:00', to: '06:00' }, { from: '12:00', to: '13:00' }] });
  assert.deepEqual(r.parseEntry('run_windows', ''), { value: [] });
  assert.match(String((r.parseEntry('run_windows', 'night') as { error: string }).error), /isn't HH:MM-HH:MM/);
  assert.equal(r.showValue('run_windows', []), 'any time');
});

test('the research settings: readable names, bounds from the machine\'s limits, the repo access as an on/off switch, and a name for every setting key', () => {
  const data = {
    owner: 'example-owner',
    user: 'example-owner',
    canChange: true,
    keys: [...SETTING_KEYS],
    available: true,
    limits: { workers: { min: 1, max: 4 }, daily_budget_usd: { max: 20 }, max_fixes_per_pr: { max: 3 }, research: { max_searches_per_day: 200, max_fetches_per_day: 500, max_usd_per_day: 20 } },
    limitsError: null,
    ceilings: { max_workers: 3, daily_usd: 30 },
    settings: [
      { key: 'research.max_searches_per_day', value: 20, source: 'instance' },
      { key: 'research.max_fetches_per_day', value: 40, source: 'repo' },
      { key: 'research.max_usd_per_day', value: 2.5, source: 'instance' },
      { key: 'research.repo_access', value: false, source: 'repo' },
    ],
  };
  const html = r.renderInstanceSettings(data);
  const row = (key: string) => html.match(new RegExp(`<tr[^>]*data-setting="${key.replace('.', '\\.')}"[\\s\\S]*?</tr>`))?.[0] ?? '';
  assert.match(row('research.max_searches_per_day'), />Research searches per day</);
  assert.match(row('research.max_searches_per_day'), /data-testid="setting-bounds"[^>]*>0–200 \(machine limit\)</);
  assert.match(row('research.max_fetches_per_day'), />Research page fetches per day</);
  assert.match(row('research.max_fetches_per_day'), /data-testid="setting-bounds"[^>]*>0–500 \(machine limit\)</);
  assert.match(row('research.max_usd_per_day'), />Research spend per day \(estimated, USD\)</);
  assert.match(row('research.max_usd_per_day'), /data-testid="setting-current"[^>]*>\$2\.5</, 'money, with its $');
  assert.match(row('research.max_usd_per_day'), /data-testid="setting-bounds"[^>]*>up to \$20 \(machine limit\)</);
  assert.match(row('research.repo_access'), />Research runs may read the repo</);
  assert.match(row('research.repo_access'), /data-testid="setting-current"[^>]*>off</);
  assert.equal((row('research.repo_access').match(/<button[^>]*data-testid="setting-input"/g) ?? []).length, 2, 'two buttons, on and off, not a text box');
  for (const k of ['research.max_searches_per_day', 'research.max_fetches_per_day', 'research.max_usd_per_day']) assert.doesNotMatch(row(k), /on or off/, `${k} is a number, not a switch`);
  // What can be entered: whole caps, a cent amount for the spend cap, on or off for the access.
  assert.deepEqual(r.parseEntry('research.max_searches_per_day', '50'), { value: 50 });
  assert.deepEqual(r.parseEntry('research.max_fetches_per_day', '1.5'), { error: 'a whole number' });
  assert.deepEqual(r.parseEntry('research.max_usd_per_day', '2.75'), { value: 2.75 });
  assert.deepEqual(r.parseEntry('research.repo_access', 'on'), { value: true });
  // The stuck-run guard's mode: one of three words, never a number or a switch.
  assert.deepEqual(r.parseEntry('stuck_guard', 'dry-run'), { value: 'dry-run' });
  assert.deepEqual(r.parseEntry('stuck_guard', 'maybe'), { error: 'off, dry-run, on' });
  assert.equal(r.boundsOf('research.max_usd_per_day', { ...data, limits: { ...data.limits, research: undefined } }), '', 'no research limits sent: no bounds line, not a wrong one');
  // Every setting key the server has gets a readable name, so a new one never shows as its raw key.
  assert.deepEqual(SETTING_KEYS.filter((k) => !r.LABEL[k]), []);
});

test('the Updates panel: the engine installed, the last update, a rollback held because the canary failed, and the canary with its duration and PR link', () => {
  const at = new Date(Date.now() - 3 * 3600_000).toISOString();
  const data = {
    configured: true,
    enabled: true,
    installed: { sha: 'a'.repeat(40), version: '0.4.1' },
    lastInstall: { at, from: 'a'.repeat(40), to: 'b'.repeat(40) },
    rollback: { at, sha: 'b'.repeat(40), reason: 'rollback: canary failed: timed out after 121 minutes at "pr": PR #7 open', held: true, canary: true },
    canary: {
      settings: { instance: 'canary', repo: 'example-org/canary-scratch', timeLimitMinutes: 120 },
      running: null,
      last: { at, passed: false, trigger: 'update', stage: 'pr', why: 'timed out after 121 minutes at "pr": PR #7 open', durationMs: 121 * 60_000, timedOut: true, issue: { number: 6, url: 'https://github.com/example-org/canary-scratch/issues/6' }, pr: { number: 7, url: 'https://github.com/example-org/canary-scratch/pull/7' }, sha: 'b'.repeat(40) },
    },
  };
  const html = r.renderUpdatesPanel(data);
  for (const id of ['updates-panel', 'updates-installed', 'updates-last', 'updates-rollback', 'updates-rollback-reason', 'updates-canary', 'updates-canary-last', 'updates-canary-why']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /data-testid="updates-installed"[\s\S]*?v0\.4\.1[\s\S]*?aaaaaaaaaaaa/);
  assert.match(html, /data-testid="updates-last"[\s\S]*?aaaaaaaaaaaa → bbbbbbbbbbbb/);
  assert.match(html, /rolled back: canary failed[\s\S]*?held[\s\S]*?timed out after 121 minutes/);
  assert.match(html, /data-testid="updates-canary-last"[\s\S]*?timed out[\s\S]*?after installing bbbbbbbbbbbb · 2 h 01 min[\s\S]*?href="https:\/\/github\.com\/example-org\/canary-scratch\/pull\/7"[^>]*>PR #(<!-- -->)?7/);
  // Passed, a daily one, and nothing rolled back.
  const ok = r.renderUpdatesPanel({ ...data, rollback: null, canary: { ...data.canary, running: { at, trigger: 'daily', issue: 9, url: 'https://github.com/example-org/canary-scratch/issues/9', deadline: at }, last: { ...data.canary.last, passed: true, timedOut: false, trigger: 'daily', durationMs: 17 * 60_000, why: 'PR #7 merged with 1 green check' } } });
  assert.match(ok, /data-testid="updates-rollback"[\s\S]*?none/);
  assert.match(ok, /passed[\s\S]*?daily · 17 min/);
  assert.doesNotMatch(ok, /data-testid="updates-canary-why"/, 'a pass shows no failure reason');
  assert.match(ok, /data-testid="updates-canary-running"[\s\S]*?issue #(<!-- -->)?9/);
  // No canary configured: where to read how.
  assert.match(r.renderUpdatesPanel({ ...data, canary: { settings: null, running: null, last: null } }), /not set up: see[\s\S]*docs\/canary\.md/);
  assert.deepEqual([r.duration(42_000), r.duration(17 * 60_000), r.duration(65 * 60_000), r.duration(null)], ['42s', '17 min', '1 h 05 min', '–']);
});

test('the machine settings: the owner gets the slot cap and engine updates with a review step; the history tables; read-only for anyone else', () => {
  const data = {
    owner: 'example-owner',
    user: 'example-owner',
    canChange: true,
    helper: '/usr/local/libexec/harness-machine',
    slots: { cap: 3, running: 1, min: 1, max: 16 },
    updates: { configured: true, enabled: true, branch: 'main', requiredChecks: ['test'] },
    changes: [{ at: new Date().toISOString(), by: 'wl-site', what: 'slots', from: 2, to: 3 }],
    history: [
      { at: new Date().toISOString(), event: 'rolled_back', from: 'b'.repeat(40), to: 'c'.repeat(40), failed: ['harness-site.service'], back: 'b'.repeat(40) },
      { at: new Date().toISOString(), event: 'installed', from: 'a'.repeat(40), to: 'b'.repeat(40), units: ['harness-site.service'] },
    ],
  };
  const html = r.renderMachine(data);
  for (const id of ['machine-settings', 'machine-setting-row', 'machine-setting-current', 'machine-setting-input', 'machine-setting-review-button', 'updates-history', 'updates-history-table', 'update-row', 'machine-changes', 'machine-changes-table', 'machine-change-row']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /data-setting="slots"[\s\S]*?>3<[\s\S]*?1–16; 1 in use now/);
  assert.match(html, /data-setting="updates"[\s\S]*?>on</);
  assert.doesNotMatch(html, /data-testid="machine-setting-confirm"/, 'confirm only after Review change');
  assert.match(html, /data-testid="update-row"[^>]*style="background:var\(--red-tint\)"[\s\S]*rolled back[\s\S]*bbbbbbbb → cccccccc[\s\S]*back to bbbbbbbb[\s\S]*failed: harness-site\.service/);
  assert.match(html, /installed[\s\S]*restarted: harness-site\.service/);
  assert.match(html, /data-testid="machine-change-row"[\s\S]*wl-site[\s\S]*slots[\s\S]*2 → 3/);
  const theirs = r.renderMachine({ ...data, user: 'example-collaborator', canChange: false });
  assert.match(theirs, /data-testid="machine-read-only"[^>]*>Only the owner, @example-owner, can change these; you are @example-collaborator\./);
  assert.doesNotMatch(theirs, /data-testid="machine-setting-input"/);
  // An instance owner who isn't a machine owner: read-only, naming who may change the machine.
  const instanceOnly = r.renderMachine({ ...data, user: 'ivy', canChange: false, machineOwner: false, machineOwners: ['ada', 'olu'], needs: 'x' });
  assert.match(instanceOnly, /data-testid="machine-read-only"[^>]*>Read-only: only the machine(&#x27;|')s owners can change these; you are @ivy\. <span data-testid="machine-owners">machine owners: @ada, @olu<\/span>/);
  assert.doesNotMatch(instanceOnly, /data-testid="machine-setting-input"|data-testid="machine-needs"/);
  const owned = { ...data, machineOwner: true, machineOwners: ['example-owner'], needs: "one of the console's allowed devices" };
  assert.match(r.renderMachine(owned), /data-testid="machine-needs"[^>]*>A change needs one of the console(&#x27;|')s allowed devices\./, 'a machine owner is told what a change needs (an older server: no readiness)');
  assert.match(r.renderMachine({ ...owned, deviceReady: true }), /data-testid="machine-needs" data-ready="yes"[^>]*>You may change these: this page came from one of the console(&#x27;|')s allowed devices\./, 'from an allowed device: changes may be made');
  assert.match(r.renderMachine({ ...owned, deviceReady: false }), /data-testid="machine-needs" data-ready="no"[^>]*>A change needs one of the console(&#x27;|')s allowed devices, and this page didn(&#x27;|')t come from one\./, 'from elsewhere: says so');
  const noUpdater = r.renderMachine({ ...data, updates: { configured: false, enabled: null }, history: [] });
  assert.match(noUpdater, /data-setting="updates"[\s\S]*?not set up/);
  assert.match(noUpdater, /No updates: the updater isn(&#x27;|')t set up on this machine/);
});

test('the PR page shows the latest stale-PR pass and its counts', () => {
  const base = { prs: [], refused: [], stops: [], holds: [], autoMerge: { on: true, policy: true, repo: true, stopped: null, why: 'on' } };
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const html = r.renderPrs({ ...base, hygiene: { at, merged_in: 2, conflicting: 1, closed: 0, held: 1, skipped: 3, line: '2 merged in, 1 conflicting, 0 closed, 1 held for an owner, 3 skipped' } });
  assert.match(html, /data-testid="prs-hygiene"[^>]*>stale PR pass [^<]*ago: <span[^>]*>2 merged in, 1 conflicting, 0 closed, 1 held for an owner, 3 skipped</);
  assert.doesNotMatch(r.renderPrs({ ...base, hygiene: null }), /prs-hygiene/, 'nothing before the first pass');
});

test('merge flow on the PR page and in the health panel: conflict fixes, light checks and hotspot holds, with how long', () => {
  const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const pr = (number: number, phase: string, extra: Record<string, unknown> = {}) => ({ number, issue: number - 100, title: `Change ${number}`, url: `https://example.test/pr/${number}`, openedAt: mins(60), head: 'a'.repeat(40), state: 'open', draft: false, status: null, unready: null, fixes: [], gaveUp: null, decision: null, waitReasons: [], merged: null, mergeFailed: null, mainResult: null, conflict: null, lightCheck: null, phase, ...extra });
  const html = r.renderPrs({
    prs: [
      pr(131, 'resolving', { conflict: { state: 'running', at: mins(7), attempt: 2, outcome: null, files: [], waitsOwner: false, reasons: [], detail: '' } }),
      pr(132, 'waiting', { conflict: { state: 'done', at: mins(3), attempt: 1, outcome: 'pushed', files: ['src/totals.js'], waitsOwner: true, reasons: ['the merge touched src/totals.js (money-path)'], detail: 'merged main' } }),
      pr(133, 'light_check', { lightCheck: { state: 'running', at: mins(4), mainSha: 'f'.repeat(40), overlap: ['src/cart.js'], outcome: null, waitMs: null, detail: '' } }),
    ],
    refused: [],
    stops: [],
    holds: [
      { issue: 41, title: 'Round the discounts', by: 32, files: ['src/totals.js', 'src/discounts.js'], reason: 'issue 32 is changing them', since: mins(12), until: null, waitedMs: null },
      { issue: 40, title: 'Change the totals', by: 31, files: ['src/totals.js'], reason: '', since: mins(30), until: mins(27), waitedMs: 180_000 },
    ],
    autoMerge: { on: true, policy: true, repo: true, stopped: null, why: 'on' },
  });
  assert.match(html, /data-task-row="pr-131"[\s\S]*?merging main, 7 min[\s\S]*?resolving a conflict/, 'a conflict being resolved, for how long');
  assert.match(html, /data-testid="pr-conflict"[\s\S]*?resolving \(attempt 2\)/);
  assert.match(html, /data-pr="132"[\s\S]*?Why the conflict fix waits for you[\s\S]*?data-testid="pr-conflict-reasons"[\s\S]*?the merge touched src\/totals\.js \(money-path\)/, 'why it waits after a conflict fix');
  assert.match(html, /data-pr="132"[\s\S]*?conflict fix: pushed[\s\S]*?src\/totals\.js · merged main/);
  assert.match(html, /data-task-row="pr-133"[\s\S]*?waiting 4 min[\s\S]*?light check/, 'a PR waiting on a light check, for how long');
  assert.match(html, /data-testid="pr-light-check"[\s\S]*?light check running[\s\S]*?waiting 4 min on main ffffffff · overlap: src\/cart\.js/);
  assert.match(html, /data-testid="prs-holds"[\s\S]*?1 held now/);
  assert.match(html, /data-testid="hold-row" data-held="held"[\s\S]*?#41[\s\S]*?#32[\s\S]*?src\/totals\.js, src\/discounts\.js[\s\S]*?held 12 min/, 'a task held on a hotspot: the files and how long');
  assert.match(html, /data-held="released"[\s\S]*?waited 3 min/);

  const view = {
    instance: 'shop',
    machine: null,
    cores: 4,
    checks: { timings: [], slowest: [], regressions: [], rule: '' },
    usage: { days: [], quotaNote: 'q' },
    merge: { since: mins(7 * 24 * 60), mergedPrs: 4, conflicts: { count: 2, needOwner: 1, minutesToMerged: [20, 40], medianMinutes: 30, perMergedPr: 15 }, lightChecks: { count: 3, minutesAdded: 9, perMergedPr: 2.3, outcomes: { merge: 2, hold: 1 } }, holds: { count: 2, minutesWaited: 15, perMergedPr: 3.8, byFile: [{ file: 'src/totals.js', minutes: 12, count: 1 }] }, flags: ['x'] },
    suggestions: ['Consider listing src/totals.js as hotspots so those tasks don\'t run at once (conflict fixes add 15 min per merged PR).'],
  };
  const h = r.renderHealth(view);
  assert.match(h, /data-testid="health-merge"[\s\S]*?4 merged PR\(s\)/);
  assert.match(h, /data-measure="conflicts"[\s\S]*?>2<[\s\S]*?30 median to merged[\s\S]*?15 min[\s\S]*?1 needed the owner/);
  assert.match(h, /data-measure="light-checks"[\s\S]*?>3<[\s\S]*?9 added[\s\S]*?2\.3 min[\s\S]*?merge 2 · hold 1/);
  assert.match(h, /data-measure="holds"[\s\S]*?15 waited[\s\S]*?3\.8 min[\s\S]*?most on src\/totals\.js/);
  assert.match(h, /data-testid="health-suggestion"[^>]*>Consider listing src\/totals\.js as hotspots/);
});

test('the live run: text, thinking, tool calls with their results, diffs, messages, the end; the owner\'s console; agents link to it', () => {
  const at = new Date().toISOString();
  const items = [
    { seq: 0, at, kind: 'start', run: 'r', issue: 7, role: 'worker', model: 'sonnet' },
    { seq: 1, at, kind: 'thinking', text: 'the total rounds down' },
    { seq: 2, at, kind: 'text', text: 'Looking at the totals.' },
    { seq: 3, at, kind: 'tool', id: 't1', tool: 'Bash', input: '{"command":"npm test"}' },
    { seq: 4, at, kind: 'tool_result', id: 't1', status: 'error', output: 'not ok 3 - rounds to the cent' },
    { seq: 5, at, kind: 'tool', id: 't2', tool: 'Edit', input: '{"file_path":"src/totals.js"}' },
    { seq: 6, at, kind: 'diff', id: 't2', tool: 'Edit', file: 'src/totals.js', diff: '-Math.floor(x)\n+Math.round(x)' },
    { seq: 7, at, kind: 'message', id: 'm1', state: 'queued', text: 'also update the README' },
  ];
  const running = r.renderLiveFeed(items, false);
  assert.match(running, /data-testid="live-thinking"[\s\S]*Thinking[\s\S]*the total rounds down/);
  assert.match(running, /data-testid="live-text"[^>]*>Looking at the totals\.</);
  assert.match(running, /data-tool="Bash"[\s\S]*?npm test[\s\S]*?>error</, 'a tool call with its input and how it ended');
  assert.match(running, /data-tool="Edit"[\s\S]*?src\/totals\.js[\s\S]*?running/, 'a write still running');
  assert.match(running, /data-testid="live-diff"[\s\S]*?src\/totals\.js[\s\S]*?bg-red-tint[^>]*>-Math\.floor\(x\)[\s\S]*?bg-green-tint[^>]*>\+Math\.round\(x\)/);
  assert.match(running, /data-testid="live-message" data-state="queued"[\s\S]*also update the README[\s\S]*held until the current turn ends/);
  assert.match(running, /data-testid="live-working"/);
  const done = r.renderLiveFeed([...items, { seq: 8, at, kind: 'truncated', why: 'lines' }, { seq: 9, at, kind: 'end', reason: 'succeeded', costUsd: 0.3, turns: 4 }], true);
  assert.match(done, /data-testid="live-truncated"[^>]*>The feed reached its line cap/);
  assert.match(done, /data-testid="live-end"[\s\S]*Run ended: succeeded[\s\S]*4 turn\(s\)[\s\S]*~\$0\.30/);
  assert.doesNotMatch(done, /data-testid="live-working"/);

  const con = { owner: 'example-owner', canControl: true, live: true, pending: [{ id: 'm1', text: 'also update the README', by: 'example-owner', at }], held: [], events: [] };
  const panel = r.renderConsole(con);
  for (const id of ['console-panel', 'console-input', 'console-send', 'console-stop', 'console-pending', 'console-pending-item']) assert.match(panel, new RegExp(`data-testid="${id}"`), id);
  assert.match(panel, /data-testid="console-pending-item"[\s\S]*held[\s\S]*also update the README/);
  assert.doesNotMatch(panel, /data-testid="console-stop-confirm"/, 'stop needs a second click');
  assert.match(r.renderConsole({ ...con, canControl: false, canMessage: false }), /data-testid="console-read-only"[^>]*>The owner, @example-owner, and the writers can message this run; only the owner can stop it\./);
  // A writer messages the run but doesn't stop it.
  const writer = r.renderConsole({ ...con, canControl: false, canMessage: true });
  assert.match(writer, /data-testid="console-send"/);
  assert.doesNotMatch(writer, /data-testid="console-stop"|console-read-only/);
  assert.equal(r.renderConsole({ ...con, live: false }), '', 'nothing to control once the run has ended');

  const run = { issue: asOwner.tasks[0]!.issue, role: 'worker', model: 'sonnet', pid: 1, attempt: 1, startedAt: at, lastHeartbeat: null, note: null, finishedAt: null, reason: null, costUsd: 0 };
  const state = { ...asOwner, runs: { active: [run], recent: [] } } as unknown as State;
  const agents = r.renderAgents(state, { canControl: true, runs: [{ run: 'run-1', issue: run.issue, role: 'worker', model: 'sonnet', startedAt: at, pending: [] }] });
  assert.match(agents, /data-testid="agent-live-link" data-run="run-1"[\s\S]*live view/);
  assert.doesNotMatch(r.renderAgents(state, { canControl: true, runs: [] }), /agent-live-link/, 'no live view listed: no link');
});

test('checks render as a table with failures tinted and their output; instances as sidebar rows; the stop banner', () => {
  const checks = r.renderChecks([{ id: 1, at: new Date().toISOString(), stage: 'verify', head: 'c'.repeat(40), checks: [{ check: 'npm test', status: 'fail', exitCode: 1, tail: 'AssertionError: 2 !== 3' }, { check: 'npm run full', status: 'skipped', exitCode: null, tail: null }] }]);
  assert.match(checks, /<table/);
  assert.match(checks, /data-check="fail"[^>]*>[\s\S]*npm test/);
  assert.match(checks, /AssertionError: 2 !== 3/);
  assert.match(checks, /<details open=""/, 'the latest failure is open');
  assert.match(checks, /data-check="skipped"/);
  const nav = r.renderInstances({ instances: [{ name: 'site', up: true, error: null }, { name: 'code', up: false, error: 'down' }] }, 'site');
  assert.match(nav, /data-instance-switcher/);
  assert.match(nav, /aria-current="true"[^>]*>[\s\S]*site/);
  assert.match(nav, /code \(not answering\)/);
  assert.match(nav, /disabled=""/, 'an instance that isn\'t answering can\'t be picked');
  assert.equal(r.renderStopBanner({ ...asOwner, emergency: { inForce: null, halted: null, lastStop: null, lastResume: null } }), '');
  assert.match(r.renderStopBanner({ ...asOwner, emergency: { inForce: { by: 'ops', at: '', reason: 'spend' }, halted: null, lastStop: null, lastResume: null } }), /Emergency stop in force/);
});

test('the usage-limit pause: a banner per paused instance counting down to its reset, and a usage line per instance on the Overview', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const running = { instance: 'site', paused: null, today: { runs: 12, limitHits: 0 }, lastHit: null };
  const paused = { instance: 'code', paused: { since: '2026-10-13T09:00:00Z', resetAt: '2026-10-13T12:05:09Z', source: 'claude', kind: 'five_hour' }, today: { runs: 4, limitHits: 1 }, lastHit: '2026-10-13T09:00:00Z' };
  // The countdown, to the second, and "now" once the reset has passed.
  assert.equal(r.countdown(paused.paused.resetAt, now), '2 h 05 min 09 s');
  assert.equal(r.countdown(paused.paused.resetAt, now + 2 * 3600_000 + 5 * 60_000), '0 min 09 s');
  assert.equal(r.countdown(paused.paused.resetAt, now + 3 * 3600_000), 'now');
  // No banner while nothing is paused; one per paused instance, with its countdown.
  assert.equal(r.renderUsageBanner([running], now), '');
  const banner = r.renderUsageBanner([running, paused], now);
  assert.equal((banner.match(/data-testid="usage-banner"/g) ?? []).length, 1);
  assert.match(banner, /data-instance="code"/);
  assert.match(banner, /Paused on the Claude usage limit/);
  assert.match(banner, /data-testid="usage-countdown"[^>]*>resumes in 2 h 05 min 09 s</);
  assert.match(banner, /requeued, not failed/);
  assert.doesNotMatch(banner, /default wait/, 'claude named the reset');
  assert.match(r.renderUsageBanner([{ ...paused, paused: { ...paused.paused, source: 'default' } }], now), /default wait/);
  assert.match(r.renderUsageBanner([paused], now + 3 * 3600_000), />resuming now</);
  // The Overview: a line per instance, running or paused, with today's runs and limit hits.
  const lines = r.renderUsageLines([running, paused], now);
  assert.equal((lines.match(/data-testid="usage-line"/g) ?? []).length, 2);
  assert.match(lines, /12 runs today/);
  assert.match(lines, /1 usage-limit hit today/);
  assert.match(lines, /data-instance="code"[\s\S]*paused until [^<]*\(2 h 05 min 09 s\)/);
  assert.match(lines, /data-instance="site"[\s\S]*>running</);
  assert.match(r.renderOverviewWithUsage(asOwner, [running, paused], now), /data-testid="overview-usage"/);
  assert.doesNotMatch(r.renderPage('overview', asOwner), /overview-usage/, 'no usage read yet: no line');
});

test('the protection mode on the Machine page, the last commit checked for writers, and the alert with its clear for an admin', () => {
  const sha = 'c'.repeat(40);
  const watch = { mode: 'main_watch' as const, detail: "GitHub doesn't protect main", lastChecked: { sha, url: `https://github.com/o/r/commit/${sha}`, at: new Date().toISOString() }, alert: null, stopped: null, canClear: false };
  const html = r.renderProtection(watch, BRAND.name);
  assert.match(html, new RegExp(`data-testid="protection-mode"[^>]*>${BRAND.name} guard \\(main watch\\)`));
  assert.match(html, /Last commit checked:[\s\S]*cccccccc/);
  assert.match(r.renderProtection({ mode: 'github' }, BRAND.name), /GitHub enforced/);
  assert.doesNotMatch(r.renderProtection({ mode: 'main_watch' }, BRAND.name), /Last commit checked/, "a viewer's: the mode only");
  assert.equal(r.renderMainWatchAlert(watch), '', 'no alert, no banner');
  const alert = { ...watch, alert: { at: new Date().toISOString(), sha, url: watch.lastChecked.url, reason: 'cccccccc was pushed to main directly', number: null, revert: 'https://github.com/o/r/pull/9' }, stopped: 'main watch: x' };
  const banner = r.renderMainWatchAlert(alert);
  assert.match(banner, /Unaccounted commit on the default branch[\s\S]*pushed to main directly[\s\S]*pull\/9/);
  assert.doesNotMatch(banner, /main-watch-clear/, 'only an admin gets the clear');
  assert.match(r.renderMainWatchAlert({ ...alert, canClear: true }), /data-testid="main-watch-clear"[^>]*>Clear and resume auto-merge/);
});

test('the pre-deploy gate on the Machine page: the deployed sha, the last held sha and why, a refusal', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const now = new Date().toISOString();
  const moving = r.renderDeployGate({ branch: 'deploy', enabled: true, tiers: ['suite'], postDeploy: false, deployed: { sha: a, url: `https://github.com/o/r/commit/${a}`, at: now, by: 'gate', override: false }, held: null, refused: null });
  assert.match(moving, /Pre-deploy gate[\s\S]*Moving/);
  assert.match(moving, /data-testid="deploy-gate-deployed"[\s\S]*deploy[\s\S]*aaaaaaaa/);
  assert.doesNotMatch(moving, /deploy-gate-held/);
  const held = r.renderDeployGate({ branch: 'deploy', enabled: true, tiers: ['suite'], postDeploy: false, deployed: { sha: a, url: '', at: null, by: null, override: false }, held: { sha: b, url: `https://github.com/o/r/commit/${b}`, at: now, reason: 'failed: suite' }, refused: null });
  assert.match(held, /Held<[\s\S]*data-testid="deploy-gate-held"[\s\S]*bbbbbbbb[\s\S]*failed: suite/);
  assert.match(r.renderDeployGate({ branch: 'deploy', enabled: true, tiers: ['suite'], postDeploy: false, deployed: null, held: null, refused: { at: now, reason: 'deploy is off main' } }), /Refused[\s\S]*not moved by the gate yet[\s\S]*deploy is off main/);
});

test('the pre-deploy gate, configured but off (deploy_gate.enabled not true): says so, and what turning it on would do', () => {
  const off = r.renderDeployGate({ branch: 'deploy', enabled: false, tiers: ['chain', 'suite'], postDeploy: true, deployed: null, held: null, refused: null });
  assert.match(off, /Pre-deploy gate[\s\S]*Configured, off/);
  assert.match(off, /data-testid="deploy-gate-off"/);
  assert.match(off, /deploy_gate.enabled: true[\s\S]*reviewed PR[\s\S]*would run chain, suite on each new default-branch commit[\s\S]*roll it back on a failed check/);
  assert.doesNotMatch(off, /Moving|deploy-gate-deployed/, 'nothing claims it moves');
  assert.doesNotMatch(r.renderDeployGate({ branch: 'deploy', enabled: false, tiers: ['suite'], postDeploy: false, deployed: null, held: null, refused: null }), /roll it back/, 'no post-deploy check configured: none promised');
});

test('bootstrap merges on the Machine page: an admin gets the accept field, a writer the list read-only, a viewer neither', () => {
  const sha = 'c'.repeat(40);
  const accepted = [{ id: 'a1', sha: null, pr: 22, head: 'd'.repeat(40), by: 'example-owner', reason: "suite can't run yet", at: new Date().toISOString(), appliedTo: sha }];
  const watch = { mode: 'main_watch' as const, detail: '', lastChecked: null, alert: null, stopped: null, canClear: false, accepted };
  const admin = r.renderProtection({ ...watch, canAccept: true }, BRAND.name);
  assert.match(admin, /data-testid="main-watch-accept-target"/);
  assert.match(admin, /data-testid="main-watch-accept-submit"[^>]*>Accept as bootstrap merge/);
  assert.match(admin, /#22 at dddddddd[\s\S]*suite can&#x27;t run yet[\s\S]*accounted: cccccccc/);
  const writer = r.renderProtection({ ...watch, canAccept: false }, BRAND.name);
  assert.match(writer, /data-testid="main-watch-accepted-row"/, 'the list');
  assert.doesNotMatch(writer, /main-watch-accept-target|Accept as bootstrap merge/, 'read-only');
  assert.doesNotMatch(r.renderProtection({ mode: 'main_watch' }, BRAND.name), /main-watch-accepted/, "a viewer's: the mode only");
});

test('a chat answer: citations as links, a draft preview with a two-step file, proposals that open their confirm flows, read-only for others', () => {
  const answer = {
    turn: 't1',
    instance: 'shop',
    answer: 'Issue #3 waits on your decision.',
    citations: [
      { kind: 'event', id: '41', instance: 'shop', label: 'event 41', href: '/events/41' },
      { kind: 'run', id: 'r-9', instance: 'shop', label: 'run r-9', href: '/runs/r-9' },
      { kind: 'issue', id: '3', instance: 'shop', label: 'issue #3', href: 'https://github.com/example-org/example-shop/issues/3' },
    ],
    unknownCitations: ['run:nope'],
    issueDraft: { ok: true, title: 'Round totals', body: '```done_when\n- test: t.js\n```', labels: ['ready'] },
    actions: [
      { kind: 'settings', key: 'workers', value: 2, confirm: 'settings.change', why: 'two tasks wait' },
      { kind: 'decision', id: 'd-1', answer: 'approve', confirm: 'decision.answer' },
      { kind: 'pause', confirm: 'emergency.pause' },
    ],
    refusedActions: ['merge: not something the chat proposes'],
    readOnly: false,
    costUsd: 0.123,
  };
  const file = { v: 1, id: '1-ab', at: '', owner: true, filed: null, state: 'answered', answer };
  const html = r.renderChatAnswer(file, BRAND.cli);
  assert.match(html, /data-testid="chat-answer-text"[^>]*>Issue #3 waits on your decision\./);
  assert.match(html, /href="\/activity\?event=41"[^>]*data-testid="chat-citation"/, 'an event opens on Activity');
  assert.match(html, /href="\/runs\/r-9"/);
  assert.match(html, /href="https:\/\/github\.com\/example-org\/example-shop\/issues\/3" target="_blank"/);
  assert.match(html, /data-testid="chat-unknown-citations"[^>]*>Left out 1 citation/);
  assert.match(html, /data-testid="chat-draft"[\s\S]*?ready[\s\S]*?Round totals[\s\S]*?data-testid="chat-draft-review"/);
  assert.doesNotMatch(html, /data-testid="chat-draft-confirm"/, 'filing needs a second click');
  assert.equal((html.match(/data-testid="chat-action"/g) ?? []).length, 3);
  assert.equal((html.match(/data-testid="chat-action-open"/g) ?? []).length, 2, 'settings and the decision open their pages');
  assert.match(html, new RegExp(`data-testid="chat-action-machine"[\\s\\S]*?${BRAND.cli} stop-all`), 'a stop is done on the machine');
  assert.match(html, /Not proposed: merge/);
  assert.match(html, /~\$0\.12 \(estimated\)/);
  assert.doesNotMatch(html, /data-testid="chat-read-only"/);
  assert.equal(r.actionHref(answer.actions[0]), '/settings?set=workers&to=2');
  assert.equal(r.actionHref(answer.actions[1]), '/decisions?proposed=approve#d-1');
  assert.equal(r.actionHref(answer.actions[2]), null);
  assert.deepEqual(r.proposedSetting('?set=workers&to=2'), { key: 'workers', value: 2 });
  assert.equal(r.proposedSetting('?set=workers&to=%7B'), null, 'an unreadable value proposes nothing');
  // Already filed: its number, no button. A draft that fails the contract check: why, and no button.
  assert.match(r.renderChatAnswer({ ...file, filed: { number: 57 } }, BRAND.cli), /data-testid="chat-draft-filed"[^>]*>Filed as #57/);
  const invalid = r.renderChatAnswer({ ...file, answer: { ...answer, issueDraft: { ok: false, title: 'x', body: 'prose', why: 'no done_when block' } } }, BRAND.cli);
  assert.match(invalid, /data-testid="chat-draft-invalid"[^>]*>Can(&#x27;|')t be filed as it is: no done_when block/);
  assert.doesNotMatch(invalid, /data-testid="chat-draft-review"/);
  // Anyone but the owner: the server sends no draft and no proposals; the answer says it's read-only.
  const theirs = r.renderChatAnswer({ ...file, owner: false, answer: { ...answer, issueDraft: null, actions: [], refusedActions: [], readOnly: true } }, BRAND.cli);
  assert.match(theirs, /data-testid="chat-read-only"/);
  assert.match(theirs, /data-testid="chat-citation"/);
  assert.doesNotMatch(theirs, /data-testid="chat-draft"|data-testid="chat-action"/);
  assert.match(r.renderChatAnswer({ v: 1, id: '1-ab', at: '', owner: true, filed: null, state: 'pending' }, BRAND.cli), /data-testid="chat-pending"/);
  assert.match(r.renderChatAnswer({ v: 1, id: '1-ab', at: '', owner: true, filed: null, state: 'refused', why: 'over the chat budget' }, BRAND.cli), /data-testid="chat-refused"[^>]*>Not answered: over the chat budget/);
});

test('a chat proposal lands in its confirm flow: the setting filled in for review, the decision option marked, the cited event marked', () => {
  const data = {
    owner: 'example-owner',
    user: 'example-owner',
    canChange: true,
    keys: ['workers'],
    available: true,
    limits: { workers: { min: 1, max: 4 }, daily_budget_usd: { max: 20 }, max_fixes_per_pr: { max: 3 } },
    limitsError: null,
    ceilings: { max_workers: 3, daily_usd: 30 },
    settings: [
      { key: 'workers', value: 1, source: 'instance' },
      { key: 'daily_budget_usd', value: 12, source: 'instance' },
    ],
  };
  const html = r.renderProposedSetting(data, { key: 'workers', value: 3 });
  assert.match(html, /data-testid="setting-proposed"[^>]*>The chat proposed workers = 3/);
  assert.match(html, /data-setting="workers" data-proposed=""[\s\S]*?value="3"/, 'filled in, not written');
  assert.doesNotMatch(html, /data-testid="setting-confirm"/, 'still Review, then Confirm');
  assert.doesNotMatch(r.renderProposedSetting({ ...data, canChange: false, user: 'someone-else' }, { key: 'workers', value: 3 }), /setting-proposed|data-proposed/);
  const loc = (globalThis as unknown as { window: { location: { search: string; hash: string } } }).window.location;
  const d = asOwner.decisions.find((x) => !x.answer && x.canAnswer !== false)!;
  try {
    loc.search = `?proposed=${encodeURIComponent(d.options[0]!)}`;
    loc.hash = `#${d.id}`;
    const dec = r.renderPage('decisions', asOwner);
    assert.match(dec, new RegExp(`data-decision="${d.id}"[\\s\\S]*?data-testid="decision-proposed"`));
    assert.equal((dec.match(/data-testid="decision-proposed"/g) ?? []).length, 1, 'only on the decision in the address');
    const ev = (asOwner.activity[0] as unknown as { id: number }).id;
    loc.search = `?event=${ev}`;
    loc.hash = '';
    assert.match(r.renderPage('activity', asOwner), new RegExp(`data-event="${ev}" data-testid="activity-row" data-cited=""`));
    loc.search = '?event=999999';
    assert.match(r.renderPage('activity', asOwner), /data-testid="activity-cited-missing"/);
  } finally {
    loc.search = '';
    loc.hash = '';
  }
});

test('the Intake page: each report redacted with what became of it, views, a link to the Inbox when drafts wait; the health numbers; refused to anyone else without asking', () => {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const report = (o: Record<string, unknown>) => ({ id: 'r', source: 'discord', receivedAt: at(1), sender: 'a1b2c3', kind: null, reproduction: null, outcome: 'pending', issue: null, dropped: null, replies: [], excerpt: 'text', ...o });
  const data = {
    reports: [
      report({ id: 'r1', kind: 'bug', reproduction: 'reproduced', outcome: 'filed', issue: 7, replies: ['received', 'filed'], excerpt: 'Checkout total is off by a cent for [AMOUNT]' }),
      report({ id: 'r2', source: 'bug-store', sender: 'd4e5f6', kind: 'feature', outcome: 'awaiting_owner', excerpt: 'Please add dark mode' }),
      report({ id: 'r3', source: 'bug-store', sender: 'd4e5f6', outcome: 'dropped', dropped: 'spam', excerpt: 'buy now [URL]' }),
    ],
    health: { perDay: [], dropped: {}, reportToMerged: { count: 0, medianMinutes: null } },
  };
  const html = r.renderIntake(data);
  assert.equal((html.match(/data-testid="intake-row"/g) ?? []).length, 3);
  assert.match(html, /data-outcome="filed"[\s\S]*?Checkout total is off by a cent for \[AMOUNT\][\s\S]*?from a1b2c3[\s\S]*?bug[\s\S]*?reproduction: reproduced[\s\S]*?>filed<[\s\S]*?data-testid="intake-issue"[^>]*>#7<[\s\S]*?data-testid="intake-replies"[^>]*>received, filed</);
  assert.match(html, /data-outcome="awaiting_owner"[\s\S]*?waiting on the owner/);
  assert.match(html, /data-outcome="dropped"[\s\S]*?data-testid="intake-dropped"[^>]*>spam</);
  assert.match(html, /data-testid="intake-inbox-link"[^>]*>1 draft\(s\) wait in your Inbox/);
  assert.equal((r.renderIntake(data, 'Needs the owner').match(/data-testid="intake-row"/g) ?? []).length, 1);
  assert.equal((r.renderIntake(data, 'On an issue').match(/data-testid="intake-row"/g) ?? []).length, 1);
  assert.match(r.renderIntake({ ...data, reports: [] }), /No reports yet[\s\S]*?off until the owner turns it on/);
  // The health numbers, once intake has recorded anything; nothing at all before.
  assert.equal(r.renderIntakeHealth(data.health), '');
  const health = r.renderIntakeHealth({ perDay: [{ day: '2026-10-10', source: 'discord', reports: 2 }, { day: '2026-10-10', source: 'bug-store', reports: 5 }], dropped: { spam: 3, 'over the sender cap': 1 }, reportToMerged: { count: 2, medianMinutes: 150 } });
  assert.equal((health.match(/data-testid="health-intake-day"/g) ?? []).length, 2);
  assert.match(health, /data-testid="health-intake-dropped"[\s\S]*?spam: 3[\s\S]*?over the sender cap: 1/, 'drops by reason, most first');
  assert.match(health, /data-testid="health-intake-merged"[^>]*>report to merged fix: median 2\.5 h over 2 report\(s\)/);
  // Anyone but the owner and the writers: told, not asked (the demo's dashboard for someone else).
  assert.equal((asOther as unknown as { canReadIntake: boolean }).canReadIntake, false);
  assert.match(r.renderIntakePage(asOther), /data-testid="intake-refused"[^>]*>Intake reports are for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
  assert.equal(r.intakeRefusal(asOwner), null);
  assert.equal(r.intakeRefusal({ ...asOwner, canReadIntake: undefined }), null, 'an older server without the flag: asked as before');
});

test('the throughput panel: merges, cost per merged PR by stage (zeros shown), the top costs with their tunings, and where PRs waited for the owner; refused to anyone else without asking', () => {
  const stages = ['worker', 'evaluator', 'plan', 'research', 'intake', 'gardener', 'chat', 'retries', 'other'];
  const usd: Record<string, number> = { worker: 2, evaluator: 2, plan: 0.5, research: 0.25, intake: 0.5, gardener: 0, chat: 0.75, retries: 4, other: 0 };
  const t = {
    since: '2026-10-08T12:00:00.000Z',
    until: '2026-10-15T12:00:00.000Z',
    merged: { total: 3, perDay: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(2 + i).padStart(2, '0')}`, merged: i === 10 ? 2 : i === 12 ? 1 : 0 })), perWeek: [{ week: '2026-10-05', merged: 2 }, { week: '2026-10-12', merged: 2 }] },
    cost: { totalUsd: 10, perMergedPrUsd: 3.33, byStage: stages.map((stage) => ({ stage, usd: usd[stage], perMergedPrUsd: Math.round((usd[stage]! / 3) * 100) / 100, share: usd[stage]! / 10 })), byModel: [{ model: 'opus', usd: 6, perMergedPrUsd: 2, share: 0.6 }, { model: 'sonnet', usd: 3.5, perMergedPrUsd: 1.17, share: 0.35 }, { model: 'haiku', usd: 0.5, perMergedPrUsd: 0.17, share: 0.05 }], evaluatorOnL0Usd: 1.5 },
    waits: [
      { kind: 'merge', label: 'merging a PR the harness left to you', owner: true, count: 1, open: 0, medianHours: 10, totalHours: 10, reasons: [{ reason: 'touches a high-risk area', count: 1 }] },
      { kind: 'decision:land', label: 'approving a change to land', owner: true, count: 1, open: 1, medianHours: 10, totalHours: 10, reasons: [] },
      { kind: 'hotspot', label: 'held behind another task changing the same files (ends on its own)', owner: false, count: 1, open: 0, medianHours: 2, totalHours: 2, reasons: [] },
    ],
    top: [
      { stage: 'retries', usd: 4, share: 0.4, suggestion: 'Retries are 40% of the spend: look at why first attempts fail.' },
      { stage: 'worker', usd: 2, share: 0.2, suggestion: 'Worker runs cost $0.67 per merged PR: split size:L issues.' },
      { stage: 'evaluator', usd: 2, share: 0.2, suggestion: '75% of evaluator spend is on L0 PRs: tiered evaluation.' },
    ],
  };
  const html = r.renderThroughput(t);
  assert.match(html, /data-testid="throughput-merged"[\s\S]*?>3</);
  assert.match(html, /data-testid="throughput-per-pr"[\s\S]*?~\$3\.33[\s\S]*?~\$10 in all/);
  assert.equal((html.match(/data-testid="throughput-day"/g) ?? []).length, 14);
  assert.match(html, /title="2026-10-12: 2 merged"/, 'each day\'s bar says its count on hover');
  assert.equal((html.match(/data-testid="throughput-week"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="throughput-stage"/g) ?? []).length, 9, 'every stage, gardener at zero included');
  assert.match(html, /data-stage="gardener"[\s\S]*?~\$0\.00/);
  assert.match(html, /data-stage="retries"[\s\S]*?Retries and fixes[\s\S]*?~\$1\.33[\s\S]*?~\$4\.00[\s\S]*?40%/);
  assert.equal((html.match(/data-testid="throughput-suggestion"/g) ?? []).length, 3);
  assert.match(html, /data-stage="retries"[^>]*>[\s\S]*?1\. Retries and fixes · ~\$4\.00 \(40%\)[\s\S]*?look at why first attempts fail/);
  assert.equal((html.match(/data-testid="throughput-wait"/g) ?? []).length, 2, 'the owner\'s waits in the table');
  assert.match(html, /data-kind="decision:land"[\s\S]*?1 waiting now/);
  assert.match(html, /data-kind="merge"[\s\S]*?touches a high-risk area/);
  assert.match(html, /data-testid="throughput-other-wait"[^>]*>Also: 1 task\(s\) held behind another task/);
  assert.match(r.renderThroughput({ ...t, waits: [] }), /data-testid="throughput-no-waits"/);
  // Usage per merged PR by model, from run.cost's model.
  assert.deepEqual([...html.matchAll(/data-testid="throughput-model" data-model="([a-z]+)"/g)].map((m) => m[1]), ['opus', 'sonnet', 'haiku']);
  assert.match(html, /data-model="opus"[\s\S]*?Opus[\s\S]*?~\$2\.00[\s\S]*?~\$6\.00[\s\S]*?60%/);
  assert.match(html, /data-model="haiku"[\s\S]*?Haiku[\s\S]*?~\$0\.17/);
  assert.doesNotMatch(r.renderThroughput({ ...t, cost: { ...t.cost, byModel: [] } }), /throughput-models/, 'no table without model costs');
  assert.match(r.renderThroughputPanel(asOther), /data-testid="throughput-refused"[^>]*>Throughput is for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
  assert.doesNotMatch(r.renderThroughputPanel(asOwner), /throughput-refused/);
});

test('agent runs refused: the runs card and a run page say whose they are, not an empty list or "No such run"', () => {
  const msg = "agent runs are for the instance's owners and writers (admin or write on its repo); @someone-else is a viewer";
  assert.equal(r.runsRefused(msg), msg, 'the server\'s refusal is recognised');
  assert.equal(r.runsRefused('no such run'), null, 'a missing run is not a refusal');
  assert.match(r.renderRunsRefused(msg), /data-testid="runs-refused"[^>]*>Agent runs are for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\.</);
  // From the state, before asking: the demo's dashboard for someone who is neither the owner nor a writer.
  assert.equal((asOther as unknown as { canReadRuns: boolean }).canReadRuns, false);
  assert.equal((asOwner as unknown as { canReadRuns: boolean }).canReadRuns, true);
  assert.equal(r.runsRefusal(asOther), msg, 'the same words the server would send');
  assert.equal(r.runsRefusal(asOwner), null);
  assert.equal(r.runsRefusal({ ...asOwner, canReadRuns: undefined }), null, 'an older server without the flag: asked as before');
  const issue = asOther.tasks[0]!.issue;
  assert.match(r.renderIssue(asOther, issue), /data-testid="runs-card"[\s\S]*?data-testid="runs-refused"/, 'the issue page says so instead of asking');
  assert.doesNotMatch(r.renderIssue(asOwner, issue), /data-testid="runs-refused"/);
});

test('a research run on its page: each search, each page fetched or refused (linked only when fetched, rel=noopener), a cap it stopped at', () => {
  const html = r.renderRunResearch({
    searches: ['sqlite vacuum into durability', 'litestream restore'],
    fetches: [
      { url: 'https://sqlite.org/lang_vacuum.html', host: 'sqlite.org', refused: null },
      { url: 'https://tracker.example.net/x', host: 'tracker.example.net', refused: 'not on the allowed hosts' },
      { url: 'javascript:alert(1)', host: '', refused: null },
    ],
    capped: ['searches: 20 of 20 today'],
  });
  assert.match(html, /2 search\(es\), 2 page\(s\) fetched, 1 refused/);
  assert.equal((html.match(/data-testid="run-research-search"/g) ?? []).length, 2);
  assert.match(html, /data-testid="run-research-search"[^>]*>sqlite vacuum into durability</);
  assert.match(html, /<a href="https:\/\/sqlite\.org\/lang_vacuum\.html" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /data-testid="run-research-fetch" data-refused=""[\s\S]*?>refused<[\s\S]*?tracker\.example\.net\/x[\s\S]*?not on the allowed hosts/);
  assert.doesNotMatch(html, /href="https:\/\/tracker\.example\.net/, 'a refused page is not a link');
  assert.doesNotMatch(html, /href="javascript:/, 'only http(s) becomes a link');
  assert.match(html, /role="alert"[^>]*data-testid="run-research-capped"[\s\S]*?Stopped at a cap:[\s\S]*?searches: 20 of 20 today/);
  assert.match(r.renderRunResearch({ searches: [], fetches: [], capped: [] }), /No searches or fetches recorded/);
});

test('waiting on you: a high-risk PR says plainly why it waits, naming the category and its first file', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const item = {
    kind: 'needs_owner', since: new Date(now - 3_600_000).toISOString(), issue: 3, pr: 31, title: 'Tighten the merge rule',
    detail: 'high-risk: self-modification (src/merge-policy.ts, src/review.ts)',
    why: [
      { category: 'self-modification', text: 'changes the merge policy: src/merge-policy.ts and 1 more' },
      { category: 'migration', text: 'changes a database migration: db/migrations/002.sql' },
    ],
  };
  const w = { at: new Date(now).toISOString(), items: [item], markdown: '', mergedSince: new Date(now).toISOString(), merged: [] };
  const html = r.renderWaiting(w, now);
  const whys = [...html.matchAll(/data-testid="waiting-why" data-category="([a-z-]+)"[\s\S]*?<\/li>/g)];
  assert.deepEqual(whys.map((m) => m[1]), ['self-modification', 'migration']);
  assert.match(whys[0]![0], />self-modification<[\s\S]*?>changes the merge policy: src\/merge-policy\.ts and 1 more</);
  assert.match(whys[1]![0], />migration<[\s\S]*?>changes a database migration: db\/migrations\/002\.sql</);
  assert.match(html, /PR #31[\s\S]*?data-testid="waiting-why"[\s\S]*?data-testid="waiting-detail"/, 'the plain reason first, then the detail');
  // Nothing high-risk (or a decision recorded before the reason was): no reason line.
  assert.doesNotMatch(r.renderWaiting({ ...w, items: [{ ...item, why: undefined }] }, now), /waiting-why/);
});

test('waiting on you: every owner-held state grouped in the digest\'s order, each with its issue or PR and how long it has waited; the digest\'s Markdown; refused to anyone else without asking', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const w = {
    at: new Date(now).toISOString(),
    items: [
      { kind: 'merge_stopped', since: ago(70), issue: null, pr: null, title: null, detail: 'main went red' },
      { kind: 'awaiting_decision', since: ago(50), issue: 1, pr: null, title: 'Round totals', detail: '@example-owner: Which rounding mode?' },
      { kind: 'needs_owner', since: ago(5), issue: 3, pr: 31, title: 'Migrate orders', detail: 'high-risk: migrations' },
      { kind: 'deploy_failed', since: ago(0.5), issue: null, pr: null, title: null, detail: 'staging: health check 503', sha: 'f'.repeat(40) },
      { kind: 'check_held', since: ago(10), issue: 5, pr: 51, title: null, detail: 'e2e missing' },
    ],
    markdown: '## Waiting on you\n',
    mergedSince: ago(24),
    merged: [
      { pr: 21, issue: 2, title: 'Round totals to the cent', url: 'https://github.com/example-org/example-shop/pull/21', at: ago(5), level: 'L0', confidence: 'high' },
      { pr: 31, issue: 3, title: 'Document the rounding rule', url: 'https://github.com/example-org/example-shop/pull/31', at: ago(2), level: null, confidence: null },
    ],
  };
  const html = r.renderWaiting(w, now);
  assert.deepEqual([...html.matchAll(/data-testid="waiting-group" data-kind="([a-z_]+)"/g)].map((m) => m[1]), ['merge_stopped', 'awaiting_decision', 'needs_owner', 'deploy_failed', 'check_held'], 'in the digest\'s order');
  assert.equal((html.match(/data-testid="waiting-item"/g) ?? []).length, 5);
  assert.match(html, /data-kind="awaiting_decision"[\s\S]*?data-testid="waiting-issue"[^>]*>#1<[\s\S]*?Round totals[\s\S]*?Which rounding mode\?[\s\S]*?waiting 2 days/);
  assert.match(html, /data-kind="needs_owner"[\s\S]*?data-testid="waiting-pr"[^>]*>PR #31<[\s\S]*?for[\s\S]*?>#3<[\s\S]*?Migrate orders[\s\S]*?high-risk: migrations[\s\S]*?waiting 5 h/);
  assert.match(html, /data-kind="deploy_failed"[\s\S]*?ffffffffffff[\s\S]*?staging: health check 503[\s\S]*?waiting 30 min/);
  assert.match(html, /data-kind="check_held"[\s\S]*?PR #51[\s\S]*?e2e missing/, 'the check, named');
  assert.match(r.renderWaiting({ ...w, items: [] }, now), /Nothing is waiting on you[\s\S]*?nothing times out/);
  // An auto-merge whose checks on the merge commit never reported: its own group, with its heading.
  const timedOut = { kind: 'main_checks_timed_out', since: w.items[0]!.since, issue: 3, pr: 31, title: 'Migrate orders', detail: 'ci never reported on the merge commit eeeeeeeeeeee; check them yourself', sha: 'e'.repeat(40) };
  assert.match(r.renderWaiting({ ...w, items: [timedOut] }, now), /data-kind="main_checks_timed_out"[\s\S]*?Auto-merges whose checks on the default branch never reported[\s\S]*?PR #31[\s\S]*?ci never reported on the merge commit/);
  // Merged since yesterday, for sampling: each PR (linked, rel=noopener) with its review level and the evaluator's confidence.
  assert.equal((html.match(/data-testid="merged-item"/g) ?? []).length, 2);
  assert.match(html, /data-testid="merged-since"[\s\S]*?Merged since yesterday[\s\S]*?>2<[\s\S]*?2026-10-14 12:00 UTC/);
  assert.match(html, /href="https:\/\/github\.com\/example-org\/example-shop\/pull\/21" target="_blank" rel="noopener noreferrer"[^>]*data-testid="merged-pr"[^>]*>PR #21<[\s\S]*?Round totals to the cent[\s\S]*?data-testid="merged-level"[\s\S]*?>L0<[\s\S]*?data-testid="merged-confidence"[\s\S]*?>evaluator confidence high</);
  assert.match(html, /PR #31[\s\S]*?level not recorded[\s\S]*?confidence not recorded/);
  assert.match(r.renderWaiting({ ...w, items: [] }, now), /data-testid="merged-item"/, 'shown even when nothing waits');
  assert.match(r.renderWaiting({ ...w, merged: [] }, now), /Nothing merged on its own/);
  // Anyone but the owner and the writers: told, not asked (the demo's dashboard for someone else).
  assert.equal((asOther as unknown as { canReadDigest: boolean }).canReadDigest, false);
  assert.match(r.renderWaitingPage(asOther), /data-testid="waiting-refused"[^>]*>What waits on the owner is for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
  assert.doesNotMatch(r.renderWaitingPage(asOwner), /waiting-refused/);
});

test("the first-run page: init's checklist in order with each status, where it stopped and how to pick up, what local mode lacks; viewers refused", () => {
  // The view as the server makes it (src/init.ts firstRunView) from a state file init wrote.
  const file = join(mkdtempSync(join(tmpdir(), 'web-render-init-')), 'init.json');
  const at = '2026-10-13T10:00:00.000Z';
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'example-org/example-shop', instance: null, steps: { tools: { status: 'done', detail: 'node 24.21.0, git, gitleaks, claude, gh', at }, claude: { status: 'failed', detail: 'not signed in, per `claude auth status`', at } }, handoff: {}, updatedAt: at, finishedAt: null }));
  const f = firstRunView(file, { root: '/r', repo: 'example-org/example-shop', instance: null, has: () => false });
  const html = r.renderFirstRun(f);
  assert.deepEqual([...html.matchAll(/data-testid="first-run-step" data-step="([a-z-]+)" data-status="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['tools:done', 'claude:failed', 'github:pending', 'repo-config:pending', 'protection:pending', 'discord:pending']);
  assert.match(html, /data-testid="first-run-mode" data-mode="local">Local mode: on this machine, as you\. No server, no ssh, no root\./);
  assert.match(html, /1 of 6 steps done/);
  assert.match(html, /role="progressbar" aria-valuemin="0" aria-valuemax="6" aria-valuenow="1"/);
  assert.match(html, /Tools present[\s\S]*?done[\s\S]*?node 24\.21\.0, git, gitleaks, claude, gh/);
  assert.match(html, /Claude login[\s\S]*?stopped here[\s\S]*?not signed in/);
  assert.doesNotMatch(html, /not reached yet/, 'a step not reached shows no detail');
  assert.match(html, /data-testid="first-run-resume"[\s\S]*?Stopped at Claude login[\s\S]*?<code[^>]*>worklane init \/r<\/code>/);
  assert.match(html, /data-testid="first-run-unavailable"[\s\S]*?Not available in local mode[\s\S]*?separate OS users[\s\S]*?root-run add-project[\s\S]*?test sandbox[\s\S]*?needs Docker/);
  assert.doesNotMatch(html, /first-run-none|first-run-finished/);
  // Never run here: the command to start, nothing done.
  const none = r.renderFirstRun(firstRunView(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: null }));
  assert.match(none, /data-testid="first-run-none"[\s\S]*?<code[^>]*>worklane init --mode local \/r<\/code>/);
  assert.doesNotMatch(none, /first-run-unavailable/, 'no mode yet: nothing claimed missing');
  // Finished: said, no resume card.
  const done = r.renderFirstRun({ ...f, steps: f.steps.map((x) => ({ ...x, status: x.optional ? 'skipped' : 'done' })), done: 6, finishedAt: at });
  assert.match(done, /data-testid="first-run-finished"/);
  assert.doesNotMatch(done, /first-run-resume/);
  // Server mode: the per-project steps live on the Setup console; nothing listed as missing.
  const server = r.renderFirstRun(firstRunView(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: 'shop' }));
  assert.match(server, /Server mode[\s\S]*?Setup console/);
  assert.doesNotMatch(server, /first-run-unavailable/);
  // Anyone but the owner and the writers: told, not asked.
  assert.match(r.renderFirstRunPage(asOther), /data-testid="first-run-refused"[^>]*>The first-run checklist is for the instance(&#x27;|')s owners and writers/);
  assert.doesNotMatch(r.renderFirstRunPage(asOwner), /first-run-refused/);
});

test("the first-run page, Repo config: auto-config's open questions with every choice and how to answer, each command's run on main, the setup PR", () => {
  const file = join(mkdtempSync(join(tmpdir(), 'web-render-init-')), 'init.json');
  const at = '2026-10-13T10:00:00.000Z';
  const verified = [
    { slot: 'setup', command: 'npm ci', base: 'b1', code: 0, passed: true, ms: 12_000, tail: '', at },
    { slot: 'full', command: 'npm test', base: 'b1', code: 1, passed: false, ms: 3_000, tail: 'boom', at },
    { slot: 'full', command: 'make test', base: 'old', code: 0, passed: true, ms: 1, tail: '', at },
  ];
  const question = { id: 'full-fails', ask: 'The full test run `npm test` fails on the default branch: use it anyway, pick another, or skip?', about: 'npm test', custom: true, choices: [{ id: 'use', label: 'use it anyway', command: 'npm test' }, { id: '1', label: 'make test   (Makefile target test)', command: 'make test' }, { id: 'custom', label: 'pick another: type a command (custom:<command>)' }, { id: 'skip', label: 'skip: leave it out' }] };
  const autoConfig = { answers: {}, overrides: {}, accepted: [], questions: [question], verified, base: 'b1', pr: null };
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'example-org/example-shop', instance: null, steps: { 'repo-config': { status: 'failed', detail: '1 question to answer', at } }, handoff: {}, autoConfig, updatedAt: at, finishedAt: null }));
  const html = r.renderFirstRun(firstRunView(file, { root: '/r', repo: 'example-org/example-shop', instance: null, has: () => false }));
  assert.match(html, /data-testid="first-run-question" data-question="full-fails"[\s\S]*?`npm test` fails on the default branch: use it anyway, pick another, or skip\?/);
  assert.deepEqual([...html.matchAll(/data-testid="first-run-choice" data-choice="([^"]+)"/g)].map((m) => m[1]), ['use', '1', 'custom', 'skip'], 'every choice shown');
  assert.match(html, /<code[^>]*>worklane init \/r --answer &lt;id&gt;=&lt;choice&gt;<\/code>/);
  assert.deepEqual([...html.matchAll(/data-testid="first-run-verified-item" data-passed="(true|false)"/g)].map((m) => m[1]), ['true', 'false'], 'only the runs on the current main');
  assert.match(html, /npm test<\/code>[\s\S]*?fails on main \(exit 1\)/);
  assert.doesNotMatch(html, /first-run-auto-config-pr/);
  // Proposed: the PR, no questions.
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'example-org/example-shop', instance: null, steps: {}, handoff: {}, autoConfig: { ...autoConfig, questions: [], pr: { number: 7, url: 'https://github.com/example-org/example-shop/pull/7', branch: 'worklane/setup' } }, updatedAt: at, finishedAt: null }));
  const proposed = r.renderFirstRun(firstRunView(file, { root: '/r', repo: 'example-org/example-shop', instance: null }));
  assert.match(proposed, /data-testid="first-run-auto-config-pr"[\s\S]*?href="https:\/\/github\.com\/example-org\/example-shop\/pull\/7"[\s\S]*?PR #7/);
  assert.doesNotMatch(proposed, /first-run-question"/);
  // No auto-config yet (a config folder already there): nothing extra.
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'o/r', instance: null, steps: {}, handoff: {}, updatedAt: at, finishedAt: null }));
  assert.doesNotMatch(r.renderFirstRun(firstRunView(file, { root: '/r', repo: 'o/r', instance: null })), /first-run-auto-config/);
});

test('the report preview: refused to anyone but the owner and the writers without asking, shown to them', () => {
  assert.equal((asOther as unknown as { canReadReports: boolean }).canReadReports, false);
  assert.match(r.renderPage('reports', asOther), /data-testid="report-preview"[\s\S]*?data-testid="report-refused"[^>]*>The report preview is for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
  assert.doesNotMatch(r.renderPage('reports', asOwner), /report-refused/);
});

/** Render, failing on anything React reports (console.error) as well as on a throw. */
function clean(render: () => string): string {
  const errors: unknown[] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    return render();
  } finally {
    console.error = prev;
    assert.deepEqual(errors, [], 'no errors while rendering');
  }
}

test('the Board renders for the owner, a writer and a viewer without errors: five columns, every card, which instance it shows', () => {
  for (const role of ['owner', 'writer', 'viewer'] as const) {
    const b = boards[role];
    assert.equal(b.role, role, `the server read ${role}`);
    assert.ok(b.cards.length >= 4, 'the demo has work in flight');
    const html = clean(() => r.renderBoard([{ name: null, data: b, error: null }]));
    assert.equal((html.match(/data-testid="board-column"/g) ?? []).length, 5);
    for (const [col, label] of [['planning', 'Planning'], ['building', 'Building'], ['verifying', 'Verifying'], ['waiting', 'Waiting on you'], ['landing', 'Landing']]) assert.match(html, new RegExp(`data-column="${col}"[^>]*>[\\s\\S]*?${label}`));
    assert.equal((html.match(/data-testid="board-card"/g) ?? []).length, b.cards.length, `${role}: every card`);
    for (const id of ['board', 'board-scope', 'board-card-ref', 'board-card-title', 'board-card-elapsed']) assert.match(html, new RegExp(`data-testid="${id}"`), `${role}: ${id}`);
    if (role === 'viewer') {
      // A viewer's cards carry no run or agent details, no change size and no checks: the server left them out.
      for (const c of b.cards) for (const k of ['run', 'diff', 'comments', 'checks']) assert.ok(!(k in c), `a viewer's card has no ${k}`);
      for (const id of ['board-card-run', 'board-card-usage', 'board-card-diff', 'board-card-comments', 'board-card-checks', 'board-watch']) assert.doesNotMatch(html, new RegExp(`data-testid="${id}"`), `viewer: no ${id}`);
    } else {
      for (const id of ['board-card-diff', 'board-card-comments', 'board-card-checks']) assert.match(html, new RegExp(`data-testid="${id}"`), `${role}: ${id}`);
      assert.match(html, /data-testid="board-card-run"[\s\S]*?data-testid="board-card-usage"/, 'the running agent and its resource use');
    }
    assert.doesNotMatch(html, /<select/, "an instance's own dashboard: no instance picker");
    // The page itself, and the Machine page, render for each role too.
    assert.match(clean(() => r.renderPage('board', { owner: asOwner, writer: asWriter, viewer: asOther }[role])), /data-testid="page-board"[\s\S]*<h1[^>]*>Board</);
  }
  // All instances (chosen in the switcher): every instance's board, each card labelled, one that failed named.
  const hub = clean(() => r.renderBoard([{ name: 'a', data: boards.owner, error: null }, { name: 'b', data: { ...boards.viewer, instance: 'b', cards: boards.viewer.cards.map((c) => ({ ...c, instance: 'b' })) }, error: null }, { name: 'c', data: null, error: 'answered 502' }]));
  assert.match(hub, /data-testid="board-scope" data-scope="all"[^>]*>[\s\S]*All instances[\s\S]*\(3\)/);
  assert.doesNotMatch(hub, /<select/, 'no per-page instance picker: the switcher decides');
  assert.equal((hub.match(/data-testid="board-card"/g) ?? []).length, boards.owner.cards.length + boards.viewer.cards.length);
  assert.match(hub, /data-testid="board-instance-error"[^>]*>c: can&#x27;t load its board: answered 502/);
  // One instance: its board only, no labels needed.
  const onlyB = clean(() => r.renderBoard([{ name: 'b', data: { ...boards.viewer, cards: boards.viewer.cards.map((c) => ({ ...c, instance: 'b' })) }, error: null }]));
  assert.match(onlyB, /data-testid="board-scope" data-scope="b"/);
  assert.equal((onlyB.match(/data-testid="board-card"/g) ?? []).length, boards.viewer.cards.length);
  assert.doesNotMatch(onlyB, /data-testid="board-card-instance"/);
});

test("the Board's Landing column shows the PR batches, and a card where its PR stands with them; a viewer's without what happened", () => {
  const owner = { ...boards.owner, batches: [{ id: 'batch-2', status: 'testing', prs: [13], issues: [3], at: '2026-01-01T00:00:00Z', detail: '' }, { id: 'batch-1', status: 'red', prs: [11, 12], issues: [1, 2], at: '2026-01-01T00:00:00Z', detail: 'passed #11; returned #12 (unit failed)' }], cards: boards.owner.cards.map((c, i) => (i === 0 ? { ...c, column: 'landing', batch: { status: 'returned', id: 'batch-1' } } : c)) };
  const html = clean(() => r.renderBoard([{ name: null, data: owner, error: null }]));
  assert.match(html, /data-column="landing"[\s\S]*?data-testid="board-batches"/, 'in the Landing column');
  assert.equal((html.match(/data-testid="board-batch"/g) ?? []).length, 2);
  assert.match(html, /data-status="red" title="passed #11; returned #12 \(unit failed\)"[\s\S]*?#11 #12/);
  assert.match(html, /data-testid="board-card-batch"[\s\S]*?batch failed/);
  const viewer = { ...boards.viewer, batches: owner.batches.map(({ detail: _, ...b }) => b) };
  const vhtml = clean(() => r.renderBoard([{ name: null, data: viewer, error: null }]));
  assert.match(vhtml, /data-status="red">/, "a viewer's batch: its status, no detail");
  assert.doesNotMatch(vhtml, /returned #12/);
  assert.doesNotMatch(clean(() => r.renderBoard([{ name: null, data: { ...boards.owner, batches: [] }, error: null }])), /data-testid="board-batches"/, 'no batches: no strip');
});

test('each role sees only its actions on the Board: viewers none; writers Watch, Steer and Answer what they may; the owner also Approves', () => {
  const html = (role: 'owner' | 'writer' | 'viewer') => clean(() => r.renderBoard([{ name: null, data: boards[role], error: null }]));
  const count = (h: string, id: string) => (h.match(new RegExp(`data-testid="${id}"`, 'g')) ?? []).length;
  const owner = html('owner');
  const writer = html('writer');
  const viewer = html('viewer');
  assert.equal(count(owner, 'board-watch'), 1);
  assert.match(owner, /data-testid="board-watch" data-mode="feed"/);
  assert.equal(count(owner, 'board-steer'), 1, 'the owner steers the live run');
  assert.ok(count(owner, 'board-approve') >= 1, 'the demo\'s high-risk landing waits for the owner');
  assert.ok(count(owner, 'board-answer') >= 1);

  assert.match(writer, /data-testid="board-watch" data-mode="feed"/);
  assert.equal(count(writer, 'board-steer'), 1, 'a writer steers the live run');
  assert.equal(count(writer, 'board-approve') + count(writer, 'board-merge'), 0, 'high-risk merges are the owner\'s');
  assert.ok(count(writer, 'board-answer') >= 1, 'a writer answers the demo\'s question');

  for (const id of ['board-watch', 'board-steer', 'board-answer', 'board-approve', 'board-merge', 'board-card-actions']) assert.equal(count(viewer, id), 0, `a viewer has no ${id}`);
  // What the server said each may do is exactly what shows.
  for (const role of ['owner', 'writer', 'viewer'] as const) {
    const a = boards[role].cards.map((c) => c.actions);
    const h = html(role);
    assert.equal(count(h, 'board-steer'), a.filter((x) => x.steer).length);
    assert.equal(count(h, 'board-answer'), a.filter((x) => x.answer).length);
    assert.equal(count(h, 'board-approve') + count(h, 'board-merge'), a.filter((x) => x.approve).length);
  }
  assert.equal(r.elapsed(new Date(Date.now() - 135 * 60_000).toISOString()), '2h 15m');
});

test('the Machine page renders for the owner, a writer and a viewer without errors: the slots, then health and machine settings', () => {
  for (const s of [asOwner, asWriter, asOther]) {
    const html = clean(() => r.renderPage('machine', s));
    assert.match(html, /data-testid="page-machine"[\s\S]*<h1[^>]*>Machine</);
    assert.match(html, /data-testid="machine-slots"/);
  }
  const slots = clean(() => r.renderMachineSlots({ cap: 2, running: 1, agents: [{ slot: 'agent-0', owner: 'cli shop #4', pid: 1, acquiredAt: new Date().toISOString() }], fullRun: null }));
  assert.match(slots, /1 of 2 in use/);
  assert.match(slots, /data-testid="machine-slot-row"[\s\S]*cli shop #4/);
  // Overview keeps a line and a link where the health panel was.
  const overview = clean(() => r.renderPage('overview', asOwner));
  assert.match(overview, /data-testid="overview-machine"[\s\S]*data-testid="overview-machine-link"/);
  assert.doesNotMatch(overview, /data-testid="health-panel"/, 'machine health moved to the Machine page');
});

test('the setup console shows each ask with its status; answer controls only where the server allows; a secret is a password field', () => {
  const base = { instance: 'demo', detail: 'why', createdAt: '2026-10-12T10:00:00Z', createdBy: 'coordinator', cancelled: null };
  const asks = [
    { ...base, id: 'ask-000000000001', kind: 'paste_secret', title: 'Bot token', credential: 'intake-discord', where: 'intake', status: 'open', answer: null, canAnswer: true },
    { ...base, id: 'ask-000000000002', kind: 'question', title: 'Owner question', options: ['yes', 'no'], writersMayAnswer: false, status: 'open', answer: null, canAnswer: false },
    { ...base, id: 'ask-000000000003', kind: 'root_step', title: 'Install', command: 'apt-get', args: ['install', 'x'], allowed: false, refusal: 'it needs the helper extended', status: 'open', answer: null, canAnswer: true },
    { ...base, id: 'ask-000000000004', kind: 'approve_link', title: 'Install the App', url: 'https://github.com/apps/x/installations/new', status: 'answered', answer: { by: 'olive', role: 'owner', answer: 'approved', detail: '', at: '2026-10-12T11:00:00Z' }, canAnswer: false },
  ];
  const html = r.renderSetup({ role: 'owner', login: 'olive', asks });
  assert.equal((html.match(/data-testid="ask-card"/g) ?? []).length, 4);
  const secret = html.match(/<input[^>]*data-testid="ask-secret"[^>]*>/)?.[0] ?? '';
  assert.match(secret, /type="password"/);
  assert.doesNotMatch(secret, /value=/, 'never prefilled');
  assert.doesNotMatch(html, /data-testid="ask-option"/, "no answer buttons on a question this person can't answer");
  assert.match(html, /Waiting on the owner/);
  assert.match(html, /data-testid="ask-refusal"[^>]*>[^<]*it needs the helper extended/);
  assert.match(html.match(/<button[^>]*data-testid="ask-run"[^>]*>/)?.[0] ?? '', /disabled=""/, "a step off the allowlist can't be run");
  assert.match(html, /data-testid="ask-answered"[^>]*>approved by @olive \(owner\)/);
  const viewer = r.renderSetup({ role: 'viewer', login: 'vic', asks: asks.map((a) => ({ ...a, canAnswer: false })) });
  assert.doesNotMatch(viewer, /data-testid="ask-secret"|data-testid="ask-run"|data-testid="ask-option"/);
  assert.equal(r.keyData({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false }), '\r');
  assert.equal(r.keyData({ key: 'c', ctrlKey: true, metaKey: false, altKey: false }), '\x03');
  assert.equal(r.keyData({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false }), null);
});

test("Add project: enabled for a machine owner on an allowed device; otherwise disabled, saying why", () => {
  const ownersFile = machineOwnersFile('ada', 'olu');
  const view = (requester: ReturnType<typeof ownerRequester>, role: 'owner' | 'writer' = 'owner') => r.renderAddProject(addProjectView([], { role, requester }, { ownersFile }));
  const controls = (html: string) => [...html.matchAll(/<(?:input|button)[^>]*data-testid="add-project-(?:name|repo|submit)"[^>]*>/g)].map((m) => m[0]);
  const enabled = view(ownerRequester('ada'));
  assert.match(enabled, /data-testid="add-project" data-enabled="yes"/);
  assert.equal(controls(enabled).length, 3);
  assert.ok(controls(enabled).every((c) => !/disabled=""/.test(c)), 'the name, the repo and the button are live');
  assert.doesNotMatch(enabled, /data-testid="add-project-disabled"/);
  const cases: [string, ReturnType<typeof ownerRequester>, RegExp][] = [
    ['an instance-only owner', ownerRequester('ivy'), /machine owners: @ada, @olu\); @ivy isn(&#x27;|')t one/],
    ['a disallowed device', { ...ownerRequester('ada'), deviceOk: false }, /one of the console(&#x27;|')s allowed devices/],
  ];
  for (const [who, requester, why] of cases) {
    const html = view(requester);
    assert.match(html, /data-testid="add-project" data-enabled="no"/, who);
    assert.ok(controls(html).length === 3 && controls(html).every((c) => /disabled=""/.test(c)), `${who}: every control disabled`);
    assert.match(html.match(/data-testid="add-project-disabled"[\s\S]*?<\/p>/)?.[0] ?? '', why, `${who}: says why`);
    const said = (html.match(/data-testid="add-project-disabled"[\s\S]*?<\/p>/)?.[0] ?? '').replace(/<[^>]+>/g, '');
    assert.equal((said.match(/[Mm]achine owners: @ada, @olu/g) ?? []).length, 1, `${who}: names the machine owners, once: ${said}`);
  }
  assert.match(view(ownerRequester('ada'), 'writer'), /data-enabled="no"[\s\S]*only an owner of this instance/, 'a writer here sees it, disabled');
});

test('Add project: the steps show in the script order as they arrive, and its asks (GitHub links, the Claude token) appear in the same view', () => {
  const log = new EventLog(':memory:');
  const ownersFile = machineOwnersFile('ada');
  const a = asks(log);
  // An ask from before the run isn't one of its asks.
  a.create({ kind: 'question', instance: 'demo', title: 'Unrelated', detail: 'x', options: ['yes'] });
  log.append('machine.requested', { id: 'mr-0000000000aa', args: ['add-project', 'shop', 'acme/shop'], by: 'ada', via: 'settings', ask: null }, 'ada', 'human');
  log.append('machine.started', { id: 'mr-0000000000aa', instance: 'demo' }, 'demo', 'coordinator');
  const step = (s: string, state: string, detail = '') => log.append('add_project.step', { request_id: 'mr-0000000000aa', name: 'shop', repo: 'acme/shop', step: s, state, detail } as never, 'demo', 'coordinator');
  const render = () => {
    const html = r.renderAddProject(addProjectView(log.read(0), { role: 'owner', requester: ownerRequester('ada') }, { ownersFile }));
    const run = html.match(/data-testid="add-project-run"[\s\S]*$/)?.[0] ?? '';
    return { html, run, steps: [...run.matchAll(/data-testid="add-project-step" data-step="([^"]+)" data-state="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`) };
  };
  const order = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'];
  assert.deepEqual(render().steps, order.map((s) => `${s}:pending`), 'all nine, in order, before any line');
  assert.match(render().html, /data-enabled="no"[\s\S]*adding shop is still running; one project at a time/, 'one run at a time');

  step('instance', 'started');
  assert.deepEqual(render().steps.slice(0, 2), ['instance:started', 'app:pending']);
  step('instance', 'done', 'users wl-shop and wl-shop-agent');
  step('app', 'ask', 'approve the App on GitHub');
  a.create({ kind: 'approve_link', instance: 'shop', title: 'Create shop-app on GitHub', detail: 'x', url: 'https://hub.example.test/setup/app-manifest/start/amf-1' }, 'setup');
  let v = render();
  assert.deepEqual(v.steps.slice(0, 3), ['instance:done', 'app:ask', 'claude-token:pending']);
  assert.match(v.run, /data-testid="add-project-asks"[\s\S]*data-testid="ask-link"[^>]*>https:\/\/hub\.example\.test\/setup\/app-manifest\/start\/amf-1/, 'the first GitHub link, in the run');
  assert.doesNotMatch(v.run, /Unrelated/, "an earlier ask isn't the run's");

  a.create({ kind: 'approve_link', instance: 'shop', title: 'Install shop-app on acme/shop only', detail: 'x', url: 'https://github.com/apps/shop-app/installations/new' }, 'setup');
  step('app', 'done');
  step('claude-token', 'ask', 'paste the token from claude setup-token');
  a.create({ kind: 'paste_secret', instance: 'shop', title: "The agent's Claude token", detail: 'x', credential: 'claude-token', where: 'the agent user only' }, 'setup');
  v = render();
  assert.equal((v.run.match(/data-testid="ask-card"/g) ?? []).length, 3, 'both GitHub links and the token ask');
  const secret = v.run.match(/<input[^>]*data-testid="ask-secret"[^>]*>/)?.[0] ?? '';
  assert.match(secret, /type="password"/, "the token goes through the dashboard's paste box");
  assert.doesNotMatch(secret, /value=/);

  for (const s of order.slice(2)) step(s, 'done');
  log.append('machine.finished', { id: 'mr-0000000000aa', outcome: 'done', detail: 'shop added' }, 'demo', 'coordinator');
  v = render();
  assert.deepEqual(v.steps, order.map((s) => `${s}:done`));
  assert.match(v.html, /data-testid="add-project-run"[^>]*data-status="done"/);
  assert.match(v.html, /data-enabled="yes"/, 'the next project may start');

  // A failed step names the step to retry.
  log.append('machine.requested', { id: 'mr-0000000000bb', args: ['add-project', 'blog', 'acme/blog'], by: 'ada', via: 'settings', ask: null }, 'ada', 'human');
  log.append('add_project.step', { request_id: 'mr-0000000000bb', name: 'blog', repo: 'acme/blog', step: 'checkout', state: 'failed', detail: 'git clone failed', retry: 'sudo bash add-project.sh blog acme/blog' }, 'demo', 'coordinator');
  log.append('machine.finished', { id: 'mr-0000000000bb', outcome: 'failed', detail: 'FAILED at checkout' }, 'demo', 'coordinator');
  assert.match(render().html, /data-testid="add-project-failed"[^>]*>Stopped at &quot;Checkout of the repo&quot;/);
  assert.match(render().html, /data-testid="add-project-retry"[^>]*>To retry: <code>sudo bash add-project.sh blog acme\/blog<\/code>/);
});

test("Add project: the page's name and repo check gives the machine helper's answers", () => {
  const names = ['shop', 'a', 'site-2', 'a'.repeat(21), 'a'.repeat(22), '', '2shop', 'Shop', 'shop_x', 'shop;id', 'dash', 'shop-agent', 'shop-eval', 'shop-work', 'shop-'];
  const repos = ['acme/shop', 'Acme-Co/site.web_2', 'a/b', 'acme', 'a/b/c', '/b', 'a/..', 'a/.', 'a/b c', 'a/b\n', '-a/b', 'a--b/c', `${'a'.repeat(40)}/b`];
  for (const n of names) assert.equal(r.addProjectInvalid(n, 'acme/shop') === null, addProjectNameOk(n), `name ${JSON.stringify(n)}`);
  for (const p of repos) assert.equal(r.addProjectInvalid('shop', p) === null, addProjectRepoOk(p), `repo ${JSON.stringify(p)}`);
});

test("two instances on one machine: with one selected, no page shows any of the other's items; All instances shows both, labelled; the default is the selected one", async () => {
  const marks: Record<'a' | 'b', InstanceMarks> = {
    a: { project: 'alpha-proj', actor: 'wl-alpha@host', issue: 8101, pr: 8170, run: 'tr-alpha-1', title: 'Alpha-only' },
    b: { project: 'beta-proj', actor: 'wl-beta@host', issue: 9201, pr: 9270, run: 'tr-beta-1', title: 'Beta-only' },
  };
  // Both instances' coordinators hold slots in the machine's one slots dir, as on a real machine.
  const shared = mkdtempSync(join(tmpdir(), 'web-render-shared-slots-'));
  const servers: Record<string, Awaited<ReturnType<typeof startDashboard>>> = {};
  for (const name of ['a', 'b'] as const) {
    const m = marks[name];
    const { dir: root } = exampleProject();
    const cfg = loadConfig(root);
    cfg.project.project.name = m.project;
    const dir = mkdtempSync(join(tmpdir(), `web-render-${name}-`));
    const log = new EventLog(join(dir, 'events.db'));
    seedInstanceItems(log, m);
    log.close();
    tryAgentSlot(`${BRAND.cli} ${m.project} #${m.issue}`, shared);
    tryTestSlot(`${m.actor} test run ${m.run}`, shared);
    servers[name] = await startDashboard({ root, cfg, eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, instance: name, slotsDir: shared, actor: m.actor });
  }
  const ask = async (instance: string | null, path: string) => {
    const d = servers[instance!]!;
    const res = await fetch(`${d.url.split('/?')[0]}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  };
  const hub = { instances: [{ name: 'a', up: true, error: null }, { name: 'b', up: true, error: null }] };
  try {
    for (const [sel, other] of [['a', 'b'], ['b', 'a']] as const) {
      const leak = marksOf(marks[other]);
      const own = marksOf(marks[sel]);
      const scope = r.scopeOf(hub, sel, false);
      assert.deepEqual(scope, { current: sel, all: false, instances: [sel] }, `${sel} selected: the scope is ${sel} alone`);
      // What the pages for the selected instance receive: its state, and what each page asks its server for.
      const state = (await ask(sel, '/api/state')) as State;
      const boardsIn = await r.loadBoards(scope, ask);
      const [served, waiting, prs, live] = await Promise.all(['/api/test-runs', '/api/waiting', '/api/prs', '/api/live'].map((p) => ask(sel, p)));
      // As the server serves them, shown as where test runs are set up (the example project has none set up).
      const testRuns = { ...(served as object), configured: true };
      assert.deepEqual(boardsIn.map((b) => b.name), [sel], `the Board asks ${sel}'s server only`);
      const rendered: Record<string, string> = {
        board: clean(() => r.renderBoard(boardsIn)),
        'board test runs': clean(() => r.renderBoardTestRuns(boardsIn)) + clean(() => r.renderTestRuns(testRuns, true)),
        'machine test runs': clean(() => r.renderTestRuns(testRuns)),
        waiting: clean(() => r.renderWaiting(waiting)) + clean(() => r.renderWaitingPage(state)),
        prs: clean(() => r.renderPrs(prs)) + clean(() => r.renderPage('prs', state)),
        agents: clean(() => r.renderAgents(state, live)),
        machine: clean(() => r.renderPage('machine', state)) + clean(() => r.renderMachineSlots((state as unknown as { slots: unknown }).slots)),
        switcher: clean(() => r.renderInstances(hub, sel)),
      };
      for (const page of ['overview', 'inbox', 'decisions', 'issues', 'activity']) rendered[page] = clean(() => r.renderPage(page, state));
      const leaking = Object.entries(rendered).filter(([, html]) => leak.test(html)).map(([page]) => page);
      assert.deepEqual(leaking, [], `${sel} selected: these pages show ${other}'s items`);
      for (const page of ['board', 'board test runs', 'waiting', 'prs', 'agents', 'overview', 'decisions', 'issues', 'activity']) assert.match(rendered[page]!, own, `${sel} selected: the ${page} shows ${sel}'s own items`);
      // Board columns and counts: the selected instance's cards only, Waiting on you among them.
      assert.match(rendered.board!, new RegExp(`data-testid="board-column" data-column="waiting"[^>]*>[^]*?>2</span>[^]*?#${marks[sel].issue + 1}[^]*?#${marks[sel].issue + 2}`), "Waiting on you: the selected instance's decision and blocked task, counted 2");
      assert.match(rendered.board!, /3 in flight/);
      assert.doesNotMatch(rendered.board!, /data-testid="board-card-instance"/, 'one instance: no labels');
      assert.equal((rendered['board test runs']!.match(/data-testid="board-test-runs-instance"/g) ?? []).length, 1, 'one test-runs strip, the selected instance\'s');
      assert.match(rendered.switcher!, /data-scope="[ab]"/);
      assert.doesNotMatch(rendered.switcher!, /data-testid="instance-all"[^>]*aria-current/, 'All instances: off');
      // Asking another instance's server from a page scoped to one is refused before anything is sent.
      await assert.rejects(r.onInstance(other, '/api/board', {}, Promise.resolve(scope)), /isn't selected/);
    }

    // The default: the instance picked last, else the first that answers; never All instances.
    assert.deepEqual(r.scopeOf(hub, null, false), { current: 'a', all: false, instances: ['a'] });
    assert.deepEqual(r.scopeOf({ instances: [{ name: 'a', up: false, error: 'down' }, { name: 'b', up: true, error: null }] }, null, false), { current: 'b', all: false, instances: ['b'] });
    assert.deepEqual(r.scopeOf({ instances: [{ name: 'a', up: true, error: null }] }, 'a', true), { current: 'a', all: false, instances: ['a'] }, 'one instance: nothing to show all of');
    assert.deepEqual(r.scopeOf(null, null, true), { current: null, all: false, instances: [null] }, "an instance's own dashboard: itself");

    // All instances, chosen in the switcher: both boards, every card labelled with its instance; both test-runs strips, labelled.
    const all = r.scopeOf(hub, 'a', true);
    assert.deepEqual(all, { current: 'a', all: true, instances: ['a', 'b'] });
    const both = await r.loadBoards(all, ask);
    const board = clean(() => r.renderBoard(both));
    assert.match(board, /data-scope="all"/);
    for (const n of ['a', 'b'] as const) {
      assert.match(board, marksOf(marks[n]));
      assert.match(board, new RegExp(`data-instance="${n}"[^>]*>[\\s\\S]*?data-testid="board-card-instance"[^>]*>${n}<`), `${n}'s cards say they are ${n}'s`);
    }
    assert.match(board, /data-column="waiting"[^>]*>[^]*?>4<\/span>/, "Waiting on you counts both instances' items");
    assert.match(board, /6 in flight/);
    const strips = clean(() => r.renderBoardTestRuns(both));
    assert.match(strips, /data-instance="a"[^>]*><div[^>]*>a<\/div>[\s\S]*data-instance="b"[^>]*><div[^>]*>b<\/div>/);
    const sw = clean(() => r.renderInstances(hub, 'a', true));
    assert.match(sw, /data-scope="all"/);
    assert.match(sw, /data-testid="instance-all"[^>]*aria-current="true"/);
    assert.match(sw, /data-testid="instance-all-note"[^>]*>The Board shows every instance; the other pages show a\./);
  } finally {
    for (const d of Object.values(servers)) await d.close();
  }
});

test('Claude account: a machine owner sees each agent user and the switch step by step, with the token box only where it is taken; anyone else nothing', () => {
  const ownersFile = machineOwnersFile('ada');
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-render-'));
  const at = new Date().toISOString();
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ at, users: [{ instance: 'shop', kind: 'agent', user: 'wl-shop-agent', stored: true, logged_in: true, auth_method: 'claude.ai', account: 'agents@example.com', token_id: '0123abcd', expires_at: new Date(Date.now() + 200 * 86_400_000).toISOString() }, { instance: 'shop', kind: 'eval', user: 'wl-shop-eval', stored: false, logged_in: false, auth_method: 'none', error: 'claude auth status says it is not logged in' }] }));
  const lines = (more: object[]) =>
    writeFileSync(join(dir, 'switch.jsonl'), [{ step: 'switch', state: 'started', detail: '2 instance(s): shop web; the token from the dashboard of shop' }, { step: 'pause', state: 'done', instance: 'shop', detail: 'starts no more runs' }, { step: 'pause', state: 'done', instance: 'web', detail: 'starts no more runs' }, { step: 'token', state: 'ask', detail: 'paste it' }, ...more].map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  const view = (login: string, instance = 'shop') => claudeAccountView({ dir, events: [], who: { role: 'owner', requester: ownerRequester(login) }, instance, ownersFile });
  lines([]);
  const html = r.renderClaudeAccount(view('ada'));
  for (const id of ['claude-account', 'claude-account-users', 'claude-account-refresh', 'claude-account-switch', 'claude-switch', 'claude-switch-token']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /data-testid="claude-account-user" data-user="wl-shop-agent" data-signed-in="yes"/);
  assert.match(html, /agents@example\.com/);
  assert.match(html, /token 0123abcd/);
  assert.match(html, /data-user="wl-shop-eval" data-signed-in="no"[\s\S]*not logged in/);
  assert.deepEqual([...html.matchAll(/data-testid="claude-switch-step" data-phase="([a-z]+)"/g)].map((m) => m[1]), ['running', 'running', 'pending', 'pending'], 'pause (runs finishing), token waiting, check, resume');
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="claude-account-switch"/, 'no second switch while one runs');
  // In another instance's dashboard the box isn't there: it says where to paste it.
  const elsewhere = r.renderClaudeAccount(view('ada', 'web'));
  assert.doesNotMatch(elsewhere, /data-testid="claude-switch-token"/);
  assert.match(elsewhere, /data-testid="claude-switch-token-elsewhere">Paste it in shop&#x27;s dashboard/);
  // Each instance's result as it comes: one resumed, one left paused.
  lines([{ step: 'token', state: 'done', detail: 'received' }, { step: 'wait', state: 'done', instance: 'shop', detail: 'finished' }, { step: 'wait', state: 'done', instance: 'web', detail: 'finished' }, { step: 'install', state: 'done', instance: 'shop', user: 'wl-shop-agent', detail: 'stored' }, { step: 'check', state: 'done', instance: 'shop', user: 'wl-shop-agent', detail: 'signed in' }, { step: 'check', state: 'failed', instance: 'web', user: 'wl-web-agent', detail: 'not logged in' }, { step: 'resume', state: 'done', instance: 'shop', detail: 'running again' }, { step: 'resume', state: 'failed', instance: 'web', detail: 'not resumed: its auth check failed' }, { step: 'switch', state: 'failed', detail: 'not resumed: web' }]);
  const done = r.renderClaudeAccount(view('ada'));
  assert.match(done, /data-testid="claude-switch" data-status="failed"/);
  assert.deepEqual([...done.matchAll(/data-testid="claude-switch-resume" data-instance="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['shop:done', 'web:failed']);
  assert.match(done, /data-testid="claude-switch-result">not resumed: web/);
  assert.doesNotMatch(done, /data-testid="claude-switch-token"/);
  // Not a machine owner: nothing at all (the server refuses them the data too).
  assert.equal(r.renderClaudeAccount(view('ivy')), '');
});

test('Health: open incidents with what broke, since when, what was tried and the fix; resolved ones folded into a history; a viewer sees no detail; each instance has its dot', async () => {
  const slots = mkdtempSync(join(tmpdir(), 'web-render-incidents-'));
  const now = new Date();
  const hour = (h: number) => new Date(now.getTime() - h * 3600_000);
  const down = raiseIncident('unit_down', 'svc-demo.service', 'instance demo\'s coordinator is failed', 'start it: sudo systemctl start svc-demo.service', { dir: slots, instance: 'demo', tried: ['systemd restarted it 5 times before giving up'], now: hour(2) }).incident;
  const disk = raiseIncident('disk_full', '/srv', 'the volume holding /srv is 91% full', 'free space on that volume', { dir: slots, now: hour(1) }).incident;
  const old = raiseIncident('github_auth', 'demo', 'GitHub refused the token', 'check the App', { dir: slots, instance: 'demo', now: hour(30) }).incident;
  resolveIncident('github_auth', 'demo', { dir: slots, now: hour(29) });
  const { dir: root } = exampleProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'web-render-incidents-state-'));
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: slots, instance: 'demo' });
  try {
    const as = (login: string) => async (_name: string | null, path: string) => (await fetch(`${d.url.split('/?')[0]}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(login) } })).json();
    const hub = { instances: [{ name: 'demo', up: true, error: null }, { name: 'gone', up: false, error: 'down' }] };
    const owner = r.renderHealthPage(await r.loadIncidents(hub, as('example-owner')), disk.id);
    // Open, oldest first, each anchored for the ops channel's link; the linked one marked.
    assert.ok(owner.indexOf(`id="incident-${down.id}"`) >= 0 && owner.indexOf(`id="incident-${down.id}"`) < owner.indexOf(`id="incident-${disk.id}"`), 'open incidents, oldest first, each anchored');
    assert.match(owner, new RegExp(`id="incident-${disk.id}"[^>]*data-targeted="true"`), 'the linked incident is marked');
    assert.match(owner, /data-testid="incident-detail"[^>]*>instance demo&#x27;s coordinator is failed/);
    assert.match(owner, /data-testid="incident-tried"[^>]*>systemd restarted it 5 times before giving up/);
    assert.match(owner, /data-testid="incident-fix"[^>]*>start it: sudo systemctl start svc-demo.service/);
    assert.match(owner, /data-testid="incident-since"[^>]*>since 2h ago/);
    assert.match(owner, /machine/, 'a machine-wide incident says so');
    // Resolved: folded (a closed <details>), unless the link points into it.
    assert.match(owner, /<details[^>]*data-testid="incident-history"(?![^>]*open)/, 'the history is folded');
    assert.match(owner, new RegExp(`id="incident-${old.id}"[^>]*data-testid="incident-resolved"`));
    assert.match(r.renderHealthPage(await r.loadIncidents(hub, as('example-owner')), old.id), /<details[^>]*open=""[^>]*data-testid="incident-history"|<details[^>]*data-testid="incident-history"[^>]*open=""/, 'a link to a resolved incident opens the history');
    // Each instance's dot: red here (an open red incident), red for one not answering.
    assert.match(owner, /data-status="red"[^>]*data-testid="health-instance-dot"[\s\S]*demo/);
    assert.match(owner, /gone<span[^>]*>not readable/);
    // A viewer: that it broke, where and since when; never the detail, what was tried or the fix.
    const viewer = r.renderHealthPage(await r.loadIncidents(hub, as('someone-else')));
    assert.match(viewer, /A service is down/);
    assert.match(viewer, /data-testid="incident-detail-hidden"/);
    for (const secretish of ['coordinator is failed', 'systemctl start', '91% full', 'restarted it']) assert.ok(!viewer.includes(secretish), `a viewer doesn't see "${secretish}"`);
    // Nothing open: says so.
    resolveIncident('unit_down', 'svc-demo.service', { dir: slots });
    resolveIncident('disk_full', '/srv', { dir: slots });
    const clear = r.renderHealthPage(await r.loadIncidents({ instances: [{ name: 'demo', up: true, error: null }] }, as('example-owner')));
    assert.match(clear, /data-testid="health-all-clear"/);
    assert.match(clear, /data-status="green"/);
  } finally {
    await d.close();
  }
  // The sidebar: each instance's row has its status dot; one that isn't answering is red.
  const nav = r.renderInstances({ instances: [{ name: 'a', up: true, error: null }, { name: 'b', up: true, error: null }, { name: 'c', up: true, error: null }, { name: 'd', up: false, error: 'down' }] }, 'a', false, { a: 'green', b: 'amber', c: 'red', d: 'green' });
  const dots = [...nav.matchAll(/data-status="(\w+)"[^>]*data-testid="instance-dot"/g)].map((m) => m[1]);
  assert.deepEqual(dots, ['green', 'amber', 'red', 'red']);
});

test('the trust panel: the recommendation and its rules, each figure over 7 and 30 days, each area with its advice and verification time; a viewer gets the allowlisted figures only, never cost', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const ts = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const events = [
    { ts: ts(9), type: 'review.level_set', payload: { issue: 1, reasons: ['money-path: src/pay.ts'] } },
    { ts: ts(9), type: 'change.proposed', payload: { issue: 1, files: ['src/pay.ts'] } },
    { ts: ts(8), type: 'merge.done', payload: { issue: 1, number: 11, sha: 'a'.repeat(40), title: 'Pay out' } },
    { ts: ts(8), type: 'merge.main_result', payload: { issue: 1, number: 11, outcome: 'red' } },
    { ts: ts(7.9), type: 'merge.main_result', payload: { issue: 9, number: 19, outcome: 'green' } },
    { ts: ts(2), type: 'merge.done', payload: { issue: 2, number: 12, sha: 'b'.repeat(40), title: 'Copy' } },
    { ts: ts(2), type: 'run.cost', payload: { issue: 2, role: 'worker', usd: 1.2, tokens_in: 30_000, tokens_out: 2_000 } },
    { ts: ts(2), type: 'run.cost', payload: { issue: 2, role: 'evaluator-verdict', usd: 0.3, secs: 240 } },
  ];
  const full = trustView(events, { agents: 2, now });
  const html = r.renderTrust(full);
  assert.match(html, /data-testid="trust-panel"/);
  assert.match(html, /data-testid="trust-recommendation" data-action="keep"[\s\S]*?Keep 2 agents/);
  assert.equal((html.match(/data-testid="trust-rule"/g) ?? []).length, 3);
  assert.match(html, /data-testid="trust-rule" data-met="true"[\s\S]*?no escaped money-path bug/);
  assert.match(html, /data-testid="trust-note"[^>]*>A recommendation only: nothing here changes/);
  assert.deepEqual([...html.matchAll(/data-testid="trust-figure" data-figure="([a-z]+)"/g)].map((m) => m[1]), ['merges', 'cfr', 'escaped', 'restore', 'review', 'flaky', 'cost']);
  assert.match(html, /data-figure="cfr"[\s\S]*?data-testid="trust-figure-7"[^>]*>0%[\s\S]*?30 days: <span[^>]*>50%/);
  assert.match(html, /data-figure="cost"[\s\S]*?~\$1\.50/);
  assert.deepEqual([...html.matchAll(/data-testid="trust-area" data-area="([a-z]+)"/g)].map((m) => m[1]), ['money', 'auth', 'other']);
  assert.match(html, /data-area="money"[\s\S]*?data-advice="too_few"/);
  assert.match(html, /data-area="other"[\s\S]*?data-testid="trust-tier"[\s\S]*?evaluator[\s\S]*?4 min median/);
  assert.match(html, /data-testid="trust-failure" data-kind="main_red"[^>]*>#1 \(PR #11\) broke the default branch/);
  assert.match(html, /data-testid="trust-definitions"/);
  assert.doesNotMatch(html, /data-testid="trust-hidden"/);
  // A viewer: the merges only, no cost, no areas or recommendation, and why.
  const viewer = r.renderTrust(trustForViewer(full, VIEWER_EVENTS));
  assert.deepEqual([...viewer.matchAll(/data-testid="trust-figure" data-figure="([a-z]+)"/g)].map((m) => m[1]), ['merges']);
  assert.doesNotMatch(viewer, /trust-recommendation|trust-area|~\$/);
  assert.match(viewer, /data-testid="trust-hidden"[^>]*>The other figures \(failures, restore, review, flaky, verification, cost, area\) are for the instance/);
});

test('the metrics panel: each figure over 7 and 30 days, merges per day, the slowest tests and those over budget; a missing source says "not measured yet", never 0; a viewer is told it is the writers\'', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const ts = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const events = [
    { ts: ts(2), type: 'pr.closed', payload: { issue: 1, number: 11, merged: true } },
    { ts: ts(1), type: 'pr.closed', payload: { issue: 2, number: 12, merged: true } },
    { ts: ts(2), type: 'merge.main_result', payload: { issue: 1, number: 11, outcome: 'red' } },
    { ts: ts(1.9), type: 'merge.main_result', payload: { issue: 2, number: 12, outcome: 'green' } },
    { ts: ts(1), type: 'ci.pr_timing', payload: { number: 12, wall_ms: 18 * 60_000 } },
    { ts: ts(1), type: 'testrun.durations', payload: { id: 'r', tier: 'full', tests: [{ name: 'db > migrates', ms: 45_000 }, { name: 'ui > renders', ms: 1200 }], parsed: 2 } },
  ];
  const m = { ...deliveryMetrics(events, { now, budgetS: 30 }), definitions: METRICS_DEFINITIONS };
  const html = r.renderMetrics(m);
  assert.match(html, /data-testid="metrics-panel"/);
  assert.deepEqual([...html.matchAll(/data-testid="metrics-figure" data-figure="([a-zA-Z]+)" data-measured="(true|false)"/g)].map((x) => `${x[1]}:${x[2]}`), [
    'merges:true',
    'mainRed:true',
    'timeToGreen:true',
    'reverts:true',
    'fixForward:false',
    'prCi:true',
    'startup:false',
    'flake:false',
  ]);
  assert.match(html, /data-figure="timeToGreen"[\s\S]*?data-testid="metrics-figure-7"[^>]*>144 min/);
  assert.match(html, /data-figure="prCi"[\s\S]*?data-testid="metrics-figure-7"[^>]*>18 min/);
  assert.match(html, /data-figure="fixForward"[\s\S]*?data-testid="metrics-not-measured"[^>]*>not measured yet<\/div><div[^>]*>fix-forward isn(&#x27;|')t built yet/);
  assert.match(html, /data-figure="flake"[\s\S]*?not measured yet/);
  assert.doesNotMatch(html.slice(html.indexOf('data-figure="flake"')).split('data-testid="metrics-per-day"')[0]!, />0%?</, 'no 0 for an unmeasured figure');
  assert.equal((html.match(/data-testid="throughput-day"/g) ?? []).length, 14, 'merges per day as bars');
  assert.deepEqual([...html.matchAll(/data-testid="metrics-slow-test"[\s\S]*?font-mono[^>]*>([^<]+)</g)].map((x) => x[1]), ['db &gt; migrates', 'ui &gt; renders']);
  assert.match(html, /data-testid="metrics-over-budget-count"[^>]*>1</);
  assert.equal((html.match(/data-testid="metrics-over-budget"/g) ?? []).length, 1);
  assert.match(html, /data-testid="metrics-definitions"/);
  // Nothing recorded at all: every figure and the slow tests say not measured yet.
  const empty = r.renderMetrics({ ...deliveryMetrics([], { now, budgetS: 30 }), definitions: METRICS_DEFINITIONS });
  assert.equal((empty.match(/data-testid="metrics-not-measured"/g) ?? []).length, 9);
  assert.doesNotMatch(empty, /metrics-figure-7|metrics-per-day|metrics-slow-test"/);
  assert.match(r.renderMetricsPanel(asOther), /data-testid="metrics-refused"[^>]*>The metrics are for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
  assert.doesNotMatch(r.renderMetricsPanel(asOwner), /metrics-refused/);
});

test('flaky tests: each quarantined check is a row with its sightings, issue and passes toward release, and the flake rate over 7 and 30 days', () => {
  const t = { test: 'ci', state: 'quarantined', firstSeen: '2026-10-12T00:00:00Z', lastSeen: '2026-10-13T00:00:00Z', sightings: 3, issue: 101, url: 'https://github.com/example/repo/issues/101', passes: 2, released: null };
  const html = r.renderFlaky({ releaseAfter: 10, quarantined: [t], released: [], rates: [{ days: 7, redRuns: 4, flakyReruns: 1, rate: 0.25 }, { days: 30, redRuns: 8, flakyReruns: 4, rate: 0.5 }], canClear: true });
  assert.match(html, /data-testid="flaky-count">1</);
  assert.match(html, /data-testid="flaky-row" data-test="ci"[\s\S]*?data-testid="flaky-sightings"[^>]*>3<[\s\S]*?#101[\s\S]*?2 of 10[\s\S]*?Clear/);
  assert.match(html, /data-testid="flaky-rate"[^>]*>Flake rate: 25% over 7 days \(1 of 4 red runs\), 50% over 30 days \(4 of 8\)/);
  assert.match(html, /The updater still needs every check green/);
  const none = r.renderFlaky({ releaseAfter: 10, quarantined: [], released: [], rates: [{ days: 7, redRuns: 0, flakyReruns: 0, rate: null }, { days: 30, redRuns: 0, flakyReruns: 0, rate: null }], canClear: false });
  assert.match(none, /No flaky tests found yet/);
});
