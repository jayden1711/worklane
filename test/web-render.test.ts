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
import { repoRoot } from './helpers.js';

type State = { tasks: { issue: number; title: string; status: string }[]; decisions: { id: string; question: string; options: string[]; answer: unknown; canAnswer?: boolean }[]; activity: { summary: string }[]; emergency: unknown };
interface Render {
  renderPage(name: string, state: State): string;
  renderIssue(state: State, issue: number): string;
  renderChecks(runs: unknown[]): string;
  renderRunList(issue: number): string;
  renderInstances(hub: unknown, current: string): string;
  renderStopBanner(state: State): string;
  renderPrs(view: unknown): string;
  renderHealth(view: unknown, instances?: unknown[]): string;
  renderInstanceSettings(data: unknown): string;
  parseEntry(key: string, raw: string): unknown;
  showValue(key: string, v: unknown): string;
  probeHub(servedByHub: boolean, get: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>, auth?: string): Promise<unknown>;
  pages: Record<string, unknown>;
}

let r: Render;
let asOwner: State;
let asOther: State;

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
    const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'web-render-state-')), user, slotsDir: mkdtempSync(join(tmpdir(), 'web-render-slots-')) });
    try {
      return (await (await fetch(`${d.url.split('/?')[0]}/api/state`, { headers: { authorization: `Bearer ${d.token}` } })).json()) as State;
    } finally {
      await d.close();
    }
  };
  asOwner = await state('example-owner');
  asOther = await state('someone-else');
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
      { key: 'ci_repair.max_fixes_per_pr', value: 2, source: 'repo' },
      { key: 'run_windows', value: [{ from: '22:00', to: '06:00' }], source: 'instance' },
    ],
  };
  const html = r.renderInstanceSettings(data);
  assert.equal((html.match(/data-testid="setting-row"/g) ?? []).length, 5);
  assert.match(html, /data-setting="workers"[\s\S]*?data-testid="setting-current"[^>]*>2<[\s\S]*?this instance(&#x27;|')s[\s\S]*?1–3 \(machine 1–4, policy max 3\)/, 'current value, source, bounds (the tighter of machine and policy)');
  assert.match(html, /up to \$20 \(machine \$20, policy \$30\)/);
  assert.match(html, /data-setting="run_windows"[\s\S]*?22:00-06:00/);
  assert.match(html, /the repo(&#x27;|')s default/);
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
