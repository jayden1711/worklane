// Render checks for the web UI: every page, rendered on the server from the
// state a real dashboard serves for the seeded demo project, still shows its
// data; decisions are still answerable only where the server says so.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
import { asPerson, exampleRoles, repoRoot } from './helpers.js';

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
  renderWaiting(w: unknown, now?: number): string;
  renderWaitingPage(state: unknown): string;
  renderSetup(data: unknown): string;
  keyData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null;
  renderRunsRefused(message: string): string;
  runsRefused(message: string): string | null;
  runsRefusal(state: unknown): string | null;
  renderRunResearch(data: unknown): string;
  renderInstances(hub: unknown, current: string): string;
  renderStopBanner(state: State): string;
  renderPrs(view: unknown): string;
  renderLiveFeed(items: unknown[], ended: boolean): string;
  renderConsole(data: unknown): string;
  renderAgents(state: State, live: unknown): string;
  renderHealth(view: unknown, instances?: unknown[]): string;
  renderMachine(data: unknown): string;
  renderInstanceSettings(data: unknown): string;
  parseEntry(key: string, raw: string): unknown;
  showValue(key: string, v: unknown): string;
  boundsOf(key: string, d: unknown): string;
  LABEL: Record<string, string>;
  probeHub(servedByHub: boolean, get: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>, auth?: string): Promise<unknown>;
  probeMe(servedByHub: boolean, get: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>, auth?: string): Promise<unknown>;
  renderBoard(boards: { name: string | null; data: unknown; error: string | null }[], filter?: string | null, now?: number): string;
  renderOutline(items: unknown[], ended: boolean): string;
  renderMachineSlots(slots: unknown): string;
  elapsed(since: string, now?: number): string;
  renderSignIn(): string;
  renderWhoAmI(state: { user: string; role?: string; via?: string }): string;
  renderAudit(entries: unknown[]): string;
  renderChatAnswer(f: unknown, cli: string): string;
  renderProposedSetting(data: unknown, proposed: { key: string; value: unknown }): string;
  actionHref(a: unknown): string | null;
  citationHref(c: unknown): string;
  proposedSetting(search: string): unknown;
  pages: Record<string, unknown>;
}

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
  const noUpdater = r.renderMachine({ ...data, updates: { configured: false, enabled: null }, history: [] });
  assert.match(noUpdater, /data-setting="updates"[\s\S]*?not set up/);
  assert.match(noUpdater, /No updates: the updater isn(&#x27;|')t set up on this machine/);
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
  assert.match(r.renderConsole({ ...con, canControl: false }), /data-testid="console-read-only"[^>]*>Only the owner, @example-owner, can message or stop this run\./);
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

test('the Board renders for the owner, a writer and a viewer without errors: five columns, every card, the instance filter', () => {
  for (const role of ['owner', 'writer', 'viewer'] as const) {
    const b = boards[role];
    assert.equal(b.role, role, `the server read ${role}`);
    assert.ok(b.cards.length >= 4, 'the demo has work in flight');
    const html = clean(() => r.renderBoard([{ name: null, data: b, error: null }]));
    assert.equal((html.match(/data-testid="board-column"/g) ?? []).length, 5);
    for (const [col, label] of [['planning', 'Planning'], ['building', 'Building'], ['verifying', 'Verifying'], ['waiting', 'Waiting on you'], ['landing', 'Landing']]) assert.match(html, new RegExp(`data-column="${col}"[^>]*>[\\s\\S]*?${label}`));
    assert.equal((html.match(/data-testid="board-card"/g) ?? []).length, b.cards.length, `${role}: every card`);
    for (const id of ['board', 'board-filter', 'board-card-ref', 'board-card-title', 'board-card-diff', 'board-card-comments', 'board-card-elapsed', 'board-card-checks']) assert.match(html, new RegExp(`data-testid="${id}"`), `${role}: ${id}`);
    assert.match(html, /data-testid="board-card-run"[\s\S]*?data-testid="board-card-usage"/, 'the running agent and its resource use');
    assert.doesNotMatch(html, /<select/, "an instance's own dashboard: no instance picker");
    // The page itself, and the Machine page, render for each role too.
    assert.match(clean(() => r.renderPage('board', { owner: asOwner, writer: asWriter, viewer: asOther }[role])), /data-testid="page-board"[\s\S]*<h1[^>]*>Board</);
  }
  // On a hub: every instance, a filter to pick one, the instance on each card.
  const hub = clean(() => r.renderBoard([{ name: 'a', data: boards.owner, error: null }, { name: 'b', data: { ...boards.viewer, instance: 'b', cards: boards.viewer.cards.map((c) => ({ ...c, instance: 'b' })) }, error: null }, { name: 'c', data: null, error: 'answered 502' }]));
  assert.match(hub, /<select[^>]*data-testid="board-filter"/);
  assert.match(hub, /<option value=""[^>]*>All instances \(3\)<\/option>/);
  assert.equal((hub.match(/data-testid="board-card"/g) ?? []).length, boards.owner.cards.length + boards.viewer.cards.length);
  assert.match(hub, /data-testid="board-instance-error"[^>]*>c: can&#x27;t load its board: answered 502/);
  const onlyB = clean(() => r.renderBoard([{ name: 'a', data: boards.owner, error: null }, { name: 'b', data: { ...boards.viewer, cards: boards.viewer.cards.map((c) => ({ ...c, instance: 'b' })) }, error: null }], 'b'));
  assert.equal((onlyB.match(/data-testid="board-card"/g) ?? []).length, boards.viewer.cards.length);
  assert.doesNotMatch(onlyB, /data-instance="demo"/, 'filtered to b');
});

test('each role sees only its actions on the Board: viewers Watch (an outline); writers Watch and Answer what they may; the owner also Steers and Approves', () => {
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
  assert.equal(count(writer, 'board-steer'), 0, 'the console is the owner\'s');
  assert.equal(count(writer, 'board-approve') + count(writer, 'board-merge'), 0, 'high-risk merges are the owner\'s');
  assert.ok(count(writer, 'board-answer') >= 1, 'a writer answers the demo\'s question');

  assert.match(viewer, /data-testid="board-watch" data-mode="outline"/);
  for (const id of ['board-steer', 'board-answer', 'board-approve', 'board-merge']) assert.equal(count(viewer, id), 0, `a viewer has no ${id}`);
  // What the server said each may do is exactly what shows.
  for (const role of ['owner', 'writer', 'viewer'] as const) {
    const a = boards[role].cards.map((c) => c.actions);
    const h = html(role);
    assert.equal(count(h, 'board-steer'), a.filter((x) => x.steer).length);
    assert.equal(count(h, 'board-answer'), a.filter((x) => x.answer).length);
    assert.equal(count(h, 'board-approve') + count(h, 'board-merge'), a.filter((x) => x.approve).length);
  }
  const outline = clean(() => r.renderOutline([{ seq: 0, at: new Date().toISOString(), kind: 'start' }, { seq: 1, at: new Date().toISOString(), kind: 'tool', tool: 'Bash' }], false));
  assert.match(outline, /data-testid="board-outline-item"[^>]*>[\s\S]*tool: Bash/);
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
