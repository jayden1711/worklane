// Render checks for the web UI: every page, rendered on the server from the
// state a real dashboard serves for the seeded demo project, still shows its
// data; decisions are still answerable only where the server says so.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { asDevicePerson, asPerson, exampleProject, exampleRoles, ownerRequester, machineOwnersFile, marksOf, MARKS, repoRoot, seedInstanceItems, type InstanceMarks } from './helpers.js';
import { addProjectView } from '../src/console/add-project.js';
import { addProjectNameOk, addProjectRepoOk } from '../src/machine.js';
import { asks } from '../src/console/asks.js';
import { claudeAccountView } from '../src/claude-account.js';
import { CLAUDE_CREDENTIAL_NAMES, REMOVED_CREDENTIAL_PATHS } from '../src/claude-credential-guard.js';
import { resetWords } from '../src/usage-limit.js';
import { tailscaleView, type TailscaleStatus } from '../src/tailscale-setup.js';
import { raiseIncident, resolveIncident } from '../src/watchdog/incidents.js';
import { METRICS_DEFINITIONS, trustForViewer, trustView } from '../src/trust.js';
import { deliveryMetrics } from '../src/merge-metrics.js';
import { FIRST_TASK_FILED, firstTaskProgress } from '../src/first-task-progress.js';
import type { StoredEvent } from '../src/events/types.js';
import { VIEWER_EVENTS } from '../src/viewer-events.js';
import { firstRunView } from '../src/init.js';
import { checkSetup } from '../src/setup-steps.js';
import type { StarterCiView } from '../src/starter-ci.js';
import { ACCOUNT, ACCOUNT_TEXT, accountDashboard } from './account-fixture.js';
import { shownPath, shownPaths } from '../src/path-text.js';

type State = { tasks: { issue: number; title: string; status: string }[]; decisions: { id: string; question: string; options: string[]; answer: unknown; canAnswer?: boolean }[]; activity: { summary: string }[]; emergency: unknown };
interface Render {
  renderPage(name: string, state: State): string;
  renderIssue(state: State, issue: number): string;
  renderGoalGraph(graph: unknown): string;
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
  renderDelegation(d: unknown): string;
  renderWaiting(w: unknown, now?: number): string;
  renderWaitingPage(state: unknown): string;
  renderRepoConfigForm(c: unknown, o?: { proposed?: string; seen?: string[]; seenNote?: string; seenLoaded?: boolean; starter?: StarterCiView; starterOpen?: boolean }): string;
  checksSeenSlot(answer: { checks: string[]; sha?: string; error?: string }, starterBelow: boolean): { seen: string[]; note: string | null };
  renderStarterCi(v: StarterCiView, inForm?: boolean): string;
  renderCiNote(ci: { kind: 'github' | 'none'; means: string | null } | undefined): string;
  renderConfigPrs(prs: unknown[], o?: { canAct?: boolean; plan?: { command: string; then: string } }): string;
  renderDraftPreview(held: unknown, o?: { canEdit?: boolean; changing?: boolean }): string;
  renderFirstRun(f: unknown, o?: { open?: string; confirming?: boolean; actionConfirming?: boolean; policyChanges?: unknown[]; configChanges?: unknown[]; rerun?: string; draftConfirming?: boolean; signin?: unknown; discord?: unknown; ghLogin?: unknown }): string;
  renderClaudeSignin(v: unknown, o?: { confirming?: boolean }): string;
  renderDiscordSetup(v: unknown, o?: { bot?: unknown; botError?: string; tokenConfirming?: boolean; plan?: unknown; values?: Record<string, unknown> }): string;
  renderFirstRunPage(state: unknown): string;
  renderSourceSetup(v: unknown, o?: { view?: unknown; started?: boolean; confirming?: string; plan?: unknown; values?: Record<string, unknown> }): string;
  renderIntakeSources(sources: unknown[], canSetUp: boolean): string;
  renderSetupScreens(steps: unknown[]): string;
  renderFirstTask(info: unknown, o?: { canEdit?: boolean; preview?: { title: string; body: string } }): string;
  renderIgnored(data: unknown): string;
  renderUpdaterSetup(data: unknown, review?: unknown): string;
  renderSetup(data: unknown): string;
  CLAUDE_CREDENTIAL_NAMES?: readonly string[];
  isClaudeCredential?(name: string): boolean;
  renderAddProject(data: unknown, picker?: unknown): string;
  renderClaudeAccount(data: unknown, now?: number, scope?: { current: string | null; all: boolean; instances: (string | null)[] } | null): string;
  renderClaudeAccountSet(state: unknown): string;
  renderTailscaleSetup(data: unknown, o?: { confirming?: string }): string;
  tailscaleBusy(d: unknown, now?: number): boolean;
  tailscaleStepEnded(prev: unknown, next: unknown): boolean;
  accountBusy(d: unknown, now?: number): boolean;
  addProjectInvalid(name: string, repo: string): string | null;
  renderRunsRefused(message: string): string;
  runsRefused(message: string): string | null;
  runsRefusal(state: unknown): string | null;
  renderRunResearch(data: unknown): string;
  renderStopBanner(state: State): string;
  renderUsageBanner(usage: unknown[], now: number): string;
  renderRunWhy(detail?: string): string;
  renderUsageLines(usage: unknown[], now: number): string;
  renderOverviewWithUsage(state: State, usage: unknown[], now: number): string;
  countdown(resetAt: string, now: number): string;
  renderProtection(protection: unknown, brand: string): string;
  renderDeployGate(gate: unknown): string;
  renderMainWatchAlert(protection: unknown): string;
  ackVisibleChars(text: string): number;
  isResumeRequest(answer: unknown): boolean;
  renderPrs(view: unknown): string;
  renderDecisionDetail(d: unknown, prBody?: unknown, diff?: unknown): string;
  renderDecisionCard(d: unknown, sending?: string, evidence?: unknown): string;
  renderRunSteps(run: unknown): string;
  renderResearchLog(rows: unknown[]): string;
  shownPath(path: string): string;
  shownPaths(paths: readonly string[]): string;
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
  renderInstances(hub: unknown, current: string, all?: boolean, status?: Record<string, string>, why?: Record<string, string>): string;
  statusOf(all: unknown[]): Record<string, string>;
  whyOf(all: unknown[]): Record<string, string>;
  nextHub(prev: unknown, fresh: unknown): unknown;
  healthPass(refresh: () => Promise<unknown>, load?: (h: unknown) => Promise<unknown[]>): Promise<{ hub: unknown; status: Record<string, string>; why: Record<string, string> }>;
  renderCoordinatorErrors(errors: unknown[] | undefined, earlier?: unknown[], count?: number, now?: number): string;
  renderHealthPage(all: unknown[], target?: string): string;
  loadIncidents(hub: unknown, get: (name: string | null, path: string) => Promise<unknown>): Promise<unknown[]>;
  scopeOf(hub: unknown, saved: string | null, all: boolean): { current: string | null; all: boolean; instances: (string | null)[] };
  loadBoards(scope: unknown, get: (instance: string | null, path: string) => Promise<unknown>): Promise<{ name: string | null; data: unknown; error: string | null }[]>;
  onInstance(instance: string | null, path: string, init: unknown, scope: Promise<unknown>): Promise<unknown>;
  renderMachineSlots(slots: unknown): string;
  elapsed(since: string, now?: number): string;
  renderSignIn(local?: boolean): string;
  renderKeyPage(help?: { file: string; copy: string | null } | null): string;
  renderKeyForm(error?: string | null): string;
  needsKey(hubPage: boolean, key: string): boolean;
  tryKey(given: string, o: { hub: boolean; get?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>; store?: { setItem(k: string, v: string): void } }): Promise<boolean>;
  renderWhoAmI(state: { user: string; role?: string; via?: string }, o?: { hubPage?: boolean }): string;
  renderNavDrawer(state: State, o?: { open?: boolean; hub?: unknown; status?: Record<string, string> }): string;
  renderSidebar(state: State, o: { hub: unknown; scope: { current: string | null; all: boolean; instances: (string | null)[] } }): string;
  renderSetupModeHidden(path: string): string;
  renderAt(path: string, state: State, title?: string): string;
  navCounts(state: unknown): Record<string, number | undefined>;
  renderNeedsYou(state: State, waiting: unknown, now?: number, error?: string | null): string;
  NEEDS_YOU_ORDER: string;
  nextStep(f: unknown): { id: string } | null;
  renderHeader(title: string): string;
  navRows: { to: string; label: string; testId: string }[];
  navFor(state: unknown): { to: string; testId: string }[];
  redirectFor(path: string): string | null;
  landOn(loc: { pathname: string; search: string; hash: string }, history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void }): string;
  EXTEND_TABS: readonly { id: string; to: string }[];
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
/** The render entry's bundle (file URL), for a test that loads it again as a browser would. */
let bundle: string;
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
  bundle = pathToFileURL(join(out, 'render-check.mjs')).href;
  r = (await import(bundle)) as Render;

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
    // Every option recommendation is named in its line (#586: in words, not a pill); no other card has that line.
    for (const d of open) {
      const card = cardOf(html, d.id);
      if (d.options.includes(d.recommendation)) assert.match(card, new RegExp(`data-testid="decision-recommended"[^>]*>Recommended: <strong[^>]*>${esc(d.recommendation).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`), `${page}: ${d.id}'s option is named`);
      else assert.doesNotMatch(card, /data-testid="decision-recommended"/, `${page}: ${d.id} recommends no option: no option named`);
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
  // #467: on this machine, the key's file whole and the command that copies it; nothing when the server gives none.
  assert.doesNotMatch(page, /data-testid="key-help"/);
  const file = '/Users/example/Library/Application Support/example/projects/abc/dashboard-token';
  const helped = r.renderKeyPage({ file, copy: `pbcopy < '${file}'` });
  assert.match(helped, /data-testid="key-help-file"[^>]*>\/Users\/example\/Library\/Application Support\/example\/projects\/abc\/dashboard-token</);
  assert.match(helped, /data-testid="key-help-command"[^>]*>pbcopy &lt; (&#x27;|')\/Users\/example\/Library\/Application Support/);
  assert.match(helped, /data-testid="key-help-copy"[^>]*>Copy command</);
  assert.doesNotMatch(r.renderKeyPage({ file, copy: null }), /key-help-command|key-help-copy/, 'no clipboard tool: the path alone');
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
  // #468: "break-glass" only on the hub's break-glass port; a checkout's own dashboard reached with its key is the owner on this machine.
  const glass = r.renderWhoAmI({ user: 'example-owner', role: 'owner', via: 'break-glass' }, { hubPage: true });
  assert.match(glass, /owner \(break-glass\)/);
  assert.doesNotMatch(glass, /sign-out/, 'the break-glass has no session to end');
  const local = r.renderWhoAmI({ user: 'example-owner', role: 'owner', via: 'break-glass' }, { hubPage: false });
  assert.match(local, /data-testid="who-role"> · owner \(this machine\)</);
  assert.doesNotMatch(local, /break-glass/, 'no alarm word on a local dashboard');
  assert.doesNotMatch(local, /sign-out/);

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
  const drawerOf = (o?: Parameters<Render['renderNavDrawer']>[1]) => r.renderNavDrawer({ ...asOwner, experiments: true } as never, o);
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
  assert.equal(r.navRows.length, 9, 'the sidebar groups were read (#585)');
  for (const n of r.navRows) assert.match(drawer, new RegExp(`<a href="${n.to.replace(/[/]/g, '\\/')}"[^>]*data-testid="${n.testId}"`), `the drawer links to ${n.label}`);
  assert.match(drawer, /data-testid="search-button"/);
  assert.match(drawer, /data-testid="theme-toggle"/);
  assert.match(drawer, /data-testid="live-indicator"/);
  // Off a hub: this instance's status dot, linking to Health.
  assert.match(amber.slice(amber.indexOf('id="nav-drawer"')), /<a href="\/machine\/health"[^>]*>.*?data-status="amber" data-testid="instance-status-dot"/);
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
  const proxied = r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: 'proxy.internal:3128', file: '/etc/x/network.json', ca: null, error: null } });
  assert.match(proxied, /data-testid="health-network"[^>]*>Outbound proxy: <code[^>]*>proxy\.internal:3128<\/code> \(from <code[^>]*>\/etc\/x\/network\.json<\/code>\)/);
  assert.doesNotMatch(proxied, /<(?:input|button|form)[^>]*network/i, 'nothing on the page changes it');
  assert.match(r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: null, file: '/etc/x/network.json', ca: null, error: '/etc/x/network.json: proxy must not carry a user or password; no outbound proxy or custom CA is set' } }), /role="alert"[^>]*data-testid="health-network-refused"[\s\S]*?Outbound proxy and custom CA refused:[\s\S]*?must not carry a user or password/);
  assert.doesNotMatch(r.renderHealth({ ...base, offsiteBackup: null, network: null }), /health-network/);
  assert.doesNotMatch(proxied, /health-network-ca/, 'no CA line without a CA');
  // The custom CA (root's ca_file): its path, how many certificates, each one's short SHA-256 fingerprint.
  const ca = r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: null, file: '/etc/x/network.json', ca: { path: '/etc/x/ca/corp.pem', count: 2, fingerprints: ['0123456789abcdef', 'fedcba9876543210'] }, error: null } });
  assert.match(ca, /data-testid="health-network-ca"[^>]*>Custom CA: <code[^>]*>\/etc\/x\/ca\/corp\.pem<\/code>, 2 certificates, fingerprints <code[^>]*>sha256:0123456789abcdef, sha256:fedcba9876543210<\/code> \(from <code[^>]*>\/etc\/x\/network\.json<\/code>\)/);
  assert.doesNotMatch(ca, /data-testid="health-network"[^-]/, 'no proxy line without a proxy');
  assert.match(r.renderHealth({ ...base, offsiteBackup: null, network: { proxy: null, file: '/etc/x/network.json', ca: { path: '/etc/x/ca.pem', count: 1, fingerprints: ['0123456789abcdef'] }, error: null } }), /1 certificate, fingerprint <code/);
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

test("#392: the provider hosts on the health panel, read-only: root's hosts and their file, or that provider runs are off; a refused file and each provider outside the set in red", () => {
  const base = { instance: 'shop@box', machine: null, cores: 4, checks: { timings: [], slowest: [], regressions: [], rule: '' }, usage: { days: [], quotaNote: '' }, offsiteBackup: null, suggestions: ['Nothing to suggest.'] };
  const file = '/etc/x/providers.json';
  const allowed = r.renderHealth({ ...base, providerHosts: { file, state: 'ok', hosts: ['api.provider.test', '127.0.0.1:8080'], error: null, refused: [] } });
  assert.match(allowed, /data-testid="health-provider-hosts">Provider hosts: <code[^>]*>api\.provider\.test, 127\.0\.0\.1:8080<\/code> \(from <code[^>]*>\/etc\/x\/providers\.json<\/code>\)/);
  assert.doesNotMatch(allowed, /health-provider-refused/, 'no provider refused: no list');
  assert.doesNotMatch(allowed, /<(?:input|button|form|select|textarea)\b/i, 'nothing on the page changes it');
  // A configured provider outside the set: named, with why, in red.
  const outside = r.renderHealth({ ...base, providerHosts: { file, state: 'ok', hosts: ['127.0.0.1:8080'], error: null, refused: [{ provider: 'hosted:glm', reason: 'open.example.com is not an allowed provider host (127.0.0.1:8080, from /etc/x/providers.json)' }] } });
  assert.match(outside, /data-testid="health-provider-refused"[\s\S]*?<span class="[^"]*text-red[^"]*">Provider <code[^>]*>hosted:glm<\/code> refused:<\/span> <span[^>]*>open\.example\.com is not an allowed provider host \(127\.0\.0\.1:8080, from \/etc\/x\/providers\.json\)<\/span>; its runs take the role(&#x27;|')s normal model/);
  // An empty list: provider runs are off.
  assert.match(r.renderHealth({ ...base, providerHosts: { file, state: 'ok', hosts: [], error: null, refused: [] } }), /data-testid="health-provider-hosts">Provider hosts: none, so provider runs are off \(from <code/);
  // No file: said plainly, with each configured provider it turns off.
  const missing = r.renderHealth({ ...base, providerHosts: { file, state: 'missing', hosts: [], error: null, refused: [{ provider: 'local', reason: 'no provider host is allowed on this machine' }] } });
  assert.match(missing, /data-testid="health-provider-hosts-none">No provider hosts: <code[^>]*>\/etc\/x\/providers\.json<\/code> doesn(&#x27;|')t exist, so provider runs are off/);
  assert.match(missing, /data-testid="health-provider-refused"[\s\S]*?<code[^>]*>local<\/code> refused:[\s\S]*?no provider host is allowed on this machine/);
  // A refused file: the refusal in red.
  const refused = r.renderHealth({ ...base, providerHosts: { file, state: 'refused', hosts: [], error: "/etc/x/providers.json: isn't root's; no provider host is allowed", refused: [] } });
  assert.match(refused, /role="alert"[^>]*data-testid="health-provider-hosts-refused"[\s\S]*?text-red[^>]*>Provider hosts refused:<\/span> <span[^>]*>\/etc\/x\/providers\.json: isn(&#x27;|')t root(&#x27;|')s; no provider host is allowed<\/span>\. Provider runs are off\./);
  assert.doesNotMatch(refused, /data-testid="health-provider-hosts"/, 'no list of hosts beside a refused file');
  // Nothing to show (no file and no provider), or a viewer (the server sends null): no line at all.
  assert.doesNotMatch(r.renderHealth({ ...base, providerHosts: null }), /health-provider/);
  assert.doesNotMatch(r.renderHealth(base), /health-provider/);
});

test('#198: the GitHub API budget on the health panel, read-only: per credential what is left and when it resets, the back-off in red, the top consumers', () => {
  const base = { instance: 'shop@box', machine: null, cores: 4, checks: { timings: [], slowest: [], regressions: [], rule: '' }, usage: { days: [], quotaNote: '' }, offsiteBackup: null, suggestions: ['Nothing to suggest.'] };
  const reset = new Date(Date.now() + 30 * 60_000).toISOString();
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  const githubRate = {
    credentials: [
      { id: 'credential 1', resources: [{ resource: 'core', limit: 5000, remaining: 12, resetAt: reset }], backoff: { kind: 'secondary_rate_limited', until }, top: [{ consumer: 'backlog', calls: 40 }], calls: 40, updatedAt: new Date().toISOString() },
      { id: 'credential 2', resources: [{ resource: 'core', limit: 5000, remaining: 4321, resetAt: reset }, { resource: 'graphql', limit: null, remaining: null, resetAt: null }], backoff: null, top: [{ consumer: 'pr-watch', calls: 120 }, { consumer: 'backlog', calls: 7 }], calls: 127, updatedAt: new Date().toISOString() },
    ],
    notShown: 1,
  };
  const html = r.renderHealth({ ...base, githubRate });
  assert.match(html, /data-testid="health-github-budget"/);
  const rows = html.match(/data-testid="health-github-budget-row"[\s\S]*?<\/tr>/g) ?? [];
  assert.equal(rows.length, 2, 'one row per credential');
  assert.match(rows[0]!, /credential 1/);
  assert.match(rows[0]!, /core 12 of 5,000 left/);
  assert.match(rows[0]!, new RegExp(`core ${reset.slice(11, 16)} UTC \\(in (29|30) min\\)`));
  assert.match(rows[0]!, /data-testid="health-github-budget-backoff"[^>]*>[\s\S]*?text-red[\s\S]*?secondary limit: paused until [0-9:]+ UTC/);
  assert.match(rows[0]!, /backlog 40/);
  assert.match(rows[1]!, /core 4,321 of 5,000 left/);
  assert.match(rows[1]!, /graphql not known yet/);
  assert.match(rows[1]!, /data-testid="health-github-budget-backoff"[^>]*>none</);
  assert.match(rows[1]!, /pr-watch 120 · backlog 7/);
  assert.match(html, /data-testid="health-github-budget-not-shown"[^>]*>1 more budget file/);
  const from = html.slice(html.indexOf('data-testid="health-github-budget"'));
  assert.doesNotMatch(from.slice(0, from.indexOf('</section>')), /<(?:input|button|form|select|textarea)\b/i, 'nothing in it changes the budget');
  // A viewer (the server sends null), or no budget yet: no section at all.
  assert.doesNotMatch(r.renderHealth({ ...base, githubRate: null }), /health-github-budget/);
  assert.doesNotMatch(r.renderHealth(base), /health-github-budget/);
  // On a hub, the machine's budget from any instance's view.
  const hub = r.renderHealth({ ...base, githubRate: null }, [{ name: 'shop', view: { ...base, githubRate }, error: null }]);
  assert.match(hub, /data-testid="health-github-budget"/);
});

test('#198 round 1: the GitHub budget section renders whatever numbers arrive (null, NaN, a bad time) and says when the budgets could not be read', () => {
  const base = { instance: 'shop@box', machine: null, cores: 4, checks: { timings: [], slowest: [], regressions: [], rule: '' }, usage: { days: [], quotaNote: '' }, offsiteBackup: null, suggestions: ['Nothing to suggest.'] };
  // What a planted 1e308 count looked like after JSON before the fix (Infinity → null), and other non-numbers.
  const bad = { credentials: [{ id: 'credential 1', resources: [{ resource: 'core', limit: null, remaining: Number.NaN, resetAt: 'not a time' }, { resource: 'graphql', limit: 5000, remaining: null, resetAt: null }], backoff: { kind: 'secondary_rate_limited', until: 'not a time' }, top: [{ consumer: 'backlog', calls: null }], calls: null, updatedAt: null }], notShown: 0, error: null };
  let html = '';
  assert.doesNotThrow(() => (html = r.renderHealth({ ...base, githubRate: bad })));
  const row = html.match(/data-testid="health-github-budget-row"[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(row, /core – left/);
  assert.match(row, /core –</);
  assert.match(row, /paused until –/);
  assert.match(row, /backlog –/);
  // A fault while reading: said, with no table.
  const failed = r.renderHealth({ ...base, githubRate: { credentials: [], notShown: 0, error: "the budget files couldn't be read (RangeError)" } });
  assert.match(failed, /data-testid="health-github-budget-error"[^>]*>GitHub API budget not shown: the budget files couldn(&#x27;|')t be read \(RangeError\)/);
  assert.doesNotMatch(failed, /health-github-budget-row/);
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
  // The last pass that found nothing newer (#465): when, on which channel, the version; no row without one.
  assert.doesNotMatch(html, /data-testid="updates-last-check"/);
  const checked = r.renderUpdatesPanel({ ...data, lastCheck: { at, channel: 'release', sha: 'a'.repeat(40), version: '0.5.0', newest: 'v0.5.0' } });
  assert.match(checked, /data-testid="updates-last-check"[\s\S]*?3h ago[\s\S]*?on (<!-- -->)?release(<!-- -->)?: up to date \((<!-- -->)?v0\.5\.0/);
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
  // Draining for an update (src/update-drain.ts): since when, and what is still finishing; no row when it isn't.
  assert.doesNotMatch(html, /data-testid="updates-drain"/);
  const drain = r.renderUpdatesPanel({ ...data, drain: { since: '2026-10-14T03:00:00.000Z', until: '2026-10-14T03:30:00.000Z', to: 'c'.repeat(40), testRuns: 2, agents: 1 } });
  assert.match(drain, /data-testid="updates-drain"[\s\S]*?draining for update[\s\S]*?since (<!-- -->)?2026-10-14 03:00 UTC(<!-- -->)?, (<!-- -->)?2 runs and 1 agent finishing[\s\S]*?No new test run or agent starts until[\s\S]*?cccccccccccc[\s\S]*?nothing running is stopped/);
  assert.match(r.renderUpdatesPanel({ ...data, drain: { since: '2026-10-14T03:00:00.000Z', until: '2026-10-14T03:30:00.000Z', to: null, testRuns: 0, agents: 0 } }), /nothing left running/);
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
  // Issue #463: a Claude login the API refused: a red banner naming the login and Claude's words, with the owner's
  // re-check; none while every login works.
  const refused = { ...running, signinFailed: [{ login: 'agents@example.com', detail: "claude's login was refused (HTTP 401): Invalid API key", since: '2026-10-13T09:00:00Z', lastCheck: { at: '2026-10-13T09:50:00Z', ok: false, detail: 'still 401' } }], canRecheckSignin: true };
  const signin = r.renderUsageBanner([refused], now);
  assert.equal((signin.match(/data-testid="signin-banner"/g) ?? []).length, 1);
  assert.match(signin, /Claude sign-in failed: no new runs/);
  assert.match(signin, /agents@example\.com/);
  assert.match(signin, /Claude said: claude&#x27;s login was refused \(HTTP 401\): Invalid API key/);
  assert.match(signin, /data-testid="signin-recheck"/);
  assert.match(signin, /Last checked .*still 401/);
  assert.doesNotMatch(r.renderUsageBanner([{ ...refused, canRecheckSignin: false }], now), /signin-recheck/, 'only the owner re-checks');
  assert.equal(r.renderUsageBanner([{ ...running, signinFailed: [] }], now), '');
  assert.match(r.renderUsageLines([refused], now), /data-testid="usage-line-status"[^>]*>Claude sign-in failed: no new runs</);
  // A failed run's why, on its run detail.
  assert.match(r.renderRunWhy('error_during_execution: sandbox required but unavailable'), /data-testid="run-detail-why"[\s\S]*Why it ended[\s\S]*sandbox required but unavailable/);
  assert.equal(r.renderRunWhy(undefined), '');
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
  // No revert PR: the banner says why, when the alert carries it (main_watch.unaccounted no_revert).
  const why = "opening the revert PR failed: git revert of cccccccc on main's tip dddddddd conflicts with later commits: CONFLICT (content): Merge conflict in a.txt";
  const none = r.renderMainWatchAlert({ ...alert, alert: { ...alert.alert, revert: null, no_revert: why } });
  assert.match(none, /data-testid="main-watch-alert-no-revert"[^>]*>No revert PR was opened: opening the revert PR failed: git revert of cccccccc .*conflicts with later commits: CONFLICT \(content\): Merge conflict in a\.txt\./);
  assert.match(r.renderMainWatchAlert({ ...alert, alert: { ...alert.alert, revert: null } }), /No revert PR was opened\./, 'no reason known: says so plainly');
});

test('a stop in force that is not the main watch\'s (a red main after an auto-merge) shows its banner, and an admin its resume (#776)', () => {
  const red = { mode: 'main_watch' as const, detail: '', lastChecked: null, alert: null, stopped: "main's required checks failed (ci) on `cccccccc` after auto-merging #12", canClear: false };
  const banner = r.renderMainWatchAlert(red);
  assert.match(banner, /data-testid="auto-merge-stopped"[\s\S]*Auto-merge is stopped[\s\S]*required checks failed \(ci\) on `cccccccc` after auto-merging #12/);
  assert.doesNotMatch(banner, /main-watch-clear/, 'only an admin gets the resume');
  assert.doesNotMatch(banner, /Unaccounted commit/, 'not the main watch alert');
  assert.match(r.renderMainWatchAlert({ ...red, canClear: true }), /data-testid="main-watch-clear"[^>]*>Clear and resume auto-merge/);
  assert.equal(r.renderMainWatchAlert({ mode: 'main_watch' }), '', "a viewer's: nothing");
});

test('a resume answer that is a recorded request (the coordinator decides, #776 on #727) is told apart from a resume done now', () => {
  assert.equal(r.isResumeRequest({ ok: true, how: 'requested', acknowledged: false, message: 'Recorded.' }), true);
  assert.equal(r.isResumeRequest({ ok: true, how: 'as_before' }), false);
  assert.equal(r.isResumeRequest(null), false);
});

test("the acknowledgement form counts visible characters as the server does: blanks that print nothing don't count (#776)", () => {
  assert.equal(r.ackVisibleChars('the fix PR is ready'), 15);
  for (const ch of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⠀', '​', '️']) assert.equal(r.ackVisibleChars(ch.repeat(12)), 0, `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
  assert.equal(r.ackVisibleChars('한국어'), 3);
});

test("the main watch banner past a revert-PR cap: the trip's revert PR and why this commit has none of its own; past the day's cap, why none", () => {
  const sha = 'd'.repeat(40);
  const base = { mode: 'main_watch' as const, detail: '', lastChecked: null, stopped: 'main watch: x', canClear: false };
  const alert = { at: new Date().toISOString(), sha, url: `https://github.com/o/r/commit/${sha}`, reason: '#42 was merged into main with required checks not green on eeeeeeee at merge time: ci missing', number: 42, revert: null };
  const trip = r.renderMainWatchAlert({ ...base, alert: { ...alert, trip_revert: 'https://github.com/o/r/pull/9', no_revert: "the per-trip cap is reached (main_watch.revert_prs_per_trip: 1): this trip's revert PR https://github.com/o/r/pull/9; the trip's commits so far: aaaaaaaa, dddddddd" } });
  assert.match(trip, /No revert PR of its own; its trip&#x27;s revert PR waits for a human: <a[^>]*data-testid="main-watch-alert-revert"[^>]*>https:\/\/github.com\/o\/r\/pull\/9</);
  assert.match(trip, /data-testid="main-watch-alert-no-revert"[^>]*> Why: the per-trip cap is reached[\s\S]*aaaaaaaa, dddddddd/);
  assert.doesNotMatch(trip, /No revert PR was opened/, 'the trip has one');
  const day = r.renderMainWatchAlert({ ...base, alert: { ...alert, trip_revert: null, no_revert: 'the per-day cap is reached (main_watch.revert_prs_per_day: 3): the main watch opened 3 revert PRs in the last 24 hours' } });
  assert.match(day, /data-testid="main-watch-alert-no-revert"[^>]*>No revert PR was opened: the per-day cap is reached/);
  assert.doesNotMatch(day, /main-watch-alert-revert/);
  assert.match(r.renderMainWatchAlert({ ...base, alert }), /No revert PR was opened\.</, 'an older alert, with neither: as before');
});

test('a dead required check on the Machine page: named, since when, and why merges keep tripping; nothing when there is none', () => {
  const watch = { mode: 'main_watch' as const, detail: "GitHub doesn't protect main", lastChecked: null, alert: null, stopped: null, canClear: false };
  assert.doesNotMatch(r.renderProtection({ ...watch, deadChecks: [] }, BRAND.name), /main-watch-dead-check/);
  const html = r.renderProtection({ ...watch, deadChecks: [{ check: 'ci', since: new Date(Date.now() - 8 * 86_400_000).toISOString() }] }, BRAND.name);
  assert.match(html, /data-testid="main-watch-dead-check"[\s\S]*Required check [\s\S]*ci[\s\S]*has had no run on any commit checked since[\s\S]*Merges keep tripping the watch until it posts/);
  assert.doesNotMatch(r.renderProtection({ mode: 'github', deadChecks: [{ check: 'ci', since: new Date().toISOString() }] }, BRAND.name), /main-watch-dead-check/, 'only while the watch guards the branch');
});

test('a dead required check whose workflow is disabled says so on the Machine page: which workflow, and why it is off', () => {
  const watch = { mode: 'main_watch' as const, detail: "GitHub doesn't protect main", lastChecked: null, alert: null, stopped: null, canClear: false };
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const workflow = { name: 'Tests', path: '.github/workflows/tests.yml', state: 'disabled_manually' };
  const html = r.renderProtection({ ...watch, deadChecks: [{ check: 'ci', since, workflow }] }, BRAND.name);
  assert.match(html, /data-testid="main-watch-dead-check-workflow"[\s\S]*Its workflow [\s\S]*Tests[\s\S]*\.github\/workflows\/tests\.yml[\s\S]*is disabled on GitHub \([\s\S]*disabled_manually[\s\S]*: [\s\S]*turned off by hand[\s\S]*\), so it can&#x27;t post the check until someone enables it again/);
  assert.match(r.renderProtection({ ...watch, deadChecks: [{ check: 'ci', since, workflow: { ...workflow, state: 'disabled_inactivity' } }] }, BRAND.name), /disabled_inactivity[\s\S]*: [\s\S]*turned off by GitHub for inactivity/);
  assert.doesNotMatch(r.renderProtection({ ...watch, deadChecks: [{ check: 'ci', since }] }, BRAND.name), /main-watch-dead-check-workflow/, 'no note without a disabled workflow');
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
  assert.match(html, /href="https:\/\/github\.com\/example-org\/example-shop\/pull\/21" target="_blank" rel="noopener noreferrer"[^>]*data-testid="merged-pr"[^>]*>PR #21<[\s\S]*?Round totals to the cent[\s\S]*?data-testid="merged-level"[\s\S]*?>L0: lands once its checks pass<[\s\S]*?data-testid="merged-confidence"[\s\S]*?>evaluator confidence high</);
  // Neither recorded for PR #31: no badge for either, rather than one saying "not recorded" (#586).
  const pr31 = /data-testid="merged-item"(?:(?!data-testid="merged-item")[\s\S])*?PR #31(?:(?!data-testid="merged-item")[\s\S])*/.exec(html)?.[0] ?? '';
  assert.match(pr31, /Document the rounding rule/);
  assert.doesNotMatch(pr31, /merged-level|merged-confidence|not recorded/);
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
    serviceManagerEnv: () => ({ env: {} }),
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
  assert.deepEqual([...html.matchAll(/data-testid="first-run-group" data-group="([a-z-]+)"/g)].map((m) => m[1]), ['install', 'tools', 'claude', 'github', 'repo-config', 'protection', 'extras', 'service', 'first-task']);
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
  // A done one is folded to its line; its screen opens again only from its own (quiet) button (#468).
  const tools = html.slice(html.indexOf('data-step="tools"'), html.indexOf('</li>', html.indexOf('data-step="tools"')));
  assert.match(tools, /data-expanded="false"[\s\S]*?data-testid="first-run-fix" data-fix="action"[^>]*>Run again</);
  assert.doesNotMatch(tools, /first-run-fix-panel|bg-ink text-surface/);
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

/** A local first run with each step before Start set done (or not), Start itself and every step after it not done. */
function beforeStart(done: (id: string) => boolean) {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const ids = f.setup!.groups.flatMap((g) => g.steps.map((s) => s.id));
  const at = ids.indexOf('service');
  assert.ok(at > 0 && ids.indexOf('first-task') > at, 'Start comes before Your first task, in screen order');
  const before = new Set(ids.slice(0, at));
  return { ...f, setup: { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => ({ ...s, done: before.has(s.id) ? done(s.id) : false })) })) } };
}
const START_WARNING = /required steps? (isn(&#x27;|')t|aren(&#x27;|')t) done yet: the coordinator may stop at/;

test('#741 the Start card counts only the steps before Start: every one of them done and Your first task not, it warns of nothing', () => {
  const f = beforeStart(() => true);
  const html = r.renderFirstRun(f);
  assert.match(html, /data-step="first-task" data-status="todo"/, 'Your first task is not done');
  assert.match(html, /data-testid="first-run-start-button"/);
  assert.doesNotMatch(html, START_WARNING, 'a step that comes after Start is not one the coordinator stops at');
});

test('#741 the Start card still warns of a required step before Start that is not done, as before', () => {
  const f = beforeStart((id) => id !== 'claude-login');
  const html = r.renderFirstRun(f);
  const start = html.slice(html.indexOf('data-testid="first-run-start"'));
  assert.match(start, /1 required step isn(&#x27;|')t done yet: the coordinator may stop at it\./, 'Claude login, before Start, counts; Your first task, after it, does not');
});

/** Fixture events, as the coordinator records them, for the first task's card. */
function cardEvents(steps: [string, object][]): StoredEvent[] {
  const t0 = Date.parse('2026-10-19T09:00:00.000Z');
  return steps.map(([type, payload], i) => ({ id: i + 1, ts: new Date(t0 + i * 60_000).toISOString(), type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent);
}

test('#741 the First task card: the filed issue\'s stages from its events, its PR linked, a held PR\'s plain words and what lets it through, every estimate labelled; none before one is filed', () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  assert.doesNotMatch(r.renderFirstRun({ ...f, firstTask: null }), /first-task-card/, 'nothing filed: no card');
  const H = 'abc1234';
  const url = 'https://github.com/example-org/example-shop/pull/41';
  const filed: [string, object] = ['dashboard.audit', { login: 'example-owner', role: 'owner', via: 'session', instance: null, action: FIRST_TASK_FILED, detail: { issue: 7 } }];
  // Just filed: waiting, each estimate labelled by its basis (here, the tick; with no earlier task, none, or a guess).
  const fresh = firstTaskProgress(cardEvents([filed]), { local: true })!;
  const waiting = r.renderFirstRun({ ...f, firstTask: fresh });
  assert.match(waiting, /data-testid="first-task-card" data-issue="7" data-outcome="open"/);
  assert.match(waiting, /data-stage="claimed" data-state="waiting"[\s\S]*?data-testid="first-task-estimate" data-basis="tick">Estimate: within about 65 s of the coordinator running/);
  assert.match(waiting, /data-stage="pr" data-state="waiting"[\s\S]*?data-basis="guess">Guess: 15-60 minutes/);
  assert.doesNotMatch(waiting, /data-basis="(tick|median|none|guess)">(?!Estimate: |Guess: )/, 'every estimate says it is one');
  // Followed to a held PR.
  const held = firstTaskProgress(
    cardEvents([
      filed,
      ['issue.seen', { issue: 7, title: 'Round totals', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }],
      ['issue.claimed', { issue: 7, instance: 'local', lease: H, base: H, owner: 'example-owner' }],
      ['run.started', { issue: 7, role: 'worker', model: 'sonnet', worktree: '/stand-in', pid: 1, pgid: 1, attempt: 1 }],
      ['run.finished', { issue: 7, role: 'worker', reason: 'succeeded', detail: '' }],
      ['eval.verdict', { issue: 7, head: H, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }],
      ['pr.opened', { issue: 7, number: 41, url, head: H, draft: false }],
      ['pr.status', { issue: 7, number: 41, head: H, ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }] }],
      ['merge.decided', { issue: 7, number: 41, head: H, auto: false, reasons: ['auto-merge is off for this instance (policy.yaml auto_merge)', 'big: 500 changed lines (over 400)'] }],
    ]),
    { local: true, repo: 'example-org/example-shop' },
  )!;
  const html = r.renderFirstRun({ ...f, firstTask: held });
  assert.match(html, /data-testid="first-task-card" data-issue="7" data-outcome="held"[\s\S]*?#7/);
  // Read-only, and no free text: no control, and not even the issue's title.
  const from = html.indexOf('data-testid="first-task-card"');
  const card = html.slice(from, html.indexOf('data-testid="first-run-', from));
  assert.ok(card.includes('first-task-hold'), 'the whole card, up to the next first-run section');
  assert.doesNotMatch(card, /<button|<form|<input|<select|<textarea|Round totals/);
  assert.deepEqual([...html.matchAll(/data-testid="first-task-stage" data-stage="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['claimed:done', 'worker:done', 'evaluator:done', 'pr:done', 'checks:done', 'merge:held']);
  assert.match(html, /data-stage="evaluator"[\s\S]*?approved, confidence high/);
  assert.match(html, /<a href="https:\/\/github\.com\/example-org\/example-shop\/pull\/41"[^>]*data-testid="first-task-pr-link">PR #41<\/a>/);
  assert.match(html, /data-testid="first-task-hold" data-kind="policy-off"><p[^>]*>Local mode: every PR waits for you\.[\s\S]*?What lets it through: Review the PR and merge it yourself on GitHub\./);
  assert.match(html, /data-testid="first-task-hold" data-kind="big"><p[^>]*>The change is over this repo(&#x27;|')s size limit[\s\S]*?What lets it through: Split it/);
  assert.doesNotMatch(html, /policy\.yaml|500 changed lines/, 'the plain words, not the raw reasons');
  // The card sits after Start: a step of the page's, not a new one.
  assert.ok(html.indexOf('data-testid="first-task-card"') > html.indexOf('data-testid="first-run-start"'));
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

test("the first-run page, Sign in to Claude: local relays claude auth login (the link for owners, nothing pasted); a server names root's commands, with no paste box; a cached account is labelled cached", () => {
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

  // Server mode (issue #711): root's two commands and the status; no paste box, no password field, ever.
  const server = { mode: 'server', canAct: true, agentUser: 'wl-example-agent', status: null, command: 'claude setup-token\nsudo bash /opt/engine/scripts/setup/credentials.sh example claude', signinCommand: 'sudo -u wl-example-agent -i claude auth login', script: 'sudo bash /opt/engine/scripts/setup/credentials.sh example claude' } as const;
  const none = r.renderClaudeSignin(server);
  assert.match(none, /data-testid="claude-signin" data-mode="server"[\s\S]*?data-testid="claude-signin-root"[^>]*>[^<]*never takes a Claude credential[\s\S]*?data-testid="claude-signin-login-command"[^>]*>sudo -u wl-example-agent -i claude auth login[\s\S]*?data-testid="claude-signin-command"[^>]*>claude setup-token\nsudo bash \/opt\/engine\/scripts\/setup\/credentials\.sh example claude/);
  const signedIn = r.renderClaudeSignin({ ...server, status: { at: '2026-10-13T10:00:00.000Z', loggedIn: true, method: 'claude.ai', cachedAccount: 'previous@example.com', installedAt: '2026-10-13T11:00:00.000Z' } });
  assert.match(signedIn, /data-testid="claude-signin-status"[\s\S]*?signed in \(claude\.ai\)[\s\S]*?data-testid="claude-signin-cached-account"[^>]*>Account: previous@example\.com \(cached/);
  for (const html of [none, signedIn]) assert.doesNotMatch(html, /type="password"|data-testid="ask-secret"|claude-signin-ask/, 'nothing to paste into');
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
  // A root policy.yaml (#726): auto_merge on and land_mode direct are root's alone; the form offers only the
  // tightening, disabled where the value is that already, and names the root command. Off stays on offer when on.
  const rootPolicy = (autoMerge: boolean) => ({
    ...policy,
    fields: [
      policy.fields[0]!,
      { ...policy.fields[1]!, only: 'pr', root: 'sudo engine policy set shop land_mode direct' },
      { ...policy.fields[2]!, value: autoMerge, only: false, root: 'sudo engine policy set shop auto_merge on' },
    ],
  });
  const off = r.renderFirstRun({ ...f, policy: rootPolicy(false), canAct: true }, { open: 'policy' });
  assert.match(off, /data-key="auto_merge"[\s\S]*?type="checkbox"[^>]*disabled=""[\s\S]*?data-testid="policy-root-only"[^>]*>Here only false; anything else is an admin(&#x27;|')s: <code[^>]*>sudo engine policy set shop auto_merge on</);
  assert.match(off, /data-key="land_mode"[\s\S]*?<select[^>]*disabled=""[\s\S]*?<\/select>/);
  assert.doesNotMatch(off.match(/data-key="land_mode"[\s\S]*?<\/select>/)![0], /direct/, 'no loosening offered');
  // A policy that can't be read on a machine instance root's record covers: why, and "Turn auto-merge off" all the same.
  const broken = { fields: [], fixed: [], error: 'refused: it is 2097200 bytes, over 262144', canTurnOff: true };
  const offAnyway = r.renderFirstRun({ ...f, policy: broken, canAct: true }, { open: 'policy' });
  assert.match(offAnyway, /data-testid="policy-error"[^>]*>refused: it is 2097200 bytes[\s\S]*?data-testid="policy-off"[^>]*>Turn auto-merge off</);
  assert.doesNotMatch(r.renderFirstRun({ ...f, policy: { ...broken, canTurnOff: false }, canAct: true }, { open: 'policy' }), /policy-off/);
  assert.doesNotMatch(r.renderFirstRun({ ...f, policy: broken, canAct: false }, { open: 'policy' }), /policy-off/, 'owners only');
  const on = r.renderFirstRun({ ...f, policy: rootPolicy(true), canAct: true }, { open: 'policy' });
  assert.match(on, /data-key="auto_merge"[\s\S]*?type="checkbox"/);
  assert.doesNotMatch(on.match(/data-key="auto_merge"[\s\S]*?type="checkbox"[^>]*>/)![0], /disabled/, 'turning it off stays on offer');
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
  // #468: the finished draft's log folded away (its questions are the choices above, not repeated in the terminal's words).
  assert.match(questions, /<details[^>]*data-testid="setup-draft-log"><summary[^>]*>What the draft did \(failed\)<\/summary>[\s\S]*?running runner\.full on main/);
  assert.doesNotMatch(questions, /<details[^>]*data-testid="setup-draft-log" open/);
  const drafting = r.renderFirstRun({ ...setup, autoConfig: { ...autoConfig, questions: [] } }, { open: 'questions', draftConfirming: true });
  assert.match(drafting, /data-testid="setup-draft"[\s\S]*?runs each on a scratch copy of the default branch[\s\S]*?data-testid="setup-draft-confirming"[\s\S]*?Run your project(&#x27;|')s commands to draft it\?[\s\S]*?data-testid="setup-draft-confirm"/);
  const pr = r.renderFirstRun({ ...setup, autoConfig: { ...autoConfig, questions: [], pr: { number: 7, url: 'https://github.com/example-org/example-shop/pull/7' } } }, { open: 'questions' });
  // #468: the setup PR is followed in the Config PRs list (one merge path for every config PR), not merged from here.
  assert.match(pr, /data-testid="setup-pr"[\s\S]*?href="https:\/\/github\.com\/example-org\/example-shop\/pull\/7"[^>]*>PR #7[\s\S]*?merge it under Config PRs below, or on GitHub/);
  assert.doesNotMatch(pr, /setup-merge-review/);
  assert.doesNotMatch(pr, /setup-draft-button/);
  assert.match(r.renderFirstRun({ ...setup, canAct: false }, { open: 'questions' }), /Only the owners can set this checkout up/);
  assert.match(r.renderFirstRun({ ...setup, configReady: true }), /The config is here: opening the dashboard…/);
  const normal = r.renderFirstRun({ ...f, setup: open, autoConfig, canAct: true }, { open: 'questions' });
  assert.match(normal, /data-testid="first-run-coming"/, 'outside setup mode: what to do today');
  assert.doesNotMatch(normal, /setup-question/);
});

test('#468 Your first task: the form (title, outcome, done_when picks from the repo\'s tests, context), its preview with the label, the template; on a server one line, no form; and the first-run page offers it after Start', () => {
  const info = { local: true, why: null, template: { label: 'ready', body: '**Outcome:** <x>\n\n```done_when\n- test: "<t>"\n```' }, tests: ['test/a.test.ts', 'test/b.test.ts'] };
  const html = r.renderFirstTask(info);
  assert.match(html, /data-testid="first-task-form"[\s\S]*?data-testid="first-task-title"[\s\S]*?data-testid="first-task-outcome"[\s\S]*?data-testid="first-task-check-kind"[\s\S]*?data-testid="first-task-test"[\s\S]*?<datalist id="first-task-tests"><option value="test\/a\.test\.ts"><\/option><option value="test\/b\.test\.ts">[\s\S]*?data-testid="first-task-context"[\s\S]*?data-testid="first-task-review"/);
  assert.match(html, /data-testid="first-task-template"[\s\S]*?add the label (<!-- -->)?ready[\s\S]*?data-testid="first-task-template-body"[^>]*>\*\*Outcome:\*\*[\s\S]*?```done_when/);
  const preview = r.renderFirstTask(info, { preview: { title: 'T', body: '```done_when\n- command: |\n    true\n```' } });
  assert.match(preview, /data-testid="first-task-preview"[\s\S]*?```done_when[\s\S]*?Filed with the label ready[\s\S]*?data-testid="first-task-file"[^>]*>File it/);
  const server = r.renderFirstTask({ ...info, local: false, why: "on a server an issue filed from this page would be its GitHub App's" });
  assert.match(server, /data-testid="first-task-server"[^>]*>Not from here: on a server/);
  assert.doesNotMatch(server, /first-task-form|first-task-review/);
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const page = r.renderFirstRun(f);
  assert.match(page, /data-group="service"[\s\S]*?data-group="first-task"[\s\S]*?data-step="first-task"[\s\S]*?data-fix="form"[^>]*>File one</);
  const srv = r.renderFirstRun(firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: 'shop', start: { kind: 'owner-command', unit: 'u', command: 'c', why: 'w' } }));
  assert.match(srv, /data-testid="first-run-first-task-server"[^>]*>Your first task: open an issue on GitHub with a ```done_when block and the ready label\. There is no form for it on a server/);
  assert.doesNotMatch(srv, /data-step="first-task"/);
});

test('#468 the Issues page\'s "Not picked up": each issue with its reasons; Add ready and Edit for a writer, the reasons alone for a viewer; on a server, why no button', () => {
  const issues = [{ issue: 3, title: 'no label', url: 'https://github.com/o/r/issues/3', author: 'someone-else', labels: [], reasons: [{ kind: 'no-ready', text: 'no ready label', fix: 'add-ready' }, { kind: 'contract', text: 'no ```done_when block in the issue body', fix: 'edit' }] }];
  const writer = r.renderIgnored({ issues, error: null, canFix: true, local: true });
  assert.match(writer, /data-testid="issue-ignored" data-issue="3"[\s\S]*?data-kind="no-ready"[\s\S]*?no ready label[\s\S]*?data-testid="issue-ignored-add-ready"[^>]*>Add ready[\s\S]*?data-kind="contract"[\s\S]*?no ```done_when block[\s\S]*?href="https:\/\/github\.com\/o\/r\/issues\/3"[^>]*data-testid="issue-ignored-edit"/);
  const viewer = r.renderIgnored({ issues, error: null, canFix: false, local: true });
  assert.match(viewer, /no ready label/);
  assert.doesNotMatch(viewer, /issue-ignored-add-ready|issue-ignored-edit/);
  assert.match(r.renderIgnored({ issues: [], error: null, canFix: true, local: true }), /data-testid="issues-ignored-none"/);
  assert.match(r.renderIgnored({ issues, error: null, canFix: false, local: false }), /On a server, add the label on GitHub/);
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
  assert.match(open, /<details[^>]*data-testid="first-run-without"><summary[^>]*>Without this page<\/summary>[\s\S]*?data-testid="first-run-automation"><span class="text-\[0px\]" aria-hidden="true">Without this page: <\/span><code[^>]*>worklane install --git-hooks<\/code>/);
  const done = { ...owner, setup: { ...owner.setup!, groups: owner.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'pre-commit' ? { ...s, done: true } : s)) })) } };
  // #468: a done step is folded (its one line, no panel) and can be opened again from its own button.
  const doneRow = r.renderFirstRun(done).match(/data-step="pre-commit"[\s\S]*?<\/li>/)![0];
  assert.match(doneRow, /data-status="done" data-expanded="false"/);
  assert.match(doneRow, /class="[^"]*truncate[^"]*"[^>]*data-testid="first-run-step-detail"/, 'its result on one line');
  assert.match(doneRow, /data-testid="first-run-fix" data-fix="action"[^>]*>Run again</);
  assert.doesNotMatch(doneRow, /first-run-fix-panel/);
  assert.match(r.renderFirstRun(done, { open: 'pre-commit', rerun: 'pre-commit' }), /data-step="pre-commit" data-status="done"[\s\S]*?data-testid="first-run-fix" data-fix="action"[^>]*>Run again[\s\S]*?data-testid="first-run-action" data-action="git-hooks"/);
  const settings = r.renderSetupScreens(done.setup!.groups.flatMap((g) => g.steps));
  assert.match(settings, /data-testid="setup-screens"[\s\S]*?Setup screens/);
  assert.match(settings, /data-step="pre-commit"[\s\S]*?>done<[\s\S]*?worklane install --git-hooks[\s\S]*?href="\/first-run\?step=pre-commit"[^>]*>Run again/);
  assert.match(settings, /data-step="service"[\s\S]*?worklane up[\s\S]*?href="\/first-run\?step=service"[^>]*>Open/);
  assert.doesNotMatch(settings, /data-step="docker"/, 'a step done on the vendor\'s own page has no screen here');
});

test('#468 first run: exactly one primary button, on the first required step not done in screen order, moving on as steps complete; none once every required step is done', () => {
  let f: ReturnType<typeof firstRun> & { canAct?: boolean } = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  f = { ...f, canAct: true };
  const order = f.setup!.groups.flatMap((g) => g.steps).filter((s) => !s.optional && !s.done && !s.skipped).map((s) => s.id);
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    const next = r.nextStep(f);
    const html = r.renderFirstRun(f);
    const primaries = [...html.matchAll(/data-primary="true"/g)].length;
    if (!next) {
      assert.equal(primaries, 0, 'every required step done: no primary step button');
      break;
    }
    seen.push(next.id);
    assert.equal(primaries, 1, `exactly one primary with ${next.id} next`);
    const step = f.setup!.groups.flatMap((g) => g.steps).find((s) => s.id === next.id)!;
    if (step.fix.kind === 'start') assert.match(html, /data-testid="first-run-start-button" data-primary="true"/, 'Start is pressed in its card');
    else assert.match(html.match(new RegExp(`data-step="${next.id}"[\\s\\S]*?</li>`))![0], /data-testid="first-run-fix"[^>]*data-primary="true"/, `${next.id}'s own button`);
    // Every other step's button is secondary (outlined or quiet), never the dark primary.
    const dark = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]).filter((b) => /data-testid="first-run-(fix|start-button)"/.test(b) && /bg-ink text-surface/.test(b));
    assert.equal(dark.length, 1, 'one dark (primary) step button');
    assert.match(dark[0]!, /data-primary="true"/);
    f = { ...f, setup: { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === next.id ? { ...s, done: true } : s)) })) } };
  }
  assert.deepEqual(seen, order, 'every required step not done, each once, in screen order');
  assert.ok(seen.length >= 3);
  // Where Start has no button here (a server: the owner's root command), the coordinator step's own button is the primary.
  const srv = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'o/r', instance: 'shop', start: { kind: 'owner-command', unit: 'u', command: 'c', why: 'w' } });
  const onlyCoordinator = { ...srv, setup: { ...srv.setup!, groups: srv.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((x) => (x.id === 'coordinator' ? { ...x, done: false, skipped: false } : { ...x, done: true })) })) } };
  assert.equal(r.nextStep(onlyCoordinator)!.id, 'coordinator');
  const srvHtml = r.renderFirstRun(onlyCoordinator);
  assert.equal([...srvHtml.matchAll(/data-primary="true"/g)].length, 1, 'still exactly one');
  assert.match(srvHtml.match(/data-step="coordinator"[\s\S]*?<\/li>/)![0], /data-testid="first-run-fix"[^>]*data-primary="true"/);
  // A skipped required step is passed over.
  const g = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const first = r.nextStep(g)!;
  const skipped = { ...g, setup: { ...g.setup!, groups: g.setup!.groups.map((x) => ({ ...x, steps: x.steps.map((s) => (s.id === first.id ? { ...s, skipped: true } : s)) })) } };
  assert.notEqual(r.nextStep(skipped)?.id, first.id);
});

test('#468 first run: the CLI fallback is one complete line, folded under "Without this page"; the questions are asked once, as choices', () => {
  const f = firstRun(join(tmpdir(), 'no-such-init.json'), { root: '/r', repo: 'example-org/example-shop', instance: null });
  const autoConfig = { questions: [{ id: 'package-manager', ask: 'which package manager runs it?', choices: [{ id: 'npm', label: 'npm' }, { id: 'pnpm', label: 'pnpm' }], custom: false }], verified: [], pr: null, answer: 'worklane init /r --answer <id>=<choice>' };
  const draft = { running: false, startedAt: '2026-10-13T10:00:00.000Z', finishedAt: '2026-10-13T10:00:05.000Z', lines: ['   ? which package manager runs it?', '       npm)  npm', '     answer (npm / pnpm): '], result: { status: 'failed', detail: '1 question to answer before the config is proposed: package-manager (npm / pnpm). Run `worklane init` in a terminal to answer' } };
  const open = { ...f.setup!, groups: f.setup!.groups.map((g) => ({ ...g, steps: g.steps.map((s) => (s.id === 'questions' ? { ...s, done: false, detail: '1 question open (shown below)' } : s)) })) };
  const html = r.renderFirstRun({ ...f, setup: open, setupMode: true, configReady: false, autoConfig, draft, canAct: true }, { open: 'questions' });
  const row = html.match(/data-step="questions"[\s\S]*?<\/li>/)![0];
  const lines = [...row.matchAll(/data-testid="first-run-automation"><span class="text-\[0px\]" aria-hidden="true">Without this page: <\/span><code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['worklane init --mode local'], 'one line, complete: nothing to fill in');
  assert.match(row, /<details[^>]*data-testid="first-run-without">/);
  assert.doesNotMatch(row, /<details[^>]*data-testid="first-run-without" open/, 'folded');
  assert.match(row, /data-testid="first-run-without-copy"/);
  // Nothing outside a folded <details> shows a CLI line, or init's prompt, again.
  // (What local mode can't do, at the foot of the page, is about other repos, not this walk.)
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, '').split('data-testid="first-run-unavailable"')[0]!;
  const again = visible.search(/worklane init|answer \(npm \/ pnpm\)/);
  assert.equal(again, -1, `a CLI line outside "Without this page": ${visible.slice(Math.max(0, again - 300), again + 80)}`);
  assert.equal([...visible.matchAll(/which package manager runs it\?/g)].length, 1, 'the question, once');
});

test('#468 setup mode: the sidebar offers First run alone (all pages once configured); a hidden page\'s address says what it needs', () => {
  // Rendered as on the server, with no window (as the drawer test above: its scroll lock measures the page only in a browser).
  const g = globalThis as Record<string, unknown>;
  const stub = g.window;
  delete g.window;
  let setupMode: string, configured: string;
  try {
    setupMode = r.renderNavDrawer({ ...asOwner, setupMode: true } as never);
    configured = r.renderNavDrawer({ ...asOwner, setupMode: false, experiments: true } as never);
  } finally {
    g.window = stub;
  }
  assert.deepEqual([...setupMode.matchAll(/data-testid="(nav-[a-z-]+)"/g)].map((m) => m[1]).filter((t) => t !== 'nav-drawer-overlay' && t !== 'nav-drawer-close' && t !== 'nav-drawer' && t !== 'nav-menu'), ['nav-first-run']);
  assert.match(setupMode, /<a href="\/first-run"[^>]*data-testid="nav-first-run"/);
  for (const n of r.navRows) assert.match(configured, new RegExp(`data-testid="${n.testId}"`), `${n.label} shown once configured`);
  assert.doesNotMatch(configured, /nav-first-run/);
  const hidden = r.renderSetupModeHidden('/issues');
  assert.match(hidden, /data-testid="setup-mode-hidden-why"[^>]*>Issues shows once this checkout has its config, and it has none yet\./);
  assert.match(hidden, /href="\/first-run"[^>]*data-testid="setup-mode-hidden-link"/);
  assert.match(r.renderSetupModeHidden('/nowhere'), /This page shows once/);
});

/** The test ids of the sidebar rows navFor gives a state. */
const navIds = (state: unknown) => r.navFor(state).map((n) => n.testId);

test('#581 nav shows Experiments for an owner or writer on an enabled instance', () => {
  for (const who of [asOwner, asWriter]) {
    const ids = navIds({ ...who, experiments: true });
    assert.ok(ids.includes('nav-experiments'), `${(who as { role?: string }).role}: ${ids.join(' ')}`);
    assert.equal(r.navFor({ ...who, experiments: true }).find((n) => n.testId === 'nav-experiments')!.to, '/experiments');
  }
  // Its own row in the sidebar, as a link to its route.
  const g = globalThis as Record<string, unknown>;
  const stub = g.window;
  delete g.window;
  try {
    assert.match(r.renderNavDrawer({ ...asWriter, experiments: true } as never), /<a href="\/experiments"[^>]*data-testid="nav-experiments"/);
  } finally {
    g.window = stub;
  }
});

test('#581 nav hides Experiments for a viewer and on a disabled instance', () => {
  assert.equal((asOther as { role?: string }).role, 'viewer');
  assert.ok(!('experiments' in asOther), 'the server sends a viewer no experiments key');
  // A viewer: never, even with the flag forged in.
  assert.ok(!navIds({ ...asOther, experiments: true }).includes('nav-experiments'));
  // Off or unknown on this machine (false), or from a server that doesn't say (absent): hidden, fail closed.
  for (const who of [asOwner, asWriter]) {
    assert.ok(!navIds({ ...who, experiments: false }).includes('nav-experiments'));
    const { experiments: _, ...without } = who as State & { experiments?: boolean };
    assert.ok(!navIds(without).includes('nav-experiments'));
  }
  // Setup mode: First run alone.
  assert.deepEqual(navIds({ ...asOwner, experiments: true, setupMode: true }), ['nav-first-run']);
});

test('#581 the old Extend route redirects', () => {
  assert.equal(r.redirectFor('/extend/experiments'), '/experiments');
  assert.equal(r.redirectFor('/extend/experiments/'), '/experiments/');
  assert.equal(r.redirectFor('/extend/experiments/example-speed'), '/experiments/example-speed', 'the study id is kept');
  for (const keep of ['/extend', '/extend/automations', '/extend/automations/nightly', '/extend/plugins', '/extend/experimentsx', '/experiments', '/']) assert.equal(r.redirectFor(keep), null, keep);
  // Replaced, not pushed (Back doesn't land on the old address again), with the query and the hash kept.
  const calls: string[] = [];
  const history = { state: { k: 1 }, replaceState: (data: unknown, _: string, url: string) => void calls.push(`${JSON.stringify(data)} ${url}`) };
  assert.equal(r.landOn({ pathname: '/extend/experiments/example-speed', search: '?x=1', hash: '#log' }, history), '/experiments/example-speed');
  assert.deepEqual(calls, ['{"k":1} /experiments/example-speed?x=1#log']);
  assert.equal(r.landOn({ pathname: '/extend/automations', search: '', hash: '' }, history), '/extend/automations');
  assert.equal(calls.length, 1, 'a current address is left alone');
  // Extend keeps Automations and Plugins, and opens on Automations.
  assert.deepEqual(r.EXTEND_TABS.map((t) => t.id), ['automations', 'plugins']);
  const extend = r.renderPage('extend', asOwner);
  assert.doesNotMatch(extend, /extend-tab-experiments/);
  assert.match(extend, /aria-current="page"[^>]*data-testid="extend-tab-automations"/);
  // The new page renders at its own route.
  assert.match(r.renderPage('experiments', asOwner), /data-testid="page-experiments"/);
});

test('#585 a grouped page\'s header draws its group\'s tabs with the counts their rows had; the sidebar has one Needs you badge', () => {
  const issues = r.renderAt('/work/issues', asOwner, 'Issues');
  assert.deepEqual([...issues.matchAll(/<a href="([^"]+)"[^>]*data-testid="(tab-[a-z]+)"/g)].map((m) => `${m[2]} ${m[1]}`), ['tab-board /', 'tab-issues /work/issues', 'tab-intake /work/intake', 'tab-prs /work/prs']);
  assert.match(issues, /<nav[^>]*aria-label="Work"[^>]*data-testid="group-tabs"/);
  assert.match(issues, /aria-current="page"[^>]*data-testid="tab-issues"/);
  assert.equal([...issues.matchAll(/aria-current="page"/g)].length, 1, 'one tab is the page shown');
  // An issue's own page is on the Issues tab.
  assert.match(r.renderAt('/work/issues/3', asOwner), /aria-current="page"[^>]*data-testid="tab-issues"/);
  // The tab carries the count its sidebar row had.
  const c = r.navCounts(asOwner);
  assert.ok(c['/work/issues']! > 0, 'the demo has open issues');
  assert.match(issues, new RegExp(`data-testid="tab-issues"[^>]*>Issues<span[^>]*>${c['/work/issues']}</span>`));
  // The Setup console is a tab under Settings.
  assert.match(r.renderAt('/settings', asOwner), /<a href="\/settings\/setup"[^>]*data-testid="tab-setup"[^>]*>Setup console</);
  // A page outside a group has no tab row; nor does any page in setup mode.
  for (const p of ['/overview', '/extend', '/experiments', '/runs/r-1', '/first-run']) assert.doesNotMatch(r.renderAt(p, asOwner), /group-tabs/, p);
  assert.doesNotMatch(r.renderAt('/work/issues', { ...asOwner, setupMode: true } as never), /group-tabs/);
  // The sidebar: one Needs you row with its one badge, and no row of its own for the Inbox or Decisions.
  const g = globalThis as Record<string, unknown>;
  const stub = g.window;
  delete g.window;
  let drawer: string;
  try {
    drawer = r.renderNavDrawer(asOwner);
  } finally {
    g.window = stub;
  }
  assert.ok(c['nav-needs-you']! > 0, 'the demo has open decisions');
  assert.match(drawer, new RegExp(`<a href="/needs-you"[^>]*data-testid="nav-needs-you"[^>]*>(?:(?!</a>).)*>${c['nav-needs-you']}</span></a>`));
  assert.doesNotMatch(drawer, /data-testid="nav-(inbox|decisions|waiting)"/);
});

test('#585 Needs you is one queue: what the three tabs list, each once, blocking first then the oldest, the order stated', () => {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const open = asOwner.decisions.filter((d) => !d.answer) as unknown as { id: string; question: string; kind: string }[];
  assert.ok(open.length >= 2, 'the demo has open decisions');
  const asked = open.find((d) => d.kind !== 'plan')!;
  const w = {
    at: new Date(now).toISOString(), markdown: '', mergedSince: new Date(now).toISOString(), merged: [],
    items: [
      // Waiting on you's own line for a decision the Decisions tab shows too: one row.
      { kind: 'awaiting_decision', since: hoursAgo(1), issue: null, pr: null, title: null, detail: 'the same decision', decision: asked.id },
      { kind: 'hotspot_held', since: hoursAgo(9_000), issue: 3, pr: null, title: 'Held one', detail: 'behind #2, on src/a.ts' },
      { kind: 'needs_owner', since: hoursAgo(2), issue: 3, pr: 31, title: 'Held one', detail: 'left to you' },
    ],
  };
  const html = r.renderNeedsYou(asOwner, w, now);
  assert.match(html, /data-testid="page-needs-you"[\s\S]*<h1[^>]*>Needs you</);
  assert.ok(html.includes(`data-testid="needs-you-order">${esc(r.NEEDS_YOU_ORDER)}<`), 'the page states the order');
  const rows = [...html.matchAll(/data-testid="needs-you-item" data-kind="([a-z_]+)" data-blocking="(yes|no)"/g)].map((m) => `${m[1]} ${m[2]}`);
  // Blocking first; the hotspot hold is the oldest of all, but nothing waits on it but you, so it is last.
  assert.equal(rows.at(-1), 'hotspot_held no');
  assert.ok(rows.slice(0, -1).every((x) => x.endsWith(' yes')), rows.join(', '));
  // #633: the badge from the state alone, whose waiting keys are what /api/waiting lists.
  const keyed = { ...asOwner, waiting: { count: w.items.length, keys: w.items.map((i) => ({ kind: i.kind, issue: i.issue, ...('decision' in i ? { decision: i.decision } : {}) })) } };
  assert.equal(rows.length, r.navCounts(keyed)['nav-needs-you'], 'the badge counts the queue');
  // Every open decision is in it once, the one Waiting on you lists too among them.
  for (const d of open) assert.equal(html.split(`href="/needs-you/decisions/${d.id}"`).length - 1, 1, d.id);
  assert.match(html, /href="\/needs-you\/decisions\/pr-31"/);
  // Before Waiting on you answers: no list yet. A viewer, refused it up front: the decisions and their blocked tasks, saying so.
  assert.match(r.renderNeedsYou(asOwner, null), /Reading what waits on you/);
  const viewer = r.renderNeedsYou(asOther, null);
  assert.match(viewer, /What waits on the owner is for the instance(&#x27;|')s owners and writers[^<]*: this queue has the decisions and your blocked tasks\./);
  assert.equal([...viewer.matchAll(/data-testid="needs-you-item"/g)].length, r.navCounts(asOther)['nav-needs-you']);
  // The Inbox's L2 landings are not in the queue (nothing waits on them): a line counts them, with the way to the Inbox.
  const landed = asOwner.tasks.slice(0, 2);
  const withLanded = r.renderNeedsYou({ ...asOwner, inbox: { ...(asOwner as unknown as { inbox: object }).inbox, notify: landed } } as never, w, now);
  assert.match(withLanded, /Not in the queue: 2 L2 changes landed for you to look over, on the <a href="\/needs-you\/inbox"[^>]*>Inbox<\/a>/);
  assert.equal([...withLanded.matchAll(/data-testid="needs-you-item"/g)].length, rows.length, 'the landings add no row');
  assert.doesNotMatch(r.renderNeedsYou({ ...asOwner, inbox: { ...(asOwner as unknown as { inbox: object }).inbox, notify: [] } } as never, w, now), /Not in the queue/);
  // The queue is the group's first tab, on its own address.
  assert.match(r.renderAt('/needs-you', asOwner), /<a href="\/needs-you"[^>]*aria-current="page"[^>]*data-testid="tab-needs-you"/);
});

test('#581 the app loads in a browser at an old address: its first page preload asks where the address moved', async () => {
  // App.tsx's module body preloads the page for window.location when there is a window, through redirectFor. Loaded
  // with a window (as a browser loads it), every module it uses must be ready by then: CI's real Chrome caught
  // "is not iterable" there, the redirect list read before it was defined, and every page failed to load.
  const g = globalThis as Record<string, unknown>;
  const stub = g.window as Record<string, unknown>;
  // Whatever else a module reads from the browser while it loads: a no-op that answers anything (never a promise).
  const anything: unknown = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : anything), apply: () => anything, construct: () => anything as object });
  const browser = (own: Record<string, unknown>) => new Proxy(own, { get: (o, k) => (k in o ? o[k as string] : k === 'then' ? undefined : anything) });
  const hadDocument = 'document' in g;
  g.window = browser({ ...stub, location: { pathname: '/extend/experiments/example-speed', search: '', hash: '' } });
  g.document = anything;
  try {
    // App.tsx is in a chunk of its own (the pages are split); load that chunk again, so its body runs with a window.
    const entry = readFileSync(new URL(bundle), 'utf8');
    const chunk = entry.match(/import \{[^}]*\bas navFor\b[^}]*\} from "(\.\/[^"]+)"/)?.[1];
    assert.ok(chunk, "the render entry imports navFor from App.tsx's chunk");
    const url = new URL(chunk, bundle).href;
    const again = (await import(`${url}?at=old-address`)) as Record<string, unknown>;
    assert.ok(Object.keys(again).length > 0, 'the module loaded');
  } finally {
    g.window = stub;
    if (!hadDocument) delete g.document;
  }
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

test("#471: a card's waiting reasons show in full, one chip each, wrapping inside the card; never cut off", () => {
  const long = [
    'doubt: evaluator confidence medium: the change was not run against the zero-quantity line the issue names, so done_when passing does not show that case is handled',
    'high-risk: migration (migrations/001_orders.sql, migrations/002_order_lines.sql, migrations/003_order_index.sql and 4 more)',
    `eval: role evaluator-verdict scored lower, 7/10 → 6/10 (~$1.20): case 9 "A planted problem that the checks miss": pass → fail; ${'x'.repeat(120)}`,
  ];
  const card = { ...boards.owner.cards[0]!, column: 'waiting', waiting: { kind: 'needs_owner', label: 'PRs waiting for you to review and merge', detail: long.join('; '), reasons: long, since: '2026-01-01T00:00:00Z' } };
  const html = clean(() => r.renderBoard([{ name: null, data: { ...boards.owner, cards: [card] }, error: null }]));
  const chips = [...html.matchAll(/<li class="([^"]*)" data-testid="board-card-reason">([^<]*)<\/li>/g)];
  assert.equal(chips.length, 3, 'one chip per reason');
  const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  assert.deepEqual(chips.map((m) => unescape(m[2]!)), long, 'every reason whole');
  for (const [, cls] of chips) {
    assert.doesNotMatch(cls!, /truncate|line-clamp|text-ellipsis|nowrap/, 'nothing cuts a chip off');
    assert.match(cls!, /wrap-anywhere/, 'a long word wraps instead of overflowing');
  }
  assert.match(html, /<ul class="[^"]*flex-wrap[^"]*" data-testid="board-card-reasons"/, 'chips wrap onto new lines');
  const wait = /data-testid="board-card-wait">([\s\S]*?)<\/ul><\/div>/.exec(html)![1]!;
  assert.doesNotMatch(wait, /truncate|line-clamp|text-ellipsis/, 'nothing in the wait cuts a reason off');
  // No reasons (a viewer, or a wait with only a line): the line in full, unclamped.
  const plain = clean(() => r.renderBoard([{ name: null, data: { ...boards.owner, cards: [{ ...card, waiting: { ...card.waiting, reasons: null, detail: long[0] } }] }, error: null }]));
  assert.doesNotMatch(plain, /board-card-reason/);
  const line = /data-testid="board-card-wait">([\s\S]*?)<\/div><\/div>/.exec(plain)![1]!;
  assert.ok(line.includes(long[0]!), 'the whole line');
  assert.doesNotMatch(line, /truncate|line-clamp|text-ellipsis/, 'unclamped');
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
});

const CLAUDE_ASK = { id: 'ask-000000000009', instance: 'demo', title: "The Claude login for demo's agents", detail: 'Paste the token claude setup-token prints.', createdAt: '2026-10-12T10:00:00Z', createdBy: 'add-project', cancelled: null, kind: 'paste_secret', where: "wl-demo-agent's Claude login", status: 'open', answer: null, canAnswer: true, request: null };
/** An open ask for `credential` that the owner may answer draws no box in the Setup console, and root's commands instead. */
function drawsNoClaudeBox(credential: string) {
  const html = r.renderSetup({ role: 'owner', login: 'olive', asks: [{ ...CLAUDE_ASK, credential }] });
  assert.match(html, /data-testid="ask-card"/, credential);
  assert.doesNotMatch(html, /<input|<textarea|type="password"|data-testid="ask-secret"/, `${credential}: no field a Claude credential could be typed into`);
  assert.doesNotMatch(html, /credential store|Waiting on the owner/, `${credential}: not offered as a paste, nor as the owner's to answer`);
  assert.match(html, /data-testid="ask-claude-root"[\s\S]*?never takes a Claude credential[\s\S]*?data-testid="ask-claude-login-command"[^>]*>sudo -u wl-demo-agent -i claude auth login<[\s\S]*?claude setup-token[\s\S]*?data-testid="ask-claude-credentials-command"[^>]*>sudo bash scripts\/setup\/credentials\.sh demo claude</, credential);
}

for (const credential of ['claude-token', 'claude-account-token', 'claude-profile-token', 'claude-login-code']) {
  test(`#711: an open ${credential} ask an earlier version left draws no box in the Setup console, even to an owner who may answer it; root's commands instead`, () => {
    assert.ok(CLAUDE_CREDENTIAL_NAMES.has(credential), `${credential} is one of the server's names`);
    drawsNoClaudeBox(credential);
  });
}

test("#711: every name in the server's CLAUDE_CREDENTIAL_NAMES draws no box (a name added there is covered)", () => {
  for (const credential of CLAUDE_CREDENTIAL_NAMES) drawsNoClaudeBox(credential);
});

test("#711: the page's Claude credential names are exactly the server's CLAUDE_CREDENTIAL_NAMES, so the two can't drift", () => {
  assert.ok(Array.isArray(r.CLAUDE_CREDENTIAL_NAMES), 'web/src/api.ts exports CLAUDE_CREDENTIAL_NAMES');
  const page = [...r.CLAUDE_CREDENTIAL_NAMES!];
  assert.equal(new Set(page).size, page.length, 'no name twice');
  assert.deepEqual([...page].sort(), [...CLAUDE_CREDENTIAL_NAMES].sort());
  for (const name of CLAUDE_CREDENTIAL_NAMES) assert.equal(r.isClaudeCredential!(name), true, name);
});

test("#711: a secret whose name only looks like a Claude credential (claude_mcp_key, claude-mcp-key, claude_other-token) still draws its password field; any other secret too", () => {
  for (const credential of ['claude_mcp_key', 'claude-mcp-key', 'claude_other-token', 'Claude-Token', 'intake-discord']) {
    const html = r.renderSetup({ role: 'owner', login: 'olive', asks: [{ ...CLAUDE_ASK, credential }] });
    const secret = html.match(/<input[^>]*data-testid="ask-secret"[^>]*>/)?.[0] ?? '';
    assert.match(secret, /type="password"/, `${credential}: its password field`);
    assert.doesNotMatch(html, /ask-claude-root/, `${credential}: not root's Claude login commands`);
  }
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
    ['a disallowed device', { ...ownerRequester('ada'), deviceOk: false }, /one of the machine(&#x27;|')s allowed devices \(dashboards\.sh --machine-devices\)/],
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

test("Add project: the steps show in the script order as they arrive, and its asks (GitHub links; an earlier version's Claude token ask, as root's commands) appear in the same view", () => {
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
  // A Claude token ask, as an earlier version's add-project opened it (#711): no box in the run's view, root's commands.
  step('claude-token', 'ask', 'paste the token from claude setup-token');
  a.create({ kind: 'paste_secret', instance: 'shop', title: "The agent's Claude token", detail: 'x', credential: 'claude-token', where: 'the agent user only' }, 'setup');
  v = render();
  assert.equal((v.run.match(/data-testid="ask-card"/g) ?? []).length, 3, 'both GitHub links and the token ask');
  // Nobody may answer it (the server, #749), and the page draws no box for it either way (AskCard, #711).
  assert.doesNotMatch(v.run, /<input|type="password"|data-testid="ask-secret"/, 'Add project: no box for the Claude token (#711)');
  assert.match(v.run, /data-testid="ask-claude-login-command"[^>]*>sudo -u wl-shop-agent -i claude auth login</);
  assert.match(v.run, /data-testid="ask-claude-credentials-command"[^>]*>sudo bash scripts\/setup\/credentials\.sh shop claude</);

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
  const names = ['shop', 'a', 'site-2', 'a'.repeat(21), 'a'.repeat(22), '', '2shop', 'Shop', 'shop_x', 'shop;id', 'dash', 'shop-agent', 'shop-eval', 'shop-work', 'shop-', 'test-shop', 'ci-shop', 'dashboard-shop', 'hub', 'hub-setup', 'update', 'tailscale', 'claude-account', 'agent', 'eval', 'work', 'test', 'ci', 'a-b-c'];
  const repos = ['acme/shop', 'Acme-Co/site.web_2', 'a/b', 'acme', 'a/b/c', '/b', 'a/..', 'a/.', 'a/b c', 'a/b\n', '-a/b', 'a--b/c', `${'a'.repeat(40)}/b`];
  for (const n of names) assert.equal(r.addProjectInvalid(n, 'acme/shop') === null, addProjectNameOk(n), `name ${JSON.stringify(n)}`);
  for (const p of repos) assert.equal(r.addProjectInvalid('shop', p) === null, addProjectRepoOk(p), `repo ${JSON.stringify(p)}`);
});

test("two instances on one machine: with one selected, no page shows any of the other's items; All instances shows both, labelled; the default is the selected one", async () => {
  const marks: Record<'a' | 'b', InstanceMarks> = { a: { ...MARKS.a }, b: { ...MARKS.b } };
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

test('#562: after an instance and then All instances, the sidebar header and the Claude account panel say All instances; picking one instance again names it', () => {
  const hub = { instances: [{ name: 'a', up: true, error: null }, { name: 'b', up: true, error: null }] };
  // What each instance's server answers: its own state (its project's name) and the machine's Claude account, from it.
  const own = asOwner as State & { project: Record<string, unknown> };
  const stateOf = (name: 'a' | 'b') => ({ ...own, project: { ...own.project, name: MARKS[name].project } }) as State;
  const accountOf = (name: 'a' | 'b') => ({
    machineOwner: true,
    machineOwners: ['example-owner'],
    login: 'example-owner',
    instance: name,
    allowed: true,
    why: null,
    status: null,
    requests: [],
    signin: 'sudo -u <agent user> -i claude auth login',
    retired: null,
  });
  // As the page sees it: every view reads scope.current's server (the state, and the account panel's data).
  const view = (scope: ReturnType<Render['scopeOf']>) => ({
    header: (/data-testid="sidebar-title"[^>]*>([^<]*)</.exec(r.renderSidebar(stateOf(scope.current as 'a' | 'b'), { hub, scope })) ?? [])[1],
    account: r.renderClaudeAccount(accountOf(scope.current as 'a' | 'b'), undefined, scope),
  });
  const scopeLine = (html: string) => (/data-testid="claude-account-scope"[^>]*>([^]*?)<\/p>/.exec(html) ?? [])[1]?.replace(/<[^>]+>/g, '');

  // b picked in the switcher, then All instances (selectAllInstances keeps scope.current: web/src/api.ts).
  const b = r.scopeOf(hub, 'b', false);
  assert.equal(view(b).header, 'beta-proj', 'b picked: the header names its project');
  const all = r.scopeOf(hub, b.current, true);
  const shown = view(all);
  assert.equal(shown.header, 'All instances', 'All instances: the header says so, not b');
  assert.match(scopeLine(shown.account) ?? '', /every instance on this machine \(a, b\)/, "All instances: the Claude account panel's scope line covers every instance");
  assert.doesNotMatch(scopeLine(shown.account) ?? '', /\bb\b(?!\))/, 'and not b alone');
  assert.doesNotMatch(shown.account, /only b&#x27;s|for b\b/, 'no copy names b as the one the panel is for');
  // How an agent user is signed in (as that user, on the machine) is the same under All.
  assert.match(shown.account, /data-testid="claude-account-signin-command">sudo -u &lt;agent user&gt; -i claude auth login</);

  // One instance again: its name in the header and in the panel.
  const a = r.scopeOf(hub, 'a', false);
  const back = view(a);
  assert.equal(back.header, 'alpha-proj', 'a picked: the header names its project');
  assert.match(scopeLine(back.account) ?? '', /^For a: /, "a picked: the panel's scope line names a");
  assert.doesNotMatch(scopeLine(back.account) ?? '', /every instance on this machine \(/);
});

test('#711, #736: the Claude account panel takes no credential and offers no account step: no password field, no switch, add, profile or sign-in form; the sign-in command and the leftovers\' root step instead', () => {
  const data = {
    machineOwner: true,
    machineOwners: ['example-owner'],
    login: 'example-owner',
    instance: 'a',
    allowed: true,
    why: null,
    status: null,
    requests: [],
    signin: 'sudo -u <agent user> -i claude auth login',
    retired: { files: ['profiles.json', 'switch.jsonl'], refused: ['a'], unreadable: false, command: 'sudo bash /opt/engine/scripts/setup/claude-account.sh uninstall' },
  };
  const html = r.renderClaudeAccount(data, undefined, r.scopeOf({ instances: [{ name: 'a', up: true, error: null }] }, 'a', false));
  assert.doesNotMatch(html, /type="password"|<input|<textarea/, 'no field a credential could be typed into');
  for (const id of ['claude-switch', 'claude-switch-token', 'claude-switch-token-send', 'claude-account-switch', 'claude-account-switch-confirm', 'claude-account-switch-howto', 'claude-profile-add', 'claude-profile-token', 'claude-profiles', 'claude-profile-use-here', 'claude-profile-remove', 'claude-failover', 'claude-signin', 'claude-signin-code']) assert.ok(!html.includes(`data-testid="${id}"`), id);
  assert.equal([...html.matchAll(/<button/g)].length, 1, 'Refresh, and nothing else');
  assert.match(html, /data-testid="claude-account-signin-command">sudo -u &lt;agent user&gt; -i claude auth login</);
  assert.match(html, /data-testid="claude-account-retired"[\s\S]*profiles\.json, switch\.jsonl[\s\S]*data-testid="claude-account-retired-refused"[^>]*>[^<]*another profile: a\.[\s\S]*data-testid="claude-account-retired-command">sudo bash \/opt\/engine\/scripts\/setup\/claude-account\.sh uninstall</);
  // Nothing left: no notice.
  assert.doesNotMatch(r.renderClaudeAccount({ ...data, retired: null }), /claude-account-retired/);
});

test('#711: no page source sends to a removed credential route, or asks the switch or a relayed sign-in to start', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
  const files = walk(join(repoRoot, 'web', 'src'));
  assert.ok(files.length > 20, 'the page sources were found');
  const found: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const route of REMOVED_CREDENTIAL_PATHS) if (s.includes(route)) found.push(`${f}: ${route}`);
    // The machine requests the server half refuses: a switch (it waits for a token) and a relayed sign-in.
    if (startsRefused(s, 'switch')) found.push(`${f}: starts a switch`);
    if (startsRefused(s, 'login')) found.push(`${f}: starts a relayed sign-in`);
  }
  assert.deepEqual(found, []);
});

/**
 * Whether a page source asks the machine to start `action`: a call with it as an argument (`act('switch')`,
 * `claudeAccountAction('switch')`, `run(() => claudeProfileAction('login', n))`), or an `action` typed or set to it
 * (`action: 'status' | 'switch'`, `{ action: 'switch' }`). Not a step or op name that only displays one.
 */
function startsRefused(s: string, action: string): boolean {
  const lit = `['"\`]${action}['"\`]`;
  const call = new RegExp(`\\b(?:act|run|claudeAccountAction|claudeProfileAction)\\(\\s*${lit}`);
  const typed = new RegExp(`\\baction\\??\\s*:\\s*(?:['"\`][\\w-]+['"\`]\\s*\\|\\s*)*${lit}`);
  return call.test(s) || typed.test(s);
}

test("#711: the page-source scan flags each way #749's page started a switch or a relayed sign-in, and not a step or op that names one", () => {
  for (const s of ["onClick={() => void act('switch')}", "const act = async (action: 'status' | 'switch') => {", "export const claudeAccountAction = (action: 'status' | 'switch') => api()", "claudeAccountAction('switch')", "body: JSON.stringify({ action: 'switch' })"]) assert.ok(startsRefused(s, 'switch'), s);
  for (const s of ["if (n) void run(() => claudeProfileAction('login', n));", "export const claudeProfileAction = (action: 'use' | 'remove' | 'login', profile: string) => api()"]) assert.ok(startsRefused(s, 'login'), s);
  for (const s of ["step: 'switch' | 'pause' | 'token'", "Pick<ClaudeAccountData, 'switch' | 'requests'>", "op: 'profile-add' | 'use' | 'remove' | 'login';", "const act = async (action: 'status') => {"]) assert.ok(!startsRefused(s, 'switch') && !startsRefused(s, 'login'), s);
});

test('Claude account: a machine owner sees each agent user, never a token box (#711), and a switch an older engine left is not followed (#736); anyone else nothing', () => {
  const ownersFile = machineOwnersFile('ada');
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-render-'));
  const at = new Date().toISOString();
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ at, users: [{ instance: 'shop', kind: 'agent', user: 'wl-shop-agent', stored: true, logged_in: true, auth_method: 'claude.ai', account: 'agents@example.com', token_id: '0123abcd', expires_at: new Date(Date.now() + 200 * 86_400_000).toISOString() }, { instance: 'shop', kind: 'eval', user: 'wl-shop-eval', stored: false, logged_in: false, auth_method: 'none', error: 'claude auth status says it is not logged in' }] }));
  // An older engine's switch, waiting for its token at a root shell.
  writeFileSync(join(dir, 'switch.jsonl'), [{ step: 'switch', state: 'started', detail: '2 instance(s): shop web' }, { step: 'pause', state: 'done', instance: 'shop', detail: 'starts no more runs' }, { step: 'token', state: 'ask', detail: 'paste it' }].map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  const view = (login: string, instance = 'shop') => claudeAccountView({ dir, events: [], who: { role: 'owner', requester: ownerRequester(login) }, instance, ownersFile });
  const html = r.renderClaudeAccount(view('ada'));
  for (const id of ['claude-account', 'claude-account-users', 'claude-account-refresh', 'claude-account-signin-howto', 'claude-account-retired']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.doesNotMatch(html, /data-testid="claude-switch/, 'no switch is followed, and no box');
  assert.match(html, /data-testid="claude-account-user" data-user="wl-shop-agent" data-signed-in="yes"/);
  assert.match(html, /agents@example\.com/);
  assert.match(html, /token 0123abcd/);
  assert.match(html, /data-user="wl-shop-eval" data-signed-in="no"[\s\S]*not logged in/);
  assert.match(html, /data-testid="claude-account-retired"[\s\S]*switch\.jsonl/);
  assert.doesNotMatch(html, /claude-account-retired-refused/, 'a switch left over refuses no instance');
  // Not a machine owner: nothing at all (the server refuses them the data too).
  assert.equal(r.renderClaudeAccount(view('ivy')), '');
});

test("#567: each role's Machine page and sign-in banner, from what the server sent that role: a viewer sees that an account is set and nothing naming it", { skip: process.platform === 'win32' }, async () => {
  const { d, get } = await accountDashboard();
  try {
    const now = Date.parse('2026-10-18T10:00:00Z');
    const seen = async (login: string) => {
      const state = JSON.parse((await get('/api/state', asPerson(login))).text) as { claudeAccount?: unknown };
      const usage = JSON.parse((await get('/api/usage', asPerson(login))).text) as unknown;
      // The Machine page's account part: the full panel for a machine owner, else whether an account is set.
      const panel = await get('/api/claude-account', asPerson(login));
      const machine = panel.status === 200 ? r.renderClaudeAccount(JSON.parse(panel.text), now) : r.renderClaudeAccountSet(state);
      return { machine, banner: r.renderUsageBanner([usage], now), state };
    };
    const viewer = await seen('someone-else');
    assert.match(viewer.machine, /data-testid="claude-account-set" data-set="true"/);
    assert.match(viewer.machine, /An account is set for this instance&#x27;s agents\./);
    assert.match(viewer.banner, /data-testid="signin-banner"/, 'a viewer still sees that runs are held on a refused login');
    assert.match(viewer.banner, /Claude refused this instance&#x27;s Claude login/);
    assert.doesNotMatch(viewer.banner, /Claude said|signin-recheck/);
    for (const html of [viewer.machine, viewer.banner]) assert.doesNotMatch(html, ACCOUNT_TEXT);
    const writer = await seen('example-collaborator');
    assert.match(writer.machine, /data-testid="claude-account-set" data-set="true"/);
    assert.doesNotMatch(writer.machine, ACCOUNT_TEXT, 'the accounts are the machine owners');
    assert.match(writer.banner, new RegExp(`Claude refused the login <span[^>]*>${ACCOUNT.email.replace(/[.]/g, '\\.')}</span>`));
    assert.match(writer.banner, /Claude said: .*OAuth token has expired/);
    const owner = await seen('example-owner');
    assert.match(owner.machine, /data-testid="claude-account"/);
    assert.doesNotMatch(owner.machine, /claude-account-set/);
    assert.match(owner.machine, new RegExp(ACCOUNT.email.replace(/[.]/g, '\\.')));
    // The fixture's profiles.json is an older engine's leftover now (#736): named for what it is, never its profile.
    assert.match(owner.machine, /data-testid="claude-account-retired"/);
    assert.match(owner.banner, /data-testid="signin-recheck"/);
    // What the line says when no account is signed in, when the machine hasn't said, and with no answer at all.
    assert.match(r.renderClaudeAccountSet({ claudeAccount: { set: false } }), /data-set="false"[\s\S]*No account is signed in/);
    assert.match(r.renderClaudeAccountSet({ claudeAccount: { set: null } }), /data-set="unknown"[\s\S]*Not known yet/);
    assert.equal(r.renderClaudeAccountSet({ claudeAccount: null }), '');
  } finally {
    await d.close();
  }
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

test("delegation summary: each category's record, time to approve and who approved, every approver's history, and the suggestions; protected ones say never suggested", async () => {
  const { delegationView } = await import('../src/delegation.js');
  const ev = (type: string, payload: object) => ({ ts: '2026-10-12T10:00:00.000Z', type, payload });
  const held = (pr: number, categories: string[], by: string, role: string, waitMs: number) => ev('delegation.observed', { pr, issue: pr + 100, categories, unchanged: true, held: true, approved_by: by, approver_role: role, wait_ms: waitMs });
  const review = { levels: { L3_human: { when: ['migration'] } }, merge: { wait_categories: ['copy', 'agent-instructions'], loosened: [] } };
  const view = delegationView(
    [held(1, ['copy'], 'example-owner', 'owner', 3_600_000), held(2, ['copy', 'agent-instructions'], 'example-collaborator', 'writer', 1_800_000), ev('delegation.suggested', { category: 'copy', direction: 'loosen', decision: 'd-1', receipts: ['r'] })],
    review,
  );
  const html = r.renderDelegation({ enabled: true, minClean: 2, ...view });
  assert.match(html, /data-testid="delegation-state">suggest-only</);
  assert.match(html, /data-category="agent-instructions"[\s\S]*?Never suggested/);
  assert.match(html, /data-category="copy"[\s\S]*?Waits for you[\s\S]*?2 PRs since the last answer: 2 approved unchanged, 0 changed[\s\S]*?2 waited for a person; time to approve: median 45m \(fastest 30m, slowest 1h 0m\)[\s\S]*?approved by @example-collaborator \(writer\) 1 of 1 unchanged, @example-owner \(owner\) 1 of 1 unchanged/);
  assert.match(html, /data-testid="delegation-approver" data-by="example-collaborator"[\s\S]*?@example-collaborator \(writer\)<\/span>: 1 approved, 1 unchanged · median 30m to approve · agent-instructions, copy/);
  assert.match(html, /data-testid="delegation-suggestion" data-answer=""[\s\S]*?Stop waiting on[\s\S]*?copy[\s\S]*?href="\/decisions\/d-1"[^>]*>waiting for your answer/);
  const off = r.renderDelegation({ enabled: false, minClean: null, categories: [], approvers: [], suggestions: [] });
  assert.match(off, /data-testid="delegation-state">off</);
  assert.match(off, /Suggestions are off for this instance/);
  assert.match(off, /data-testid="delegation-empty"/);
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
  assert.match(url, /dashboards\.sh \[--machine-devices [^\]]*\] --client-id .* \[--siri [^\]]*\] \[--hooks [^\]]*\]/);
  // All done: nothing is next; each step can be run again.
  const done = r.renderTailscaleSetup(view('ada', st({ hubUrl: `https://${name}` })));
  assert.match(done, /data-testid="tailscale-setup" data-next="none"/);
  assert.equal([...done.matchAll(/Run again…/g)].length, 4);
  // Off an allowed device: read-only, and it says why.
  const away = r.renderTailscaleSetup(tailscaleView({ status: none, dir: dirOf([]), events: [], who: { role: 'owner', requester: { login: 'ada', breakGlass: false, deviceOk: false } }, instance: 'shop', ownersFile }));
  assert.match(away, /data-testid="tailscale-disabled"[^>]*>Read-only: a machine change needs one of the machine&#x27;s allowed devices \(dashboards\.sh --machine-devices\)/);
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

test("#468 config PRs: open with Merge here (the command, as the approver's, before Confirm); merged with who, when and the checkout's commit; merged but not synced, why and Fast-forward now or the command; closed, said; writers can't act", () => {
  const base = { url: 'https://github.com/example-org/example-shop/pull/7', kind: 'config', base: 'main', mergedBy: null, mergedAt: null, synced: false, sha: null, why: null, retry: false, command: null, checkedAt: null };
  const open = r.renderConfigPrs([{ ...base, number: 7, state: 'open' }]);
  assert.match(open, /data-testid="config-prs"[\s\S]*?data-testid="config-pr" data-number="7" data-state="open"[\s\S]*?Config PR #(<!-- -->)?7[\s\S]*?data-testid="config-pr-merge-review"[^>]*>Merge PR #(<!-- -->)?7(<!-- -->)? here…/);
  assert.doesNotMatch(r.renderConfigPrs([{ ...base, number: 7, state: 'open' }], { canAct: false }), /config-pr-merge-review/);
  const confirming = r.renderConfigPrs([{ ...base, number: 7, state: 'open' }], { plan: { command: 'gh pr merge 7 --repo example-org/example-shop --squash --subject x (#7), approved by example-owner on the first-run page --body ', then: "then this checkout's main is fast-forwarded to origin's" } });
  assert.match(confirming, /data-testid="config-pr-merge-confirming"[\s\S]*?as your approval[\s\S]*?approved by example-owner[\s\S]*?data-testid="config-pr-merge-confirm"[^>]*>Confirm merge[\s\S]*?data-testid="config-pr-merge-cancel"/);
  const done = r.renderConfigPrs([{ ...base, number: 1, kind: 'setup', state: 'merged', synced: true, mergedBy: 'example-owner', mergedAt: '2026-10-15T12:00:00Z', sha: 'abcdef1234567890' }]);
  assert.match(done, /The setup PR #(<!-- -->)?1[\s\S]*?merged, in this checkout[\s\S]*?data-testid="config-pr-done"[^>]*>Merged(<!-- -->)? by @example-owner(<!-- -->)? at [^<]+[\s\S]*?checkout at <span[^>]*>abcdef1<\/span>/);
  assert.doesNotMatch(done, /config-pr-merge-review|isn(&#x27;|')t open/, 'merged is never offered as an error');
  const dirty = r.renderConfigPrs([{ ...base, number: 2, state: 'merged', why: 'this checkout has uncommitted changes (1 file(s): README.md)', retry: true, command: 'git pull --ff-only origin main' }]);
  assert.match(dirty, /data-testid="config-pr-why"[\s\S]*?uncommitted changes \(1 file\(s\): README\.md\)[\s\S]*?data-testid="config-pr-sync"[^>]*>Fast-forward now/);
  const diverged = r.renderConfigPrs([{ ...base, number: 3, state: 'merged', why: 'it diverged', retry: false, command: 'git log origin/main..main' }]);
  assert.match(diverged, /data-testid="config-pr-command"[^>]*>git log origin\/main\.\.main</);
  assert.doesNotMatch(diverged, /config-pr-sync/);
  assert.match(r.renderConfigPrs([{ ...base, number: 4, state: 'closed', why: 'PR #4 was closed without merging: nothing changed; propose it again' }]), /closed without merging/);
});

test('#468 the draft preview: the summary and the files rendered from the same draft agree; Confirm and Change; Change is the Repo config form on the draft', async () => {
  const { draftView } = await import('../src/setup-mode.js');
  const { scaffoldConfig } = await import('../src/install.js');
  const { parse } = await import('yaml');
  const root = mkdtempSync(join(tmpdir(), 'web-render-draft-'));
  const dir = join(root, BRAND.configDir);
  scaffoldConfig(dir, { name: 'example-shop', repo: 'example-org/example-shop', defaultBranch: 'main', owner: 'example-owner' });
  const yaml = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const held = draftView(root, { branch: 'main', base: 'a'.repeat(40), owner: 'example-owner', yaml, body: 'x', at: '2026-10-15T12:00:00Z' })!;
  const html = r.renderDraftPreview(held);
  // The files as rendered, read back, against the summary as rendered: the same draft.
  const files = Object.fromEntries([...html.matchAll(/data-testid="draft-file" data-file="([^"]+)"><summary[^>]*>[^<]*<\/summary><pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => [m[1], parse(m[2]!.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))]));
  assert.deepEqual(Object.keys(files).sort(), Object.keys(yaml).sort(), 'every drafted YAML file, read-only');
  const text = (id: string) => html.match(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</div>`))![1]!.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
  assert.match(text('draft-summary-owners'), new RegExp(`owner @${files['config.yaml'].owners.default}; writers ${files['config.yaml'].owners.writers.map((w: string) => `@${w}`).join(', ')}`));
  assert.match(text('draft-summary-budget'), new RegExp(`\\$${files['agents.yaml'].daily_budget_usd}$`));
  for (const [role, x] of Object.entries(files['agents.yaml'].roles as Record<string, { enabled: boolean; model: string }>)) {
    if (x.enabled) assert.match(text('draft-summary-models'), new RegExp(`${role}: ${x.model}`));
    else assert.doesNotMatch(text('draft-summary-models'), new RegExp(`${role}:`));
  }
  assert.match(text('draft-summary-tests'), new RegExp(`full: ${files['tests.yaml'].runner.full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const c of files['review.yaml'].levels.L3_human.when) assert.match(text('draft-summary-waits'), new RegExp(c));
  assert.match(html, /data-testid="draft-confirm"[^>]*>Confirm<[\s\S]*?data-testid="draft-change-button"[^>]*>Change</);
  assert.doesNotMatch(r.renderDraftPreview(held, { canEdit: false }), /draft-confirm/);
  const change = r.renderDraftPreview(held, { changing: true });
  assert.match(change, /data-testid="draft-change"[\s\S]*?data-testid="repo-config-form"[\s\S]*?nothing is pushed until you Confirm the preview[\s\S]*?data-testid="repo-config-budget"[^>]*value="40"[\s\S]*?data-testid="repo-config-draft-back"/);
});

test("#468 the Repo config form's worker model: a dropdown of exactly the server's list, the default marked; a hand-edited value shown with a warning, not replaced", () => {
  const c = { values: { writers: ['example-owner'], required_checks: ['test'], daily_budget_usd: 40, workers_count: 1, workers_model: 'opus' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop', models: ['haiku', 'sonnet', 'opus'], defaultModel: 'sonnet' };
  const html = r.renderRepoConfigForm(c);
  const select = html.match(/<select[^>]*data-testid="repo-config-workers-model"[^>]*>([\s\S]*?)<\/select>/)!;
  assert.deepEqual([...select[1]!.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]), [['haiku', 'haiku'], ['sonnet', 'sonnet (default)'], ['opus', 'opus']]);
  assert.doesNotMatch(html, /repo-config-model-warning/);
  const odd = r.renderRepoConfigForm({ ...c, values: { ...c.values, workers_model: 'gpt-5' }, modelListed: false });
  assert.match(odd, /<option value="gpt-5"[^>]*data-testid="repo-config-model-unknown"[^>]*>gpt-5 \(not listed\)/);
  assert.match(odd, /data-testid="repo-config-model-warning"[^>]*>The config names a worker model the engine doesn(&#x27;|')t list \(gpt-5\): it is kept as it is unless you pick another/);
  // #468 (the owner): a full Anthropic model id counts as listed: shown as itself, no warning.
  const full = r.renderRepoConfigForm({ ...c, values: { ...c.values, workers_model: 'claude-sonnet-4-5' }, modelListed: true });
  assert.match(full, /<option value="claude-sonnet-4-5"[^>]*>claude-sonnet-4-5<\/option>/);
  assert.doesNotMatch(full, /repo-config-model-warning|repo-config-model-unknown/);
});

test('Tailscale: the read that shows a step ended offers the next step at once, from the status after it, with no wait for the idle poll', { skip: process.platform === 'win32' }, async () => {
  // Put together here so the repo holds no tailnet name, even a made-up one (the denylist's rule).
  const name = ['box', 'tail0example', 'ts', 'net'].join('.');
  const st = (over: Partial<TailscaleStatus>): TailscaleStatus => ({ installed: true, version: '1.104.1', pinnedVersion: '1.104.1', state: 'Running', name, https: true, serve: false, other443: false, breakGlassForwarded: false, funnel: false, hubUrl: 'https://hub.example.test', ...over });
  let tailscale = st({ state: 'NeedsLogin', name: null, https: false });
  const tsDir = mkdtempSync(join(tmpdir(), 'tailscale-ended-'));
  const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const line = (state: string, detail: string) => `${JSON.stringify({ at: at(), step: 'up', state, detail })}\n`;
  writeFileSync(join(tsDir, 'steps.jsonl'), line('started', '') + line('running', 'tailscale up (no auth key)') + line('waiting', 'the login link is in alpha\'s dashboard'));
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-ended-dash-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, instance: 'alpha', machineOwnersFile: machineOwnersFile('example-owner'), tailscaleDir: tsDir, tailscaleStatus: async () => tailscale, slotsDir: join(dir, 'slots') });
  const read = async () => {
    const res = await fetch(`${d.url.split('/?')[0]!}/api/tailscale`, { headers: { authorization: `Bearer ${d.token}`, ...asDevicePerson('example-owner') } });
    assert.equal(res.status, 200);
    return (await res.json()) as { next: string | null; run: { status: string }; busy: string | null; steps: { id: string; blocked: string | null }[] };
  };
  const serveButton = (html: string) => /data-step="serve"[^]*?<button([^>]*)data-testid="tailscale-step-run"/.exec(html)![1]!;
  try {
    // up is waiting on the owner: the card polls at its busy pace, and serve can't be asked for yet.
    const waiting = await read();
    assert.deepEqual([waiting.run.status, waiting.next], ['waiting', 'up']);
    assert.ok(r.tailscaleBusy(waiting));
    assert.match(serveButton(r.renderTailscaleSetup(waiting)), /disabled=""/);
    // The owner logs in: tailscale is up, and the step's last line is written, all within the status cache's 3 s.
    tailscale = st({});
    appendFileSync(join(tsDir, 'steps.jsonl'), line('done', `on the tailnet as ${name}`));
    // The very next read, with no wait: the step is done, Tailscale's status is the one after it, and serve is offered.
    const ended = await read();
    assert.deepEqual([ended.run.status, ended.next, ended.busy], ['done', 'serve', null]);
    assert.equal(ended.steps.find((s) => s.id === 'serve')!.blocked, null);
    assert.doesNotMatch(serveButton(r.renderTailscaleSetup(ended)), /disabled/, 'the Serve button is enabled on the render after that read');
    // And the card sees the step end, so it reads again at once (fresh) rather than at its idle pace.
    assert.ok(r.tailscaleStepEnded(waiting, ended));
    assert.ok(!r.tailscaleStepEnded(ended, ended), 'only once');
    assert.ok(!r.tailscaleBusy(ended), 'then idle: nothing left running');
  } finally {
    await d.close();
  }
});

test('Tailscale and Claude account: a request handed to its own unit keeps the card at its busy pace until the unit writes its first line', () => {
  const now = Date.parse('2026-10-14T12:00:30Z');
  const req = (over: Record<string, unknown> = {}) => ({ id: 'mr-1', args: ['tailscale', 'serve'], by: 'ada', at: '2026-10-14T12:00:20.500Z', status: 'done', detail: 'started', finishedAt: '2026-10-14T12:00:22Z', ...over });
  const run = (startedAt: string, status = 'done') => ({ step: 'up', startedAt, status, detail: '', lines: [] });
  // The request is done (the unit was started), but the progress file still shows the step before: keep looking.
  assert.ok(r.tailscaleBusy({ run: run('2026-10-14T12:00:01Z'), requests: [req()] }, now));
  assert.ok(r.tailscaleBusy({ run: null, requests: [req()] }, now));
  // The unit's first line is there: from now on its own status decides.
  assert.ok(!r.tailscaleBusy({ run: run('2026-10-14T12:00:21Z'), requests: [req()] }, now));
  assert.ok(r.tailscaleBusy({ run: run('2026-10-14T12:00:21Z', 'running'), requests: [req()] }, now));
  // A refused or failed request starts no unit; and after a minute the unit is taken not to have started.
  assert.ok(!r.tailscaleBusy({ run: run('2026-10-14T12:00:01Z'), requests: [req({ status: 'refused' })] }, now));
  assert.ok(!r.tailscaleBusy({ run: run('2026-10-14T12:00:01Z'), requests: [req()] }, now + 120_000));
  // The Claude account panel starts no unit of its own any more (#736): it looks again only while a request waits or runs.
  assert.ok(r.accountBusy({ requests: [req({ args: ['claude-account', 'status'], status: 'pending' })] }));
  assert.ok(r.accountBusy({ requests: [req({ args: ['claude-account', 'status'], status: 'running' })] }));
  assert.ok(!r.accountBusy({ requests: [req({ args: ['claude-account', 'status'] })] }), 'status runs in the helper itself: no unit to wait for');
});

test("no effect in the web app returns a member call's value: React calls it as the cleanup (scrollIntoView returns a Promise in Chrome)", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  const bad: string[] = [];
  for (const f of files(join(repoRoot, 'web', 'src'))) {
    // An expression-bodied effect may be `void x`, a cleanup `() => ...`, or a call of a plain local function;
    // a member call (`a.b()`, `a?.b()`) returns whatever that API returns.
    for (const m of readFileSync(f, 'utf8').matchAll(/use(?:Layout)?Effect\(\(\) => (?!\{|void |\(\) =>)([^,]*?)\(/g)) if (/[.?]/.test(m[1]!)) bad.push(`${f.slice(repoRoot.length)}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

/** The markup with each reserved slot's contents taken out (its own tag, and so its fixed size, kept). */
function withoutReserved(html: string): string {
  let out = html;
  for (;;) {
    const at = out.search(/<(\w+)[^>]*data-reserved="[^"]*"[^>]*>/);
    if (at < 0) return out;
    const open = /<(\w+)[^>]*>/.exec(out.slice(at))!;
    const tag = open[1]!;
    let depth = 0;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    re.lastIndex = at;
    let end = -1;
    for (let m; (m = re.exec(out)); ) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    assert.ok(end > 0, `unclosed reserved <${tag}>`);
    out = `${out.slice(0, at)}${open[0].replace('data-reserved', 'data-was-reserved')}${out.slice(end)}`;
  }
}

test("the Repo config form: no input moves when GitHub's checks answer arrives after mount", () => {
  const c = { values: { writers: ['example-owner'], required_checks: ['test'], daily_budget_usd: 40, workers_count: 1, workers_model: 'sonnet' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop' };
  const loading = r.renderRepoConfigForm(c);
  assert.match(loading, /data-testid="repo-config-checks-status"[^>]*>checking GitHub…</);
  const states = {
    'checks arrived': r.renderRepoConfigForm(c, { seenLoaded: true, seen: ['ci/test', 'ci/lint', 'ci/e2e', 'ci/docs', 'ci/build', 'ci/typecheck'] }),
    'no checks ran': r.renderRepoConfigForm(c, { seenLoaded: true, seenNote: 'GitHub ran no checks on its tip' }),
    'GitHub refused': r.renderRepoConfigForm(c, { seenLoaded: true, seenNote: "GitHub didn't answer: HTTP 502" }),
  };
  assert.match(states['no checks ran'], /data-testid="repo-config-checks-status"[^>]*>GitHub ran no checks on its tip</);
  assert.match(states['checks arrived'], /data-check="ci\/typecheck"/);
  // Everything above each field is the same markup before and after, apart from what is inside the reserved slots.
  const inputs = [...loading.matchAll(/<input[^>]*data-testid="([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(inputs.includes('repo-config-check-name') && inputs.includes('repo-config-budget'), inputs.join(', '));
  const above = (html: string, id: string) => withoutReserved(html.slice(0, html.indexOf(`data-testid="${id}"`)));
  for (const [what, html] of Object.entries(states)) for (const id of inputs) assert.equal(above(html, id), above(loading, id), `${id} moves once ${what}`);
  // And the slots are of a fixed size: one truncated line, and a list that scrolls in its own height.
  assert.match(loading, /class="block h-5 truncate[^"]*" data-reserved="status"/);
  assert.match(loading, /class="h-\[4\.75rem\] overflow-y-auto[^"]*" data-reserved="checks"/);
});

test('#569 the Repo config form\'s checks note names the short sha of the tip with no checks yet; a re-read that finds checks on a new tip replaces it, the old sha gone', () => {
  const c = { values: { writers: ['example-owner'], required_checks: ['test'], daily_budget_usd: 40, workers_count: 1, workers_model: 'sonnet' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop' };
  const old = '0123456789abcdef0123456789abcdef01234567';
  const tip = 'fedcba9876543210fedcba9876543210fedcba98';
  const status = (html: string) => /data-testid="repo-config-checks-status"[^>]*>([^<]*)</.exec(html)?.[1]?.replaceAll('&#x27;', "'");
  const form = (slot: { seen: string[]; note: string | null }) => r.renderRepoConfigForm(c, { seenLoaded: true, seen: slot.seen, ...(slot.note === null ? {} : { seenNote: slot.note }) });
  // The first read: GitHub ran nothing on the tip, named by its first 7 characters.
  const empty = r.checksSeenSlot({ checks: [], sha: old }, false);
  assert.deepEqual(empty, { seen: [], note: 'no checks yet on 0123456' });
  const before = form(empty);
  assert.equal(status(before), 'no checks yet on 0123456');
  // With no required check chosen yet, the starter CI below is pointed to, after the same words.
  assert.equal(r.checksSeenSlot({ checks: [], sha: old }, true).note, 'no checks yet on 0123456: add a starter CI below');
  // The re-read after a refresh or a merge: a new tip, with a check. The note is replaced and the old sha is gone.
  const ran = r.checksSeenSlot({ checks: ['test', 'lint'], sha: tip }, false);
  assert.deepEqual(ran, { seen: ['test', 'lint'], note: null });
  const after = form(ran);
  assert.equal(status(after), "the checks GitHub ran on main's tip are offered below");
  assert.doesNotMatch(after, /0123456/, 'the old tip is named nowhere');
  assert.match(after, /data-check="lint"/);
  // The endpoint's own errors are shown as they are (it sends no sha with them).
  assert.deepEqual(r.checksSeenSlot({ checks: [], error: "origin/main isn't fetched here" }, true), { seen: [], note: "origin/main isn't fetched here" });
  assert.deepEqual(r.checksSeenSlot({ checks: [], error: "GitHub didn't answer: HTTP 502" }, false), { seen: [], note: "GitHub didn't answer: HTTP 502" });
  // The layout invariant holds for the new note: nothing above an input differs from the loading form but the slots' contents.
  const loading = r.renderRepoConfigForm(c);
  const inputs = [...loading.matchAll(/<input[^>]*data-testid="([a-z-]+)"/g)].map((m) => m[1]!);
  const above = (html: string, id: string) => withoutReserved(html.slice(0, html.indexOf(`data-testid="${id}"`)));
  for (const html of [before, after]) for (const id of inputs) assert.equal(above(html, id), above(loading, id), `${id} moves`);
  assert.match(before, /class="block h-5 truncate[^"]*" data-reserved="status"/);
});

test("the Repo config form with no required check (#469): the starter CI, last in the form; its summary and file; Confirm is GitHub's new-file page with the file; once it ran on main, the step says its check is selected", () => {
  const c = { values: { writers: ['example-owner'], required_checks: [], daily_budget_usd: 40, workers_count: 1, workers_model: 'sonnet' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop' };
  const file = 'name: ci\njobs:\n  test:\n    name: test\n';
  const view: StarterCiView = { path: '.github/workflows/ci.yml', check: 'test', summary: 'Runs `npm test` on Node 22 for every PR and every push to main, as the check `test`, with read-only permissions.', file, placeholder: false, command: 'npm test', branch: 'main', newFile: 'https://github.com/example-org/example-shop/new/main?filename=.github%2Fworkflows%2Fci.yml', onBranch: false, firstRun: { state: 'none', conclusion: null }, noCi: { offered: false, means: 'No CI (ci: none): …', why: 'needs test_run: add the starter CI' } };
  const closed = r.renderRepoConfigForm(c, { starter: view });
  assert.match(closed, /data-testid="starter-ci-add"/);
  assert.doesNotMatch(closed, /starter-ci-preview/);
  // Last in the form: everything above it is the form as it was without it.
  assert.ok(closed.indexOf('data-testid="starter-ci"') > closed.indexOf('data-testid="repo-config-review"'));
  const open = r.renderRepoConfigForm(c, { starter: view, starterOpen: true });
  assert.match(open, /data-testid="starter-ci-summary"[^>]*>Runs `npm test` on Node 22 for every PR and every push to main/);
  assert.match(open, /data-testid="starter-ci-file"[^>]*>name: ci\njobs:/);
  const href = /<a href="([^"]+)"[^>]*data-testid="starter-ci-confirm"/.exec(open)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(href, 'Confirm is a link');
  const u = new URL(href);
  assert.equal(`${u.origin}${u.pathname}`, 'https://github.com/example-org/example-shop/new/main');
  assert.equal(u.searchParams.get('filename'), '.github/workflows/ci.yml');
  assert.equal(u.searchParams.get('value'), file);
  assert.match(open, /target="_blank"/);
  assert.match(open, /data-testid="starter-ci-change"/);
  assert.match(open, /you commit it and open the PR as yourself; nothing here writes a workflow/);
  const ran = r.renderRepoConfigForm(c, { starter: { ...view, onBranch: true, firstRun: { state: 'done', conclusion: 'success' } } });
  assert.match(ran, /data-testid="starter-ci-status" data-state="done"[^>]*>The workflow&#x27;s check test finished on main \(success\): it is selected above as a required check\. Review the change, then propose it\./);
  // A server's instance (no form): the same panel, and once it ran, what to name in config.yaml through a PR.
  assert.match(r.renderStarterCi(view), /data-testid="starter-ci-add"/);
  assert.match(r.renderStarterCi({ ...view, onBranch: true, firstRun: { state: 'done', conclusion: 'failure' } }), /finished on main \(failure\): name it in config\.yaml required_checks \(required_checks: \[test\]\) through a PR, and merge it\./);
  // No CI (#469): not offered without test_run, saying why; offered with it, saying what it means; a server gets the lines.
  assert.match(open, /data-testid="no-ci" data-offered="false"[\s\S]*data-testid="no-ci-refused"[^>]*>No CI isn&#x27;t offered here: needs test_run: add the starter CI</);
  const offered = { ...view, noCi: { offered: true, means: "No CI (ci: none): a PR is ready when this machine's test runs pass", why: null } };
  const inForm = r.renderRepoConfigForm(c, { starter: offered });
  assert.match(inForm, /data-testid="no-ci-means"[^>]*>Or choose No CI \(ci: none\): a PR is ready when this machine&#x27;s test runs pass\.</);
  assert.match(inForm, /data-testid="no-ci-choose"/);
  assert.match(r.renderStarterCi(offered), /data-testid="no-ci-lines"[^>]*># config\.yaml, through a PR:\nci: none\nrequired_checks: \[\]</);
  // A config already on No CI has no starter CI to offer.
  assert.doesNotMatch(r.renderRepoConfigForm({ ...c, values: { ...c.values, ci: 'none' } }, { starter: offered }), /starter-ci/);
  // The PR and Land pages' note, only under No CI.
  assert.match(r.renderCiNote({ kind: 'none', means: 'No CI (ci: none): …' }), /data-testid="ci-none-note"[^>]*>No CI \(ci: none\): …\. The main watch can&#x27;t judge merges by checks; auto-merge relies on this machine&#x27;s runs, and every tier runs on each merge commit on main, which is judged by them\.</);
  assert.equal(r.renderCiNote({ kind: 'github', means: null }), '');
  assert.equal(r.renderCiNote(undefined), '');
  // A config that names a check has nothing to add: no starter CI.
  assert.doesNotMatch(r.renderRepoConfigForm({ ...c, values: { ...c.values, required_checks: ['ci'] } }, { starter: view }), /starter-ci/);
});

/** A goal's graph as GET /api/goal-graph serves it (src/goal-graph.ts): 11 first, 12 and 14 after it, 13 after 12. */
const GOAL_GRAPH = {
  goal: 10,
  split: true,
  nodes: [
    { issue: 11, key: 'schema', title: 'Add the export schema', status: 'landed', pr: null, run: null, cycle: false, layer: 0 },
    { issue: 12, key: 'api', title: 'Serve the export', status: 'in_review', pr: { number: 120, url: 'https://example.test/pr/120' }, run: 'run-12', cycle: false, layer: 1 },
    { issue: 14, key: 'docs', title: 'Document exports', status: null, pr: null, run: null, cycle: false, layer: 1 },
    { issue: 13, key: 'ui', title: 'Export button', status: 'building', pr: null, run: 'run-13', cycle: false, layer: 2 },
  ],
  edges: [
    { from: 11, to: 12, cycle: false },
    { from: 12, to: 13, cycle: false },
    { from: 11, to: 14, cycle: false },
  ],
  cycles: [] as number[][],
  total: 4,
  capped: false,
};
const attrs = (html: string, testid: string) => [...html.matchAll(new RegExp(`<[a-z]+ [^>]*data-testid="${testid}"[^>]*>`, 'g'))].map((m) => Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));

test("a goal's task graph: a node per task in its state's colours, an edge per dependency, each node a focusable link to its PR, run or issue", () => {
  const html = r.renderGoalGraph(GOAL_GRAPH);
  const nodes = attrs(html, 'goal-graph-node');
  assert.deepEqual(nodes.map((n) => [n['data-issue'], n['data-status']]), [['11', 'landed'], ['12', 'in_review'], ['14', 'unseen'], ['13', 'building']]);
  const edges = attrs(html, 'goal-graph-edge');
  assert.deepEqual(edges.map((e) => `${e['data-from']}>${e['data-to']}`).sort(), ['11>12', '11>14', '12>13']);
  // The state is written on the node, in the colour tokens its status badge uses (landed green, building blue).
  assert.match(html, /Landed<\/text>/);
  assert.match(html, /Building<\/text>/);
  assert.match(html, /Not seen yet<\/text>/);
  assert.match(html, /fill:var\(--green-tint\)/);
  assert.match(html, /fill:var\(--blue-tint\)/);
  // Click targets: the PR's recorded URL (new tab), else its latest run, else its issue page; links are focusable.
  const by = Object.fromEntries(nodes.map((n) => [n['data-issue'], n]));
  assert.equal(by['12']!.href, 'https://example.test/pr/120');
  assert.equal(by['12']!['data-target'], 'pr');
  assert.equal(by['12']!.target, '_blank');
  assert.equal(by['13']!.href, '/runs/run-13');
  assert.equal(by['13']!['data-target'], 'run');
  assert.equal(by['11']!.href, '/issues/11');
  assert.equal(by['14']!.href, '/issues/14');
  for (const n of nodes) assert.match(n['aria-label']!, /^#\d+ .+\. Opens /, 'each node says what it is and where it goes');
  // A PR URL that isn't https is never a link: the node goes to its issue instead.
  const bad = r.renderGoalGraph({ ...GOAL_GRAPH, nodes: [{ ...GOAL_GRAPH.nodes[1]!, pr: { number: 1, url: 'javascript:alert(1)' }, run: null }], edges: [] });
  assert.doesNotMatch(bad, /javascript:/);
  assert.match(bad, /href="\/issues\/12"/);
  // Phone width: the graph scrolls inside its own box, never the page.
  assert.match(attrs(html, 'goal-graph-scroll')[0]!.class!, /overflow-x-auto/);
  assert.doesNotMatch(html, /goal-graph-cycles|goal-graph-capped|goal-graph-empty/);
});

test("a goal's task graph: a cycle is flagged on its nodes, its edges and in words; a capped graph says so; an empty one says why", () => {
  const cyc = { ...GOAL_GRAPH, nodes: GOAL_GRAPH.nodes.map((n) => ({ ...n, cycle: n.issue === 12 || n.issue === 13 })), edges: [...GOAL_GRAPH.edges.map((e) => (e.from === 12 ? { ...e, cycle: true } : e)), { from: 13, to: 12, cycle: true }], cycles: [[12, 13]] };
  const html = r.renderGoalGraph(cyc);
  assert.match(html, /data-testid="goal-graph-cycles"/);
  assert.match(html, /#12 → #13 → #12/);
  assert.deepEqual(attrs(html, 'goal-graph-node').filter((n) => n['data-cycle'] === 'true').map((n) => n['data-issue']).sort(), ['12', '13']);
  assert.deepEqual(attrs(html, 'goal-graph-edge').filter((e) => e['data-cycle'] === 'true').map((e) => `${e['data-from']}>${e['data-to']}`).sort(), ['12>13', '13>12']);

  assert.match(r.renderGoalGraph({ ...GOAL_GRAPH, total: 75, capped: true }), /Showing 4 of 75 tasks/);

  assert.match(r.renderGoalGraph({ goal: 10, split: false, nodes: [], edges: [], cycles: [], total: 0, capped: false }), /data-testid="goal-graph-empty"[^>]*>No task graph yet/);
  assert.match(r.renderGoalGraph({ goal: 10, split: true, nodes: [], edges: [], cycles: [], total: 0, capped: false }), /This goal&#x27;s split has no tasks/);
});

test("the task graph is on a goal's own page, and only a goal's", () => {
  const t = asOwner.tasks[0]!;
  const withLabels = (labels: (x: State['tasks'][number]) => string[]) => ({ ...asOwner, tasks: asOwner.tasks.map((x) => ({ ...x, labels: labels(x) })) }) as State;
  assert.match(r.renderIssue(withLabels((x) => (x.issue === t.issue ? ['type:goal'] : [])), t.issue), /data-testid="goal-graph"/);
  assert.doesNotMatch(r.renderIssue(withLabels(() => []), t.issue), /data-testid="goal-graph"/);
});

test("a dot for an instance whose incidents couldn't be read is grey (unknown) with why, not red; red stays for an open red incident or one not answering", async () => {
  const view = (status: string) => ({ instance: null, status, open: [], resolved: [], detail: true });
  const hub = { instances: [{ name: 'ok', up: true, error: null }, { name: 'broken', up: true, error: null }, { name: 'refused', up: true, error: null }, { name: 'gone', up: false, error: 'connect ECONNREFUSED' }] };
  const all = await r.loadIncidents(hub, async (name) => {
    if (name === 'refused') throw new Error('sign in first (401)');
    return view(name === 'broken' ? 'red' : 'green');
  });
  assert.deepEqual(r.statusOf(all), { ok: 'green', broken: 'red', refused: 'unknown', gone: 'red' }, 'a read failure is unknown; a red incident and a down instance are red');
  assert.deepEqual(r.whyOf(all), { refused: 'sign in first (401)', gone: "its dashboard isn't answering" });
  // The sidebar: grey, with the error on hover and for screen readers.
  const nav = r.renderInstances(hub, 'ok', false, r.statusOf(all), r.whyOf(all));
  const dots = [...nav.matchAll(/data-status="(\w+)"[^>]*data-testid="instance-dot"[^>]*title="([^"]*)"[^>]*aria-label="([^"]*)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(dots.map((d) => d[0]), ['green', 'red', 'unknown', 'red']);
  assert.match(dots[2]![1]!, /status unknown.*sign in first \(401\)/, 'hover says why');
  assert.equal(dots[2]![2], dots[2]![1], 'and so does the screen-reader label');
  assert.match(dots[3]![2]!, /something is broken.*ECONNREFUSED/);
  // Off a hub, this instance's own dot: grey when its incidents can't be read.
  const g = globalThis as Record<string, unknown>;
  const stub = g.window;
  delete g.window;
  try {
    const own = await r.loadIncidents(null, async () => {
      throw new Error('timed out');
    });
    const drawer = r.renderNavDrawer(asOwner as never, { status: r.statusOf(own), why: r.whyOf(own) } as never);
    assert.match(drawer, /data-status="unknown" data-testid="instance-status-dot" title="status unknown[^"]*\(timed out\)"/);
  } finally {
    g.window = stub;
  }
  // The Health page's chip: the same.
  assert.match(r.renderHealthPage(all), /data-status="unknown" data-testid="health-instance-dot" title="[^"]*sign in first/);
});

test('each health refresh asks the hub again: an instance down at page load is read, and selectable, once it answers', async () => {
  const atLoad = { instances: [{ name: 'a', up: true, error: null }, { name: 'b', up: false, error: 'connect ECONNREFUSED' }] };
  const recovered = { instances: [{ name: 'a', up: true, error: null }, { name: 'b', up: true, error: null }] };
  const asked: (string | null)[] = [];
  const get = async (name: string | null) => (asked.push(name), { instance: name, status: 'green', open: [], resolved: [], detail: true });
  // The first pass, with the list from page load: b is skipped and red.
  const first = await r.healthPass(async () => atLoad, (h) => r.loadIncidents(h, get));
  assert.equal(first.status.b, 'red');
  assert.deepEqual(asked, ['a']);
  // The next pass, with the hub asked again: b is read and green, and its row is no longer disabled.
  const next = await r.healthPass(async () => r.nextHub(first.hub, recovered), (h) => r.loadIncidents(h, get));
  assert.equal(next.status.b, 'green');
  assert.deepEqual(asked, ['a', 'a', 'b']);
  const row = (html: string) => html.split('<button').filter((x) => x.includes('data-testid="instance-row"'))[1] ?? '';
  assert.match(row(r.renderInstances(atLoad, 'a')), /disabled/, 'at load: b is down and can\'t be picked');
  assert.doesNotMatch(row(r.renderInstances(next.hub, 'a', false, next.status)), /disabled|not answering/, 'once it answers: b can be picked');
  // No answer from the hub keeps the last list rather than emptying the sidebar; the same answer keeps the same object.
  assert.equal(r.nextHub(recovered, null), recovered);
  assert.equal(r.nextHub(recovered, JSON.parse(JSON.stringify(recovered))), recovered);
});

test("the coordinator card: current errors once each with a count and since when (the viewer's local time); cleared ones folded as earlier", () => {
  const now = Date.parse('2026-10-14T18:00:00.000Z');
  const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const html = r.renderCoordinatorErrors(
    [{ where: 'dispatch', message: 'fetch failed', kind: 'error', count: 3, first: '2026-10-14T17:00:00.000Z', last: '2026-10-14T17:40:00.000Z', at: '2026-10-14T17:40:00.000Z' }],
    [{ where: 'reconcile', message: 'GitHub 502', kind: 'error', count: 1, first: '2026-10-14T16:00:00.000Z', last: '2026-10-14T16:00:00.000Z', at: '2026-10-14T16:00:00.000Z' }],
    undefined,
    now,
  );
  assert.equal([...html.matchAll(/data-testid="coordinator-error"/g)].length, 1, 'one entry for the three');
  assert.match(html, /data-count="3"[^>]*>[\s\S]*?dispatch: fetch failed[\s\S]*?×3</);
  assert.match(html, new RegExp(`data-testid="coordinator-error-when">3 times since ${t('2026-10-14T17:00:00.000Z')}, last ${t('2026-10-14T17:40:00.000Z')}<`));
  assert.match(html, /<details[^>]*data-testid="coordinator-errors-earlier"(?![^>]*open)/, 'earlier ones: folded');
  assert.match(html, /Earlier, since cleared \(1\)[\s\S]*reconcile: GitHub 502/);
  // A viewer: how many now, never their text.
  assert.match(r.renderCoordinatorErrors(undefined, [], 3, now), /data-testid="coordinator-errors-count"[^>]*>The coordinator is reporting errors now \(3\)/);
  // Nothing current, nothing earlier: nothing shown.
  assert.equal(r.renderCoordinatorErrors([], [], 0, now), '');
});

test("the first-run page's Slack and Linear steps: an empty state with one first action for an owner and no button for a writer; then the steps; who may send never a picker", () => {
  const cred = (credential: string, key: string, title: string, stored = false) => ({ credential, key, title, configured: stored, file: stored ? `/home/example/.config/shop-secrets/${credential}` : null, present: stored, error: null, ask: null });
  const slack = {
    available: true,
    kind: 'slack',
    instance: 'shop',
    canAct: true,
    portal: 'https://api.slack.com/apps',
    creds: [cred('intake-slack-app', 'slack_app_token', 'Paste the Slack app-level token'), cred('intake-slack-bot', 'slack_bot_token', 'Paste the Slack bot token')],
    intake: { file: '/home/example/.local/state/worklane/instances/shop/intake.yaml', exists: false, error: null, values: { 'slack.enabled': false, 'slack.team': null, 'slack.channels': [] }, warnings: [], allowed: 0, trusted: 0 },
    form: [
      { key: 'slack.enabled', kind: 'boolean', what: 'the app connects' },
      { key: 'slack.team', kind: 'team', what: 'the one workspace' },
      { key: 'slack.channels', kind: 'ids', what: 'the channels' },
    ],
    slack: { manifest: '{"settings":{"socket_mode_enabled":true}}', scopes: [{ scope: 'app_mentions:read', why: 'mentions only' }] },
    automation: { token: 'sudo bash /opt/worklane/current/scripts/setup/credentials.sh shop intake-slack', view: 'sudo -H -u wl-shop worklane slack view --instance shop', file: '/home/example/.local/state/worklane/instances/shop/intake.yaml', keys: ['slack.enabled', 'slack.team', 'slack.channels'], restart: 'sudo systemctl restart worklane-shop.service' },
  };
  // Nothing set up: the empty state, what it does, and exactly one action (a link to Slack); no button at all.
  const empty = r.renderSourceSetup(slack);
  assert.match(empty, /data-testid="source-empty" data-source="slack"[\s\S]*?Slack isn(’|&#x27;)t connected[\s\S]*?Socket Mode[\s\S]*?public address/);
  assert.equal((empty.match(/data-testid="source-first-action"/g) ?? []).length, 1);
  assert.match(empty, /href="https:\/\/api\.slack\.com\/apps"[^>]*data-testid="source-first-action"[^>]*>Create the Slack app from the manifest</);
  assert.doesNotMatch(empty, /<button/, 'no other action, and no dead button');
  // A writer: the same words, who sets it up, and nothing to click.
  const writer = r.renderSourceSetup({ ...slack, canAct: false });
  assert.match(writer, /data-testid="source-writer-note"[^>]*>An owner of this instance sets it up here/);
  assert.doesNotMatch(writer, /<button|<a /);
  // Started (or anything stored): the four steps; the paste buttons; no load button before both tokens are stored.
  const steps = r.renderSourceSetup(slack, { started: true });
  for (const id of ['source-step-create', 'source-step-token', 'source-step-pick', 'source-step-restart']) assert.match(steps, new RegExp(`data-testid="${id}"`));
  assert.equal((steps.match(/data-testid="source-token-button"/g) ?? []).length, 2);
  assert.doesNotMatch(steps, /data-testid="source-load"/);
  assert.match(steps, /data-testid="source-manifest"/);
  assert.match(r.renderSourceSetup(slack, { started: true, confirming: 'intake-slack-bot' }), /data-testid="source-token-confirming"[\s\S]*?never the secret[\s\S]*?data-testid="source-token-confirm"/);
  // Stored, the view loaded: the picks, the people to copy, Review; who may send is only counted, never a picker.
  const stored = { ...slack, creds: [cred('intake-slack-app', 'slack_app_token', 'Paste the Slack app-level token', true), cred('intake-slack-bot', 'slack_bot_token', 'Paste the Slack bot token', true)], intake: { ...slack.intake, allowed: 2 } };
  const view = { kind: 'slack', team: { id: 'T0000000001', name: 'Example' }, bot: { user: 'U00000000B0' }, channels: [{ id: 'C0000000001', name: 'ideas', member: true }, { id: 'C0000000002', name: 'random', member: false }], members: [{ id: 'U0000000011', name: 'Ada' }], at: new Date().toISOString() };
  const loaded = r.renderSourceSetup(stored, { view });
  assert.deepEqual([...loaded.matchAll(/data-testid="source-field" data-key="([a-z_.]+)"/g)].map((m) => m[1]), ['slack.enabled', 'slack.team', 'slack.channels']);
  assert.match(loaded, /#random \(invite the bot\)/);
  assert.match(loaded, /data-testid="source-senders-note"[\s\S]*?slack\.allowed_senders[\s\S]*?2 now/);
  assert.match(loaded, /data-testid="source-people"[\s\S]*?U0000000011/);
  assert.match(loaded, /data-testid="source-review"/);
  assert.doesNotMatch(loaded, /data-key="slack\.allowed_senders"/);
  // A writer sees where it stands: no paste, load or review button.
  assert.doesNotMatch(r.renderSourceSetup({ ...stored, canAct: false }, { view }), /source-token-button|source-load"|source-review|source-portal-link/);
  // Linear's empty state names its one action too.
  const linear = { ...slack, kind: 'linear', portal: 'https://linear.app/settings/account/security', creds: [cred('intake-linear', 'linear_api_key', 'Paste the Linear API key')], slack: undefined, linear: { permissions: [{ name: 'Read', why: 'read' }] }, form: [], intake: { ...slack.intake, values: {} } };
  assert.match(r.renderSourceSetup(linear), /Linear isn(’|&#x27;)t connected[\s\S]*?data-testid="source-first-action"[^>]*>Create a Linear API key</);
});

test("the Intake page's sources strip: each source's state and counts; an owner's card links to its step, a writer's says who sets it up", () => {
  const sources = [
    { name: 'discord', state: 'on', detail: '2 channels · 3 may send' },
    { name: 'slack', state: 'none', detail: '0 channels · 0 may send' },
    { name: 'linear', state: 'invalid', detail: 'one label · 1 may send' },
  ];
  const owner = r.renderIntakeSources(sources, true);
  assert.deepEqual([...owner.matchAll(/data-source="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['discord:on', 'slack:none', 'linear:invalid']);
  assert.match(owner, /href="\/first-run\?open=slack"[^>]*>Set up on First run/);
  assert.match(owner, /intake\.yaml refused/);
  const writer = r.renderIntakeSources(sources, false);
  assert.doesNotMatch(writer, /<a /);
  assert.match(writer, /An owner sets this up/);
});

/** #768: names a changed path can have that text can't show as they are: a bidi override, a zero-width space, a newline, a DEL. */
const ODD_PATHS = ['src/\u202eexe.txt', 'src/a\u200bb.js', 'src/a\nb.js', 'src/a\x7fb.js'];
/** No control, format or default-ignorable character: nothing reorders or hides the text around it. */
const RAW_INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** A path as the page's markup holds it: shown (escaped, JSON-quoted), then HTML-escaped. */
const shownHtml = (p: string) => r.shownPath(p).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

test('the web path display is the engine\'s shownPath: they agree on every kind of name (#768)', () => {
  const corpus = [...ODD_PATHS, 'src/a.ts', 'docs/naïve.md', 'docs/releasing.md ', '"src/x.ts', 'src/\u0455rc.ts', '\u0455rc/x.ts', 'src/\ufffd.ts', 'src/\u034f.ts', 'src/a, b.ts', 'src/x\u00a0y.ts', 'src/\ufe0f.ts', ''];
  for (const p of corpus) assert.equal(r.shownPath(p), shownPath(p), JSON.stringify(p));
  assert.equal(r.shownPaths(ODD_PATHS), shownPaths(ODD_PATHS));
  for (const p of ODD_PATHS) assert.doesNotMatch(r.shownPath(p), RAW_INVISIBLE, JSON.stringify(p));
});

test('a changed path with a bidi override, a zero-width, a newline or a DEL shows escaped in every place the dashboard shows one; the data stays raw (#768)', () => {
  const places: [string, string][] = [];
  const at = new Date().toISOString();
  // The decision's page: each section on its own, so each place is checked alone.
  const detail = { id: 'd-odd', kind: 'land', issue: 7, owner: 'example-owner', question: 'Approve landing #7 (L3)?', options: [], recommendation: 'approve', askedAt: at, answer: null, canAnswer: false, ifNothing: 'No timeout: it waits.', withheld: null };
  const change = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: ODD_PATHS.map((path) => ({ path, added: 1, removed: 0 })), filesMore: 0, level: 'L3', levelReasons: [], source: 'log' };
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high', confidenceReason: null, advice: '', unread: ODD_PATHS, unverifiedClaims: [], designChange: null, designReason: null };
  const impact = { flags: [{ flag: 'money-path', files: ODD_PATHS }, { flag: 'auth', files: [] }, { flag: 'secrets', files: [] }], others: [], note: null };
  const findings = (file: string) => ({ list: [{ claim: 'rounds down', evidence: 'x', file, line: 3 }], confidence: 'high', unverified: [] });
  places.push(['decision page: the change\'s file chips', r.renderDecisionDetail({ ...detail, change })]);
  places.push(['decision page: the files the evaluator did not read', r.renderDecisionDetail({ ...detail, verdict })]);
  places.push(['decision page: the impact flags\' file chips', r.renderDecisionDetail({ ...detail, impact })]);
  // The decision card's Details: its findings and impact lines.
  const card = { id: 'd-odd', kind: 'land', issue: 7, owner: 'example-owner', question: 'Approve landing #7 (L3)?', options: ['approve', 'reject'], recommendation: 'approve', askedAt: at, answer: null };
  places.push(['decision card: the impact line', r.renderDecisionCard(card, undefined, { ...detail, impact })]);
  // The PR page: a conflict fix's files, a light check's overlap, a hold's files.
  const pr = { number: 9, issue: 7, title: 'Change', url: 'https://example.test/pr/9', openedAt: at, head: 'a'.repeat(40), state: 'open', draft: false, status: null, unready: null, fixes: [], gaveUp: null, decision: null, waitReasons: [], merged: null, mergeFailed: null, mainResult: null, conflict: null, lightCheck: null, phase: 'waiting' };
  const prs = { prs: [], refused: [], stops: [], holds: [], autoMerge: { on: true, policy: true, repo: true, stopped: null, why: 'on' } };
  places.push(['PR page: a conflict fix\'s files', r.renderPrs({ ...prs, prs: [{ ...pr, conflict: { state: 'done', at, attempt: 1, outcome: 'pushed', files: ODD_PATHS, waitsOwner: false, reasons: [], detail: '' } }] })]);
  places.push(['PR page: a light check\'s overlap', r.renderPrs({ ...prs, prs: [{ ...pr, phase: 'light_check', lightCheck: { state: 'running', at, mainSha: 'f'.repeat(40), overlap: ODD_PATHS, outcome: null, waitMs: null, detail: '' } }] })]);
  places.push(['PR page: a hold\'s files', r.renderPrs({ ...prs, holds: [{ issue: 41, title: 'Round', by: 32, files: ODD_PATHS, reason: '', since: at, until: null, waitedMs: null }] })]);
  // A run's record: its write steps and the files it wrote.
  const run = { id: 'r1', issue: 7, role: 'worker', model: 'sonnet', startedAt: at, endedAt: at, reason: 'succeeded', costUsd: null, turns: 1, steps: ODD_PATHS.map((what) => ({ kind: 'write', tool: 'Write', what, status: 'ok', exitCode: null, output: '' })), files: ODD_PATHS, otherTools: 0, final: '', truncated: false };
  places.push(['run record: its write steps and the files it wrote', r.renderRunSteps(run)]);
  // An experiment's research log: the files a result changed.
  const row = { n: 1, kind: 'exploit', at, hypothesis: 'h', variable: 'v', stage: 1, stage2: [], seeds: 1, motivation: 'm', change: { commit: null, files: ODD_PATHS }, config: {}, minutes: null, waited_s: null, result: null, decision: 'keep', why: '', step: null, parent: null };
  places.push(['experiment log: the files a result changed', r.renderResearchLog([row])]);
  // One path at a time: a finding's file, the health panel's hotspot file, a live diff's file.
  for (const p of ODD_PATHS) {
    places.push([`decision page: a finding's file chip (${shownPath(p)})`, r.renderDecisionDetail({ ...detail, kind: 'question', findings: findings(p) })]);
    places.push([`decision card: a finding's file (${shownPath(p)})`, r.renderDecisionCard(card, undefined, { ...detail, kind: 'question', findings: findings(p) })]);
    const health = { instance: 'shop', machine: null, cores: 4, checks: { timings: [], slowest: [], regressions: [], rule: '' }, usage: { days: [], quotaNote: 'q' }, merge: { since: at, mergedPrs: 1, conflicts: { count: 0, needOwner: 0, minutesToMerged: [], medianMinutes: null, perMergedPr: 0 }, lightChecks: { count: 0, minutesAdded: 0, perMergedPr: 0, outcomes: {} }, holds: { count: 1, minutesWaited: 5, perMergedPr: 5, byFile: [{ file: p, minutes: 5, count: 1 }] }, flags: [] }, suggestions: [] };
    places.push([`health panel: the hotspot file (${shownPath(p)})`, r.renderHealth(health)]);
    places.push([`live run: a diff's file (${shownPath(p)})`, r.renderLiveFeed([{ seq: 1, at, kind: 'diff', id: 't', tool: 'Edit', file: p, diff: '+x' }], false)]);
  }
  // Every place checked, each failure named: a raw character, or a path (each of a list's, the one of a single) not shown escaped.
  const wrong = places.flatMap(([where, html]) => [
    ...(RAW_INVISIBLE.test(html) ? [`${where}: a raw control, format or invisible character`] : []),
    ...(where.includes('(') ? ODD_PATHS.filter((p) => where.includes(`(${shownPath(p)})`)) : ODD_PATHS).filter((p) => !html.includes(shownHtml(p))).map((p) => `${where}: ${JSON.stringify(p)} not shown escaped`),
  ]);
  assert.deepEqual(wrong, []);
  assert.equal(places.length, 9 + 4 * ODD_PATHS.length, 'every place rendered');
  assert.ok(verdict.unread.includes('src/\u202eexe.txt') && change.files[0]!.path === 'src/\u202eexe.txt', 'the data stays raw');
});

test('a plain ASCII changed path shows as itself in the same places (#768)', () => {
  const at = new Date().toISOString();
  const detail = { id: 'd', kind: 'land', issue: 7, owner: 'example-owner', question: 'Q?', options: [], recommendation: 'approve', askedAt: at, answer: null, canAnswer: false, ifNothing: 'No timeout: it waits.', withheld: null };
  const html = r.renderDecisionDetail({ ...detail, change: { base: null, head: null, files: [{ path: 'src/totals.js', added: 1, removed: 0 }], filesMore: 0, level: 'L1', levelReasons: [], source: 'log' }, verdict: { patch_correct: true, test_correct: true, confidence: 'high', confidenceReason: null, advice: '', unread: ['src/cart.js'], unverifiedClaims: [], designChange: null, designReason: null } });
  assert.match(html, /title="src\/totals\.js"><span class="min-w-0 truncate">src\/totals\.js<\/span>/, 'a file chip: the name as it is, in its text and its title');
  assert.match(html, />src\/cart\.js</, 'a file it did not read: as it is');
  const finding = r.renderDecisionDetail({ ...detail, kind: 'question', findings: { list: [{ claim: 'c', evidence: 'e', file: 'src/totals.js', line: 3 }], confidence: null, unverified: [] } });
  assert.match(finding, /title="src\/totals\.js:3"><span class="min-w-0 truncate">src\/totals\.js:3<\/span>/, 'a finding\'s chip: the file and its line');
});
