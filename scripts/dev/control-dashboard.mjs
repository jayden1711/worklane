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
// --keep (leave the temporary directory), --no-chrome-sandbox (for nested sandboxes; see the skill).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineErrors, errorKey, findPage, loadFeatureMap, pagePath, parseCommand, readyText, targetExpr } from './feature-map.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const VALUE_OPTIONS = ['--engine', '--chrome', '--theme', '--out', '--screenshot', '--baseline'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTIONS.includes(argv[i - 1]));
const [command = 'help', ...rest] = positional;
const engine = resolve(option('--engine', fileURLToPath(new URL('../..', import.meta.url))));
const theme = option('--theme', 'light');
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

export function findChrome(given = option('--chrome', process.env.CHROME)) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 15_000, every = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** A minimal DevTools protocol client over the WebSocket Node ships with. */
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`DevTools WebSocket ${url} refused`)), { once: true });
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail, method }));
  }
  on(method, fn) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
  }
  close() {
    this.ws.close();
  }
}

/** A free loopback port (so Chrome's DevTools and the dashboard don't collide with anything running). */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Seed the demo, start its dashboard, start Chrome: everything under one temporary directory. */
async function start() {
  const cli = join(engine, 'dist', 'src', 'cli.js');
  if (!existsSync(cli) || !existsSync(join(engine, 'dist', 'web', 'index.html'))) throw new Error(`${engine} isn't built: run npm run build && npm run build:web in it`);
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome or Chromium found; pass --chrome <path> (or set CHROME)');
  const { BRAND } = await import(pathToFileURL(join(engine, 'dist', 'src', 'brand.js')).href);
  const work = mkdtempSync(join(tmpdir(), 'dash-control-'));
  const procs = [];
  const stop = () => {
    for (const p of procs) p.kill();
    if (!flag('--keep')) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    // The demo, its dashboard and their state all live in the temporary directory, never the user's own:
    // in the children, and in this process too (the run record below is written from here).
    process.env[`${BRAND.envPrefix}_STATE_DIR`] = join(work, 'state');
    const env = { ...process.env };
    const seeded = spawnSync(process.execPath, [cli, 'demo', join(work, 'demo')], { encoding: 'utf8', env });
    const root = seeded.stdout.match(/project (.+)/)?.[1]?.trim();
    if (seeded.status !== 0 || !root) throw new Error(`seeding the demo failed:\n${seeded.stdout}${seeded.stderr}`);
    const dash = spawn(process.execPath, [cli, 'dashboard', '--root', root, '--user', 'example-owner', '--no-open', '--port', String(await freePort())], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(dash);
    let printed = '';
    dash.stdout.on('data', (d) => (printed += d));
    dash.stderr.on('data', (d) => (printed += d));
    const shown = await until('the dashboard URL', () => printed.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)?.[0], 20_000).catch((e) => {
      throw new Error(`${e.message}\n${printed}`);
    });
    const base = shown.split('/?')[0];
    const token = shown.split('?t=')[1];
    const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
    const issue = state.tasks.find((t) => t.status === 'awaiting_decision')?.issue ?? state.tasks[0]?.issue;
    const run = await seedRun(root, issue);

    const profile = join(work, 'chrome');
    mkdirSync(profile);
    const browser = spawn(chrome, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,1000',
      '--force-prefers-reduced-motion',
      ...(flag('--no-chrome-sandbox') ? ['--no-sandbox'] : []),
      ...(theme === 'dark' ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    procs.push(browser);
    let chromeErr = '';
    browser.stderr.on('data', (d) => (chromeErr = (chromeErr + d).slice(-2000)));
    const portFile = join(profile, 'DevToolsActivePort');
    const devtools = await until('Chrome to open its DevTools port', () => existsSync(portFile) && readFileSync(portFile, 'utf8').split(/\r?\n/)[0], 20_000).catch((e) => {
      throw new Error(`${e.message}\nChrome said: ${chromeErr.trim() || '(nothing)'}`);
    });
    const targets = await until('a page target', async () => (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()).find((t) => t.type === 'page'));
    const cdp = await Cdp.connect(targets.webSocketDebuggerUrl);
    return { cdp, base, token, issue, run, stop, work };
  } catch (e) {
    stop();
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
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
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
    const found = findPage(this.map, which);
    if (!found) throw new Error(`no page ${JSON.stringify(which)} in docs/feature-map.md`);
    const params = { ...this.params(found.page), ...found.params };
    const path = which.startsWith('/') ? which : pagePath(found.page, params);
    // The token goes on the first load only; the page moves it to session storage.
    const url = `${this.base}${path}${this.opened ? '' : `${path.includes('?') ? '&' : '?'}t=${this.token}`}`;
    await this.cdp.send('Page.navigate', { url });
    this.opened = true;
    const want = readyText(found.page, params);
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
    const { x, y } = await this.element(target);
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
    s.stop();
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
