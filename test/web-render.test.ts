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
import { tailscaleView, type TailscaleStatus } from '../src/tailscale-setup.js';
import { raiseIncident, resolveIncident } from '../src/watchdog/incidents.js';
import { METRICS_DEFINITIONS, trustForViewer, trustView } from '../src/trust.js';
import { deliveryMetrics } from '../src/merge-metrics.js';
import { VIEWER_EVENTS } from '../src/viewer-events.js';
import { firstRunView } from '../src/init.js';
import { checkSetup } from '../src/setup-steps.js';
import type { StarterCiView } from '../src/starter-ci.js';

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
  renderWaiting(w: unknown, now?: number): string;
  renderWaitingPage(state: unknown): string;
  renderRepoConfigForm(c: unknown, o?: { proposed?: string; seen?: string[]; seenNote?: string; seenLoaded?: boolean; starter?: StarterCiView; starterOpen?: boolean }): string;
  renderStarterCi(v: StarterCiView, inForm?: boolean): string;
  renderCiNote(ci: { kind: 'github' | 'none'; means: string | null } | undefined): string;
  renderConfigPrs(prs: unknown[], o?: { canAct?: boolean; plan?: { command: string; then: string } }): string;
  renderDraftPreview(held: unknown, o?: { canEdit?: boolean; changing?: boolean }): string;
  renderFirstRun(f: unknown, o?: { open?: string; confirming?: boolean; actionConfirming?: boolean; policyChanges?: unknown[]; configChanges?: unknown[]; rerun?: string; draftConfirming?: boolean; signin?: unknown; discord?: unknown; ghLogin?: unknown }): string;
  renderClaudeSignin(v: unknown, o?: { confirming?: boolean }): string;
  renderDiscordSetup(v: unknown, o?: { bot?: unknown; botError?: string; tokenConfirming?: boolean; plan?: unknown; values?: Record<string, unknown> }): string;
  renderFirstRunPage(state: unknown): string;
  renderSetupScreens(steps: unknown[]): string;
  renderFirstTask(info: unknown, o?: { canEdit?: boolean; preview?: { title: string; body: string } }): string;
  renderIgnored(data: unknown): string;
  renderUpdaterSetup(data: unknown, review?: unknown): string;
  renderSetup(data: unknown): string;
  renderAddProject(data: unknown, picker?: unknown): string;
  renderClaudeAccount(data: unknown, now?: number): string;
  renderTailscaleSetup(data: unknown, o?: { confirming?: string }): string;
  tailscaleBusy(d: unknown, now?: number): boolean;
  tailscaleStepEnded(prev: unknown, next: unknown): boolean;
  accountBusy(d: unknown, now?: number): boolean;
  addProjectInvalid(name: string, repo: string): string | null;
  keyData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null;
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
  renderSetupModeHidden(path: string): string;
  nextStep(f: unknown): { id: string } | null;
  renderHeader(title: string): string;
  navRows: { to: string; label: string; testId: string }[];
  renderAudit(entries: unknown[]): string;
  renderChatAnswer(f: unknown, cli: string): string;
  renderComposerMic(role: string | undefined, prefs: VoicePrefs, support: unknown, listening?: boolean): string;
  renderMicInterim(listening: boolean, interim: string, error?: string | null): string;
  renderVoiceSettings(owner: boolean, brand?: string): string;
  renderVoiceSettingsView(prefs: VoicePrefs, status: unknown, brand?: string, wakeModel?: string | null): string;
  renderWakeIndicator(micOpen: boolean, phrase: string): string;
  WakeListener: new (engine: unknown, env: unknown, phrase: string, hooks: { onWake: () => void; onChange: (s: { status: string; micOpen: boolean; why: string | null }) => void }) => { set(o: { enabled: boolean; held?: boolean }): void; dictating(on: boolean): void; dispose(): void; status: string; micOpen: boolean };
  startOnWake(o: { support: unknown; listening: boolean; start: () => void }): string;
  mayWake(role: string | undefined, prefs: VoicePrefs): boolean;
  wakePhrase(brand: string): string;
  registerWakeEngine(e: unknown): () => void;
  wakeEngine(): unknown;
  NO_WAKE_MODEL: string;
  checkSupport(ctor: unknown, o: { lang: string; allowCloud: boolean }): Promise<{ kind: string; why?: string; local?: boolean }>;
  Dictation: new (ctor: unknown, o: { lang: string; local: boolean }, hooks: { onFinal: (t: string) => void; onInterim: (t: string) => void; onListening: (l: boolean) => void; onError: (w: string) => void }) => { start(): void; stop(): void; abort(): void; listening: boolean };
  insertAt(text: string, start: number, end: number, chunk: string): { text: string; caret: number };
  intoBox(box: () => unknown, setText: (t: string) => void): (words: string) => void;
  NO_ON_DEVICE: string;
  speechCtor(w: unknown): unknown;
  mayDictate(role: string | undefined, prefs: VoicePrefs): boolean;
  readVoicePrefs(): VoicePrefs;
  renderTalkStatus(role: string | undefined, prefs: VoicePrefs, speaking: boolean, note?: string | null): string;
  renderVoiceSettingsVoices(prefs: VoicePrefs, voices: { local: number; network: number } | null): string;
  mayTalk(role: string | undefined, prefs: VoicePrefs): boolean;
  countVoices(voices: FakeVoice[], lang: string): { local: number; network: number };
  pickVoice(voices: FakeVoice[], lang: string, allowNetwork: boolean): FakeVoice | null;
  spokenText(answer: string): string;
  stopSpeaking(): void;
  TalkBack: new (o: { lang: string; allowNetwork: boolean; synth?: unknown; voicesWaitMs?: number }) => TalkBackLike;
  CODE_OMITTED: string;
  SECRET_OMITTED: string;
  NO_LOCAL_VOICE: string;
  renderProposedSetting(data: unknown, proposed: { key: string; value: unknown }): string;
  actionHref(a: unknown): string | null;
  citationHref(c: unknown): string;
  proposedSetting(search: string): unknown;
  renderVoiceBanner(view: unknown): string;
  renderVoiceButton(show: boolean, support: unknown, listening?: boolean): string;
  renderVoiceControl(state: unknown, prefs: VoicePrefs): string;
  approvalFor(state: unknown, issue: number): { ok: boolean; why?: string; decision?: string; title?: string; effect?: string };
  bannerText(p: unknown): string;
  CONFIRM_WINDOW_MS: number;
  mayUseVoice(role: string | undefined, prefs: VoicePrefs): boolean;
  parseHeard(text: string): { kind: string; issue?: number; text?: string };
  tabState(doc: unknown): { focused: boolean; visible: boolean };
  voiceActive(role: string | undefined, prefs: VoicePrefs, tab: { focused: boolean; visible: boolean }): boolean;
  VoiceCommands: new (o: { find: (issue: number) => unknown; now?: () => number }) => VoiceMachine;
  pages: Record<string, unknown>;
}

/** A long prose recommendation (the kind once cut mid-sentence in a one-line pill). */
const LONG_PROSE =
  'Release the stale claim in the first sweep instead of the second: the lock is only freed in reconcile.js:472 (pinned by the lease check) after a second sweep, so a coordinator that crashes between sweeps leaves the task claimed until its lease expires an hour later. ' +
  'Free it as soon as the lease holder is gone, keep the lease check for live holders, and add a test that stops the holder between two sweeps and expects the next sweep to free the task.';

type VoicePrefs = { dictation: boolean; allowCloud: boolean; talkBack?: boolean; allowNetworkVoices?: boolean; wakeWord?: boolean; voiceCommands?: boolean };
type VoiceMachine = { pending: unknown; hear(text: string, active: boolean): { do: string; [k: string]: unknown }; click(active: boolean): { do: string; [k: string]: unknown }; cancel(): { do: string } };
type FakeVoice = { name: string; lang: string; localService: boolean; default?: boolean };
type TalkBackLike = { speaking: boolean; setActive(a: boolean): void; escape(): boolean; stop(): void; dispose(): void; speak(t: string): Promise<{ spoken: boolean; why?: string | null }>; stopWhenHidden(doc: unknown): () => void };
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
    configured = r.renderNavDrawer({ ...asOwner, setupMode: false } as never);
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
  // The Claude account switch is started the same way (its own unit): the panel used to stop looking entirely.
  const sw = (startedAt: string, status = 'done') => ({ startedAt, status, detail: '', tokenFrom: 'alpha', waitingForToken: false, token: null, instances: [] });
  const account = req({ args: ['claude-account', 'switch'] });
  assert.ok(r.accountBusy({ switch: sw('2026-10-13T09:00:00Z'), requests: [account] }, now));
  assert.ok(r.accountBusy({ switch: null, requests: [account] }, now));
  assert.ok(!r.accountBusy({ switch: sw('2026-10-14T12:00:21Z'), requests: [account] }, now));
  assert.ok(r.accountBusy({ switch: sw('2026-10-14T12:00:21Z', 'running'), requests: [account] }, now));
  assert.ok(!r.accountBusy({ switch: null, requests: [req({ args: ['claude-account', 'status'] })] }, now), 'status runs in the helper itself: no unit to wait for');
});

// Voice dictation in the Ask panel (web/src/voice/): owners only, off until turned on, on-device only by default,
// and nothing it hears is ever sent.

/** A stand-in for the browser's SpeechRecognition: the test says what it hears. */
function fakeRecognizer(o: { availability?: string | null; processLocally?: boolean } = {}) {
  const made: FakeRec[] = [];
  class FakeRec {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    calls: string[] = [];
    constructor() {
      made.push(this);
    }
    start() {
      this.calls.push('start');
    }
    stop() {
      this.calls.push('stop');
    }
    abort() {
      this.calls.push('abort');
    }
    hear(results: [string, boolean][], resultIndex = 0) {
      this.onresult?.({ resultIndex, results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
    }
  }
  if (o.processLocally !== false) Object.defineProperty(FakeRec.prototype, 'processLocally', { value: false, writable: true });
  if (o.availability !== null) (FakeRec as unknown as { available: unknown }).available = async () => o.availability ?? 'available';
  return { ctor: FakeRec, made };
}

const READY_LOCAL = { kind: 'ready', local: true, title: 'Dictate (on-device)' };
const roleOf = (s: State) => (s as unknown as { role?: string }).role;

test("the mic is the owners' only, from the role the server serves: not a writer's, not a viewer's", () => {
  const on = { dictation: true, allowCloud: false };
  assert.deepEqual([roleOf(asOwner), roleOf(asWriter), roleOf(asOther)], ['owner', 'writer', 'viewer'], 'the roles a real dashboard serves');
  assert.match(r.renderComposerMic(roleOf(asOwner), on, READY_LOCAL), /data-testid="chat-mic"[^>]*data-state="idle"[^>]*data-local="true"/);
  for (const s of [asWriter, asOther]) assert.equal(r.renderComposerMic(roleOf(s), on, READY_LOCAL), '', `no mic for a ${roleOf(s)}`);
  assert.equal(r.renderComposerMic(undefined, on, READY_LOCAL), '', 'no role (an older server): no mic');
  // The Settings section that turns it on: an owner's only too.
  assert.match(r.renderVoiceSettings(true), /data-testid="settings-voice"/);
  assert.equal(r.renderVoiceSettings(false), '');
});

test('the mic is off until an owner turns it on in Settings, and on-device only until they allow the cloud', () => {
  localStorage.setItem('dash-voice', '{}');
  const prefs = r.readVoicePrefs();
  assert.deepEqual(prefs, { dictation: false, allowCloud: false, talkBack: false, allowNetworkVoices: false, wakeWord: false, voiceCommands: false }, 'all off by default');
  assert.equal(r.renderComposerMic(roleOf(asOwner), prefs, READY_LOCAL), '', 'not rendered for the owner until enabled');
  const settings = r.renderVoiceSettings(true);
  assert.match(settings, /data-testid="voice-dictation"/);
  assert.doesNotMatch(settings, /checked=""/, 'both switches start off');
  localStorage.setItem('dash-voice', JSON.stringify({ dictation: 'yes', allowCloud: 1 }));
  assert.deepEqual(r.readVoicePrefs(), { dictation: false, allowCloud: false, talkBack: false, allowNetworkVoices: false, wakeWord: false, voiceCommands: false }, 'only a stored true turns either on');
  localStorage.setItem('dash-voice', JSON.stringify({ dictation: true }));
  assert.deepEqual(r.readVoicePrefs(), { dictation: true, allowCloud: false, talkBack: false, allowNetworkVoices: false, wakeWord: false, voiceCommands: false });
  assert.match(r.renderVoiceSettings(true), /data-testid="voice-dictation" checked=""/);
  assert.match(r.renderComposerMic(roleOf(asOwner), r.readVoicePrefs(), READY_LOCAL), /data-testid="chat-mic"/, 'there once turned on');
  localStorage.setItem('dash-voice', '{}');
});

test("without speech recognition there is no button; on-device only, a browser that can't keep the audio local gets a disabled one saying why", async () => {
  const on = { dictation: true, allowCloud: false };
  const owner = roleOf(asOwner);
  assert.equal(r.speechCtor({}), null);
  const none = await r.checkSupport(null, { lang: 'en-US', allowCloud: false });
  assert.deepEqual(none, { kind: 'none' });
  assert.equal(r.renderComposerMic(owner, on, none), '', 'no recognizer: no button at all');
  // A recognizer with no on-device API (an older Chrome's webkitSpeechRecognition): it would stream to the cloud.
  const old = await r.checkSupport(fakeRecognizer({ availability: null, processLocally: false }).ctor, { lang: 'en-US', allowCloud: false });
  assert.deepEqual([old.kind, old.why], ['disabled', r.NO_ON_DEVICE]);
  assert.match(r.renderComposerMic(owner, on, old), /<button[^>]*disabled=""[^>]*title="on-device speech recognition isn(&#x27;|')t available in this browser"[^>]*data-state="disabled"/);
  // The on-device API, but no model for the language: still disabled.
  for (const availability of ['unavailable', 'downloadable']) {
    const s = await r.checkSupport(fakeRecognizer({ availability }).ctor, { lang: 'en-US', allowCloud: false });
    assert.equal(s.kind, 'disabled', availability);
  }
  const throws = fakeRecognizer();
  (throws.ctor as unknown as { available: unknown }).available = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await r.checkSupport(throws.ctor, { lang: 'en-US', allowCloud: false }).then((s) => [s.kind, s.why]), ['disabled', r.NO_ON_DEVICE], 'a check that throws is no error, just disabled');
  // On the device: ready, and local.
  assert.deepEqual(await r.checkSupport(fakeRecognizer().ctor, { lang: 'en-US', allowCloud: false }).then((s) => [s.kind, s.local]), ['ready', true]);
  // Only when the owner allowed the cloud does a browser without on-device get a working mic, marked not local.
  const cloud = await r.checkSupport(fakeRecognizer({ availability: null, processLocally: false }).ctor, { lang: 'en-US', allowCloud: true });
  assert.deepEqual([cloud.kind, cloud.local], ['ready', false]);
  assert.match(r.renderComposerMic(owner, { dictation: true, allowCloud: true }, cloud), /data-local="false"/);
  assert.match(r.renderVoiceSettingsView(on, { recognizer: true, availability: 'downloadable' }), /data-testid="voice-install"/);
  assert.doesNotMatch(r.renderVoiceSettingsView(on, { recognizer: true, availability: 'available' }), /data-testid="voice-install"/);
});

test('dictation puts what it hears in the box at the caret, interim apart, and sends nothing: no fetch, no WebSocket', () => {
  const g = globalThis as Record<string, unknown>;
  const network: string[] = [];
  const saved = { fetch: g.fetch, WebSocket: g.WebSocket, XMLHttpRequest: g.XMLHttpRequest, EventSource: g.EventSource };
  g.fetch = (...a: unknown[]) => (network.push(`fetch ${String(a[0])}`), Promise.reject(new Error('no network in dictation')));
  g.WebSocket = class {
    constructor(url: string) {
      network.push(`ws ${url}`);
    }
  };
  g.XMLHttpRequest = class {
    open(_m: string, url: string) {
      network.push(`xhr ${url}`);
    }
  };
  g.EventSource = class {
    constructor(url: string) {
      network.push(`sse ${url}`);
    }
  };
  try {
    const { ctor, made } = fakeRecognizer();
    // The text box: a question already typed, the caret after "Why is".
    const box = {
      value: 'Why is stuck?',
      selectionStart: 6,
      selectionEnd: 6,
      setSelectionRange(a: number, b: number) {
        this.selectionStart = a;
        this.selectionEnd = b;
      },
    };
    let state = box.value;
    const interims: string[] = [];
    const listening: boolean[] = [];
    const errors: string[] = [];
    const d = new r.Dictation(ctor, { lang: 'en-US', local: true }, { onFinal: r.intoBox(() => box, (t) => (state = t)), onInterim: (t) => interims.push(t), onListening: (l) => listening.push(l), onError: (w) => errors.push(w) });
    d.start();
    const rec = made[0]!;
    assert.equal((rec as unknown as { processLocally: boolean }).processLocally, true, 'on-device asked of this recognizer');
    assert.deepEqual([rec.continuous, rec.interimResults, rec.lang], [true, true, 'en-US']);
    rec.hear([['issue', false]]);
    assert.equal(interims.at(-1), 'issue', 'interim, not in the box');
    assert.equal(box.value, 'Why is stuck?');
    rec.hear([['issue twelve', true], [' and', false]]);
    assert.equal(box.value, 'Why is issue twelve stuck?', 'the final lands at the caret');
    assert.equal(state, box.value, "the box's own state has it too");
    assert.equal(box.selectionStart, 'Why is issue twelve'.length, 'the caret sits after it');
    assert.equal(interims.at(-1), 'and');
    // Two finals in one event: both land, in order; "send" is only a word.
    rec.hear([['issue twelve', true], ['and thirteen', true], ['send', true]], 1);
    assert.equal(box.value, 'Why is issue twelve and thirteen send stuck?', 'no voice command');
    // The second click stops; the browser ends.
    d.stop();
    assert.deepEqual(rec.calls, ['start', 'stop']);
    rec.onend?.();
    assert.deepEqual(listening, [true, false]);
    assert.equal(interims.at(-1), '', 'the interim line clears');
    assert.equal(box.value, 'Why is issue twelve and thirteen send stuck?', 'still in the box, for review: the end sends nothing');
    assert.deepEqual(errors, []);
    // Aborted (the panel closed or lost focus): nothing more lands, even if the browser still says something.
    const d2 = new r.Dictation(ctor, { lang: 'en-US', local: true }, { onFinal: r.intoBox(() => box, (t) => (state = t)), onInterim: () => {}, onListening: () => {}, onError: () => {} });
    d2.start();
    const rec2 = made[1]!;
    const handler = rec2.onresult;
    d2.abort();
    assert.deepEqual(rec2.calls, ['start', 'abort']);
    assert.equal(d2.listening, false);
    handler?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late words' } }] });
    assert.doesNotMatch(box.value, /late words/, 'nothing lands after an abort');
    assert.deepEqual(network, [], 'no fetch, WebSocket, XHR or EventSource during dictation');
  } finally {
    Object.assign(g, saved);
  }
});

test('on-device only: a recognizer without the processLocally option is never started', () => {
  const { ctor, made } = fakeRecognizer({ processLocally: false });
  const errors: string[] = [];
  const d = new r.Dictation(ctor, { lang: 'en-US', local: true }, { onFinal: () => {}, onInterim: () => {}, onListening: () => {}, onError: (w) => errors.push(w) });
  d.start();
  assert.deepEqual(made[0]!.calls, [], 'not started');
  assert.deepEqual(errors, [r.NO_ON_DEVICE]);
});

test('dictated words go in at the caret with a space where words meet, replacing a selection', () => {
  assert.deepEqual(r.insertAt('', 0, 0, ' hello '), { text: 'hello', caret: 5 });
  assert.deepEqual(r.insertAt('Why', 3, 3, 'stuck'), { text: 'Why stuck', caret: 9 });
  assert.deepEqual(r.insertAt('a c', 1, 2, 'b'), { text: 'a b c', caret: 4 }, 'a space each side where words meet; the caret after them');
  assert.deepEqual(r.insertAt('Why old stuck', 4, 7, 'new'), { text: 'Why new stuck', caret: 7 });
  assert.deepEqual(r.insertAt('x', 1, 1, '  '), { text: 'x', caret: 1 }, 'nothing heard: nothing changes');
});

test('the interim line is marked as interim and says how to stop; an error says dictation stopped', () => {
  assert.equal(r.renderMicInterim(false, ''), '');
  assert.match(r.renderMicInterim(true, 'why is'), /data-testid="chat-mic-interim"[\s\S]*Listening[\s\S]*class="truncate italic" data-testid="chat-mic-interim-text">why is…/);
  assert.match(r.renderMicInterim(true, ''), /Esc stops/);
  assert.match(r.renderMicInterim(false, '', 'no microphone found'), /data-testid="chat-mic-error"[^>]*>Dictation stopped: no microphone found/);
});

// Talk-back in the Ask panel (web/src/voice/talk.ts): owners only, off until turned on, on-device voices only by
// default, the answer without code or secrets, and stopped the moment the owner talks.

const LOCAL_EN: FakeVoice = { name: 'Samantha', lang: 'en-US', localService: true };
const NETWORK_EN: FakeVoice = { name: 'Google US English', lang: 'en-US', localService: false, default: true };

/** A stand-in for window.speechSynthesis and SpeechSynthesisUtterance: it records what it is asked to do. */
function fakeSynth(voices: FakeVoice[] = [LOCAL_EN, NETWORK_EN]) {
  const calls: string[] = [];
  const spoken: { text: string; voice: FakeVoice | null; lang: string; onend: (() => void) | null }[] = [];
  class Utterance {
    lang = '';
    voice: FakeVoice | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    constructor(public text: string) {}
  }
  const synth = {
    speak(u: Utterance) {
      calls.push('speak');
      spoken.push(u);
    },
    cancel() {
      calls.push('cancel');
    },
    getVoices: () => voices,
  };
  return { s: { synth, Utterance }, calls, spoken };
}

const TALK_ON = { dictation: false, allowCloud: false, talkBack: true, allowNetworkVoices: false };

test("talk-back is off by default and the owners' only: a writer, a viewer or an owner who didn't turn it on hear nothing", async () => {
  localStorage.setItem('dash-voice', '{}');
  const prefs = r.readVoicePrefs();
  assert.equal(prefs.talkBack, false, 'off by default');
  assert.equal(prefs.allowNetworkVoices, false, 'network voices off by default');
  localStorage.setItem('dash-voice', JSON.stringify({ talkBack: 'yes', allowNetworkVoices: 1 }));
  assert.deepEqual([r.readVoicePrefs().talkBack, r.readVoicePrefs().allowNetworkVoices], [false, false], 'only a stored true turns it on');
  localStorage.setItem('dash-voice', '{}');
  assert.doesNotMatch(r.renderVoiceSettings(true), /data-testid="voice-talk-back" checked=""/, 'the switch starts off');
  assert.match(r.renderVoiceSettings(true), /data-testid="voice-allow-network-voices"/);

  const owner = roleOf(asOwner);
  assert.equal(r.mayTalk(owner, prefs), false, 'an owner who did not turn it on');
  assert.equal(r.mayTalk(owner, TALK_ON), true);
  for (const s of [asWriter, asOther]) {
    assert.equal(r.mayTalk(roleOf(s), TALK_ON), false, `not a ${roleOf(s)}`);
    assert.equal(r.renderTalkStatus(roleOf(s), TALK_ON, true), '', `no reading line for a ${roleOf(s)}`);
  }
  assert.equal(r.mayTalk(undefined, TALK_ON), false, 'no role (an older server)');
  assert.equal(r.renderTalkStatus(owner, prefs, true), '', 'nothing for an owner with it off');
  assert.match(r.renderTalkStatus(owner, TALK_ON, true), /data-testid="chat-speaking"[\s\S]*data-testid="chat-speaking-stop"/);

  // The reader itself does nothing until it is made active (the panel open, for an owner who turned it on).
  const f = fakeSynth();
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: f.s });
  try {
    assert.deepEqual(await t.speak('Issue 12 is waiting on a review.'), { spoken: false, why: null });
    assert.deepEqual(f.calls, [], 'speechSynthesis.speak is never called while inactive');
  } finally {
    t.dispose();
  }
});

test('reading an answer hands speechSynthesis.speak the answer with code blocks and secrets left out', async () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const key = 'sk-ant-' + 'api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2';
  const jwtish = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456';
  const answer = [
    '**Issue 12** is stuck: the `review` lane has no free slot.',
    '```bash',
    'export GH_TOKEN=' + token,
    'git push --force-with-lease',
    '```',
    `The key ${key} was pasted in the log, and so was ${jwtish}.`,
    'Run it with postgres://app:hunter2pass@db.internal/main.',
  ].join('\n');
  const said = r.spokenText(answer);
  for (const secret of [token, key, jwtish, 'hunter2pass', 'force-with-lease', 'GH_TOKEN']) assert.ok(!said.includes(secret), `"${secret}" is not read out: ${said}`);
  assert.match(said, new RegExp(`${r.CODE_OMITTED}`), 'the code block is named, not read');
  assert.match(said, new RegExp(`The key ${r.SECRET_OMITTED} was pasted`), 'a secret is named, not read');
  assert.match(said, /^Issue 12 is stuck: the review lane has no free slot\./, 'markdown marks are not read out');
  assert.match(r.spokenText('Before\n```\nan unclosed block\nstill code'), new RegExp(`^Before\\n${r.CODE_OMITTED}\\.$`), 'an unclosed block is left out to the end');
  assert.equal(r.spokenText('Commit 3f2a9c1 is fine.'), 'Commit 3f2a9c1 is fine.', 'a short id is ordinary text');

  const f = fakeSynth();
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: f.s });
  try {
    t.setActive(true);
    assert.deepEqual(await t.speak(answer), { spoken: true });
    assert.deepEqual(f.calls, ['speak']);
    assert.equal(f.spoken[0]!.text, said, 'speak gets the redacted text, nothing else');
    assert.equal(t.speaking, true);
    f.spoken[0]!.onend?.();
    assert.equal(t.speaking, false, 'done when the browser says it ended');
  } finally {
    t.dispose();
  }
});

test("the owner starting to dictate stops the answer being read, at once", async () => {
  const f = fakeSynth();
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: f.s });
  try {
    t.setActive(true);
    await t.speak('A long answer about issue 12.');
    assert.equal(t.speaking, true);
    const { ctor } = fakeRecognizer();
    new r.Dictation(ctor, { lang: 'en-US', local: true }, { onFinal: () => {}, onInterim: () => {}, onListening: () => {}, onError: () => {} }).start();
    assert.deepEqual(f.calls, ['speak', 'cancel'], 'starting dictation cancels speech');
    assert.equal(t.speaking, false);
    // And the hook other voice input (the wake word) calls does the same.
    await t.speak('Another answer.');
    r.stopSpeaking();
    assert.deepEqual(f.calls, ['speak', 'cancel', 'speak', 'cancel']);
  } finally {
    t.dispose();
  }
});

test('Esc, the panel closing and the tab being hidden each stop the reading; nothing starts after a stop', async () => {
  const f = fakeSynth();
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: f.s });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const unhide = t.stopWhenHidden(doc);
  try {
    t.setActive(true);
    // Esc.
    await t.speak('One.');
    assert.equal(t.escape(), true, 'Esc while reading is taken by the reading');
    assert.deepEqual([f.calls.at(-1), t.speaking], ['cancel', false], 'Esc cancels');
    assert.equal(t.escape(), false, 'the next Esc is the panel’s (it closes)');
    // The tab hidden.
    await t.speak('Two.');
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(t.speaking, true, 'still visible: still reading');
    doc.visibilityState = 'hidden';
    const before = f.calls.length;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual([f.calls.slice(before), t.speaking], [['cancel'], false], 'hidden cancels');
    doc.visibilityState = 'visible';
    // The panel closing (useTalkBack makes it inactive).
    await t.speak('Three.');
    t.setActive(false);
    assert.deepEqual([f.calls.at(-1), t.speaking], ['cancel', false], 'closing the panel cancels');
    assert.deepEqual(await t.speak('Four.'), { spoken: false, why: null }, 'closed: nothing is read');
    // A stop while the browser's voices are still loading: nothing starts once they arrive.
    const late = fakeSynth([]);
    let fire = () => {};
    const slow = { ...late.s, synth: { ...late.s.synth, addEventListener: (_: string, fn: () => void) => (fire = fn), removeEventListener: () => {} } };
    const t2 = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: slow, voicesWaitMs: 5000 });
    t2.setActive(true);
    const pending = t2.speak('Five.');
    t2.stop();
    late.s.synth.getVoices = () => [LOCAL_EN];
    fire();
    assert.deepEqual(await pending, { spoken: false, why: null });
    assert.ok(!late.calls.includes('speak'), 'nothing is read after a stop');
    t2.dispose();
  } finally {
    unhide();
    t.dispose();
  }
});

test('only on-device voices unless the owner allowed network voices; never the browser default by omission', async () => {
  assert.equal(r.pickVoice([NETWORK_EN, LOCAL_EN], 'en-US', false), LOCAL_EN);
  assert.equal(r.pickVoice([NETWORK_EN], 'en-US', false), null, 'a network voice is not used unless allowed');
  assert.equal(r.pickVoice([NETWORK_EN], 'en-US', true), NETWORK_EN, 'allowed: a network voice when there is no local one');
  assert.equal(r.pickVoice([NETWORK_EN, LOCAL_EN], 'en-US', true), LOCAL_EN, 'allowed, a local voice still comes first');
  assert.equal(r.pickVoice([{ name: 'Thomas', lang: 'fr-FR', localService: true }], 'en-US', false), null, 'not another language');

  const only = fakeSynth([NETWORK_EN]);
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: only.s });
  try {
    t.setActive(true);
    assert.deepEqual(await t.speak('Hello.'), { spoken: false, why: r.NO_LOCAL_VOICE });
    assert.deepEqual(only.calls, [], 'nothing is spoken with only a network voice');
  } finally {
    t.dispose();
  }
  const both = fakeSynth();
  const t2 = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: both.s });
  try {
    t2.setActive(true);
    await t2.speak('Hello.');
    assert.equal(both.spoken[0]!.voice, LOCAL_EN, 'the voice is set to the local one, never left to the browser default');
  } finally {
    t2.dispose();
  }
  assert.match(r.renderTalkStatus(roleOf(asOwner), TALK_ON, false, r.NO_LOCAL_VOICE), /data-testid="chat-talk-note"[^>]*>Not read aloud: no on-device voice/);
  assert.deepEqual(r.countVoices([LOCAL_EN, NETWORK_EN, { name: 'Thomas', lang: 'fr-FR', localService: true }], 'en-US'), { local: 1, network: 1 });
  assert.match(r.renderVoiceSettingsVoices(TALK_ON, { local: 0, network: 2 }), /data-testid="voice-voices"[^>]*>Voices for reading aloud \(en-US\): 0 on-device \(2 network, not used\): answers aren(&#x27;|')t read aloud here/);
});

test('reading aloud sends nothing: no fetch, WebSocket, XHR or EventSource while it speaks or stops', async () => {
  const g = globalThis as Record<string, unknown>;
  const network: string[] = [];
  const saved = { fetch: g.fetch, WebSocket: g.WebSocket, XMLHttpRequest: g.XMLHttpRequest, EventSource: g.EventSource };
  g.fetch = (...a: unknown[]) => (network.push(`fetch ${String(a[0])}`), Promise.reject(new Error('no network in talk-back')));
  g.WebSocket = class {
    constructor(url: string) {
      network.push(`ws ${url}`);
    }
  };
  g.XMLHttpRequest = class {
    open(_m: string, url: string) {
      network.push(`xhr ${url}`);
    }
  };
  g.EventSource = class {
    constructor(url: string) {
      network.push(`sse ${url}`);
    }
  };
  const f = fakeSynth();
  const t = new r.TalkBack({ lang: 'en-US', allowNetwork: true, synth: f.s });
  try {
    t.setActive(true);
    await t.speak('Issue 12 is waiting.\n```\ncode\n```');
    f.spoken[0]!.onend?.();
    await t.speak('Again.');
    t.escape();
    t.setActive(false);
    assert.deepEqual(f.calls, ['speak', 'speak', 'cancel', 'cancel']);
    assert.deepEqual(network, [], 'no fetch, WebSocket, XHR or EventSource during talk-back');
  } finally {
    t.dispose();
    Object.assign(g, saved);
  }
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

// Voice intake and spoken approvals (web/src/voice/commands.ts, VoiceControl.tsx): owners only, off until turned on,
// only from a focused and visible tab; shown on a 10-second banner and acted on only by "confirm" in that window (or
// a click), once, on exactly the item shown. The server checks it all again (test/voice.test.ts).

const VOICE_ON = { dictation: false, allowCloud: false, talkBack: false, allowNetworkVoices: false, voiceCommands: true };
const FOCUSED = { focused: true, visible: true };
/** The state the page has: one open intake approval on #12 (voice may approve it), one excluded plan on #13. */
const voiceState = {
  tasks: [{ issue: 12, title: 'Show tax separately', status: 'triage' }, { issue: 13, title: 'Change the payout path', status: 'claimed' }],
  decisions: [
    { id: 'd-12', kind: 'intake', issue: 12, question: 'File it?', options: ['approve', 'edit', 'reject'], receipts: ['intake:x'], answer: null, canAnswer: true, voiceRefused: null },
    { id: 'd-13', kind: 'plan', issue: 13, question: 'Approve this plan?', options: ['approve', 'revise', 'reject'], receipts: ['approve: the build starts with this plan'], answer: null, canAnswer: true, voiceRefused: 'it is high-risk (high-risk: money-path (src/pay.ts)); approve it with a click' },
  ],
};
function machine() {
  let now = 1_000_000;
  const m = new r.VoiceCommands({ find: (n) => r.approvalFor(voiceState, n), now: () => now });
  return { m, tick: (ms: number) => (now += ms) };
}

test("voice intake and approvals are off by default, the owners' only, and need the switch in Settings", () => {
  localStorage.setItem('dash-voice', '{}');
  const prefs = r.readVoicePrefs();
  assert.equal(prefs.voiceCommands, false, 'off by default');
  assert.equal(r.mayUseVoice('owner', prefs), false);
  assert.equal(r.renderVoiceControl(asOwner, prefs), '', 'nothing on the page until turned on');
  assert.doesNotMatch(r.renderVoiceSettings(true), /data-testid="voice-commands-toggle" checked=""/, 'the switch starts off');
  assert.match(r.renderVoiceSettings(true), /Voice intake and approvals/);
  localStorage.setItem('dash-voice', JSON.stringify({ voiceCommands: 'yes' }));
  assert.equal(r.readVoicePrefs().voiceCommands, false, 'only a stored true turns it on');
  localStorage.setItem('dash-voice', '{}');
  assert.equal(r.mayUseVoice('owner', VOICE_ON), true);
  for (const role of ['writer', 'viewer', undefined]) assert.equal(r.mayUseVoice(role, VOICE_ON), false, `not for a ${role}`);
  assert.match(r.renderVoiceButton(true, READY_LOCAL), /data-testid="voice-commands"[^>]*data-state="idle"/);
  assert.equal(r.renderVoiceButton(false, READY_LOCAL), '');
});

test('an unfocused or hidden tab gets no action: nothing is shown, and a confirm or click does nothing', () => {
  const tab = (focused: boolean, visibilityState: string) => r.tabState({ hasFocus: () => focused, visibilityState });
  assert.deepEqual(tab(true, 'visible'), FOCUSED);
  for (const t of [tab(false, 'visible'), tab(true, 'hidden'), tab(false, 'hidden'), r.tabState(undefined)]) assert.equal(r.voiceActive('owner', VOICE_ON, t), false, JSON.stringify(t));
  const { m } = machine();
  assert.equal(m.hear('add a dark mode', false).do, 'nothing', 'unfocused: nothing shown');
  assert.equal(m.pending, null);
  assert.equal(m.hear('add a dark mode', true).do, 'show');
  // The tab loses focus with the banner up: the confirm is not acted on, and nothing stays pending.
  assert.equal(m.hear('confirm', false).do, 'nothing');
  assert.equal(m.pending, null);
  assert.equal(m.hear('approve 12', true).do, 'show');
  assert.equal(m.click(false).do, 'nothing', 'a click from an unfocused tab does nothing either');
  assert.equal(m.pending, null);
});

test('a spoken idea is shown, and sent only on "confirm" within 10 s; a confirm after the window does nothing', () => {
  const { m, tick } = machine();
  const shown = m.hear('Add a dark mode to the dashboard.', true);
  assert.equal(shown.do, 'show');
  assert.equal((shown.pending as { kind: string; text: string }).text, 'Add a dark mode to the dashboard.');
  tick(r.CONFIRM_WINDOW_MS - 1);
  assert.deepEqual(m.hear('Confirm.', true), { do: 'send-intake', text: 'Add a dark mode to the dashboard.' });
  // Too late: the window closed.
  m.hear('add a dark mode', true);
  tick(r.CONFIRM_WINDOW_MS + 1);
  assert.equal(m.hear('confirm', true).do, 'nothing', 'a confirm after 10 s does nothing');
  assert.equal(m.click(true).do, 'nothing', 'nor a click');
  assert.equal(m.pending, null);
});

test('"cancel", or any other speech in the window, cancels; it is not taken as a new command', () => {
  const { m } = machine();
  m.hear('add a dark mode', true);
  assert.equal(m.hear('cancel', true).do, 'cancelled');
  assert.equal(m.hear('confirm', true).do, 'nothing', 'nothing left to confirm');
  m.hear('approve 12', true);
  const other = m.hear('approve 13', true);
  assert.equal(other.do, 'cancelled', 'other speech cancels, even another command');
  assert.equal(m.hear('confirm', true).do, 'nothing');
  m.hear('add a dark mode', true);
  assert.equal(m.hear('well actually confirm', true).do, 'cancelled', 'only exactly "confirm" confirms');
  assert.equal(m.pending, null);
});

test('"approve <n>" shows the item, its title and what approving does; one confirm approves exactly that one item, once', () => {
  assert.deepEqual(r.parseHeard('Approve #12.'), { kind: 'approve', issue: 12 });
  assert.deepEqual(r.parseHeard('approve number 12'), { kind: 'approve', issue: 12 });
  assert.equal(r.parseHeard('approve it').kind, 'idea');
  const { m } = machine();
  const shown = m.hear('approve 12', true);
  assert.equal(shown.do, 'show');
  const p = shown.pending as { kind: string; issue: number; decision: string; title: string; effect: string };
  assert.deepEqual([p.kind, p.issue, p.decision, p.title], ['approve', 12, 'd-12', 'Show tax separately']);
  assert.match(p.effect, /filed as a ready issue/);
  assert.match(r.bannerText(shown.pending), /Approve number 12, Show tax separately\. Approving means: /);
  assert.deepEqual(m.hear('confirm', true), { do: 'approve', issue: 12, decision: 'd-12' });
  assert.equal(m.hear('confirm', true).do, 'nothing', 'a second confirm approves nothing');
  assert.equal(m.click(true).do, 'nothing', 'nor a click');
  // Nothing open on the number: shown as refused, and a confirm does nothing.
  const none = m.hear('approve 99', true);
  assert.equal((none.pending as { kind: string }).kind, 'refused');
  assert.equal(m.hear('confirm', true).do, 'nothing');
});

test('an excluded item is never approvable by voice on the page either: shown as refused, a confirm does nothing', () => {
  const { m } = machine();
  const shown = m.hear('approve 13', true);
  const p = shown.pending as { kind: string; why: string };
  assert.equal(p.kind, 'refused');
  assert.match(p.why, /can't be approved by voice: it is high-risk/);
  assert.equal(m.hear('confirm', true).do, 'nothing');
  assert.equal(m.hear('approve 13', true).do, 'show');
  assert.equal(m.click(true).do, 'nothing', 'nor by a click on the banner');
  // A server that didn't say voice may approve it (no voiceRefused field): refused too.
  const older = r.approvalFor({ tasks: [], decisions: [{ ...voiceState.decisions[0], voiceRefused: undefined }] }, 12);
  assert.equal(older.ok, false);
});

test('every spoken confirm shows the 10-second banner, with what confirm does, a countdown and the same confirm as a button', () => {
  const { m } = machine();
  const idea = m.hear('add a dark mode', true);
  const html = r.renderVoiceBanner({ pending: idea.pending, left: 10 });
  assert.match(html, /data-testid="voice-banner"[^>]*data-kind="intake"/);
  assert.match(html, /data-testid="voice-banner-text"[^>]*>add a dark mode</);
  assert.match(html, /Say “confirm” within <span class="tabular-nums">10<\/span> s, or click; anything else said cancels\./);
  assert.match(html, /data-testid="voice-banner-confirm"[^>]*>Send to intake</);
  m.cancel();
  const approve = m.hear('approve 12', true);
  const a = r.renderVoiceBanner({ pending: approve.pending, left: 7 });
  assert.match(a, /data-kind="approve"/);
  assert.match(a, /Approve <span class="font-medium">#(<!-- -->)?12<\/span>: (<!-- -->)?Show tax separately/);
  assert.match(a, /Approving: (<!-- -->)?the report is filed as a ready issue/);
  assert.match(a, /data-testid="voice-banner-confirm"[^>]*>Approve</);
  m.cancel();
  const refused = r.renderVoiceBanner({ pending: m.hear('approve 13', true).pending, left: 10 });
  assert.match(refused, /data-kind="refused"/);
  assert.doesNotMatch(refused, /voice-banner-confirm/, 'an exclusion has no confirm button');
  assert.equal(r.renderVoiceBanner(null), '');
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

// The wake word, "hey <brand>" (web/src/voice/wake.ts): owners only, off by default, on this computer only, the
// microphone open only while everything allows it and never without the indicator, and a hit only starts dictation.

/** Stands in for fetch, WebSocket, XHR and EventSource while `fn` runs; returns every request anything made. */
async function noNetwork(fn: () => Promise<void> | void): Promise<string[]> {
  const g = globalThis as Record<string, unknown>;
  const network: string[] = [];
  const saved = { fetch: g.fetch, WebSocket: g.WebSocket, XMLHttpRequest: g.XMLHttpRequest, EventSource: g.EventSource };
  g.fetch = (...a: unknown[]) => (network.push(`fetch ${String(a[0])}`), Promise.reject(new Error('no network')));
  g.WebSocket = class {
    constructor(url: string) {
      network.push(`ws ${url}`);
    }
  };
  g.XMLHttpRequest = class {
    open(_m: string, url: string) {
      network.push(`xhr ${url}`);
    }
  };
  g.EventSource = class {
    constructor(url: string) {
      network.push(`sse ${url}`);
    }
  };
  try {
    await fn();
  } finally {
    Object.assign(g, saved);
  }
  return network;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
};

/** A browser and a wake-word model, stood in: the test says what is visible, what the permission is, and when it hears. */
function fakeWake(o: { perm?: 'granted' | 'prompt' | 'denied' | null; engine?: boolean } = {}) {
  const calls: string[] = [];
  const changes: { status: string; micOpen: boolean }[] = [];
  let visible = true;
  const onVis = new Set<() => void>();
  const onPerm = new Set<() => void>();
  const perm = o.perm === null ? null : { state: o.perm ?? 'granted', addEventListener: (_t: string, cb: () => void) => onPerm.add(cb), removeEventListener: (_t: string, cb: () => void) => onPerm.delete(cb) };
  const tracks: { stopped: boolean; ended: (() => void) | undefined }[] = [];
  const hits: (() => void)[] = [];
  let listener: { micOpen: boolean } | null = null;
  const micOpenAtAsk: boolean[] = [];
  const env = {
    getUserMedia: async () => {
      calls.push('getUserMedia');
      micOpenAtAsk.push(listener?.micOpen ?? false);
      const t = {
        stopped: false,
        ended: undefined as (() => void) | undefined,
        stop() {
          this.stopped = true;
        },
        addEventListener(_t: string, cb: () => void) {
          this.ended = cb;
        },
      };
      tracks.push(t);
      return { getTracks: () => [t] };
    },
    visible: () => visible,
    onVisibility: (cb: () => void) => (onVis.add(cb), () => void onVis.delete(cb)),
    permission: async () => (calls.push('permission'), perm),
  };
  const engine =
    o.engine === false
      ? null
      : {
          id: 'test',
          label: 'test model (licence checked)',
          start: async (a: { phrase: string; onHit: () => void }) => {
            calls.push(`engine start: ${a.phrase}`);
            hits.push(a.onHit);
            return { stop: () => calls.push('engine stop') };
          },
        };
  const woken: number[] = [];
  const make = (phrase = r.wakePhrase(BRAND.name)) => {
    const l = new r.WakeListener(engine, env, phrase, { onWake: () => woken.push(1), onChange: (s) => changes.push(s) });
    listener = l;
    return l;
  };
  return {
    make,
    calls,
    changes,
    tracks,
    woken,
    micOpenAtAsk,
    hit: () => hits.at(-1)!(),
    setVisible(v: boolean) {
      visible = v;
      for (const cb of onVis) cb();
    },
    setPerm(s: 'granted' | 'prompt' | 'denied') {
      perm!.state = s;
      for (const cb of onPerm) cb();
    },
    gum: () => calls.filter((c) => c === 'getUserMedia').length,
    open: () => tracks.filter((t) => !t.stopped).length,
  };
}

test("the wake word is the owners' only, off by default, and its phrase is the product's name from brand.ts", () => {
  const all = { dictation: true, allowCloud: false, wakeWord: true };
  assert.equal(r.mayWake('owner', all), true);
  for (const role of ['writer', 'viewer', undefined]) assert.equal(r.mayWake(role, all), false, `not for ${role ?? 'no role'}`);
  assert.equal(r.mayWake('owner', { ...all, wakeWord: false }), false, 'not until an owner turns it on');
  assert.equal(r.mayWake('owner', { ...all, dictation: false }), false, 'not without the mic button it dictates through');
  localStorage.setItem('dash-voice', '{}');
  assert.equal(r.readVoicePrefs().wakeWord, false, 'off by default');
  localStorage.setItem('dash-voice', JSON.stringify({ dictation: true, wakeWord: 'on' }));
  assert.equal(r.readVoicePrefs().wakeWord, false, 'only a stored true turns it on');
  // Settings: the switch is in the owners-only section, unchecked, and names the phrase from the brand the server serves.
  assert.equal(r.renderVoiceSettings(false, BRAND.name), '', 'no section for anyone but an owner');
  const settings = r.renderVoiceSettings(true, BRAND.name);
  assert.match(settings, /data-testid="voice-wake-word"/);
  assert.doesNotMatch(settings, /checked=""[^>]*data-testid="voice-wake-word"/, 'starts off');
  assert.ok(settings.includes(`“${r.wakePhrase(BRAND.name)}”`), 'the phrase, from brand.ts');
  assert.equal(r.wakePhrase('Acme'), 'hey Acme', 'whatever the product is called');
  localStorage.setItem('dash-voice', '{}');
  // Nothing in the voice module spells the name out.
  const dir = join(repoRoot, 'web', 'src', 'voice');
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), new RegExp(BRAND.cli, 'i'), `${f} doesn't hardcode the product name`);
});

test('no wake-word model ships: Settings says so and nothing opens the mic', async () => {
  assert.equal(r.wakeEngine(), null, 'no engine bundled');
  const on = { dictation: true, allowCloud: false, wakeWord: true };
  assert.match(r.renderVoiceSettingsView(on, null, BRAND.name), /data-testid="voice-wake-model">No wake-word model installed: it won(&#x27;|')t listen/);
  assert.match(r.renderVoiceSettingsView(on, null, BRAND.name, 'test model'), /data-testid="voice-wake-model">Model: test model/);
  const w = fakeWake({ engine: false });
  const l = w.make();
  l.set({ enabled: true });
  await settle();
  assert.equal(l.status, 'no-model');
  assert.deepEqual(w.calls, [], 'no permission query, no getUserMedia');
});

test('no getUserMedia (and no permission query) until an owner turns it on; then the mic opens once', async () => {
  const w = fakeWake();
  const l = w.make();
  await settle();
  l.set({ enabled: false });
  await settle();
  assert.deepEqual([...w.calls], [], 'nothing asked while off');
  l.set({ enabled: true });
  await settle();
  assert.equal(w.gum(), 1);
  assert.equal(l.status, 'listening');
  assert.ok(w.calls.includes(`engine start: hey ${BRAND.name}`));
  // Off again (the setting, or anyone but an owner): the mic closes at once.
  l.set({ enabled: false });
  assert.equal(w.open(), 0, 'tracks stopped');
  assert.equal(l.micOpen, false);
  assert.ok(w.calls.includes('engine stop'));
  await settle();
  assert.equal(w.gum(), 1, 'not reopened');
});

test('the indicator is on screen whenever the mic is open for the wake word, from the moment it is asked for', async () => {
  const w = fakeWake();
  const l = w.make();
  l.set({ enabled: true });
  await settle();
  assert.deepEqual(w.micOpenAtAsk, [true], 'micOpen (the indicator) is already true when getUserMedia is called');
  assert.ok(w.changes.some((c) => c.micOpen && c.status === 'listening'));
  assert.equal(l.micOpen, w.open() > 0);
  w.setVisible(false);
  assert.equal(l.micOpen, w.open() > 0);
  const phrase = r.wakePhrase(BRAND.name);
  const shown = r.renderWakeIndicator(true, phrase);
  assert.match(shown, /data-testid="wake-indicator"/);
  assert.match(shown, /role="status"/);
  assert.match(shown, /class="fixed /, 'fixed: on screen whatever the page');
  assert.ok(shown.includes(`Mic on: listening for <q class="font-medium">${phrase}</q>`), 'says so in words');
  assert.match(shown, /data-testid="wake-off"/, 'and can be turned off right there');
  assert.equal(r.renderWakeIndicator(false, phrase), '', 'gone once the mic is closed');
  // The dashboard renders it on every page, outside the routed page.
  assert.match(readFileSync(join(repoRoot, 'web', 'src', 'App.tsx'), 'utf8'), /\{state && <WakeWord role=\{state\.role\} brand=\{state\.brand\.name\} \/>\}/);
});

test('a wake word stops talk-back and starts on-device dictation into the box; nothing is sent, no network at all', async () => {
  const box = { value: 'Draft', selectionStart: 5, selectionEnd: 5, setSelectionRange() {} };
  const { ctor, made } = fakeRecognizer();
  const w = fakeWake();
  // An answer being read aloud (talk.ts) when the owner says the wake word.
  const f = fakeSynth();
  const talk = new r.TalkBack({ lang: 'en-US', allowNetwork: false, synth: f.s });
  const network = await noNetwork(async () => {
    const l = w.make();
    l.set({ enabled: true });
    talk.setActive(true);
    await talk.speak('A long answer about issue 12.');
    assert.equal(talk.speaking, true);
    await settle();
    w.hit();
    assert.deepEqual(w.woken, [1], 'the Ask panel is told');
    assert.equal(talk.speaking, false, "talk-back stopped at the hit, through talk.ts's stopSpeaking, before dictation starts");
    assert.deepEqual(f.calls, ['speak', 'cancel']);
    assert.equal(w.open(), 0, 'the wake mic is closed: dictation has it now');
    assert.equal(l.status, 'held');
    // What the Ask panel does on the wake: the same dictation as the mic button.
    const dictation = new r.Dictation(ctor, { lang: 'en-US', local: true }, { onFinal: r.intoBox(() => box, () => {}), onInterim: () => {}, onListening: () => {}, onError: () => {} });
    assert.equal(r.startOnWake({ support: READY_LOCAL, listening: false, start: () => dictation.start() }), 'started');
    l.dictating(true);
    await settle();
    assert.equal(w.gum(), 1, 'no wake mic while dictating');
    l.dictating(false);
    await settle();
    assert.equal(w.gum(), 2, 'listening again once dictation ends');
    l.dispose();
    talk.dispose();
  });
  assert.deepEqual(made[0]!.calls, ['start'], 'dictation started, and only that');
  assert.equal((made[0] as unknown as { processLocally: boolean }).processLocally, true, 'on-device, as the mic button');
  assert.equal(box.value, 'Draft', 'nothing typed, nothing sent');
  assert.deepEqual(network, [], 'no fetch, WebSocket, XHR or EventSource from the wake word');
  // The support check still running waits; no on-device recognizer never starts one.
  let started = 0;
  assert.equal(r.startOnWake({ support: null, listening: false, start: () => started++ }), 'pending');
  assert.equal(r.startOnWake({ support: { kind: 'disabled', why: r.NO_ON_DEVICE }, listening: false, start: () => started++ }), 'unavailable');
  assert.equal(started, 0);
});

test('a hidden tab closes the wake mic at once; visible again, it listens again', async () => {
  const w = fakeWake();
  const l = w.make();
  l.set({ enabled: true });
  await settle();
  assert.equal(w.open(), 1);
  w.setVisible(false);
  assert.equal(w.open(), 0, 'tracks stopped synchronously on hide');
  assert.equal(l.micOpen, false);
  await settle();
  assert.equal(l.status, 'hidden');
  assert.equal(w.gum(), 1);
  w.setVisible(true);
  await settle();
  assert.equal(w.gum(), 2);
  assert.equal(l.status, 'listening');
  // Hidden while the mic is still being asked for: the stream that arrives late is stopped, not used.
  w.setVisible(false);
  w.setVisible(true);
  w.setVisible(false);
  await settle();
  assert.equal(w.open(), 0);
  assert.equal(l.micOpen, false);
  l.dispose();
});

test('a revoked or denied mic permission closes it and it is not asked for again', async () => {
  const w = fakeWake();
  const l = w.make();
  l.set({ enabled: true });
  await settle();
  w.setPerm('prompt');
  await settle();
  assert.equal(w.open(), 0);
  assert.equal(l.status, 'revoked');
  assert.equal(w.gum(), 1, 'not asked again');
  w.setPerm('granted');
  await settle();
  assert.equal(w.gum(), 2, 'granted again: listens');
  // A track that ends (the browser took the mic away): closed, not reopened.
  w.tracks.at(-1)!.ended?.();
  await settle();
  assert.equal(l.status, 'revoked');
  assert.equal(w.gum(), 2);
  l.dispose();
  const denied = fakeWake({ perm: 'denied' });
  const d = denied.make();
  d.set({ enabled: true });
  await settle();
  assert.equal(denied.gum(), 0, 'denied: never asked');
  assert.equal(d.status, 'blocked');
});

test('the listening marker is our own ring, and holds still under prefers-reduced-motion', () => {
  const css = readFileSync(join(repoRoot, 'web', 'src', 'styles.css'), 'utf8');
  assert.match(r.renderWakeIndicator(true, 'hey x'), /<span class="wake-ring" aria-hidden="true"><\/span>/);
  assert.match(css, /\.wake-ring::after \{[^}]*animation: wake-pulse /, 'it pulses');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.wake-ring::after \{ display: none; animation: none; \} \}/, 'reduced motion: the pulse is gone');
  assert.match(css, /\.wake-ring \{[^}]*border: 2px solid var\(--red\)/, 'the still ring stays, in the theme token');
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
