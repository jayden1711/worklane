#!/usr/bin/env node
// Screenshots of every dashboard page, light and dark, against a freshly
// seeded demo project. Uses an installed Chrome or Chromium (headless); no
// npm dependency. macOS, Linux and Windows.
//   node scripts/dev/screenshots.mjs --out <dir> [--engine <checkout with dist/>] [--chrome <path>]
// The engine checkout must be built (npm run build && npm run build:web).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
  });
  return { p, base: url.split('/?')[0], token: url.split('?t=')[1] };
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
  ['agents', '/agents'],
  ['activity', '/activity'],
  ['deploys', '/deploys'],
  ['reports', '/reports'],
  ['logs', '/logs'],
  ['settings', '/settings'],
  ...(runId ? [['run-detail', `/runs/${runId}`]] : []),
];
const shots = [...pages.map(([name, path]) => ({ name, url: `${base}${path}`, token })), ...(hub ? [{ name: 'hub-overview', url: `${hub.base}/`, token: hub.token }] : [])];

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
rmSync(work, { recursive: true, force: true, maxRetries: 3 });
process.exit(failed ? 1 : 0);
