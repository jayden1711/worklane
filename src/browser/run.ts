// Run one of a project's browser flows (Track B): start the app in a worktree, wait until it answers on
// localhost, drive headless Chromium through the flow's steps, and collect what a reviewer needs: console
// errors, failed and slow requests, a performance-trace summary, and a screenshot. The browser only ever
// reaches the app on localhost: every other request is refused before it leaves, and recorded. The app and
// the browser are always stopped, whatever happens. With no Chrome or Chromium on the machine, the run is
// skipped and says so, rather than failing.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, FlowStep } from '../config/schema.js';
import { killTree, killTreeAs, projectCommand, spawnDetached } from '../os/index.js';
import { findChrome, launchChrome, portInUse, sleep, stopTree, until, type Cdp } from './cdp.js';
import { targetExpr } from './targets.js';
import { summarizeTrace, TRACE_CATEGORIES, type TraceEvent, type TraceSummary } from './trace.js';

/** Hosts the browser may reach: the app, on this machine. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Whether the browser may load this URL: the app on localhost, or an in-page scheme (data, blob, about). */
export function isLocal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (['data:', 'blob:', 'about:'].includes(u.protocol)) return true;
  return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && LOCAL_HOSTS.has(u.hostname);
}

/** A step, in words, for the evidence. */
export function stepLabel(s: FlowStep): string {
  if ('goto' in s) return `goto ${s.goto}`;
  if ('click' in s) return `click ${s.click}`;
  if ('type' in s) return `type into ${s.type.target}`;
  if ('key' in s) return `key ${s.key}`;
  if ('wait' in s) return typeof s.wait === 'number' ? `wait ${s.wait} ms` : `wait for ${s.wait}`;
  return `expect ${s.expect_text.target} to show "${s.expect_text.text}"`;
}

export interface FlowEvidence {
  flow: string;
  /** Every step ran and held. */
  ok: boolean;
  steps: { step: string; ok: boolean; ms: number; error?: string }[];
  consoleErrors: { kind: string; text: string; url?: string }[];
  failedRequests: { url: string; method: string; status: number | null; error: string | null }[];
  slowRequests: { url: string; method: string; ms: number }[];
  /** Requests refused because they weren't to the app on localhost. */
  blockedRequests: string[];
  trace: TraceSummary | null;
  screenshot: string | null;
  durationMs: number;
  /** What went wrong cleaning up (a profile left behind): reported, never judged. */
  notes?: string[];
}

export type FlowRun = FlowEvidence | { flow: string; skipped: string };

/** Stop the app and everything it started (a dev server's own children too), through the OS adapter. */
function stopApp(p: ChildProcess, runAs?: { user: string; home: string }): Promise<boolean> {
  return stopTree(p, () => (runAs ? killTreeAs(runAs.user, p.pid) : killTree(p.pid, () => p.kill('SIGKILL'))));
}

/**
 * Run `flow` from `app` against the app started in `cwd`. Evidence lands in `outDir` (the screenshot). Throws when
 * the app can't be started or never becomes ready (its output tail in the message), or the browser fails; a failing
 * step is evidence. However it ends, Chrome and the app's whole process tree are stopped first. Chrome's temporary
 * profile goes under `chromeProfileRoot` when given (the system temp folder otherwise).
 */
export async function runFlow(o: { app: AppConfig; flow: string; cwd: string; outDir: string; chrome?: string | null; noSandbox?: boolean; runAs?: { user: string; home: string }; chromeProfileRoot?: string }): Promise<FlowRun> {
  const steps = o.app.flows[o.flow];
  if (!steps) throw new Error(`no flow "${o.flow}" in app.yaml (it has: ${Object.keys(o.app.flows).join(', ')})`);
  // undefined: look for one; null: there is none (what a machine without a browser, or a test, says).
  const chrome = o.chrome === undefined ? findChrome(process.env.CHROME) : o.chrome;
  if (!chrome) return { flow: o.flow, skipped: 'no Chrome or Chromium on this machine (set CHROME to its path); browser checks skipped' };
  const { port } = o.app.start;
  if (await portInUse(port)) throw new Error(`port ${port} is already in use, so the app can't be started on it`);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();

  // The app is a project command like any check: the pipefail shell, as the agent user when there is one, and in
  // its own process group so all of it can be stopped.
  let appOut = '';
  const cmd = projectCommand(o.app.start.command, o.runAs, { PORT: String(port) });
  const app = spawn(cmd.file, cmd.args, { cwd: o.cwd, env: cmd.env, detached: spawnDetached, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = (d: Buffer) => (appOut = (appOut + d.toString()).slice(-4000));
  app.stdout?.on('data', tail);
  app.stderr?.on('data', tail);
  app.on('error', (e) => (appOut += `\n${e.message}`));
  let browser: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let ev: FlowEvidence | null = null;
  try {
    await until(
      `the app to answer ${base}${o.app.start.ready.path}`,
      async () => {
        if (app.exitCode !== null) throw new Error(`the app exited (${app.exitCode}) before it was ready`);
        return (await fetch(`${base}${o.app.start.ready.path}`, { signal: AbortSignal.timeout(2000) })).ok;
      },
      o.app.start.ready.timeout_s * 1000,
      250,
    ).catch((e: Error) => {
      throw new Error(`${e.message}\nthe app said:\n${appOut.trim().split('\n').slice(-20).join('\n') || '(nothing)'}`);
    });

    browser = await launchChrome(chrome, { ...(o.noSandbox ? { noSandbox: true } : {}), ...(o.chromeProfileRoot ? { profileRoot: o.chromeProfileRoot } : {}) });
    const cdp = browser.cdp;
    ev = { flow: o.flow, ok: true, steps: [], consoleErrors: [], failedRequests: [], slowRequests: [], blockedRequests: [], trace: null, screenshot: null, durationMs: 0 };
    watch(cdp, ev, o.app.thresholds.slow_request_ms);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const trace: TraceEvent[] = [];
    cdp.on('Tracing.dataCollected', (p) => trace.push(...((p.value as TraceEvent[]) ?? [])));
    const traced = new Promise((r) => cdp.on('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: TRACE_CATEGORIES } });
    for (const s of steps) {
      const st = Date.now();
      try {
        await step(cdp, base, s);
        ev.steps.push({ step: stepLabel(s), ok: true, ms: Date.now() - st });
      } catch (e) {
        // A failing step ends the flow; what it left on screen is still captured.
        ev.steps.push({ step: stepLabel(s), ok: false, ms: Date.now() - st, error: (e as Error).message.split('\n')[0]!.slice(0, 300) });
        ev.ok = false;
        break;
      }
    }
    await sleep(300); // let the last requests and frames land
    await cdp.send('Tracing.end');
    await Promise.race([traced, sleep(10_000)]);
    ev.trace = summarizeTrace(trace);
    mkdirSync(o.outDir, { recursive: true });
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    ev.screenshot = join(o.outDir, `${o.flow}.png`);
    writeFileSync(ev.screenshot, Buffer.from(data, 'base64'));
    ev.durationMs = Date.now() - t0;
    return ev;
  } finally {
    // Every path ends here, a thrown error included, and each part of teardown runs whatever the one before
    // did: a browser or an app left running would outlive the check (and keep a test run from ever exiting).
    const notes: string[] = [];
    try {
      browser?.cdp.close();
    } catch {
      // already closed
    }
    const chromeNote = browser ? await browser.close() : null;
    if (chromeNote) notes.push(chromeNote);
    try {
      if (!(await stopApp(app, o.runAs))) notes.push(`the app (pid ${app.pid}) didn't stop`);
    } catch (e) {
      notes.push(`stopping the app failed: ${(e as Error).message}`);
    }
    // Cleanup is reported, never a reason the flow fails.
    if (ev && notes.length) ev.notes = [...(ev.notes ?? []), ...notes];
  }
}

/** Collect console errors, failed and slow requests; refuse every request that isn't to the app on localhost. */
function watch(cdp: Cdp, ev: FlowEvidence, slowMs: number) {
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails as { text: string; url?: string; exception?: { description?: string } };
    ev.consoleErrors.push({ kind: 'exception', text: d.exception?.description ?? d.text, ...(d.url ? { url: d.url } : {}) });
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'assert') return;
    const args = (p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ');
    ev.consoleErrors.push({ kind: `console.${p.type}`, text: args });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry as { level: string; source: string; text: string; url?: string };
    // A request the browser logs as failed is reported once, as a failed request.
    if (e.level === 'error' && e.source !== 'network') ev.consoleErrors.push({ kind: e.source, text: e.text, ...(e.url ? { url: e.url } : {}) });
  });
  cdp.on('Fetch.requestPaused', (p) => {
    const req = p.request as { url: string };
    if (isLocal(req.url)) void cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    else {
      ev.blockedRequests.push(req.url.slice(0, 300));
      void cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  const started = new Map<string, { url: string; method: string; at: number }>();
  cdp.on('Network.requestWillBeSent', (p) => {
    const r = p.request as { url: string; method: string };
    started.set(String(p.requestId), { url: r.url, method: r.method, at: Number(p.timestamp) });
  });
  cdp.on('Network.responseReceived', (p) => {
    const r = p.response as { url: string; status: number };
    const s = started.get(String(p.requestId));
    if (r.status >= 400) ev.failedRequests.push({ url: r.url.slice(0, 300), method: s?.method ?? 'GET', status: r.status, error: null });
  });
  cdp.on('Network.loadingFinished', (p) => {
    const s = started.get(String(p.requestId));
    if (!s) return;
    const ms = Math.round((Number(p.timestamp) - s.at) * 1000);
    if (ms >= slowMs) ev.slowRequests.push({ url: s.url.slice(0, 300), method: s.method, ms });
  });
  cdp.on('Network.loadingFailed', (p) => {
    const s = started.get(String(p.requestId));
    // A request this run refused is reported as blocked, not failed.
    if (!s || p.blockedReason === 'inspector' || String(p.errorText).includes('ERR_BLOCKED_BY_CLIENT')) return;
    ev.failedRequests.push({ url: s.url.slice(0, 300), method: s.method, status: null, error: String(p.errorText) });
  });
}

async function evalIn(cdp: Cdp, expr: string): Promise<unknown> {
  const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Where a target is on the page (scrolled into view), once it's there. */
function at(cdp: Cdp, target: string) {
  return until(target, () => evalIn(cdp, `(() => { const e = ${targetExpr(target)}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>, 10_000);
}

async function step(cdp: Cdp, base: string, s: FlowStep) {
  if ('goto' in s) {
    const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
    await cdp.send('Page.navigate', { url: `${base}${s.goto}` });
    await Promise.race([loaded, sleep(15_000)]);
    return;
  }
  if ('click' in s) {
    const { x, y } = await at(cdp, s.click);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return;
  }
  if ('type' in s) {
    const { x, y } = await at(cdp, s.type.target);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text: s.type.text });
    return;
  }
  if ('key' in s) {
    const parts = s.key.split('+');
    const key = parts.pop()!;
    const mods: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const modifiers = parts.reduce((m, p) => m | (mods[p] ?? 0), 0);
    const printable = key.length === 1;
    const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
    const k = { key, code: printable ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key, modifiers, windowsVirtualKeyCode: printable ? key.toUpperCase().charCodeAt(0) : (codes[key] ?? 0) };
    await cdp.send('Input.dispatchKeyEvent', { type: printable && !modifiers ? 'keyDown' : 'rawKeyDown', ...k, ...(printable && !modifiers ? { text: key } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(150);
    return;
  }
  if ('wait' in s) {
    if (typeof s.wait === 'number') await sleep(s.wait);
    else await at(cdp, s.wait);
    return;
  }
  const { target, text } = s.expect_text;
  await until(`${target} to show "${text}"`, async () => {
    const shown = (await evalIn(cdp, `(() => { const e = ${targetExpr(target)}; return e ? e.innerText : null; })()`)) as string | null;
    return shown !== null && shown.includes(text);
  }, 10_000);
}
