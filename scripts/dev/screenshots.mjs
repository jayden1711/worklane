#!/usr/bin/env node
// Screenshots of every dashboard page, light and dark, against a freshly
// seeded demo project. Uses an installed Chrome or Chromium (headless); no
// npm dependency. macOS, Linux and Windows.
//   node scripts/dev/screenshots.mjs --out <dir> [--engine <checkout with dist/>] [--chrome <path>]
// The engine checkout must be built (npm run build && npm run build:web).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const engine = resolve(arg('--engine', fileURLToPath(new URL('../..', import.meta.url))));
const out = resolve(arg('--out', 'screenshots'));
const cli = join(engine, 'dist', 'src', 'cli.js');
if (!existsSync(cli) || !existsSync(join(engine, 'dist', 'web', 'index.html'))) {
  console.error(`${engine} isn't built: run npm run build && npm run build:web in it`);
  process.exit(2);
}

function findChrome() {
  const given = arg('--chrome', process.env.CHROME);
  if (given) return given;
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32'
        ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
        : [];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('no Chrome or Chromium found; pass --chrome <path> (or set CHROME)');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'dash-shots-'));
// Everything the demo, its dashboard and the hub keep goes under the temporary dir, not your own state.
process.env.WORKLANE_STATE_DIR = join(work, 'state');
const node = process.execPath;
const seeded = spawnSync(node, [cli, 'demo', join(work, 'demo')], { encoding: 'utf8' });
const root = seeded.stdout.match(/project (.+)/)?.[1]?.trim();
if (seeded.status !== 0 || !root) {
  console.error(`seeding the demo failed:\n${seeded.stdout}${seeded.stderr}`);
  process.exit(1);
}

// Optional parts of an engine, used when this one has them (an older ref may not).
const optional = async (rel) => {
  const f = join(engine, 'dist', 'src', rel);
  return existsSync(f) ? import(pathToFileURL(f).href) : null;
};
const dash = await optional('dashboard.js');
const ctx = await optional('guardrails/context.js');
const record = await optional('run-record.js');
const hubMod = await optional('dashboard-hub.js');

/** Start a dashboard process and wait for the URL it prints (with its token). */
async function serve(args) {
  const p = spawn(node, [cli, 'dashboard', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  const url = await new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`no dashboard URL after 20 s:\n${printed}`)), 20_000);
    const on = (d) => {
      printed += d.toString();
      const m = printed.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/);
      if (m) {
        clearTimeout(t);
        done(m[0]);
      }
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('exit', (code) => {
      clearTimeout(t);
      fail(new Error(`the dashboard exited (${code}): ${printed.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
  return { p, base: url.split('/?')[0], token: url.split('?t=')[1] };
}

// Pull requests for the PR page (the demo lands directly, so it opens none): one waiting for a
// person, one whose CI fix gave up, one being fixed, one auto-merged; a refused push. Only where
// this engine knows the PR events.
const eventsMod = await optional('events/log.js');
if (eventsMod?.EventLog && ctx?.projectStateDir) {
  const log = new eventsMod.EventLog(join(ctx.projectStateDir(root), 'events.db'));
  const s = (c) => c.repeat(40);
  const add = (type, payload) => log.append(type, payload, 'screenshots');
  try {
    const open = (issue, number, head) => add('pr.opened', { issue, number, url: `https://github.com/example-org/example-shop/pull/${number}`, head, draft: true });
    open(1, 41, s('a'));
    add('pr.status', { issue: 1, number: 41, head: s('a'), ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }, { name: 'lint', outcome: 'pass' }] });
    add('pr.ready', { issue: 1, number: 41, head: s('a') });
    add('merge.decided', { issue: 1, number: 41, head: s('a'), auto: false, reasons: ['touches money-path: src/totals.js (L3)', '512 changed lines, over the 400 limit'] });
    open(2, 42, s('b'));
    add('pr.status', { issue: 2, number: 42, head: s('b'), ready: false, reasons: ['test failed'], checks: [{ name: 'test', outcome: 'fail' }, { name: 'lint', outcome: 'pass' }] });
    add('ci_fix.started', { issue: 2, number: 42, head: s('b'), checks: ['test'], attempt: 1, lease: s('1') });
    add('ci_fix.finished', { issue: 2, number: 42, outcome: 'no_push', head: null, detail: 'the failing test also fails on main' });
    add('ci_fix.gave_up', { issue: 2, number: 42, head: s('b'), reason: 'the failure is not caused by this change: the same test fails on main' });
    // Then a person pushes a fix; it's ready, and the merge policy still leaves it to a person: both reasons show.
    add('pr.status', { issue: 2, number: 42, head: s('9'), ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }, { name: 'lint', outcome: 'pass' }] });
    add('pr.ready', { issue: 2, number: 42, head: s('9') });
    add('merge.decided', { issue: 2, number: 42, head: s('9'), auto: false, reasons: ['high-risk: migrations', 'a CI fix run happened on this PR'] });
    open(3, 43, s('c'));
    add('pr.status', { issue: 3, number: 43, head: s('c'), ready: false, reasons: ['lint failed'], checks: [{ name: 'test', outcome: 'pass' }, { name: 'lint', outcome: 'fail' }] });
    add('ci_fix.started', { issue: 3, number: 43, head: s('c'), checks: ['lint'], attempt: 1, lease: s('2') });
    open(4, 44, s('d'));
    add('pr.ready', { issue: 4, number: 44, head: s('d') });
    add('merge.decided', { issue: 4, number: 44, head: s('d'), auto: true, reasons: ['docs only, 18 changed lines', 'evaluator approved with high confidence'] });
    add('merge.done', { issue: 4, number: 44, head: s('d'), sha: s('e'), url: 'https://github.com/example-org/example-shop/commit/eeeeeeee', title: 'Document the discount rounding rule' });
    add('merge.main_result', { issue: 4, number: 44, sha: s('e'), outcome: 'green', failed: [] });
    add('pr.closed', { issue: 4, number: 44, merged: true });
    add('push.refused', { issue: 5, head: s('f'), stage: 'push', reasons: ['data/export.csv: under a refused path (data/**)'] });
    // The merge flow: a conflict being resolved, one whose fix waits for a person, a light check, two hotspot holds.
    open(6, 45, s('7'));
    add('conflict_fix.detected', { issue: 6, number: 45, head: s('7'), base_sha: s('8') });
    add('conflict_fix.started', { issue: 6, number: 45, head: s('7'), base_sha: s('8'), strategy: 'merge', attempt: 1, lease: s('3') });
    open(7, 46, s('6'));
    add('conflict_fix.detected', { issue: 7, number: 46, head: s('6'), base_sha: s('8') });
    add('conflict_fix.finished', { issue: 7, number: 46, base_sha: s('8'), strategy: 'merge', outcome: 'pushed', head: s('5'), files: ['src/totals.js'], waits_owner: true, reasons: ['the merge touched src/totals.js (money-path)'], detail: 'merged main' });
    open(8, 47, s('4'));
    add('pr.ready', { issue: 8, number: 47, head: s('4') });
    add('light_check.started', { issue: 8, number: 47, head: s('4'), main_sha: s('8'), overlap: ['src/cart.js'] });
    add('hotspot.held', { issue: 9, by: 6, files: ['src/totals.js'], reason: 'issue 6 is changing src/totals.js' });
    add('hotspot.held', { issue: 10, by: 7, files: ['src/discounts.js'], reason: 'issue 7 is changing src/discounts.js' });
    add('hotspot.released', { issue: 10, waited_ms: 180_000, files: ['src/discounts.js'], started: true });
  } catch (e) {
    console.error(`no PR events in this engine (${e.message.split('\n')[0]}); the PR page stays empty`);
  } finally {
    log.close();
  }
}

// The hub forwards to an instance's own port, so with a hub to show, the demo's dashboard listens there.
const port = hubMod && dash?.instancePort ? dash.instancePort('shop') : 4300 + Math.floor(Math.random() * 90);
const main = await serve(['--root', root, '--user', 'example-owner', '--no-open', '--port', String(port)]);
const { base, token } = main;
const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
const issue = state.tasks.find((t) => t.status === 'awaiting_decision')?.issue ?? state.tasks[0]?.issue;
const stateDir = ctx?.projectStateDir ? ctx.projectStateDir(root) : null;

// A recorded agent run for the run pages (the demo's scripted agents don't record one).
let runId = null;
if (record?.RunRecorder && stateDir) {
  const wt = join(root, '.claude', 'worktrees', `issue-${issue}`);
  const r = new record.RunRecorder(stateDir, { role: 'worker', model: 'sonnet', cwd: wt });
  const said = (content) => r.line({ type: 'assistant', message: { content } });
  const got = (content) => r.line({ type: 'user', message: { content } });
  said([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }]);
  got([{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 1\nnot ok 3 - totals round to the cent\n  expected 10.01, got 10.009999' }]);
  said([{ type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: join(wt, 'src', 'totals.js') } }]);
  got([{ type: 'tool_result', tool_use_id: 'b', content: 'edited' }]);
  said([{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npm test' } }]);
  got([{ type: 'tool_result', tool_use_id: 'c', content: 'ok 1 - cart\nok 2 - discounts\nok 3 - totals round to the cent' }]);
  r.finish({ reason: 'succeeded', costUsd: 0.42, turns: 6, model: 'sonnet', final: 'Totals now round half-up to the cent; the failing test passes.' });
  runId = r.id;
}

// The demo as an instance too, for what only an instance has (its settings): an instance of the
// demo's checkout in the temporary state dir, its policy within the demo's config, one setting
// changed by the owner through its server (so Activity shows it). Only where this engine has settings.
let inst = null;
if (existsSync(join(engine, 'dist', 'src', 'settings.js'))) {
  const { userInfo, homedir } = await import('node:os');
  const init = spawnSync(node, [cli, 'instance', 'init', 'shop', '--repo', root, '--github', 'example-org/example-shop', '--agent-user', userInfo().username], { encoding: 'utf8' });
  const home = join(process.env.WORKLANE_STATE_DIR, 'instances', 'shop');
  if (init.status === 0 && existsSync(join(home, 'instance.yaml'))) {
    const yml = join(home, 'instance.yaml');
    writeFileSync(yml, readFileSync(yml, 'utf8').replace(/^ {2}agent_home: .*$/m, `  agent_home: ${JSON.stringify(homedir())}`));
    writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: direct\nsettings:\n  daily_budget_usd: 25\n');
    try {
      inst = await serve(['--instance', 'shop', '--user', 'example-owner', '--no-open', '--port', String(port + 2)]);
      await fetch(`${inst.base}/api/instance-settings`, { method: 'POST', headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'workers', value: 3 }) });
    } catch (e) {
      console.error(`no instance dashboard (${e.message.split('\n')[0]}); the instance settings shot is skipped`);
    }
  } else console.error(`instance init failed: ${(init.stderr || init.stdout).trim().split('\n').pop()}`);
}

let hub = null;
if (hubMod && stateDir) {
  hub = await serve(['--hub', `shop=${stateDir}`, '--port', String(port + 1)]);
}

const pages = [
  ['overview', '/'],
  ['inbox', '/inbox'],
  ['decisions', '/decisions'],
  ['issues', '/issues'],
  ['issues-board', '/issues?view=board'],
  ['issue-detail', `/issues/${issue}`],
  ['land', '/land'],
  ['pull-requests', '/prs'],
  ['agents', '/agents'],
  ['activity', '/activity'],
  ['deploys', '/deploys'],
  ['reports', '/reports'],
  ['logs', '/logs'],
  ['settings', '/settings'],
  ...(runId ? [['run-detail', `/runs/${runId}`]] : []),
];
const shots = [
  ...pages.map(([name, path]) => ({ name, url: `${base}${path}`, token })),
  ...(hub ? [{ name: 'hub-overview', url: `${hub.base}/`, token: hub.token }] : []),
  ...(inst ? [{ name: 'instance-settings', url: `${inst.base}/settings`, token: inst.token }, { name: 'instance-activity', url: `${inst.base}/activity`, token: inst.token }] : []),
];

/** One screenshot. Chrome keeps running while the live stream is open, so it's stopped once the PNG is written. */
async function shoot(url, file, theme) {
  const profile = mkdtempSync(join(tmpdir(), 'dash-chrome-'));
  rmSync(file, { force: true });
  const c = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--window-size=1440,1000',
    // Headless capture doesn't run entrance animations to the end; reduced motion turns them off (the UI honours it).
    '--force-prefers-reduced-motion',
    // Wait a fixed time for the page to render instead of for network idle (the stream never idles).
    '--timeout=4000',
    ...(theme === 'dark' ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
    `--screenshot=${file}`,
    url,
  ], { stdio: 'ignore' });
  const exited = new Promise((r) => c.on('exit', r));
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
    const size = existsSync(file) ? statSync(file).size : -1;
    if (size > 0 && size === last) break;
    last = size;
    if (done) break;
  }
  c.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  return existsSync(file) && statSync(file).size > 0;
}

mkdirSync(out, { recursive: true });
let failed = 0;
for (const theme of ['light', 'dark']) {
  for (const s of shots) {
    const file = join(out, `${s.name}-${theme}.png`);
    const sep = s.url.includes('?') ? '&' : '?';
    if (await shoot(`${s.url}${sep}t=${s.token}`, file, theme)) console.log(`wrote ${file}`);
    else {
      failed++;
      console.error(`FAIL ${s.name} (${theme})`);
    }
  }
}
main.p.kill();
hub?.p.kill();
inst?.p.kill();
rmSync(work, { recursive: true, force: true, maxRetries: 3 });
process.exit(failed ? 1 : 0);
