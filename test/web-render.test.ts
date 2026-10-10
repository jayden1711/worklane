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
