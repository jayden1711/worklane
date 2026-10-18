// The first-run page as the owner's first real install met it (#468), in a real Chrome against a real dashboard:
// the owner on their own machine isn't called "break-glass"; setup mode shows First run alone, and a deep link to a
// page that isn't there yet says what it needs; exactly one primary button, on the next required step; a done step
// folds to its line and expands again, kept across a reload in the same tab; and the way to do a step without the
// page is one complete command, folded under "Without this page". And (#417) an open panel stays where it is on screen
// across a poll that changes the detail lines above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { findChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import { setupModeConfig } from '../src/setup-mode.js';
import type { SetupProbe } from '../src/setup-steps.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, STEADY_PX, webUiSkip } from './browser-helpers.js';
import { exampleProject } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

/** The machine as the checks see it: every tool there, Claude and gh signed out, no service; git for real. */
const probe: SetupProbe = {
  which: (c) => `/stand-in/${c}`,
  run: (cmd, args, o = {}) => {
    if (cmd === 'git') {
      try {
        return { status: 0, stdout: execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (e) {
        return { status: 1, stdout: '', stderr: String((e as { stderr?: string }).stderr ?? '') };
      }
    }
    return { status: 1, stdout: '{"loggedIn": false}', stderr: 'stand-in: signed out' };
  },
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
};

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
const row = (step: string) => `[data-testid="first-run-step"][data-step="${step}"]`;

/** A page in the tab, with the dashboard's key in the tab's own storage (as the key form keeps it; never in a URL). */
async function browser(token: string) {
  const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
  const cdp = b.cdp;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (!sessionStorage.getItem('dash-token')) sessionStorage.setItem('dash-token', ${JSON.stringify(token)}); } catch {}` });
  const open = async (url: string, ready: string) => {
    await cdp.send('Page.navigate', { url });
    await until(`${ready} on ${url}`, () => js<boolean>(cdp, `!!${q(ready)}`), 30_000, 200);
  };
  return { b, cdp, open };
}

test('#468 in a real Chrome: a configured checkout\'s first run, the owner on this machine: one primary next step; a done step folds, expands, and keeps either across a reload; one complete CLI line, folded', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const { dir } = exampleProject();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  install({ root: dir });
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  new EventLog(join(stateDir, 'events.db')).close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', slotsDir: mkdtempSync(join(tmpdir(), 'frw-slots-')), setupProbe: probe });
  const { b, cdp, open } = await browser(d.token);
  try {
    await open(`${d.url}/first-run`, '[data-testid="first-run-step"]');
    // 1: the dashboard's own key on this machine is the owner, on this machine; never "break-glass" off a hub.
    assert.equal(await js<string>(cdp, `${q('[data-testid="who-role"]')}.textContent`), ' · owner (this machine)');
    // 5: exactly one primary button, on the first required step not done (Claude is signed out here).
    const primaries = await js<string[]>(cdp, `[...document.querySelectorAll('[data-primary="true"]')].map((e) => e.closest('[data-step]')?.dataset.step ?? e.dataset.testid)`);
    assert.deepEqual(primaries, ['claude-login']);
    // 13: a done step (the tools: all there) is folded to its line, and expands from its own button.
    const tools = row('tools');
    assert.equal(await js<string>(cdp, `${q(tools)}.dataset.status`), 'done');
    assert.equal(await js<string>(cdp, `${q(tools)}.dataset.expanded`), 'false');
    assert.equal(await js<boolean>(cdp, `getComputedStyle(${q(`${tools} [data-testid="first-run-step-detail"]`)}).whiteSpace === 'nowrap'`), true, 'its result on one line');
    await pressSteady(cdp, q(`${tools} [data-testid="first-run-fix"]`), 'the tools step\'s button');
    await until('the tools step expanded', () => js<boolean>(cdp, `${q(tools)}.dataset.expanded === 'true' && !!${q(`${tools} [data-testid="first-run-fix-panel"]`)}`), 10_000, 100);
    // ... and stays so after a reload in the same tab.
    await open(`${d.url}/first-run`, `${tools} [data-testid="first-run-fix-panel"]`);
    assert.equal(await js<string>(cdp, `${q(tools)}.dataset.expanded`), 'true', 'kept across a reload');
    // 16: inside it, the one way without the page: one complete line, folded until asked for.
    const without = `${tools} [data-testid="first-run-without"]`;
    assert.equal(await js<number>(cdp, `document.querySelectorAll(${JSON.stringify(`${tools} [data-testid="first-run-automation"]`)}).length`), 1);
    assert.equal(await js<boolean>(cdp, `${q(without)}.open`), false, 'folded');
    assert.equal(await js<boolean>(cdp, `${q(`${without} code`)}.checkVisibility()`), false, 'the command shows only once asked for');
    // What the walk (scripts/ci/wizard-e2e.mjs) and Settings read as the line, folded or not: "Without this page: <command>".
    const said = () => js<string>(cdp, `${q(`${tools} [data-testid="first-run-automation"]`)}.innerText`);
    assert.equal(await said(), '', 'nothing of it shown while folded');
    await pressSteady(cdp, q(`${without} summary`), 'Without this page');
    await until('the command shown', () => js<boolean>(cdp, `${q(`${without} code`)}.checkVisibility()`), 5_000, 100);
    const line = await js<string>(cdp, `${q(`${without} code`)}.textContent`);
    assert.equal((await said()).replace(/^Without this page: /, '').trim(), line, 'the same line, opened');
    assert.equal(line, `${BRAND.cli} init --yes (local: the same pinned tools); on a server, scripts/setup/tools.sh through bootstrap.sh --hardened`);
    assert.equal(await js<number>(cdp, `${q(`${without} code`)}.scrollHeight <= ${q(`${without} code`)}.clientHeight + 1 ? 1 : 0`), 1, 'one line, never wrapped');
    // Opened by its link (Settings' Run again): the line is open from the start, as the walk reads it.
    await open(`${d.url}/first-run?step=tools`, `${tools} [data-testid="first-run-fix-panel"]`);
    assert.equal(await js<boolean>(cdp, `${q(without)}.open`), true);
    assert.equal((await said()).replace(/^Without this page: /, '').trim(), line);
    // Folded again from the same button, and kept so after a reload.
    await pressSteady(cdp, q(`${tools} [data-testid="first-run-fix"]`), 'the tools step\'s button');
    await until('the tools step folded', () => js<boolean>(cdp, `${q(tools)}.dataset.expanded === 'false'`), 10_000, 100);
    await open(`${d.url}/first-run`, tools);
    assert.equal(await js<string>(cdp, `${q(tools)}.dataset.expanded`), 'false');
    assert.equal(await js<boolean>(cdp, `!!${q(`${tools} [data-testid="first-run-fix-panel"]`)}`), false);
    // 2, configured: every page in the sidebar (Extend too: the owner here is the break-glass owner), First run among none of them (Settings links to it).
    const nav = await js<string[]>(cdp, `[...document.querySelectorAll('aside nav[aria-label="Pages"] a')].map((a) => a.dataset.testid)`);
    assert.equal(nav.length, 19, nav.join(', '));
    assert.ok(!nav.includes('nav-first-run'));
  } finally {
    await b.close();
    await d.close();
  }
});

test('#468 in a real Chrome: setup mode shows First run alone; a deep link to a page not there yet says what it needs and leads to First run', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const { dir } = exampleProject();
  rmSync(join(dir, BRAND.configDir), { recursive: true, force: true });
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  new EventLog(join(stateDir, 'events.db')).close();
  const d = await startDashboard({ root: dir, cfg: setupModeConfig(dir, 'example-owner'), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', slotsDir: mkdtempSync(join(tmpdir(), 'frw-slots-')), setupProbe: probe, setupMode: {} });
  const { b, cdp, open } = await browser(d.token);
  try {
    await open(`${d.url}/issues`, '[data-testid="setup-mode-hidden"]');
    assert.equal(await js<string>(cdp, `${q('[data-testid="setup-mode-hidden-why"]')}.textContent`), 'Issues shows once this checkout has its config, and it has none yet.');
    const nav = await js<string[]>(cdp, `[...document.querySelectorAll('aside nav[aria-label="Pages"] a')].map((a) => a.dataset.testid)`);
    assert.deepEqual(nav, ['nav-first-run']);
    await pressSteady(cdp, q('[data-testid="setup-mode-hidden-link"]'), 'Open First run');
    await until('the first-run page', () => js<boolean>(cdp, `location.pathname === '/first-run' && !!${q('[data-testid="page-first-run"]')}`), 15_000, 100);
    // The one primary button here too: setup mode's first step left (once the checklist has loaded).
    await until('the checklist', () => js<boolean>(cdp, `!!${q('[data-testid="first-run-step"]')}`), 15_000, 100);
    assert.equal(await js<number>(cdp, `document.querySelectorAll('[data-primary="true"]').length`), 1);
  } finally {
    await b.close();
    await d.close();
  }
});

/**
 * In the page, before it loads (#417): the first-run answer with the detail lines `window.__details` names (step id to
 * line) put in place of the server's, and the page's own 15 s poll (POLL_MS in web/src/pages/FirstRun.tsx) run at
 * once by `window.__poll()`, not 15 s later.
 */
const POLL_HOOKS = `(() => {
  const realFetch = window.fetch.bind(window);
  window.__details = null;
  window.fetch = async (input, init) => {
    const res = await realFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const details = window.__details;
    if (!details || url.pathname !== '/api/first-run' || !res.ok) return res;
    const body = await res.json();
    for (const g of body.setup?.groups ?? []) for (const s of g.steps) if (s.id in details) s.detail = details[s.id];
    return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  const polls = new Map();
  const set = window.setInterval.bind(window);
  const clear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const id = set(fn, ms, ...rest);
    if (ms === 15000) polls.set(id, fn);
    return id;
  };
  window.clearInterval = (id) => {
    polls.delete(id);
    clear(id);
  };
  window.__polls = () => polls.size;
  window.__poll = () => polls.forEach((fn) => fn());
})()`;

test('#417 in a real Chrome: an open panel\'s offset does not change across a poll that changes the detail lines above it', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const { dir } = exampleProject();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  install({ root: dir });
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  new EventLog(join(stateDir, 'events.db')).close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', slotsDir: mkdtempSync(join(tmpdir(), 'frw-slots-')), setupProbe: probe });
  const { b, cdp, open } = await browser(d.token);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: POLL_HOOKS });
  // The open step (an action with a static panel, low on the page) and the lines above its panel: two steps' above it
  // (one not done, one optional) and its own.
  const step = 'fingerprints';
  const above = ['required-checks', 'pre-commit', step];
  const panel = `${row(step)} [data-testid="first-run-fix-panel"]`;
  const detail = (id: string) => `${row(id)} [data-testid="first-run-step-detail"]`;
  /** The panel's offset in the view, two frames after the last change (a frame for a late answer to land). */
  const panelTop = () => js<number>(cdp, `new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(${q(panel)}.getBoundingClientRect().top))))`);
  const heights = () => js<number[]>(cdp, `${JSON.stringify(above.map(detail))}.map((s) => document.querySelector(s).getBoundingClientRect().height)`);
  try {
    await open(`${d.url}/first-run`, row(step));
    // Opened from its button, as a person does (pressSteady scrolls it to the middle of the view first).
    await pressSteady(cdp, q(`${row(step)} [data-testid="first-run-fix"]`), `the ${step} step's button`);
    await until('its panel open', () => js<boolean>(cdp, `!!${q(panel)}`), 10_000, 100);
    assert.equal(await js<number>(cdp, 'window.__polls()'), 1, 'the page polls every 15 s');
    // Each line above the panel is on screen, between the top of the view and the panel: a change there is one a person sees.
    const top0 = await panelTop();
    for (const id of above) assert.equal(await js<boolean>(cdp, `(() => { const r = ${q(detail(id))}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= ${top0}; })()`), true, `${id}'s line on screen above the panel`);
    const long = 'A detail line long enough to wrap: '.concat('it says more than one line of this page holds, '.repeat(8)).trim();
    const cases: [string, Record<string, string>][] = [
      ['longer, wrapping to more lines', Object.fromEntries(above.map((id) => [id, `${id}: ${long}`]))],
      ['shorter, one line each', Object.fromEntries(above.map((id) => [id, `${id}: ok`]))],
    ];
    for (const [what, details] of cases) {
      const before = await panelTop();
      const was = await heights();
      await js<boolean>(cdp, `(window.__details = ${JSON.stringify(details)}, window.__poll(), true)`);
      await until(`the poll's answer drawn (${what})`, () => js<boolean>(cdp, `${JSON.stringify(Object.entries(details))}.every(([id, line]) => document.querySelector('[data-testid="first-run-step"][data-step="' + id + '"] [data-testid="first-run-step-detail"]')?.textContent === line)`), 10_000, 50);
      const after = await panelTop();
      assert.notDeepEqual(await heights(), was, `${what}: the lines above the panel changed height`);
      assert.ok(Math.abs(after - before) <= STEADY_PX, `${what}: the open panel moved from ${before} px to ${after} px in the view`);
    }
  } finally {
    await b.close();
    await d.close();
  }
});
