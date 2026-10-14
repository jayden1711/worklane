#!/usr/bin/env node
// Drive the dashboard the way a person would, to check a UI change: seed a
// demo project in a temporary directory, start its dashboard, and control a
// headless Chrome or Chromium over the DevTools protocol (no npm dependency).
// Pages are named by their id in docs/feature-map.md.
//
//   node scripts/dev/control-dashboard.mjs check [--out <dir>] [--baseline <earlier check output>]
//       every page: wait for it, screenshot it, collect console errors; with a baseline, only new errors fail
//   node scripts/dev/control-dashboard.mjs open <page|/path> [--screenshot <file>]
//   node scripts/dev/control-dashboard.mjs run [<commands file> | -]  one command per line (JSON or short form); one JSON result per line
//   node scripts/dev/control-dashboard.mjs probe                     what works here: loopback, Chrome, DevTools (for sandboxed agents)
//
// Commands for `run` (short form or JSON):
//   open decisions | {"op":"open","page":"/issues/3"}      navigate and wait for the page's heading
//   click text:Approve | click testid:x | click <css>     a real mouse click at the element's centre
//   click point:380,400                                    a real mouse click at that point of the page (e.g. an overlay beside a drawer)
//   type hello | {"op":"type","target":"input","text":"x"}
//   key j | key Meta+k | key Escape                        keyboard input (shortcuts, chords)
//   text <target>                                          the element's text (default: main)
//   wait 500 | wait <target>                               a pause, or until the element exists
//   screenshot <file.png>                                  the viewport as PNG
//   console                                                console errors and exceptions so far
//   trace <file.json> | {"op":"trace","file":"t.json","ms":3000,"page":"issues"}   a performance trace (Chrome trace format)
//   eval <js expression>                                   its value (JSON)
//
// Options: --engine <built checkout> (default: this one), --chrome <path> (or CHROME), --theme light|dark,
// --with-prs (add pull-request history for the PR views), --with-usage-pause (pause the demo on the Claude usage
// limit, resetting in 2 h: the banner and the Overview's usage line), --with-incidents (watchdog incidents for
// Health: two open, one resolved, in a slot directory of its own under the temporary directory), --with-learnings
// (failed-run notes for the Learnings panel on Reports: one cause seen 3 times, one seen once), --with-stage-labels
// (earliest-failed-stage labels for the report preview's stage section on Reports, plan and review among them), --with-goal
// (two goals split into the demo's tasks for the task graph: #900, and #901 whose two other tasks form a dependency cycle),
// --viewport <w>x<h> (default 1440x1000; under
// 768 wide, e.g. 390x844, a phone), --keep (leave the temporary directory),
// --no-chrome-sandbox (for nested sandboxes; see the skill), --user <login> (whom the dashboard serves; default the
// demo's owner, example-owner; the token is the owner's break-glass, so this only names who answers),
// --as owner|writer|viewer (through the hub instead: sign in with GitHub, a fake one, as that role; see signin-fake.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineErrors, errorKey, findPage, loadFeatureMap, pagePath, parseCommand, readyText, targetExpr } from './feature-map.mjs';
// The DevTools client and its helpers, shared with the project-app runner (src/browser/cdp.ts, built).
import { findChrome as sharedFindChrome, freePort, launchChrome, sleep, until } from '../../dist/src/browser/cdp.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const VALUE_OPTIONS = ['--engine', '--chrome', '--theme', '--out', '--screenshot', '--baseline', '--user', '--as', '--viewport'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTIONS.includes(argv[i - 1]));
const [command = 'help', ...rest] = positional;
const engine = resolve(option('--engine', fileURLToPath(new URL('../..', import.meta.url))));
const theme = option('--theme', 'light');
/** --viewport <width>x<height>: the page's size (default 1440x1000); under 768 wide it is emulated as a phone. */
const viewport = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(option('--viewport', '1440x1000'));
  if (!m) throw new Error('--viewport takes <width>x<height>, e.g. 390x844');
  return { width: Number(m[1]), height: Number(m[2]) };
})();
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Chrome or Chromium: --chrome, CHROME, then the usual places (src/browser/cdp.ts, shared with the project-app runner). */
export function findChrome(given = option('--chrome', process.env.CHROME)) {
  return sharedFindChrome(given);
}

export { freePort };

/** Seed the demo, start its dashboard, start Chrome: everything under one temporary directory. */
async function start() {
  const cli = join(engine, 'dist', 'src', 'cli.js');
  if (!existsSync(cli) || !existsSync(join(engine, 'dist', 'web', 'index.html'))) throw new Error(`${engine} isn't built: run npm run build && npm run build:web in it`);
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome or Chromium found; pass --chrome <path> (or set CHROME)');
  const { BRAND } = await import(pathToFileURL(join(engine, 'dist', 'src', 'brand.js')).href);
  const work = mkdtempSync(join(tmpdir(), 'dash-control-'));
  const procs = [];
  let browser = null;
  const stop = async () => {
    for (const p of procs) p.kill();
    // Chrome and all its processes stopped, and its profile removed, before the directory holding it goes.
    const note = browser ? await browser.close() : null;
    if (note) process.stderr.write(`control-dashboard: ${note}\n`);
    if (!flag('--keep')) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    // The demo, its dashboard and their state all live in the temporary directory, never the user's own:
    // in the children, and in this process too (the run record below is written from here).
    process.env[`${BRAND.envPrefix}_STATE_DIR`] = join(work, 'state');
    // With incidents, the machine's slot directory (where the watchdog keeps them) is the temporary one too.
    if (flag('--with-incidents')) process.env.AGENT_SLOTS_DIR = join(work, 'slots');
    const env = { ...process.env };
    const seeded = spawnSync(process.execPath, [cli, 'demo', join(work, 'demo')], { encoding: 'utf8', env });
    const root = seeded.stdout.match(/project (.+)/)?.[1]?.trim();
    if (seeded.status !== 0 || !root) throw new Error(`seeding the demo failed:\n${seeded.stdout}${seeded.stderr}`);
    const as = option('--as');
    const dash = as
      ? spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'signin-fake.mjs'), root, as, engine, join(work, 'hub')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, [cli, 'dashboard', '--root', root, '--user', option('--user', 'example-owner'), '--no-open', '--port', String(await freePort())], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(dash);
    let printed = '';
    dash.stdout.on('data', (d) => (printed += d));
    dash.stderr.on('data', (d) => (printed += d));
    const shown = await until('the dashboard URL', () => printed.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)?.[0], 20_000).catch((e) => {
      throw new Error(`${e.message}\n${printed}`);
    });
    // With --as, the browser goes through the hub and signs in; the token here only seeds the run below.
    const hub = as ? await until('the hub URL', () => printed.match(/^hub (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1], 20_000) : null;
    const direct = shown.split('/?')[0];
    const token = shown.split('?t=')[1];
    const base = hub ?? direct;
    const state = await (await fetch(`${direct}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
    const issue = state.tasks.find((t) => t.status === 'awaiting_decision')?.issue ?? state.tasks[0]?.issue;
    const run = await seedRun(root, issue);
    if (flag('--with-prs')) await seedPrs(root, state.tasks.map((t) => t.issue));
    if (flag('--with-usage-pause')) await seedUsagePause(root, issue);
    if (flag('--with-incidents')) await seedIncidents(process.env.AGENT_SLOTS_DIR);
    if (flag('--with-learnings')) await seedLearnings(root, state.tasks.map((t) => t.issue));
    if (flag('--with-stage-labels')) await seedStageLabels(root, state.tasks.map((t) => t.issue));
    if (flag('--with-goal')) await seedGoals(root, state.tasks.map((t) => t.issue));

    // Chrome started the way the engine starts it for its own browser checks (src/browser/cdp.ts launchChrome):
    // its launch wait (scaled on a loaded machine by <PREFIX>_BROWSER_TIMEOUT_SCALE) and one more start when the
    // DevTools port never appears, rather than a fixed wait of this script's own. Its profile is in the temporary
    // directory with everything else.
    browser = await launchChrome(chrome, {
      width: viewport.width,
      height: viewport.height,
      noSandbox: flag('--no-chrome-sandbox'),
      profileRoot: work,
      extraArgs: ['--force-prefers-reduced-motion', ...(theme === 'dark' ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1'])],
    });
    for (const note of browser.notes) process.stderr.write(`control-dashboard: ${note}\n`);
    const cdp = browser.cdp;
    return { cdp, base, token: hub ? null : token, signIn: !!hub, issue, run, stop, work };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** A recorded agent run, so the run page has something to show (the demo's scripted agents don't record one). */
async function seedRun(root, issue) {
  const rec = join(engine, 'dist', 'src', 'run-record.js');
  const ctx = join(engine, 'dist', 'src', 'guardrails', 'context.js');
  if (!existsSync(rec) || !existsSync(ctx) || issue === undefined) return null;
  const { RunRecorder } = await import(pathToFileURL(rec).href);
  const { projectStateDir } = await import(pathToFileURL(ctx).href);
  const wt = join(root, '.claude', 'worktrees', `issue-${issue}`);
  const r = new RunRecorder(projectStateDir(root), { role: 'worker', model: 'sonnet', cwd: wt });
  r.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } });
  r.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 1\nnot ok 3 - totals round to the cent' }] } });
  r.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: join(wt, 'src', 'totals.js') } }] } });
  r.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'edited' }] } });
  r.finish({ reason: 'succeeded', costUsd: 0.42, turns: 4, model: 'sonnet', final: 'Totals round half-up to the cent now.' });
  return r.id;
}

/**
 * --with-prs: pull-request history for the PR views (the demo opens none): one PR being checked, one
 * waiting for its owner after a CI fix run gave up, one auto-merged, a refused push, and an auto-merge
 * stop with its revert. Appended through the engine's own event log, so each event is checked against
 * its schema; an engine without these events gets none.
 */
async function seedPrs(root, issues) {
  const logMod = join(engine, 'dist', 'src', 'events', 'log.js');
  const svc = join(engine, 'dist', 'src', 'service.js');
  if (!existsSync(logMod) || !existsSync(svc) || issues.length < 4) return;
  const { EventLog } = await import(pathToFileURL(logMod).href);
  const { logPath } = await import(pathToFileURL(svc).href);
  const log = new EventLog(logPath(root));
  const [a, b, c, d] = issues;
  const h = (n) => String(n).repeat(7).slice(0, 7) + 'abcdef0';
  const url = (n) => `https://github.com/example/shop/pull/${n}`;
  const events = [
    ['pr.opened', { issue: a, number: 101, url: url(101), head: h(1), draft: true }],
    ['pr.status', { issue: a, number: 101, head: h(1), ready: false, reasons: ['test pending'], checks: [{ name: 'lint', outcome: 'pass' }, { name: 'test', outcome: 'pending' }] }],
    ['pr.opened', { issue: b, number: 102, url: url(102), head: h(2), draft: true }],
    ['pr.status', { issue: b, number: 102, head: h(2), ready: false, reasons: ['test failed'], checks: [{ name: 'lint', outcome: 'pass' }, { name: 'test', outcome: 'fail' }] }],
    ['ci_fix.started', { issue: b, number: 102, head: h(2), checks: ['test'], attempt: 1, lease: h(9) }],
    ['ci_fix.finished', { issue: b, number: 102, outcome: 'no_push', head: null, detail: 'the failure is in a test this change does not touch' }],
    ['ci_fix.gave_up', { issue: b, number: 102, head: h(2), reason: 'the worker showed the failure is not caused by this change' }],
    ['merge.decided', {
      issue: b, number: 102, head: h(2), auto: false,
      reasons: ['a CI fix run happened on this PR', 'high-risk: migration (db/migrations/002_orders.sql)', 'high-risk: self-modification (src/merge-policy.ts)'],
      why: [{ category: 'migration', text: 'changes a database migration: db/migrations/002_orders.sql' }, { category: 'self-modification', text: 'changes the merge policy: src/merge-policy.ts' }],
    }],
    ['pr.opened', { issue: c, number: 103, url: url(103), head: h(3), draft: true }],
    ['pr.status', { issue: c, number: 103, head: h(3), ready: true, reasons: [], checks: [{ name: 'lint', outcome: 'pass' }, { name: 'test', outcome: 'pass' }] }],
    ['pr.ready', { issue: c, number: 103, head: h(3) }],
    ['merge.decided', { issue: c, number: 103, head: h(3), auto: true, reasons: ['every required check passed on the evaluated commit', '42 lines in 2 files'] }],
    ['merge.done', { issue: c, number: 103, head: h(3), sha: h(4), url: url(103), title: 'Round totals to the cent' }],
    ['pr.closed', { issue: c, number: 103, merged: true }],
    ['merge.main_result', { issue: c, number: 103, sha: h(4), outcome: 'red', failed: ['test'] }],
    ['merge.stopped', { reason: 'main went red after an auto-merge', number: 103, sha: h(4), revert: url(104) }],
    ['push.refused', { issue: d, head: h(5), stage: 'change', reasons: ['changes 1900 lines (limit 1500)'] }],
    // WHY: the holds table's two kinds, a file hold and a "Depends on" hold (src/task-graph.ts).
    ['hotspot.held', { issue: d, by: a, files: ['src/totals.js'], reason: `waits for #${a}: both change src/totals.js` }],
    ['dependency.held', { issue: c, on: [b], reason: `waits for #${b} to close` }],
    ['pr_hygiene.pass', { merged_in: 1, conflicting: 0, closed: 0, held: 1, skipped: 1, prs: [{ number: 101, outcome: 'merged_in', why: 'base 4 day(s) old' }, { number: 102, outcome: 'held', why: 'labelled needs-owner' }, { number: 103, outcome: 'skipped', why: 'already up to date with main' }] }],
  ];
  for (const [type, payload] of events) {
    try {
      log.append(type, payload, 'demo');
    } catch (e) {
      // An older engine doesn't know the event: left out, and said so.
      console.error(`--with-prs: ${type} not recorded (${e.message.split('\n')[0]})`);
    }
  }
}

/** WHY: item 33; the demo fails no task, so --with-learnings notes a cause seen 3 times (promotable) and one seen once. */
async function seedLearnings(root, issues) {
  const logMod = join(engine, 'dist', 'src', 'events', 'log.js');
  const svc = join(engine, 'dist', 'src', 'service.js');
  if (!existsSync(logMod) || !existsSync(svc) || issues.length < 3) return;
  const { EventLog } = await import(pathToFileURL(logMod).href);
  const { logPath } = await import(pathToFileURL(svc).href);
  const log = new EventLog(logPath(root));
  const note = (i, issue, outcome, stage, cause, fp, root) => ({ key: `${issue}:worker:${i}`, issue, role: 'worker', attempt: 1, run: null, outcome, stage, cause, fingerprint: fp, same_as: root });
  const notes = [
    note(1, issues[0], 'checks failed', 'verification', 'test: fail', 'f1a2b3c4d5e6f7a8', null),
    note(2, issues[1], 'checks failed', 'verification', 'test: fail', 'f1a2b3c4d5e6f7a8', `${issues[0]}:worker:1`),
    note(3, issues[2], 'checks failed', null, 'test: fail', 'f1a2b3c4d5e6f7a8', `${issues[0]}:worker:1`),
    note(4, issues[2], 'startup failure', 'environment/harness', 'error_during_execution: (no error text)', '0a1b2c3d4e5f6a7b', null),
  ];
  for (const n of notes) {
    try {
      log.append('learning.noted', n, 'demo');
    } catch (e) {
      console.error(`--with-learnings: not recorded (${e.message.split('\n')[0]})`);
    }
  }
}

/** --with-stage-labels: the demo fails no run, so the week's stage labels are recorded as the labeller would, one or more per stage. */
async function seedStageLabels(root, issues) {
  const logMod = join(engine, 'dist', 'src', 'events', 'log.js');
  const svc = join(engine, 'dist', 'src', 'service.js');
  if (!existsSync(logMod) || !existsSync(svc) || !issues.length) return;
  const { EventLog } = await import(pathToFileURL(logMod).href);
  const { logPath } = await import(pathToFileURL(svc).href);
  const log = new EventLog(logPath(root));
  const label = (run, stage, reason, by = 'code') => ({ run, issue: issues[0], role: stage === 'plan' && run.startsWith('plan') ? 'planner' : 'worker', instance: 'demo', stage, reason, by });
  const labels = [
    label('plan-1', 'plan', 'the plan contract check sent the plan back: the plan run gave no steps'),
    label('plan-2', 'plan', '@example-owner rejected the plan at the plan gate'),
    label('work-1', 'plan', 'the plan never names test/price.test.js, the done_when test that failed'),
    label('work-2', 'wrong files', 'edited the client when the bug is in the server', 'judge'),
    label('work-3', 'verification', "the run didn't run any of the issue's done_when commands"),
    label('work-4', 'review', "the evaluator passed 1a2b3c4d (confidence high); the PR's checks then failed on that same head: test"),
    label('work-5', 'review', "the evaluator rejected 5e6f7a8b; that same head merged as #9 and the default branch's checks stayed green"),
    label('work-6', 'environment/harness', 'the run has a run.transient_retry event'),
  ];
  for (const l of labels) {
    try {
      log.append('run.stage_labeled', l, 'demo');
    } catch (e) {
      console.error(`--with-stage-labels: not recorded (${e.message.split('\n')[0]})`);
    }
  }
}

/** --with-goal: the demo files no goal; #900 is split into its first four tasks, #901 into the fifth and sixth, which wait on each other. */
async function seedGoals(root, issues) {
  const logMod = join(engine, 'dist', 'src', 'events', 'log.js');
  const svc = join(engine, 'dist', 'src', 'service.js');
  if (!existsSync(logMod) || !existsSync(svc) || issues.length < 6) return;
  const { EventLog } = await import(pathToFileURL(logMod).href);
  const { logPath } = await import(pathToFileURL(svc).href);
  const log = new EventLog(logPath(root));
  const [a, b, c, d, e, f] = issues;
  const seen = (issue, title) => ['issue.seen', { issue, title, labels: ['type:goal', 'goal:split'], author: 'example-owner', owner: 'example-owner', actionable: false, why: 'a goal' }];
  const kid = (number, key, depends_on) => ({ number, key, depends_on, body_hash: '0000000000000000' });
  const events = [
    seen(900, 'Checkout totals, end to end'),
    ['goal.split', { issue: 900, summary: 'Totals first, then the two views that show them, then the docs.', children: [kid(a, 'totals', []), kid(b, 'cart', [a]), kid(c, 'receipt', [a]), kid(d, 'docs', [b, c])] }],
    seen(901, 'Discounts, both ways'),
    ['goal.split', { issue: 901, summary: 'Two halves.', children: [kid(e, 'one', []), kid(f, 'two', [e])] }],
    ['dependency.cycle', { issue: e, cycle: [e, f] }],
  ];
  for (const [type, payload] of events) {
    try {
      log.append(type, payload, 'demo');
    } catch (e) {
      console.error(`--with-goal: ${type} not recorded (${e.message.split('\n')[0]})`);
    }
  }
}

/** --with-incidents: two open watchdog incidents (one red, one amber) and a resolved one, in the temporary slot directory. */
async function seedIncidents(dir) {
  const mod = join(engine, 'dist', 'src', 'watchdog', 'incidents.js');
  if (!existsSync(mod)) return;
  const { raiseIncident, resolveIncident } = await import(pathToFileURL(mod).href);
  const at = (h) => new Date(Date.now() - h * 3600_000);
  raiseIncident('unit_down', 'coordinator', "this instance's coordinator is failed", 'start it again from the machine', { dir, tried: ['restarted it 5 times before giving up'], now: at(2) });
  raiseIncident('disk_full', 'data', 'the data volume is 91% full', 'free space on that volume', { dir, severity: 'amber', now: at(1) });
  raiseIncident('github_auth', 'app', 'GitHub refused the token', 'check the GitHub App', { dir, now: at(30) });
  resolveIncident('github_auth', 'app', { dir, now: at(29) });
}

/** --with-usage-pause: a run hit the Claude usage limit and the instance is paused until 2 h from now. */
async function seedUsagePause(root, issue) {
  const logMod = join(engine, 'dist', 'src', 'events', 'log.js');
  const svc = join(engine, 'dist', 'src', 'service.js');
  if (!existsSync(logMod) || !existsSync(svc)) return;
  const { EventLog } = await import(pathToFileURL(logMod).href);
  const { logPath } = await import(pathToFileURL(svc).href);
  const log = new EventLog(logPath(root));
  const reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 2 * 3600_000).toISOString();
  const detail = "usage or rate limit reached: You've hit your limit";
  try {
    log.append('usage.limit_hit', { issue: issue ?? null, role: 'worker', model: 'sonnet', provider: null, reset_at: reset, source: 'claude', kind: 'five_hour', detail }, 'demo');
    log.append('usage.paused', { reset_at: reset, source: 'claude', kind: 'five_hour', issue: issue ?? null, role: 'worker', detail }, 'demo');
  } catch (e) {
    console.error(`--with-usage-pause: not recorded (${e.message.split('\n')[0]})`);
  }
}

/** The controller: one tab, the console errors it has seen, and the commands. */
class Controller {
  constructor(s, map) {
    Object.assign(this, s);
    this.map = map;
    this.errors = [];
    this.opened = false;
  }
  async init() {
    const c = this.cdp;
    c.on('Runtime.exceptionThrown', (p) => this.errors.push({ kind: 'exception', text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text, url: p.exceptionDetails.url ?? '' }));
    c.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'assert') this.errors.push({ kind: `console.${p.type}`, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    });
    c.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') this.errors.push({ kind: p.entry.source, text: p.entry.text, url: p.entry.url ?? '' });
    });
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: viewport.width < 768 ? 2 : 1, mobile: viewport.width < 768 });
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  params(page) {
    return { n: this.issue, id: this.run ?? '' };
  }
  async open(which) {
    // A path the map doesn't have yet (a page being added) opens too; it's ready once it shows any heading.
    const found = findPage(this.map, which) ?? (which.startsWith('/') ? { page: { id: which, route: which, ready: '' }, params: {} } : null);
    if (!found) throw new Error(`no page ${JSON.stringify(which)} in docs/feature-map.md`);
    const params = { ...this.params(found.page), ...found.params };
    const path = which.startsWith('/') ? which : pagePath(found.page, params);
    // Signing in (--as): once, through the hub's GitHub sign-in (the fake GitHub says yes at once).
    if (this.signIn && !this.signedIn) {
      await this.cdp.send('Page.navigate', { url: `${this.base}/auth/login` });
      await until('the sign-in to come back to the hub', () => this.eval(`location.origin === ${JSON.stringify(this.base)} && location.pathname === '/' && !!document.querySelector('[data-testid="who-am-i"]')`), 20_000);
      this.signedIn = true;
      this.opened = true;
    }
    // The token goes on the first load only; the page moves it to session storage.
    const url = `${this.base}${path}${this.opened || !this.token ? '' : `${path.includes('?') ? '&' : '?'}t=${this.token}`}`;
    await this.cdp.send('Page.navigate', { url });
    this.opened = true;
    const want = readyText(found.page, params);
    // A page with a root test id is ready once that element is there and its heading reads right.
    if (found.page.root) await until(`the ${found.page.id} page's root ${found.page.root}`, () => this.eval(`!!document.querySelector(${JSON.stringify(found.page.root)})`));
    const heading = await until(`the ${found.page.id} page's heading "${want}"`, async () => {
      const h = await this.eval(`document.querySelector('main header h1')?.innerText.trim() ?? ''`);
      return h && h.includes(want) ? h : null;
    });
    return { page: found.page.id, path, heading };
  }
  async element(target) {
    return until(`${target}`, () => this.eval(`(() => { const e = ${targetExpr(target)}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`), 10_000);
  }
  async click(target) {
    const point = /^point:(\d+),(\d+)$/.exec(target);
    const { x, y } = point ? { x: Number(point[1]), y: Number(point[2]) } : await this.element(target);
    for (const type of ['mousePressed', 'mouseReleased']) await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return { clicked: target };
  }
  async type(text, target) {
    if (target) await this.click(target);
    await this.cdp.send('Input.insertText', { text });
    return { typed: text.length };
  }
  async key(spec) {
    const parts = spec.split('+');
    const key = parts.pop();
    const mods = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const modifiers = parts.reduce((m, p) => m | (mods[p] ?? 0), 0);
    const printable = key.length === 1;
    const code = printable ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key;
    const keyCodes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
    const base = { key, code, modifiers, windowsVirtualKeyCode: printable ? key.toUpperCase().charCodeAt(0) : keyCodes[key] ?? 0 };
    await this.cdp.send('Input.dispatchKeyEvent', { type: printable && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(printable && !modifiers ? { text: key } : {}) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(150);
    return { key: spec };
  }
  async screenshot(file) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return { screenshot: resolve(file) };
  }
  async trace(file, ms = 3000, page) {
    const events = [];
    this.cdp.on('Tracing.dataCollected', (p) => events.push(...p.value));
    const complete = new Promise((r) => this.cdp.on('Tracing.tracingComplete', r));
    await this.cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'v8.execute', 'blink.user_timing', 'loading', 'disabled-by-default-devtools.timeline'] } });
    if (page) await this.open(page);
    await sleep(ms);
    await this.cdp.send('Tracing.end');
    await complete;
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, JSON.stringify({ traceEvents: events }));
    return { trace: resolve(file), events: events.length };
  }
  async do(c) {
    switch (c.op) {
      case 'open':
        return this.open(c.page);
      case 'click':
        return this.click(c.target);
      case 'type':
        return this.type(c.text, c.target);
      case 'key':
        return this.key(c.key);
      case 'text':
        return { text: await until(`${c.target ?? 'main'}`, () => this.eval(`(() => { const e = ${targetExpr(c.target ?? 'main')}; return e ? e.innerText : null; })()`), 10_000) };
      case 'wait':
        if (c.ms !== undefined) await sleep(c.ms);
        else await this.element(c.target);
        return { waited: c.ms ?? c.target };
      case 'screenshot':
        return this.screenshot(c.file);
      case 'console':
        return { errors: this.errors };
      case 'trace':
        return this.trace(c.file, c.ms, c.page);
      case 'eval':
        return { value: await this.eval(c.expr) };
    }
  }
}

async function session(fn) {
  const map = loadFeatureMap();
  const s = await start();
  const ctl = new Controller(s, map);
  try {
    await ctl.init();
    return await fn(ctl, map);
  } finally {
    s.cdp.close();
    await s.stop();
  }
}

/** What works here, step by step: for agents in a sandbox, so a failure names its cause. */
async function probe() {
  const steps = [];
  const step = async (name, fn) => {
    try {
      steps.push({ step: name, ok: true, detail: (await fn()) ?? '' });
    } catch (e) {
      steps.push({ step: name, ok: false, detail: e.message.split('\n').slice(0, 3).join(' ') });
    }
  };
  await step('temporary directory is writable', () => {
    const d = mkdtempSync(join(tmpdir(), 'dash-probe-'));
    rmSync(d, { recursive: true });
    return tmpdir();
  });
  await step('a loopback port can be opened', async () => `127.0.0.1:${await freePort()}`);
  await step('the engine is built', () => {
    if (!existsSync(join(engine, 'dist', 'web', 'index.html'))) throw new Error(`run npm run build && npm run build:web in ${engine}`);
    return engine;
  });
  await step('Chrome or Chromium is installed', () => {
    const c = findChrome();
    if (!c) throw new Error('none found; pass --chrome <path>');
    return c;
  });
  if (steps.every((s) => s.ok)) await step('the dashboard starts and Chrome opens it over DevTools', () => session(async (ctl) => (await ctl.open('overview')).heading));
  for (const s of steps) say(s);
  return steps.every((s) => s.ok) ? 0 : 1;
}

async function main() {
  switch (command) {
    case 'probe':
      return probe();
    case 'open':
      return session(async (ctl) => {
        say(await ctl.open(rest[0] ?? 'overview'));
        const shot = option('--screenshot');
        if (shot) say(await ctl.screenshot(shot));
        if (ctl.errors.length) say({ errors: ctl.errors });
        return ctl.errors.length ? 1 : 0;
      });
    case 'check':
      return session(async (ctl, map) => {
        const out = resolve(option('--out', 'dashboard-check'));
        // With an earlier check's output, only errors it didn't have count (the same page, kind, text and path).
        const baseFile = option('--baseline');
        const known = new Set(baseFile ? baselineErrors(readFileSync(baseFile, 'utf8')) : []);
        let bad = 0;
        for (const p of map.pages) {
          if (p.id === 'run-detail' && !ctl.run) {
            say({ page: p.id, skipped: 'this engine records no runs' });
            continue;
          }
          const before = ctl.errors.length;
          try {
            const r = await ctl.open(p.id);
            await sleep(300);
            const shot = await ctl.screenshot(join(out, `${p.id}-${theme}.png`));
            const errors = ctl.errors.slice(before);
            const fresh = errors.filter((e) => !known.has(errorKey(p.id, e)));
            if (fresh.length) bad++;
            say({ ...r, ...shot, errors, ...(baseFile ? { new_errors: fresh } : {}) });
          } catch (e) {
            bad++;
            say({ page: p.id, error: e.message });
          }
        }
        say({ pages: map.pages.length, failed: bad, out });
        return bad ? 1 : 0;
      });
    case 'run':
      return session(async (ctl) => {
        const src = rest[0] && rest[0] !== '-' ? readFileSync(rest[0], 'utf8') : readFileSync(0, 'utf8');
        let failed = 0;
        for (const [i, line] of src.split(/\r?\n/).entries()) {
          let c;
          try {
            c = parseCommand(line);
            if (!c) continue;
            say({ line: i + 1, op: c.op, ok: true, ...(await ctl.do(c)) });
          } catch (e) {
            failed++;
            say({ line: i + 1, op: c?.op ?? null, ok: false, error: e.message });
          }
        }
        return failed ? 1 : 0;
      });
    default:
    {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
      const head = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
      process.stdout.write(`${head.map((l) => l.replace(/^\/\/ ?/, '')).join('\n')}\n`);
    }
      return command === 'help' ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`control-dashboard: ${e.message}`);
      process.exit(1);
    },
  );
}
