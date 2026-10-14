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
import { tailscaleView, type TailscaleStatus } from '../src/tailscale-setup.js';
import { raiseIncident, resolveIncident } from '../src/watchdog/incidents.js';
import { METRICS_DEFINITIONS, trustForViewer, trustView } from '../src/trust.js';
import { deliveryMetrics } from '../src/merge-metrics.js';
import { VIEWER_EVENTS } from '../src/viewer-events.js';
import { firstRunView } from '../src/init.js';
import { checkSetup } from '../src/setup-steps.js';

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
  renderConstraints(c: unknown): string;
  renderConstraintsPanel(state: unknown): string;
  renderMetrics(m: unknown): string;
  renderMetricsPanel(state: unknown): string;
  renderFlaky(f: unknown): string;
  renderHarnessEvals(h: unknown): string;
  renderLearnings(l: unknown): string;
  renderWaiting(w: unknown, now?: number): string;
  renderWaitingPage(state: unknown): string;
  renderFirstRun(f: unknown, o?: { open?: string; confirming?: boolean; actionConfirming?: boolean; policyChanges?: unknown[]; configChanges?: unknown[]; rerun?: string; draftConfirming?: boolean; signin?: unknown; discord?: unknown; ghLogin?: unknown }): string;
  renderClaudeSignin(v: unknown, o?: { confirming?: boolean }): string;
  renderDiscordSetup(v: unknown, o?: { bot?: unknown; botError?: string; tokenConfirming?: boolean; plan?: unknown; values?: Record<string, unknown> }): string;
  renderFirstRunPage(state: unknown): string;
  renderSetupScreens(steps: unknown[]): string;
  renderUpdaterSetup(data: unknown, review?: unknown): string;
  renderSetup(data: unknown): string;
  renderAddProject(data: unknown, picker?: unknown): string;
  renderClaudeAccount(data: unknown, now?: number): string;
  renderTailscaleSetup(data: unknown, o?: { confirming?: string }): string;
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
  renderSignIn(local?: boolean): string;
  renderKeyPage(): string;
  renderKeyForm(error?: string | null): string;
  needsKey(hubPage: boolean, key: string): boolean;
  tryKey(given: string, o: { hub: boolean; get?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>; store?: { setItem(k: string, v: string): void } }): Promise<boolean>;
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

test("the dashboard key: a page opened without one (the install's URL) asks for it in a hidden field or its file; it is tried in a header, then kept in this tab only", async () => {
  assert.equal(r.needsKey(false, ''), true, "an instance's own page with no key asks for it");
  assert.equal(r.needsKey(false, 'k'.repeat(32)), false);
  assert.equal(r.needsKey(true, ''), false, 'a hub page signs in instead');
  const page = r.renderKeyPage();
  assert.match(page, /data-testid="key-page"/);
  assert.match(page, /<input id="dash-key" type="password" autoComplete="off"|<input id="dash-key" type="password" autocomplete="off"/);
  assert.match(page, /data-testid="key-file"[\s\S]*type="file"/, 'or its file');
  assert.match(r.renderKeyForm("That key doesn't open this dashboard."), /role="alert" data-testid="key-error">That key doesn(&#x27;|')t open this dashboard\./);

  const key = 'a'.repeat(32);
  const kept: Partial<Record<string, string>> = {};
  const store = { setItem: (k: string, v: string) => void (kept[k] = v) };
  const calls: { url: string; auth: string | undefined }[] = [];
  const answer = (ok: boolean, body: unknown = {}) => async (url: string, init?: { headers?: Record<string, string> }) => (calls.push({ url, auth: init?.headers?.authorization }), { ok, json: async () => body });
  assert.equal(await r.tryKey(`  ${key}\n`, { hub: false, get: answer(true), store }), true, 'pasted with spaces, or read from the file with its newline');
  assert.deepEqual(calls, [{ url: '/api/role', auth: `Bearer ${key}` }], 'in a header, never the URL');
  assert.deepEqual(kept, { 'dash-token': key });
  for (const k of Object.keys(kept)) Reflect.deleteProperty(kept, k);
  assert.equal(await r.tryKey(key, { hub: false, get: answer(false), store }), false, 'a wrong key');
  assert.equal(await r.tryKey('not a key!', { hub: false, get: answer(true), store }), false, 'not even asked');
  assert.equal(await r.tryKey(key, { hub: true, get: answer(true, { login: null, csrf: null, breakGlass: false }), store }), false, "the hub's sign-in port says 200 to anyone: only the break-glass answer counts");
  assert.deepEqual(kept, {}, 'nothing kept unless it opened the dashboard');
  assert.equal(await r.tryKey(key, { hub: true, get: answer(true, { login: null, csrf: null, breakGlass: true }), store }), true);
  assert.equal(calls.at(-1)!.url, '/api/me');

  assert.match(r.renderSignIn(true), /data-testid="sign-in-key"[\s\S]*data-testid="key-form"/, "on this machine, the hub's sign-in page takes the key too");
  assert.doesNotMatch(r.renderSignIn(), /key-form/, 'not through the public sign-in');
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
  // The machine's outbound proxy (root's network.json), read-only: the host and its file, or the refusal in red.
  const proxied = r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: 'proxy.internal:3128', file: '/etc/x/network.json', error: null } });
  assert.match(proxied, /data-testid="health-network"[^>]*>Outbound proxy: <code[^>]*>proxy\.internal:3128<\/code> \(from <code[^>]*>\/etc\/x\/network\.json<\/code>\)/);
  assert.doesNotMatch(proxied, /<(?:input|button|form)[^>]*network/i, 'nothing on the page changes it');
  assert.match(r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: null, file: '/etc/x/network.json', error: '/etc/x/network.json: proxy must not carry a user or password; no outbound proxy is set' } }), /role="alert"[^>]*data-testid="health-network-refused"[\s\S]*?Outbound proxy refused:[\s\S]*?must not carry a user or password/);
  assert.doesNotMatch(r.renderHealth({ ...base, offsiteBackup: null, network: null }), /health-network/);
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

test('the updater setup: the three steps; signers and staged signers with the root command that confirms each; no way to add a signer or pick main; read-only for anyone else', () => {
  const key = `AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`; // made up: the shape of a public key, no real one
  const key2 = `AAAAC3NzaC1lZDI1NTE5AAAAI${'B'.repeat(43)}`;
  const rootCommand = 'sudo bash /opt/harness/current/scripts/setup/updates.sh --confirm-signer SHA256:secondfingerprint';
  const updater = {
    installed: true,
    enabled: false,
    channel: 'release',
    channelWhat: 'the newest release tag vX.Y.Z, only when its signature verifies',
    signersFile: '/etc/harness/allowed_signers',
    updaterReads: null,
    signers: [{ principal: 'first@example.com', options: 'namespaces="git"', keyType: 'ssh-ed25519', key, fingerprint: 'SHA256:firstfingerprint' }],
    pending: [{ principal: 'second@example.com', key: key2, fingerprint: 'SHA256:secondfingerprint', by: 'wl-site', at: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(), confirm: rootCommand }],
    pendingMax: 4,
    script: { install: 'sudo bash scripts/setup/updates.sh', signer: 'sudo bash scripts/setup/updates.sh --signer <principal> ssh-ed25519 <public key>', confirm: 'sudo bash scripts/setup/updates.sh --confirm-signer <SHA256 fingerprint of a staged signer>', release: 'sudo bash scripts/setup/updates.sh --channel release', main: 'sudo bash scripts/setup/updates.sh --channel main' },
  };
  const data = { owner: 'example-owner', user: 'example-owner', canChange: true, helper: '/usr/local/libexec/harness-machine', slots: { cap: 3, running: 1, min: 1, max: 16 }, updates: { configured: true, enabled: false, branch: 'main', requiredChecks: ['test'] }, updater, changes: [], history: [] };
  const html = r.renderUpdaterSetup(data);
  for (const id of ['updater-setup', 'updater-nothing-changes', 'updater-step', 'updater-install', 'updater-signers', 'updater-signer', 'updater-stage-only', 'updater-pending', 'updater-pending-fingerprint', 'updater-pending-command', 'updater-pending-discard', 'updater-signer-form', 'updater-signer-principal', 'updater-signer-key', 'updater-signer-review', 'updater-channel', 'updater-main-root-only', 'updater-script']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /data-testid="updater-nothing-changes"[^>]*>Nothing changes until you review a step and confirm it\. Skip any of them, or all: the machine stays as it is\./);
  assert.match(html, /data-step="1"[\s\S]*?installed, updates off[\s\S]*?Install again…/);
  assert.match(html, /data-step="2"[\s\S]*?1 listed, 1 staged/);
  assert.match(html, /data-testid="updater-signer"[\s\S]*?first@example\.com[\s\S]*?ssh-ed25519[\s\S]*?namespaces=(&quot;|")git(&quot;|")[\s\S]*?SHA256:firstfingerprint/);
  assert.match(html, /data-testid="updater-stage-only"[^>]*>This page can(&#x27;|')t add a signer, and it can(&#x27;|')t remove or replace one\. It can stage a key; an admin then confirms it with one command at a root shell on the machine\./);
  // The staged signer: marked as not a signer, its key and fingerprint, and the exact root command that confirms it.
  assert.match(html, new RegExp(`data-testid="updater-pending" data-fingerprint="SHA256:secondfingerprint"[\\s\\S]*?staged, not a signer[\\s\\S]*?second@example\\.com[\\s\\S]*?by (<!-- -->)?wl-site[\\s\\S]*?${key2}[\\s\\S]*?data-testid="updater-pending-fingerprint"[^>]*>SHA256:secondfingerprint<[\\s\\S]*?data-testid="updater-pending-command"[^>]*>sudo bash /opt/harness/current/scripts/setup/updates\\.sh --confirm-signer SHA256:secondfingerprint<`));
  // The channel: where it is; no picker, no main to choose; on release there is nothing to press.
  assert.match(html, /data-testid="updater-channel" data-channel="release"/);
  assert.doesNotMatch(html, /data-channel="main"|type="radio"|data-testid="updater-release"/, 'no channel picker, and no main');
  assert.match(html, /data-testid="updater-main-root-only"[^>]*>The page only ever moves a machine to release\. Following main instead is set at a root shell: <span[^>]*>sudo bash scripts\/setup\/updates\.sh --channel main</);
  assert.match(html, /data-testid="updater-script"[\s\S]*?sudo bash scripts\/setup\/updates\.sh\nsudo bash scripts\/setup\/updates\.sh --signer &lt;principal&gt; ssh-ed25519 &lt;public key&gt;\nsudo bash scripts\/setup\/updates\.sh --confirm-signer &lt;SHA256 fingerprint of a staged signer&gt;\nsudo bash scripts\/setup\/updates\.sh --channel release</);
  // Nothing is confirmable until a step has been reviewed, and nothing on the page says "add".
  assert.doesNotMatch(html, /data-testid="updater-(review|confirm)"|Add this signer|Add signer/);
  // A signer under review to stage: the principal, the whole key, its fingerprint, the root command, and a button that says stage.
  const key3 = `AAAAC3NzaC1lZDI1NTE5AAAAI${'C'.repeat(43)}`;
  const plan = { step: 'stage', args: ['stage-update-signer', 'third@example.com', 'ssh-ed25519', key3], command: `/usr/local/libexec/harness-machine stage-update-signer third@example.com ssh-ed25519 ${key3}`, changes: ['stages this principal and key in /var/lib/harness/pending-signers.json, for 24 hours', 'changes nothing in /etc/harness/allowed_signers: a staged key is trusted for nothing'], script: '', signer: { principal: 'third@example.com', key: key3, fingerprint: 'SHA256:thirdfingerprint', line: `third@example.com ssh-ed25519 ${key3}`, confirm: 'sudo bash /opt/harness/current/scripts/setup/updates.sh --confirm-signer SHA256:thirdfingerprint', file: '/etc/harness/allowed_signers' } };
  const reviewing = r.renderUpdaterSetup(data, { input: { step: 'stage', principal: 'third@example.com', key: key3 }, plan });
  assert.match(reviewing, new RegExp(`data-testid="updater-review" data-step="stage"[\\s\\S]*?Staging adds nothing to the keys this machine trusts[\\s\\S]*?data-testid="updater-review-principal"[^>]*>third@example\\.com<[\\s\\S]*?data-testid="updater-review-key"[^>]*>${key3}<[\\s\\S]*?data-testid="updater-review-fingerprint"[^>]*>SHA256:thirdfingerprint<[\\s\\S]*?data-testid="updater-review-root-command"[^>]*>sudo bash /opt/harness/current/scripts/setup/updates\\.sh --confirm-signer SHA256:thirdfingerprint<[\\s\\S]*?data-testid="updater-review-command"[^>]*>/usr/local/libexec/harness-machine stage-update-signer [\\s\\S]*?a staged key is trusted for nothing[\\s\\S]*?data-testid="updater-confirm"[^>]*>Stage this signer<`));
  assert.doesNotMatch(reviewing, /data-testid="updater-signer-form"/, 'the form gives way to what was entered, until confirmed or cancelled');
  // A discard under review opens in its own staged entry.
  const discarding = r.renderUpdaterSetup(data, { input: { step: 'discard', principal: 'second@example.com', key: key2 }, plan: { step: 'discard', args: [], command: '/usr/local/libexec/harness-machine discard-update-signer second@example.com ssh-ed25519 x', changes: ['takes it out'], script: '' } });
  assert.match(discarding, /data-testid="updater-pending"[\s\S]*?data-testid="updater-review" data-step="discard"[\s\S]*?data-testid="updater-confirm"[^>]*>Discard it</);
  // On main: the one channel change the page offers is back to release.
  const onMain = r.renderUpdaterSetup({ ...data, updater: { ...updater, channel: 'main', channelWhat: "main's newest commit whose checks are all green. There is no release tag on this channel, so no tag signature is checked" } });
  assert.match(onMain, /data-testid="updater-channel" data-channel="main"[\s\S]*?no tag signature is checked[\s\S]*?data-testid="updater-release"[^>]*>Follow releases…</);
  // Four staged: no room for another, so no form.
  assert.doesNotMatch(r.renderUpdaterSetup({ ...data, updater: { ...updater, pending: Array.from({ length: 4 }, (_, i) => ({ ...updater.pending[0]!, principal: `s${i}@example.com`, key: `${key2.slice(0, -1)}${i}` })) } }), /data-testid="updater-signer-form"/);
  // Not installed: the channel waits for the install; no signers yet.
  const bare = r.renderUpdaterSetup({ ...data, updater: { ...updater, installed: false, enabled: null, channel: null, channelWhat: null, signers: null, pending: [] } });
  assert.match(bare, /data-step="1"[\s\S]*?not installed[\s\S]*?Install the updater…/);
  assert.match(bare, /data-step="2"[\s\S]*?none listed/);
  assert.match(bare, /Install the updater first: it starts on release/);
  assert.doesNotMatch(bare, /data-testid="updater-release"|data-testid="updater-signers"|data-testid="updater-pending"/);
  // A config that names another signers file: said, in the signers step.
  assert.match(r.renderUpdaterSetup({ ...data, updater: { ...updater, updaterReads: '/root/signers' } }), /data-testid="updater-reads-elsewhere"[^>]*>[\s\S]*?\/root\/signers/);
  // Anyone who can't change the machine sees the state, the staged signer and its command, and nothing to press.
  const theirs = r.renderUpdaterSetup({ ...data, user: 'example-collaborator', canChange: false });
  assert.match(theirs, /data-testid="updater-signer"[\s\S]*data-testid="updater-pending-command"/);
  assert.doesNotMatch(theirs, /data-testid="updater-(install|signer-form|signer-review|pending-discard|release|confirm)"/);
  // An older server sends no updater: the section isn't there, and the machine settings still render.
  const { updater: _none, ...older } = data;
  assert.equal(r.renderUpdaterSetup(older), '');
  assert.match(r.renderMachine(data), /data-testid="updater-setup"[\s\S]*data-testid="machine-setting-row"/, 'above the settings table, on the Machine page');
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

/** The first-run view as the server makes it: init's record (src/init.ts firstRunView), the steps checked live with stand-ins, and Start. */
function firstRun(file: string, o: { root: string; repo: string; instance: string | null; start?: unknown; canStart?: boolean }) {
  const probe = {
    which: (c: string) => (['git', 'gitleaks', 'claude', 'gh'].includes(c) ? `/stand-in/${c}` : null),
    run: () => ({ status: 1, stdout: '{"loggedIn": false}', stderr: 'stand-in' }),
    serviceRunning: () => false,
    systemUnitActive: () => false,
    linger: () => null,
  };
  const setup = checkSetup({ mode: o.instance ? 'server' : 'local', root: o.root, repo: o.repo, instance: o.instance, stateDir: mkdtempSync(join(tmpdir(), 'web-render-fr-')), policyFile: null, openQuestions: 0, setupPr: null, instanceFacts: () => ({ error: 'no instance here' }) }, probe);
  const view = firstRunView(file, { root: o.root, repo: o.repo, instance: o.instance, has: () => false, setup });
  const start = o.start ?? { kind: 'local', label: 'dev.worklane.example-shop', file: '/home/example/Library/LaunchAgents/dev.worklane.example-shop.plist', manager: 'launchd (a per-user agent: KeepAlive, starts at login)', commands: ['launchctl bootstrap gui/501 /home/example/Library/LaunchAgents/dev.worklane.example-shop.plist'], program: ['/usr/bin/node', '/opt/engine/dist/src/cli.js', 'coordinator', 'run', '--root', '/r'], log: '/state/coordinator.log' };
  return { ...view, start, canStart: o.canStart ?? true };
}

const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test("the first-run page: every setup step checked live, grouped, done or not done; a Fix for each that isn't; init's record; what local mode lacks; viewers refused", () => {
  const file = join(mkdtempSync(join(tmpdir(), 'web-render-init-')), 'init.json');
  const at = '2026-10-13T10:00:00.000Z';
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'example-org/example-shop', instance: null, steps: { tools: { status: 'done', detail: 'node 24.21.0, git, gitleaks, claude, gh', at }, claude: { status: 'failed', detail: 'not signed in, per `claude auth status`', at } }, handoff: {}, updatedAt: at, finishedAt: null }));
  const f = firstRun(file, { root: '/r', repo: 'example-org/example-shop', instance: null });
  const html = r.renderFirstRun(f);
  // Grouped as the registry groups them, local mode's only.
  assert.deepEqual([...html.matchAll(/data-testid="first-run-group" data-group="([a-z-]+)"/g)].map((m) => m[1]), ['install', 'tools', 'claude', 'github', 'repo-config', 'protection', 'extras', 'service']);
  const steps = [...html.matchAll(/data-testid="first-run-step" data-step="([a-z-]+)" data-status="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.ok(steps.includes('tools:done'), 'tools are all on PATH (live, not from init.json)');
  assert.ok(steps.includes('claude-login:todo'), 'signed out, per claude auth status');
  assert.equal(steps.length, f.setup!.total);
  assert.match(html, /data-testid="first-run-mode" data-mode="local">Local mode: on this machine, as you\. No server, no ssh, no root\./);
  assert.match(html, new RegExp(`${f.setup!.done} of ${f.setup!.total} steps done, ${f.setup!.requiredLeft} required left`));
  assert.match(html, /data-testid="first-run-recheck"[^>]*>Re-check/);
  assert.match(html, /data-testid="first-run-checked"/);
  // Each not-done step has a Fix of its kind; a done one has none.
  assert.match(html, /data-step="claude-login" data-status="todo"[\s\S]*?data-testid="first-run-fix" data-fix="signin"[^>]*>Sign in</);
  assert.match(html, /data-step="service" data-status="todo"[\s\S]*?data-fix="start"[^>]*>Start</);
  const tools = html.slice(html.indexOf('data-step="tools"'), html.indexOf('</li>', html.indexOf('data-step="tools"')));
  assert.doesNotMatch(tools, /first-run-fix/);
  assert.doesNotMatch(html, /first-run-fix-panel/, 'no Fix open yet');
  // init's record: where it last stopped, and the command that picks up there.
  assert.match(html, /data-testid="first-run-resume"[\s\S]*?init last stopped at Claude login[\s\S]*?<code[^>]*>worklane init \/r<\/code>/);
  assert.match(html, /data-testid="first-run-unavailable"[\s\S]*?Not available in local mode[\s\S]*?separate OS users[\s\S]*?root-run add-project[\s\S]*?test sandbox[\s\S]*?needs Docker/);
  assert.doesNotMatch(html, /first-run-none/);
  // Fix, Sign in to Claude: its panel opens in the step (rendered from its data; the page loads it).
  const claude = r.renderFirstRun(f, { open: 'claude-login', signin: { mode: 'local', canAct: true, state: 'idle', url: null, detail: 'not started', startedAt: null, endedAt: null, status: null } });
  assert.match(claude, /data-testid="first-run-fix-panel"[\s\S]*?data-testid="claude-signin" data-mode="local" data-state="idle"[\s\S]*?data-testid="claude-signin-button"/);
  // ... and it runs again once done (another account, an expired login).
  const signedIn = { ...f, setup: { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((x) => (x.id === 'claude-login' ? { ...x, done: true } : x)) })) } };
  assert.match(r.renderFirstRun(signedIn), /data-step="claude-login" data-status="done"[\s\S]*?data-testid="first-run-fix" data-fix="signin"[^>]*>Again</);
  // Connect GitHub (src/gh-login.ts): the command it runs for you; owners get the button, writers are told why not.
  const ghFix = (canAct: boolean, ghLogin?: unknown) => r.renderFirstRun({ ...f, canAct }, { open: 'gh-login', ...(ghLogin ? { ghLogin } : {}) });
  const gh0 = { state: 'idle', code: null, url: null, startedAt: null, expiresAt: null, detail: null, installed: true };
  assert.match(ghFix(true, gh0), /data-fix="gh-login"[^>]*>Connect GitHub<[\s\S]*?data-testid="gh-login" data-state="idle"[\s\S]*?<code[^>]*>gh auth login --web<\/code>[\s\S]*?never sees the token[\s\S]*?data-testid="gh-login-start"[^>]*>Connect GitHub</);
  assert.match(ghFix(false), /data-testid="gh-login-refused"/);
  assert.doesNotMatch(ghFix(false), /gh-login-start/);
  // Waiting: the one-time code, GitHub's device page, Cancel.
  const waiting = ghFix(true, { ...gh0, state: 'waiting', code: 'E286-95A6', url: 'https://github.com/login/device', startedAt: '2026-10-13T00:00:00Z', expiresAt: '2026-10-13T00:15:00Z' });
  assert.match(waiting, /data-testid="gh-login-code"[^>]*>E286-95A6</);
  assert.match(waiting, /href="https:\/\/github\.com\/login\/device"[^>]*data-testid="gh-login-link"/);
  assert.match(waiting, /data-testid="gh-login-cancel"/);
  // Failed: why, and Try again; no gh: the Tools step.
  assert.match(ghFix(true, { ...gh0, state: 'failed', detail: 'gh stopped (exit 1)' }), /data-testid="gh-login-detail"[^>]*>gh stopped \(exit 1\)<[\s\S]*?data-testid="gh-login-start"[^>]*>Try again</);
  assert.match(ghFix(true, { ...gh0, installed: false }), /data-testid="gh-login-no-gh"/);
  assert.match(ghFix(true, { ...gh0, state: 'done', detail: 'signed in' }), /data-testid="gh-login-done"/);
  // Fix with no screen yet: what a person does today, and that a screen is coming.
  const coming = f.setup!.groups.flatMap((g) => g.steps).find((s) => !s.done && s.fix.kind === 'coming')!;
  const comingHtml = r.renderFirstRun(f, { open: coming.id });
  assert.match(comingHtml, /data-testid="first-run-coming"[\s\S]*?Today: <\/span>/);
  assert.match(comingHtml, /A screen for this is coming\./);
  assert.ok(comingHtml.includes(escaped(coming.today)), "today's way, as the audit has it");
  // Fix only in a terminal: the command and why.
  assert.match(r.renderFirstRun(f, { open: 'path' }), /data-testid="first-run-terminal"[\s\S]*?Only in a terminal: it goes in your shell profile/);
  // Start: the change shown first, then a confirmation.
  assert.match(html, /data-testid="first-run-start"[\s\S]*?data-testid="first-run-start-change"[\s\S]*?launchd[\s\S]*?dev\.worklane\.example-shop\.plist[\s\S]*?coordinator run --root \/r[\s\S]*?data-testid="first-run-start-button"/);
  assert.doesNotMatch(html, /first-run-start-confirm"/, 'no confirmation until Start is pressed');
  const confirming = r.renderFirstRun(f, { confirming: true });
  assert.match(confirming, /data-testid="first-run-start-confirming"[\s\S]*?data-testid="first-run-start-confirm"[^>]*>Confirm start[\s\S]*?data-testid="first-run-start-cancel"/);
  // A writer sees the change but no Start.
  const writer = r.renderFirstRun({ ...f, canStart: false });
  assert.match(writer, /data-testid="first-run-start-refused"[^>]*>Only the instance(&#x27;|')s owners can start it/);
  assert.doesNotMatch(writer, /first-run-start-button/);
  // Never run here: still checked live, and the command to walk it.
  const none = r.renderFirstRun(firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: null }));
  assert.match(none, /data-testid="first-run-none"[\s\S]*?<code[^>]*>worklane init \/r<\/code>/);
  assert.match(none, /data-testid="first-run-group"/);
  // Server mode: the server's steps; Start is the owner's root command, never a button here.
  const server = r.renderFirstRun(firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: 'shop', start: { kind: 'owner-command', unit: 'worklane-shop.service', command: 'sudo bash /opt/engine/scripts/setup/service.sh shop', why: 'the dashboard never runs sudo' } }));
  assert.match(server, /Server mode/);
  assert.match(server, /data-group="policy"[\s\S]*?data-group="updates"/);
  assert.match(server, /data-testid="first-run-start-owner-command"[\s\S]*?worklane-shop\.service[\s\S]*?<code[^>]*>sudo bash \/opt\/engine\/scripts\/setup\/service\.sh shop<\/code>/);
  assert.doesNotMatch(server, /first-run-start-button|first-run-unavailable/);
  // Anyone but the owner and the writers: told, not asked.
  assert.match(r.renderFirstRunPage(asOther), /data-testid="first-run-refused"[^>]*>The first-run checklist is for the instance(&#x27;|')s owners and writers/);
  assert.doesNotMatch(r.renderFirstRunPage(asOwner), /first-run-refused/);
});

test("the first-run page, a Fix the dashboard does itself: its plan shown first, then a confirmation; the owners only; why not, where it can't run", () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const plans = {
    'git-hooks': { id: 'git-hooks', step: 'pre-commit', label: 'Install the git hooks', available: true, changes: ['/r/.git/hooks/pre-commit: a gitleaks secret scan on every commit'], commands: ['worklane install --git-hooks'] },
  };
  const withPlans = { ...f, actions: plans, canAct: true };
  const html = r.renderFirstRun(withPlans);
  assert.match(html, /data-step="pre-commit" data-status="todo"[\s\S]*?data-testid="first-run-fix" data-fix="action"[^>]*>Install</);
  const open = r.renderFirstRun(withPlans, { open: 'pre-commit' });
  assert.match(open, /data-testid="first-run-action" data-action="git-hooks"[\s\S]*?data-testid="first-run-action-plan"[\s\S]*?Install the git hooks changes:[\s\S]*?\/r\/\.git\/hooks\/pre-commit: a gitleaks secret scan[\s\S]*?It runs:[\s\S]*?<code[^>]*>worklane install --git-hooks<\/code>[\s\S]*?data-testid="first-run-action-button"[^>]*>Install the git hooks…/);
  assert.doesNotMatch(open, /first-run-action-confirm"/, 'no confirmation until the button is pressed');
  assert.match(r.renderFirstRun(withPlans, { open: 'pre-commit', actionConfirming: true }), /data-testid="first-run-action-confirming"[\s\S]*?Make the change above\?[\s\S]*?data-testid="first-run-action-confirm"[^>]*>Confirm[\s\S]*?data-testid="first-run-action-cancel"/);
  const writer = r.renderFirstRun({ ...withPlans, canAct: false }, { open: 'pre-commit' });
  assert.match(writer, /data-testid="first-run-action-plan"[\s\S]*?data-testid="first-run-action-refused"[^>]*>Only the instance(&#x27;|')s owners can run it/);
  assert.doesNotMatch(writer, /first-run-action-button/);
  const unavailable = r.renderFirstRun({ ...withPlans, actions: { 'git-hooks': { ...plans['git-hooks'], available: false, why: 'nothing is missing', changes: [], commands: [] } } }, { open: 'pre-commit' });
  assert.match(unavailable, /data-testid="first-run-action-unavailable"[^>]*>Not from here: nothing is missing\./);
  assert.doesNotMatch(unavailable, /first-run-action-button/);
});

test("the first-run page, Sign in to Claude: local relays claude auth login (the link for owners, nothing pasted); a server pastes a setup token; a cached account is labelled cached", () => {
  const local = { mode: 'local', canAct: true, state: 'idle', url: null, detail: 'not started', startedAt: null, endedAt: null, status: null };
  const idle = r.renderClaudeSignin(local);
  assert.match(idle, /data-testid="claude-signin" data-mode="local" data-state="idle"[\s\S]*?claude auth login[\s\S]*?Nothing is pasted[\s\S]*?never sees, logs or stores a token/);
  assert.match(idle, /data-testid="claude-signin-button"[^>]*>Sign in…/);
  assert.doesNotMatch(idle, /claude-signin-confirm"/, 'no confirmation until Sign in is pressed');
  assert.match(r.renderClaudeSignin(local, { confirming: true }), /data-testid="claude-signin-confirming"[\s\S]*?Run claude auth login now\?[\s\S]*?data-testid="claude-signin-confirm"/);
  assert.match(r.renderClaudeSignin({ ...local, canAct: false }), /data-testid="claude-signin-refused"[^>]*>Only the instance(&#x27;|')s owners can start it/);
  const url = 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback&state=s';
  const waiting = r.renderClaudeSignin({ ...local, state: 'waiting', url, detail: 'open it', startedAt: '2026-10-13T10:00:00.000Z' });
  assert.ok(waiting.includes(`href="${url.replace('&', '&amp;')}"`), waiting);
  assert.match(waiting, /data-testid="claude-signin-link"[^>]*>Open Anthropic(&#x27;|')s sign-in/);
  assert.match(waiting, /data-testid="claude-signin-cancel"/);
  assert.doesNotMatch(waiting, /claude-signin-button/);
  assert.match(r.renderClaudeSignin({ ...local, canAct: false, state: 'waiting', detail: 'open it' }), /shown to the instance(&#x27;|')s owners only/);
  const done = r.renderClaudeSignin({ ...local, state: 'done', detail: 'signed in (claude.ai)', status: { loggedIn: true, method: 'claude.ai', cachedAccount: 'someone@example.com' } });
  assert.match(done, /data-testid="claude-signin-cached-account"[^>]*>Account: someone@example\.com \(cached by Claude Code; it may predate a later token change\)/);

  const server = { mode: 'server', canAct: true, agentUser: 'wl-example-agent', ask: null, status: null, command: 'claude setup-token\nsudo bash /opt/engine/scripts/setup/credentials.sh example claude', script: 'sudo bash /opt/engine/scripts/setup/credentials.sh example claude' };
  const none = r.renderClaudeSignin(server);
  assert.match(none, /data-testid="claude-signin" data-mode="server"[\s\S]*?wl-example-agent only \(0600\), never shown or logged[\s\S]*?data-testid="claude-signin-no-ask"[\s\S]*?data-testid="claude-signin-setup"[\s\S]*?data-testid="claude-signin-command"[^>]*>claude setup-token\nsudo bash \/opt\/engine\/scripts\/setup\/credentials\.sh example claude/);
  assert.doesNotMatch(none, /\/login/, 'no /login session any more');
  const ask = { id: 'a1', instance: 'example', title: "The Claude login for example's agents", detail: 'Paste the token claude setup-token prints.', createdAt: '2026-10-13T10:00:00.000Z', createdBy: 'add-project', status: 'open', answer: null, cancelled: null, kind: 'paste_secret', credential: 'claude-token', where: 'x' };
  const box = r.renderClaudeSignin({ ...server, ask: { ...ask, canAnswer: true }, status: { at: '2026-10-13T10:00:00.000Z', loggedIn: true, method: 'claude.ai', cachedAccount: 'previous@example.com', installedAt: '2026-10-13T11:00:00.000Z' } });
  assert.match(box, /data-testid="claude-signin-ask"[\s\S]*?type="password"[^>]*data-testid="ask-secret"/);
  assert.match(box, /data-testid="claude-signin-status"[\s\S]*?signed in \(claude\.ai\)[\s\S]*?data-testid="claude-signin-cached-account"[^>]*>Account: previous@example\.com \(cached/);
  assert.match(r.renderClaudeSignin({ ...server, ask: { ...ask, canAnswer: false } }), /data-testid="claude-signin-refused"[^>]*>Only the instance(&#x27;|')s owners can paste it/);
});

test("the first-run page, Policy form: each key with its bounds and why, the isolation keys read-only, Review then the change and Confirm; writers can't edit", () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: 'shop' });
  const policy = {
    fields: [
      { key: 'budget.daily_usd', value: 20, kind: 'number', min: 1, max: 100, step: 1, why: "the instance's daily spend ceiling" },
      { key: 'land_mode', value: 'pr', kind: 'choice', choices: ['pr', 'direct'], why: 'pr: every change lands through a PR' },
      { key: 'auto_merge', value: false, kind: 'boolean', why: 'on: the harness merges its own PRs' },
    ],
    fixed: [{ key: 'sandbox', value: true }, { key: 'lanes', value: ['default'] }],
    error: null,
  };
  const html = r.renderFirstRun({ ...f, policy, canAct: true }, { open: 'policy' });
  assert.match(html, /data-step="policy"[\s\S]*?data-testid="first-run-fix" data-fix="form"[^>]*>Review</);
  assert.match(html, /data-testid="policy-form"[\s\S]*?data-key="budget\.daily_usd"[\s\S]*?type="number"[^>]*min="1"[^>]*max="100"[\s\S]*?1–100[\s\S]*?daily spend ceiling[\s\S]*?data-key="land_mode"[\s\S]*?<select[\s\S]*?direct[\s\S]*?data-key="auto_merge"[\s\S]*?type="checkbox"/);
  assert.match(html, /data-testid="policy-fixed"[^>]*>Not changed here \(isolation; set at a root shell\): sandbox true · lanes default/);
  assert.match(html, /data-testid="policy-review"[^>]*>Review the change/);
  assert.doesNotMatch(html, /policy-confirm"/);
  const confirming = r.renderFirstRun({ ...f, policy, canAct: true }, { open: 'policy', policyChanges: [{ key: 'auto_merge', from: false, to: true }] });
  assert.match(confirming, /data-testid="policy-confirming"[\s\S]*?data-testid="policy-change"[^>]*>auto_merge: false → true[\s\S]*?data-testid="policy-confirm"[^>]*>Confirm/);
  const writer = r.renderFirstRun({ ...f, policy, canAct: false }, { open: 'policy' });
  assert.match(writer, /data-testid="policy-refused"[^>]*>Only the instance(&#x27;|')s owners can change its policy/);
  assert.match(writer, /type="number"[^>]*disabled=""/);
});

test("the first-run page, Repo config form: writers, required checks, budget and workers from the default branch's config; Review then the change and Propose as a PR; writers can't; why not when the config isn't on the default branch", () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const repoConfig = { values: { writers: ['example-owner'], required_checks: ['test'], daily_budget_usd: 40, workers_count: 1, workers_model: 'sonnet' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop' };
  const html = r.renderFirstRun({ ...f, repoConfig, canAct: true }, { open: 'required-checks' });
  assert.match(html, /data-step="required-checks"[\s\S]*?data-testid="first-run-fix" data-fix="form"[^>]*>Change</);
  assert.match(html, /data-testid="repo-config-form"[\s\S]*?proposed as a PR against main; nothing changes until it merges[\s\S]*?data-testid="repo-config-writers"[^>]*value="example-owner"[\s\S]*?data-testid="repo-config-check" data-check="test"[\s\S]*?checked=""[\s\S]*?data-testid="repo-config-budget"[^>]*value="40"[\s\S]*?data-testid="repo-config-review"[^>]*>Review the change/);
  const confirming = r.renderFirstRun({ ...f, repoConfig, canAct: true }, { open: 'required-checks', configChanges: [{ file: '.worklane/config.yaml', key: 'required_checks', from: ['test'], to: ['test', 'lint'] }] });
  assert.match(confirming, /data-testid="repo-config-change"[^>]*>\.worklane\/config\.yaml required_checks: test → test, lint[\s\S]*?data-testid="repo-config-propose"[^>]*>Propose as a PR/);
  const writer = r.renderFirstRun({ ...f, repoConfig, canAct: false }, { open: 'required-checks' });
  assert.match(writer, /data-testid="repo-config-refused"[^>]*>Only the instance(&#x27;|')s owners can propose a config change/);
  assert.doesNotMatch(writer, /repo-config-review|repo-config-check-name/);
  assert.match(html, /placeholder="another check, as GitHub names it"[^>]*data-testid="repo-config-check-name"[\s\S]*?data-testid="repo-config-check-add"/);
  assert.match(r.renderFirstRun({ ...f, repoConfig: { error: '.worklane/ missing at origin/main' }, canAct: true }, { open: 'required-checks' }), /data-testid="repo-config-error"[^>]*>Not from here yet: \.worklane\/ missing at origin\/main/);
});

test("the first-run page in setup mode: the banner; the origin picker; auto-config's questions as choices, the draft confirmed first and its log; the setup PR with Merge; outside setup mode, today's way", () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const autoConfig = { questions: [{ id: 'package-manager', ask: 'which package manager runs it?', choices: [{ id: 'npm', label: 'npm' }, { id: 'pnpm', label: 'pnpm' }], custom: false }], verified: [], pr: null, answer: 'worklane init /r --answer <id>=<choice>' };
  const draft = { running: false, startedAt: '2026-10-13T10:00:00.000Z', finishedAt: '2026-10-13T10:00:05.000Z', lines: ['   running runner.full on main (abcdef12): npm test'], result: { status: 'failed', detail: '1 question to answer' } };
  // The questions step as setup mode finds it: not done while auto-config waits on an answer.
  const open = { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'questions' ? { ...s, done: false, detail: '1 question open (shown below)' } : s)) })) };
  const setup = { ...f, setup: open, setupMode: true, configReady: false, autoConfig, draft, canAct: true };
  const html = r.renderFirstRun(setup);
  assert.match(html, /data-testid="first-run-setup-mode"[\s\S]*?Setup mode: this checkout has no config yet/);
  assert.doesNotMatch(html, /data-testid="first-run-auto-config"/, 'the read-only view gives way to the panels');
  assert.match(r.renderFirstRun(setup, { open: 'origin' }), /data-step="origin" data-status="todo"[\s\S]*?data-fix="form"[^>]*>Pick[\s\S]*?data-testid="setup-origin"[\s\S]*?placeholder="owner\/name"[^>]*data-testid="setup-origin-repo"[\s\S]*?data-testid="setup-origin-review"/);
  const questions = r.renderFirstRun(setup, { open: 'questions' });
  assert.match(questions, /data-testid="setup-question" data-question="package-manager"[\s\S]*?which package manager runs it\?[\s\S]*?type="radio"[\s\S]*?npm[\s\S]*?pnpm[\s\S]*?data-testid="setup-save-answers"/);
  assert.match(questions, /data-testid="setup-draft-log"[\s\S]*?Finished: 1 question to answer[\s\S]*?running runner\.full on main/);
  const drafting = r.renderFirstRun({ ...setup, autoConfig: { ...autoConfig, questions: [] } }, { open: 'questions', draftConfirming: true });
  assert.match(drafting, /data-testid="setup-draft"[\s\S]*?runs each on a scratch copy of the default branch[\s\S]*?data-testid="setup-draft-confirming"[\s\S]*?Run your project(&#x27;|')s commands to draft it\?[\s\S]*?data-testid="setup-draft-confirm"/);
  const pr = r.renderFirstRun({ ...setup, autoConfig: { ...autoConfig, questions: [], pr: { number: 7, url: 'https://github.com/example-org/example-shop/pull/7' } } }, { open: 'questions' });
  assert.match(pr, /data-testid="setup-pr"[\s\S]*?href="https:\/\/github\.com\/example-org\/example-shop\/pull\/7"[^>]*>PR #7[\s\S]*?data-testid="setup-merge-review"[^>]*>Merge…/);
  assert.doesNotMatch(pr, /setup-draft-button/);
  assert.match(r.renderFirstRun({ ...setup, canAct: false }, { open: 'questions' }), /Only the owners can set this checkout up/);
  assert.match(r.renderFirstRun({ ...setup, configReady: true }), /The config is here: opening the dashboard…/);
  const normal = r.renderFirstRun({ ...f, setup: open, autoConfig, canAct: true }, { open: 'questions' });
  assert.match(normal, /data-testid="first-run-coming"/, 'outside setup mode: what to do today');
  assert.doesNotMatch(normal, /setup-question/);
});

test('the first-run page: Skip on a step not done (owners), skipped shown and Undo; each screen names its command; a done step opened from Settings runs again; Settings lists every screen', () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const owner = { ...f, canAct: true, actions: { 'git-hooks': { id: 'git-hooks', step: 'pre-commit', label: 'Install the git hooks', available: true, changes: ['hooks'], commands: [] } } };
  const html = r.renderFirstRun(owner);
  assert.match(html, /data-step="pre-commit" data-status="todo"[\s\S]*?data-testid="first-run-skip" data-skipped="false"[^>]*>Skip</);
  assert.doesNotMatch(r.renderFirstRun({ ...owner, canAct: false }), /first-run-skip"/, 'writers: no Skip');
  const skipped = { ...owner, setup: { ...owner.setup!, groups: owner.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'pre-commit' ? { ...s, skipped: true } : s)) })) } };
  const sk = r.renderFirstRun(skipped, { open: 'pre-commit' });
  assert.match(sk, /data-step="pre-commit" data-status="skipped"[\s\S]*?>skipped<[\s\S]*?data-testid="first-run-skip" data-skipped="true"[^>]*>Undo skip</);
  assert.doesNotMatch(sk.slice(sk.indexOf('data-step="pre-commit"'), sk.indexOf('</li>', sk.indexOf('data-step="pre-commit"'))), /first-run-fix-panel/, 'a skipped step stays closed');
  const open = r.renderFirstRun(owner, { open: 'pre-commit' });
  assert.match(open, /data-testid="first-run-automation"[^>]*>Without this page: <code[^>]*>worklane install --git-hooks<\/code>/);
  const done = { ...owner, setup: { ...owner.setup!, groups: owner.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'pre-commit' ? { ...s, done: true } : s)) })) } };
  assert.doesNotMatch(r.renderFirstRun(done).match(/data-step="pre-commit"[\s\S]*?<\/li>/)![0], /first-run-fix"/, 'done: no Fix on the checklist');
  assert.match(r.renderFirstRun(done, { open: 'pre-commit', rerun: 'pre-commit' }), /data-step="pre-commit" data-status="done"[\s\S]*?data-testid="first-run-fix" data-fix="action"[^>]*>Run again[\s\S]*?data-testid="first-run-action" data-action="git-hooks"/);
  const settings = r.renderSetupScreens(done.setup!.groups.flatMap((g) => g.steps));
  assert.match(settings, /data-testid="setup-screens"[\s\S]*?Setup screens/);
  assert.match(settings, /data-step="pre-commit"[\s\S]*?>done<[\s\S]*?worklane install --git-hooks[\s\S]*?href="\/first-run\?step=pre-commit"[^>]*>Run again/);
  assert.match(settings, /data-step="service"[\s\S]*?worklane up[\s\S]*?href="\/first-run\?step=service"[^>]*>Open/);
  assert.doesNotMatch(settings, /data-step="docker"/, 'a step done on the vendor\'s own page has no screen here');
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
  const html = r.renderFirstRun(firstRun(file, { root: '/r', repo: 'example-org/example-shop', instance: null }));
  assert.match(html, /data-testid="first-run-question" data-question="full-fails"[\s\S]*?`npm test` fails on the default branch: use it anyway, pick another, or skip\?/);
  assert.deepEqual([...html.matchAll(/data-testid="first-run-choice" data-choice="([^"]+)"/g)].map((m) => m[1]), ['use', '1', 'custom', 'skip'], 'every choice shown');
  assert.match(html, /<code[^>]*>worklane init \/r --answer &lt;id&gt;=&lt;choice&gt;<\/code>/);
  assert.deepEqual([...html.matchAll(/data-testid="first-run-verified-item" data-passed="(true|false)"/g)].map((m) => m[1]), ['true', 'false'], 'only the runs on the current main');
  assert.match(html, /npm test<\/code>[\s\S]*?fails on main \(exit 1\)/);
  assert.doesNotMatch(html, /first-run-auto-config-pr/);
  // Proposed: the PR, no questions.
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'example-org/example-shop', instance: null, steps: {}, handoff: {}, autoConfig: { ...autoConfig, questions: [], pr: { number: 7, url: 'https://github.com/example-org/example-shop/pull/7', branch: 'worklane/setup' } }, updatedAt: at, finishedAt: null }));
  const proposed = r.renderFirstRun(firstRun(file, { root: '/r', repo: 'example-org/example-shop', instance: null }));
  assert.match(proposed, /data-testid="first-run-auto-config-pr"[\s\S]*?href="https:\/\/github\.com\/example-org\/example-shop\/pull\/7"[\s\S]*?PR #7/);
  assert.doesNotMatch(proposed, /first-run-question"/);
  // No auto-config yet (a config folder already there): nothing extra.
  writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', target: '/r', repo: 'o/r', instance: null, steps: {}, handoff: {}, updatedAt: at, finishedAt: null }));
  assert.doesNotMatch(r.renderFirstRun(firstRun(file, { root: '/r', repo: 'o/r', instance: null })), /first-run-auto-config/);
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

test('Add project on an older sudo: no submit, why, and the root command to run instead; the name and repo fields still there to fill it', () => {
  const ownersFile = machineOwnersFile('ada');
  const f = join(mkdtempSync(join(tmpdir(), 'helper-rules-')), 'helper-rules.json');
  writeFileSync(f, JSON.stringify({ sudo: '1.9.9', patterns_min: '1.9.10', left_out: ['add-project', 'stage-update-signer', 'discard-update-signer'] }));
  const html = r.renderAddProject(addProjectView([], { role: 'owner', requester: ownerRequester('ada') }, { ownersFile, helperRulesFile: f }));
  assert.match(html, /data-testid="add-project" data-enabled="no"/);
  assert.doesNotMatch(html, /data-testid="add-project-submit"|data-testid="add-project-disabled"/, 'no button that could only fail, and no bare refusal');
  assert.match(html, /data-testid="add-project-manual"[\s\S]*?this machine(&#x27;|')s sudo \(1\.9\.9\) is older than 1\.9\.10[\s\S]*?data-testid="add-project-manual-command"[^>]*>sudo bash \/opt\/worklane\/current\/scripts\/setup\/add-project\.sh &lt;name&gt; &lt;owner\/repo&gt;</);
  for (const id of ['add-project-name', 'add-project-repo']) assert.doesNotMatch(html.match(new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`))![0], /disabled=""/, `${id} can be filled in`);
  // On 1.9.10 or later, as before.
  const g = join(mkdtempSync(join(tmpdir(), 'helper-rules-')), 'helper-rules.json');
  writeFileSync(g, JSON.stringify({ sudo: '1.9.15', patterns_min: '1.9.10', left_out: [] }));
  const ok = r.renderAddProject(addProjectView([], { role: 'owner', requester: ownerRequester('ada') }, { ownersFile, helperRulesFile: g }), null);
  assert.match(ok, /data-testid="add-project-submit"/);
  assert.doesNotMatch(ok, /data-testid="add-project-manual"/);
});

test("Add project's repo picker: the account's repos to pick from, the ones the App can't work on shown disabled with why; the script it stands for; hidden when adding isn't allowed", () => {
  const ownersFile = machineOwnersFile('ada');
  const data = addProjectView([], { role: 'owner', requester: ownerRequester('ada') }, { ownersFile });
  const picker = {
    owner: 'ada',
    ownerType: 'User',
    accounts: ['ada', 'example-org'],
    repos: [
      { fullName: 'ada/shop', private: false, installable: true, why: null, pushedAt: null },
      { fullName: 'ada/old-site', private: false, installable: false, why: 'archived: read-only, so the agents could never push to it', pushedAt: null },
    ],
    note: 'GitHub lists only public repos here: type a private repo as owner/name.',
    error: null,
  };
  const html = r.renderAddProject(data, picker);
  assert.match(html, /data-testid="add-project-picker" data-owner="ada"/);
  const account = html.match(/<input[^>]*data-testid="add-project-account"[^>]*>/)![0];
  assert.match(account, /value="ada"/, 'the account listed');
  assert.doesNotMatch(account, /disabled=""/, 'and editable: an organization GitHub does not show publicly is typed');
  const accounts = html.match(/<datalist id="add-project-accounts">[\s\S]*?<\/datalist>/)![0];
  assert.deepEqual([...accounts.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ['ada', 'example-org']);
  assert.match(html, /data-testid="add-project-account-list"/);
  const options = [...html.matchAll(/<option value="([^"]*)"( disabled="")? data-testid="add-project-repo-option" data-installable="(yes|no)">([^<]*)</g)].map((m) => [m[1], m[3], !!m[2]]);
  assert.deepEqual(options, [
    ['ada/shop', 'yes', false],
    ['ada/old-site', 'no', true],
  ]);
  assert.match(html, /ada\/old-site \(archived: read-only/);
  assert.match(html, /data-testid="add-project-picker-note"[^>]*>GitHub lists only public repos here/);
  // The script the screen stands for, and where the App's secrets go.
  const script = html.match(/data-testid="add-project-script"[\s\S]*?<\/p>/)![0];
  assert.match(script, /sudo bash scripts\/setup\/add-project\.sh &lt;name&gt; &lt;owner\/repo&gt;/);
  assert.match(script, /0400 files: never shown, logged or sent anywhere/);
  // GitHub's refusal: the message instead of the note; the typed field still there.
  const failed = r.renderAddProject(data, { ...picker, repos: [], error: "GitHub's limit is reached: type owner/name" });
  assert.match(failed, /data-testid="add-project-picker-error"[^>]*>GitHub(&#x27;|')s limit is reached/);
  assert.doesNotMatch(failed, /data-testid="add-project-picker-note"/);
  assert.match(failed, /data-testid="add-project-repo"/);
  // Not yet listed, and not allowed.
  assert.match(r.renderAddProject(data), /data-testid="add-project-picker-loading"/);
  const refused = r.renderAddProject(addProjectView([], { role: 'owner', requester: ownerRequester('ivy') }, { ownersFile }), picker);
  assert.doesNotMatch(refused, /data-testid="add-project-picker/, 'no picker for someone who may not add a project');
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

test('the repeated-feedback panel: each constraint with its count, a link per sighting and revert, its proposal or why not; refused for anyone but the owner and writers', () => {
  const sighting = (n: number) => ({ key: `review:${n}`, source: 'review_changes', by: 'example-owner', at: '2026-10-01T10:00:00Z', ref: `PR #${n}`, url: `https://example.com/acme/app/pull/${n}`, words: 'Never call the payments client from a handler.' });
  const c = {
    enabled: true,
    minSightings: 2,
    maxPerWeek: 3,
    usedThisWeek: 1,
    constraints: [
      { id: 'c-1', label: 'Never call the payments client from a handler.', terms: ['payment'], count: 2, sightings: [sighting(11), sighting(12)], reverts: [{ url: 'https://example.com/acme/app/pull/30', at: 'x', words: 'checks failed' }], status: 'proposed_pr', proposal: { kind: 'pr', number: 40, url: 'https://example.com/acme/app/pull/40' }, detail: '' },
      { id: 'c-2', label: 'Feature flags need an owner field.', terms: [], count: 1, sightings: [sighting(15)], reverts: [], status: 'watching', proposal: null, detail: 'seen 1 time(s); a check is proposed from 2' },
    ],
  };
  const html = r.renderConstraints(c);
  assert.match(html, /data-testid="constraints-panel"[\s\S]*?Repeated feedback[\s\S]*?at 2 sightings it becomes a proposed check \(1 of 3 this week\)/);
  assert.deepEqual([...html.matchAll(/data-testid="constraint" data-status="([a-z_]+)" data-count="(\d+)"/g)].map((m) => [m[1], m[2]]), [['proposed_pr', '2'], ['watching', '1']]);
  assert.match(html, /href="https:\/\/example.com\/acme\/app\/pull\/11"[^>]*>PR #11<\/a>[\s\S]*?href="https:\/\/example.com\/acme\/app\/pull\/12"[^>]*>PR #12<\/a>[\s\S]*?href="https:\/\/example.com\/acme\/app\/pull\/30"[^>]*>revert<\/a>/);
  assert.match(html, /data-testid="constraint-detail"[^>]*><a href="https:\/\/example.com\/acme\/app\/pull\/40"[^>]*>PR #40<\/a>/);
  assert.match(html, /Check proposed[\s\S]*?Seen once/);
  assert.match(r.renderConstraints({ ...c, enabled: false, constraints: [] }), /off for this instance[\s\S]*?data-testid="constraints-empty"/);
  assert.match(r.renderConstraintsPanel(asOther), /data-testid="constraints-refused"[^>]*>Repeated feedback is for the instance(&#x27;|')s owners and writers \(admin or write on its repo\); @someone-else is a viewer\./);
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
  assert.match(html, /data-figure="fixForward"[\s\S]*?data-testid="metrics-not-measured"[^>]*>not measured yet<\/div><div[^>]*>fix-forward hasn(&#x27;|')t taken on a red default branch yet/);
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

test('harness evals: one row per run, newest first, with success, its change from the baseline, cost, wall-clock and interventions per replay', async () => {
  const { harnessEvalView } = await import('../src/harness-evals/score.js');
  let id = 0;
  const ev = (type: string, payload: object, ts: string) => ({ id: ++id, ts, type, actor: 'a', source: 'coordinator', payload }) as never;
  const task = (run: string, ok: boolean) => ev('harness_eval.task', { run, task: 'repo-1', held_out: false, sample: 1, success: ok, done_when: ok, verdict: ok, outcome: ok ? 'queued' : 'blocked', cost_usd: 1, wall_ms: 120_000, interventions: ok ? 0 : 1, detail: '' }, '2026-10-01T00:00:00Z');
  const run = (rid: string, passed: number, cost: number, ts: string, extra: object = {}) => ev('harness_eval.run', { id: rid, trigger: 'change', engine: 'a'.repeat(40), pr: 42, tasks: 1, samples: 2, runs: 2, passed, cost_usd: cost, wall_ms: 240_000, interventions: 2 - passed, budget_usd: 10, stopped: null, ...extra }, ts);
  const view = harnessEvalView([task('r1', true), task('r1', true), run('r1', 2, 2, '2026-10-01T00:00:00Z'), task('r2', true), task('r2', false), run('r2', 1, 3, '2026-10-08T00:00:00Z')]);
  const html = r.renderHarnessEvals({ ...view, enabled: true });
  const rows = [...html.matchAll(/data-testid="harness-eval-run" data-run="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['r2', 'r1'], 'newest first');
  assert.match(html, /data-run="r2"[\s\S]*?data-testid="harness-eval-success"[^>]*>50% \(1\/2\)[\s\S]*?−50 pts[\s\S]*?~\$1\.50[\s\S]*?\+\$0\.50[\s\S]*?2\.0 min[\s\S]*?0\.50/);
  assert.match(html, /data-testid="harness-evals-tasks"[\s\S]*?repo-1: 1\/2/);
  assert.match(r.renderHarnessEvals({ enabled: false, runs: [], latest: [] }), /No runs yet/);
});

test('learnings: each cause with its sightings and stages; Promote only for an owner on a ready cause not promoted yet', () => {
  const g = (count: number, fp: string, promotion: unknown = null) => ({ fingerprint: fp, root: `k-${fp}`, outcome: 'failed', cause: `cause ${fp}`, count, issues: [7, 8], stages: [{ stage: 'environment/harness', count }], first: '2026-10-12T00:00:00Z', last: '2026-10-13T00:00:00Z', ready: count >= 3, line: `- Seen ${count} times (failed): cause ${fp}`, promotion });
  const owner = r.renderLearnings({ minSightings: 3, canPromote: true, groups: [g(3, 'a'), g(1, 'b'), g(4, 'c', { state: 'filed', by: 'example-owner', line: '- x', pr: 'https://github.com/example/repo/pull/9', detail: '' })] });
  assert.match(owner, /data-testid="learnings-count">3</);
  assert.match(owner, /data-fingerprint="a"[\s\S]*?learning-sightings"[^>]*>3<[\s\S]*?cause a[\s\S]*?environment\/harness 3 · issues #7, #8[\s\S]*?value="- Seen 3 times \(failed\): cause a"[\s\S]*?Promote to AGENTS\.md/);
  assert.match(owner, /data-fingerprint="b"[\s\S]*?promotable from 3/);
  assert.equal(owner.match(/data-testid="learning-promote"/g)?.length, 1, 'not for b (seen once) nor c (promoted)');
  assert.match(owner, /Promoted by @example-owner:[\s\S]*?pull\/9[\s\S]*?\(L3, waits for the owner\)/);
  const writer = r.renderLearnings({ minSightings: 3, canPromote: false, groups: [g(3, 'a')] });
  assert.doesNotMatch(writer, /learning-promote/);
  assert.match(r.renderLearnings({ minSightings: 3, canPromote: true, groups: [] }), /No failed runs noted yet/);
});

test('Tailscale and HTTPS: a machine owner sees the state, the four steps with what each changes and its script, and the login link only while up waits; anyone else nothing', () => {
  const ownersFile = machineOwnersFile('ada');
  // Put together here so the repo holds no tailnet name, even a made-up one (the denylist's rule).
  const name = ['box', 'tail0example', 'ts', 'net'].join('.');
  const link = 'https://login.tailscale.com/a/0123456789abcdef';
  const st = (over: Partial<TailscaleStatus> = {}): TailscaleStatus => ({ installed: true, version: '1.104.1', pinnedVersion: '1.104.1', state: 'Running', name, https: true, serve: true, other443: false, breakGlassForwarded: false, funnel: false, hubUrl: 'https://hub.example.test', ...over });
  const none = st({ installed: false, version: null, state: null, name: null, https: false, serve: false });
  const dirOf = (lines: object[], url?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tailscale-render-'));
    if (lines.length) writeFileSync(join(dir, 'steps.jsonl'), lines.map((l) => JSON.stringify({ at: new Date().toISOString(), ...l })).join('\n') + '\n');
    if (url) writeFileSync(join(dir, 'login-url'), `${url}\n`);
    return dir;
  };
  const view = (login: string, status: TailscaleStatus | null, dir = dirOf([])) => tailscaleView({ status, dir, events: [], who: { role: 'owner', requester: ownerRequester(login) }, instance: 'shop', ownersFile });
  const steps = (html: string) => [...html.matchAll(/data-testid="tailscale-step" data-step="([a-z-]+)" data-done="(true|false)" data-next="(true|false)"/g)].map((m) => `${m[1]}:${m[2] === 'true' ? 'done' : m[3] === 'true' ? 'next' : 'later'}`);

  // No tailscale: says so, offers the install, and nothing else can be run yet.
  const fresh = r.renderTailscaleSetup(view('ada', none));
  assert.match(fresh, /data-testid="tailscale-setup" data-next="install"/);
  assert.match(fresh, /Tailscale is not installed on this machine\. It is optional: without it the hub stays where it is\./);
  assert.match(fresh, /Nothing here runs until you confirm a step; leave it alone and the hub keeps its URL\./);
  assert.match(fresh, /data-testid="tailscale-hub-url"[^>]*>The hub&#x27;s URL now: <span[^>]*>https:\/\/hub\.example\.test</);
  assert.deepEqual(steps(fresh), ['install:next', 'up:later', 'serve:later', 'public-url:later']);
  assert.equal([...fresh.matchAll(/<button[^>]*disabled=""[^>]*data-testid="tailscale-step-run"/g)].length, 3, 'only the install can be asked for');
  assert.equal([...fresh.matchAll(/data-testid="tailscale-step-command"/g)].length, 4, 'each step names its script');
  assert.match(fresh, /sudo bash scripts\/setup\/tailscale\.sh install/);
  assert.match(fresh, /data-testid="tailscale-script"/);
  assert.doesNotMatch(fresh, /data-testid="tailscale-login"|data-testid="tailscale-step-confirm"|data-testid="tailscale-run"/);

  // Asked for: what it changes, as root, before a second click.
  const confirming = r.renderTailscaleSetup(view('ada', none), { confirming: 'install' });
  assert.match(confirming, /data-testid="tailscale-step-confirm"[\s\S]*As root, through the machine helper[\s\S]*signing key[\s\S]*version 1\.104\.1 \(pinned\)[\s\S]*no install script[\s\S]*data-testid="tailscale-step-confirm-run"/);

  // up is waiting: the login page is a button, for the owner.
  const waitingLines = [{ step: 'up', state: 'started', detail: '' }, { step: 'up', state: 'running', detail: 'tailscale up (no auth key): it prints a login link and waits' }, { step: 'up', state: 'waiting', detail: 'the login link is in shop\'s dashboard, shown to machine owners only' }];
  const needsLogin = st({ state: 'NeedsLogin', name: null, https: false, serve: false });
  const waiting = r.renderTailscaleSetup(view('ada', needsLogin, dirOf(waitingLines, link)));
  assert.match(waiting, /data-testid="tailscale-run" data-step="up" data-status="waiting"/);
  assert.match(waiting, new RegExp(`<a href="${link.replace(/[/.]/g, '\\$&')}" target="_blank" rel="noreferrer" referrerPolicy="no-referrer"[^>]*data-testid="tailscale-login-link">Open Tailscale&#x27;s login page</a>`));
  assert.equal([...waiting.matchAll(/login\.tailscale\.com/g)].length, 1, 'the link is the button and nothing else');
  assert.equal([...waiting.matchAll(/data-testid="tailscale-step-run"/g)].length, 3, 'the running step has no button');
  assert.doesNotMatch(waiting, /<button(?![^>]*disabled="")[^>]*data-testid="tailscale-step-run"/, 'no second step while one runs');
  // Anyone who isn't a machine owner: nothing at all, the link included.
  assert.equal(r.renderTailscaleSetup(view('ivy', needsLogin, dirOf(waitingLines, link))), '');

  // On the tailnet without HTTPS certificates: serve waits, with Tailscale's own page to turn them on.
  const noCert = r.renderTailscaleSetup(view('ada', st({ https: false, serve: false })));
  assert.deepEqual(steps(noCert), ['install:done', 'up:done', 'serve:next', 'public-url:later']);
  assert.match(noCert, /data-testid="tailscale-step-blocked"[^>]*>Not yet: your tailnet doesn&#x27;t issue an HTTPS certificate/);
  assert.match(noCert, /<a href="https:\/\/login\.tailscale\.com\/admin\/dns"[^>]*data-testid="tailscale-step-link">Open Tailscale&#x27;s DNS settings<\/a>/);

  // Served: the URL step says what the new URL is, what restarts, and the callback to set on GitHub.
  const url = r.renderTailscaleSetup(view('ada', st()), { confirming: 'public-url' });
  assert.deepEqual(steps(url), ['install:done', 'up:done', 'serve:done', 'public-url:next']);
  assert.match(url, new RegExp(`the hub&#x27;s URL becomes https://${name.replace(/\./g, '\\.')} \\(now https://hub\\.example\\.test\\), through dashboards\\.sh`));
  assert.match(url, new RegExp(`callback URL to exactly https://${name.replace(/\./g, '\\.')}/auth/callback`));
  assert.match(url, /dashboards\.sh --client-id/);
  // All done: nothing is next; each step can be run again.
  const done = r.renderTailscaleSetup(view('ada', st({ hubUrl: `https://${name}` })));
  assert.match(done, /data-testid="tailscale-setup" data-next="none"/);
  assert.equal([...done.matchAll(/Run again…/g)].length, 4);
  // Off an allowed device: read-only, and it says why.
  const away = r.renderTailscaleSetup(tailscaleView({ status: none, dir: dirOf([]), events: [], who: { role: 'owner', requester: { login: 'ada', breakGlass: false, deviceOk: false } }, instance: 'shop', ownersFile }));
  assert.match(away, /data-testid="tailscale-disabled"[^>]*>Read-only: a machine change needs one of the console&#x27;s allowed devices/);
  assert.equal([...away.matchAll(/<button[^>]*disabled=""[^>]*data-testid="tailscale-step-run"/g)].length, 4);
  // Funnel: shown read-only. Off: it says nothing here turns it on. Already on: said in red, and neither later step can be asked for.
  assert.match(done, /data-testid="tailscale-funnel" data-funnel="off"[^>]*>Funnel \(the public internet\): off\. Nothing here turns it on/);
  const funnel = r.renderTailscaleSetup(view('ada', st({ funnel: true, serve: false })));
  assert.match(funnel, /data-testid="tailscale-funnel" data-funnel="on"[^>]*>Funnel \(the public internet\): ON\. Nothing here turns it on or off/);
  assert.equal([...funnel.matchAll(/data-testid="tailscale-step-blocked"[^>]*>Not yet: Tailscale Funnel is on for this machine/g)].length, 2);
  assert.match(funnel, /data-step="serve"[\s\S]*?<button[^>]*disabled=""[^>]*data-testid="tailscale-step-run"[\s\S]*?data-step="public-url"[\s\S]*?<button[^>]*disabled=""[^>]*data-testid="tailscale-step-run"/);
  assert.doesNotMatch(fresh, /data-testid="tailscale-funnel"/, 'nothing to say about Funnel before tailscale is installed');
  // The engine has no setup script: it says so and offers no step.
  const old = r.renderTailscaleSetup(view('ada', null));
  assert.match(old, /no Tailscale setup script yet/);
  assert.doesNotMatch(old, /data-testid="tailscale-steps"/);
});

test("the first-run page's Discord step: the token's place and a paste box, the invite link, pickers from the bot's list, the exact diff before Confirm; the script equivalents; no token anywhere", () => {
  const keys = ['discord.enabled', 'discord.guild', 'discord.channels', 'discord.asks_channel', 'discord.ops_channel', 'discord.chat_channels', 'discord.dashboard_url', 'superfan.enabled', 'superfan.channel', 'superfan.machine_channel'];
  const kinds: Record<string, string> = { 'discord.enabled': 'boolean', 'discord.guild': 'guild', 'discord.channels': 'ids', 'discord.chat_channels': 'ids', 'discord.dashboard_url': 'url', 'superfan.enabled': 'boolean' };
  const v = {
    available: true,
    instance: 'shop',
    canAct: true,
    portal: 'https://discord.com/developers/applications',
    token: { configured: false, file: null, present: false, error: null },
    ask: null,
    invite: { integer: '309237648384', permissions: [{ name: 'View Channels', bit: 10, why: 'see the channels' }, { name: 'Send Messages', bit: 11, why: 'reply' }, { name: 'Create Public Threads', bit: 35, why: 'open threads' }, { name: 'Send Messages in Threads', bit: 38, why: 'answer in them' }] },
    intake: { file: '/home/example/.local/state/worklane/instances/shop/intake.yaml', exists: false, error: null, values: { 'discord.enabled': false, 'discord.guild': null, 'discord.channels': [], 'discord.asks_channel': null, 'discord.ops_channel': null, 'discord.chat_channels': [], 'discord.dashboard_url': null, 'superfan.enabled': false, 'superfan.channel': null, 'superfan.machine_channel': null }, warnings: [] },
    form: keys.map((key) => ({ key, kind: kinds[key] ?? 'id', what: `what ${key} is` })),
    automation: { token: 'sudo bash /opt/worklane/current/scripts/setup/credentials.sh shop intake-discord', channels: 'sudo -H -u wl-shop worklane discord channels --instance shop', file: '/home/example/.local/state/worklane/instances/shop/intake.yaml', keys, restart: 'sudo systemctl restart worklane-shop.service' },
  };
  // Nothing stored yet: the portal link, Paste the token, the permissions, and no picker before the bot's list is loaded.
  const fresh = r.renderDiscordSetup(v);
  assert.match(fresh, /data-testid="discord-setup" data-instance="shop"[\s\S]*?Nothing here changes until you confirm it/);
  assert.match(fresh, /href="https:\/\/discord\.com\/developers\/applications"[^>]*data-testid="discord-portal-link"/);
  assert.match(fresh, /data-testid="discord-token-state" data-stored="false"[\s\S]*?not stored[\s\S]*?names no bot token yet/);
  assert.match(fresh, /data-testid="discord-token-button"[^>]*>Paste the token…/);
  assert.match(fresh, /data-testid="discord-invite-integer">309237648384</);
  assert.equal((fresh.match(/<li><span[^>]*>(View Channels|Send Messages|Create Public Threads|Send Messages in Threads)<\/span>/g) ?? []).length, 4);
  assert.match(fresh, /data-testid="discord-invite-waiting"[^>]*>[^<]*store the token first/);
  assert.doesNotMatch(fresh, /discord-load"|discord-form|discord-invite-link|discord-confirm"/, 'no listing without a token, no form without the list');
  // The script equivalents, named on the screen.
  assert.match(fresh, /data-testid="discord-automation"[\s\S]*?credentials\.sh shop intake-discord\nsudo -H -u wl-shop worklane discord channels --instance shop\n# intake\.yaml: discord\.enabled, discord\.guild,[\s\S]*?superfan\.machine_channel\nsudo systemctl restart worklane-shop\.service/);
  // Paste the token asks first; the paste box is the setup console's own, a password field never prefilled.
  assert.match(r.renderDiscordSetup(v, { tokenConfirming: true }), /data-testid="discord-token-confirming"[\s\S]*?records an ask[\s\S]*?data-testid="discord-token-confirm"[\s\S]*?data-testid="discord-token-cancel"/);
  const ask = { id: 'ask-0000000000aa', instance: 'shop', title: 'Paste the Discord bot token', detail: 'From the portal.', createdAt: '2026-10-13T10:00:00Z', createdBy: 'olive', status: 'open', answer: null, cancelled: null, canAnswer: true, kind: 'paste_secret', credential: 'intake-discord', where: 'credentials.yaml intake.discord_token' };
  const asking = r.renderDiscordSetup({ ...v, ask });
  const box = asking.match(/<input[^>]*data-testid="ask-secret"[^>]*>/)?.[0] ?? '';
  assert.match(box, /type="password"/);
  assert.doesNotMatch(box, /value=/);
  assert.doesNotMatch(asking, /discord-token-button/);
  // Stored, the bot's view loaded: the invite link, the intent, and pickers offering only the bot's own channels.
  const stored = { ...v, token: { configured: true, file: '/home/example/.config/shop-secrets/intake-discord', present: true, error: null } };
  assert.match(r.renderDiscordSetup(stored), /data-stored="true"[\s\S]*?stored[\s\S]*?shop-secrets\/intake-discord[\s\S]*?data-testid="discord-token-button"[^>]*>Replace the token…[\s\S]*?data-testid="discord-load"[^>]*>Load the bot(&#x27;|')s view/);
  const bot = {
    application: { id: '700000000000000001', name: 'Example Bot', message_content: false },
    invite: 'https://discord.com/oauth2/authorize?client_id=700000000000000001&scope=bot&permissions=309237648384',
    channels: [
      { guild_id: '900000000000000001', guild: 'Alpha Server', id: '100000000000000011', name: 'general', type: 0 },
      { guild_id: '900000000000000001', guild: 'Alpha Server', id: '100000000000000017', name: 'superfan-shop', type: 0 },
      { guild_id: '900000000000000002', guild: 'Zeta Server', id: '100000000000000021', name: 'ideas', type: 0 },
    ],
    at: new Date().toISOString(),
  };
  const values = { ...v.intake.values, 'discord.guild': '900000000000000001', 'discord.channels': ['100000000000000011'] };
  const loaded = r.renderDiscordSetup(stored, { bot, values });
  assert.match(loaded, /href="https:\/\/discord\.com\/oauth2\/authorize\?client_id=700000000000000001&amp;scope=bot&amp;permissions=309237648384"[^>]*data-testid="discord-invite-link"[^>]*>Open Discord(&#x27;|')s invite page for Example Bot/);
  assert.match(loaded, /data-testid="discord-intent" data-on="false"[\s\S]*?off\. Turn it on/);
  assert.match(loaded, /data-testid="discord-loaded"[^>]*>3 channels the bot can see/);
  assert.deepEqual([...loaded.matchAll(/data-testid="discord-field" data-key="([a-z_.]+)"/g)].map((m) => m[1]), keys);
  const fieldOf = (key: string) => {
    const from = loaded.indexOf(`data-key="${key}"`);
    const next = loaded.indexOf('data-testid="discord-field"', from);
    return loaded.slice(from, next < 0 ? undefined : next);
  };
  // The channels the bot reads are offered from the chosen server only; a post-only one from any server, named with it.
  assert.match(fieldOf('discord.channels'), /#general[\s\S]*#superfan-shop/);
  assert.doesNotMatch(fieldOf('discord.channels'), /ideas/);
  assert.match(fieldOf('discord.channels'), /<input type="checkbox"[^>]*checked=""[^>]*\/>#general/);
  assert.match(fieldOf('superfan.channel'), /<option value="100000000000000021">Zeta Server \/ #ideas<\/option>/);
  assert.match(fieldOf('discord.guild'), /<option value="900000000000000001" selected="">Alpha Server<\/option>/);
  assert.match(loaded, /data-testid="discord-review"[^>]*>Review the change/);
  assert.doesNotMatch(loaded, /discord-confirm"/, 'no Confirm before the diff is shown');
  // Reviewed: the exact diff and the warning, then Confirm and write, or Cancel.
  const plan = { ok: true, confirmed: false, file: v.intake.file, creates: true, changes: [], hash: 'h', warnings: ['discord is on but discord.allowed_senders is empty: no Discord message will be accepted'], diff: '--- (no intake.yaml yet)\n+++ intake.yaml\n+version: 1\n+discord:\n+  guild: "900000000000000001"' };
  const reviewed = r.renderDiscordSetup(stored, { bot, values, plan });
  assert.match(reviewed, /data-testid="discord-plan"[\s\S]*?This creates [^<]*intake\.yaml \(0600\):[\s\S]*?data-testid="discord-diff">--- \(no intake\.yaml yet\)\n\+\+\+ intake\.yaml\n\+version: 1\n\+discord:\n\+  guild: &quot;900000000000000001&quot;<\/pre>[\s\S]*?data-testid="discord-warning"[^>]*>discord is on but[\s\S]*?Write exactly this change\?[\s\S]*?data-testid="discord-confirm"[^>]*>Confirm and write<[\s\S]*?data-testid="discord-cancel"/);
  assert.doesNotMatch(reviewed, /data-testid="discord-review"/);
  // A failed listing says why; a writer reads where it stands and gets no button.
  assert.match(r.renderDiscordSetup(stored, { botError: 'Discord refused the bot token (401 on GET /applications/@me)' }), /data-testid="discord-load-error"[^>]*>Discord refused the bot token/);
  const writer = r.renderDiscordSetup({ ...stored, canAct: false }, { bot, values });
  assert.match(writer, /data-testid="discord-setup-refused"/);
  assert.doesNotMatch(writer, /discord-token-button|discord-load"|discord-review|discord-confirm"/);
  // A checkout: why there is no step. And on the first-run page, the step opens it, on a done step too.
  assert.match(r.renderDiscordSetup({ available: false, why: "Discord intake is a server instance's" }), /data-testid="discord-setup-unavailable"[^>]*>Discord intake is a server instance(&#x27;|')s\./);
  const file = join(mkdtempSync(join(tmpdir(), 'web-render-discord-')), 'init.json');
  const f = firstRun(file, { root: '/r', repo: 'example-org/example-shop', instance: 'shop', start: { kind: 'unsupported', why: 'a stand-in' } });
  const step = f.setup!.groups.flatMap((g) => g.steps).find((s) => s.id === 'discord')!;
  assert.deepEqual(step.fix, { kind: 'discord', label: 'Set up' });
  assert.match(r.renderFirstRun(f), /data-step="discord" data-status="todo"[\s\S]*?data-testid="first-run-fix" data-fix="discord"[^>]*>Set up</);
  assert.match(r.renderFirstRun(f, { open: 'discord', discord: stored }), /data-step="discord"[\s\S]*?data-testid="first-run-fix-panel"[\s\S]*?data-testid="discord-setup"/);
  const done = { ...f, setup: { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'discord' ? { ...s, done: true } : s)) })) } };
  assert.match(r.renderFirstRun(done, { open: 'discord', discord: stored }), /data-step="discord" data-status="done"[\s\S]*?data-fix="discord"[^>]*>Change<[\s\S]*?data-testid="discord-setup"/);
});
