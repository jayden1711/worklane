// Run one of a project's browser flows (Track B): start the app in a worktree, wait until it answers on
// localhost, drive headless Chromium through the flow's steps, and collect what a reviewer needs: console
// errors, failed and slow requests, a performance-trace summary, and screenshots of where the flow ended (at
// desktop width, in dark mode and at phone width). The browser only ever
// reaches the app on localhost: every other request is refused before it leaves, and recorded. The app and
// the browser are always stopped, whatever happens. With no Chrome or Chromium on the machine, the run is
// skipped and says so, rather than failing.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, FlowStep } from '../config/schema.js';
import { killTree, killTreeAs, projectCommand, spawnDetached } from '../os/index.js';
import { browserTimeouts, findChrome, launchChrome, portInUse, sleep, stopTree, track, until, type Cdp } from './cdp.js';
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
  /** Where the flow ended, at the run's own desktop view (1440 px wide, light). */
  screenshot: string | null;
  /** The same end state in dark mode and at phone width: each shot's file, or why it wasn't taken. */
  views: ViewShot[];
  /**
   * Console errors and failed requests seen once the desktop shot was taken (the dark and phone views' relayout):
   * listed, never judged, as those views are evidence for a reviewer, not part of the flow. At most VIEW_ERRORS_MAX.
   */
  viewErrors: ViewError[];
  durationMs: number;
  /** What went wrong cleaning up (a profile left behind): reported, never judged. */
  notes?: string[];
}

export type FlowRun = FlowEvidence | { flow: string; skipped: string };

/** A view of the flow's end state besides the desktop one. */
export type ShotView = 'dark' | 'phone';
/** A shot at another view: its file, or why it wasn't taken. */
export type ViewShot = { view: ShotView; path: string } | { view: ShotView; error: string };
/** A console error or failed request seen while a view was being shot. */
export interface ViewError {
  view: ShotView;
  /** As a console error's kind (exception, console.error, ...), or 'failed request'. */
  kind: string;
  text: string;
}
/** How many view errors a run keeps: they are never judged, so a noisy relayout can't grow the evidence. */
export const VIEW_ERRORS_MAX = 20;

/** The viewport every flow runs in. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false } as const;
/** A common phone's CSS viewport, for the phone shot: no more pixels than the desktop shot. */
export const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } as const;

/** Two frames (at most 500 ms, should frames not come), then a moment (never past `left()`) for a theme's transitions. */
async function settle(cdp: Pick<Cdp, 'send'>, left: () => number) {
  await evalIn(cdp, 'new Promise((ok) => { requestAnimationFrame(() => requestAnimationFrame(ok)); setTimeout(ok, 500); })');
  await sleep(Math.min(250, Math.max(0, left())));
}

/** The extra shots' shared budget ran out while a view was being taken: the view is listed as skipped. */
class BudgetSpent extends Error {}

/**
 * A shot's file name. INVARIANT: no two (flow, view) pairs share one: flow names are lowercase letters, digits and
 * dashes (src/config/schema.ts), so the dot is a separator no flow name has (`home.dark.png` is never flow
 * `home-dark`'s, or any flow's, desktop shot), even when every flow writes into one folder, as previews do.
 */
export const shotName = (flow: string, view?: ShotView) => (view ? `${flow}.${view}.png` : `${flow}.png`);

/**
 * Shoot where the flow ended: at the run's desktop view, then in dark mode (prefers-color-scheme: dark, still at
 * desktop width), then at phone width (light again). The desktop shot failing fails the run, as it always has; a
 * dark or phone shot that fails says why in its place and is never a reason the run fails. `onView` is told each
 * view before it is set up, so what the page does from then on is attributed to it (drive() records it unjudged).
 * INVARIANT: three shots at most per run, each of the viewport only (never the whole page), so a run's evidence
 * stays bounded however long the app's page is. The dark and phone views together get `budgetMs` (10 s, scaled
 * like every browser timeout) and each of their commands `commandMs` (5 s, scaled) or what is left of the budget,
 * whichever is less: a page or Chrome that stalls them costs `budgetMs` at most, a view the budget cuts off is
 * listed as skipped, and one not reached as not tried.
 */
export async function captureShots(
  cdp: Pick<Cdp, 'send'>,
  outDir: string,
  flow: string,
  o: { onView?: (view: ShotView) => void; commandMs?: number; budgetMs?: number } = {},
): Promise<{ screenshot: string; views: ViewShot[] }> {
  const commandMs = o.commandMs ?? browserTimeouts().commandMs / 6;
  const budgetMs = o.budgetMs ?? commandMs * 2;
  mkdirSync(outDir, { recursive: true });
  const shoot = async (via: Pick<Cdp, 'send'>, name: string) => {
    const { data } = await via.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const path = join(outDir, name);
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  };
  // The desktop shot: through `cdp` itself, so with the usual command timeout and no budget.
  const screenshot = await shoot(cdp, shotName(flow));
  // The monotonic clock: an NTP step can't stretch or shrink the budget.
  const start = performance.now();
  // WHY the flag: a timer may fire a millisecond before the clock says the budget is gone; once it has cut a
  // command off, the budget is spent, whatever the clock reads.
  let cutOff = false;
  const left = () => (cutOff ? 0 : budgetMs - (performance.now() - start));
  // INVARIANT: no extra command outlives the shared budget. Each waits for its answer (commandMs at most) or for the
  // budget's end, whichever comes first, so the dark and phone views together never take longer than budgetMs.
  const extra: Pick<Cdp, 'send'> = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const ms = left();
      if (ms <= 0) throw new BudgetSpent();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cut = new Promise<never>((_, fail) => (timer = setTimeout(() => ((cutOff = true), fail(new BudgetSpent())), ms)));
      try {
        return await Promise.race([cdp.send<T>(method, params, commandMs), cut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  const set: Record<ShotView, () => Promise<unknown>> = {
    dark: () => extra.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }),
    // WHY: an empty list clears the dark emulation first, so a failed dark shot never leaves the phone shot dark.
    phone: async () => {
      await extra.send('Emulation.setEmulatedMedia', { features: [] });
      await extra.send('Emulation.setDeviceMetricsOverride', { ...PHONE_VIEWPORT });
    },
  };
  const views: ViewShot[] = [];
  for (const view of ['dark', 'phone'] as const) {
    if (left() <= 0) {
      views.push({ view, error: `not tried: the extra shots' ${budgetMs / 1000} s were spent` });
      continue;
    }
    o.onView?.(view);
    try {
      await set[view]();
      await settle(extra, left);
      views.push({ view, path: await shoot(extra, shotName(flow, view)) });
    } catch (e) {
      // A view the budget cut off is skipped, like one never tried: a note in the evidence, never a failure.
      if (e instanceof BudgetSpent) views.push({ view, error: `skipped: the extra shots' ${budgetMs / 1000} s ran out while it was being taken` });
      else views.push({ view, error: (e as Error).message.split('\n')[0]!.slice(0, 300) });
    }
  }
  return { screenshot, views };
}

/** Stop the app and everything it started (a dev server's own children too), through the OS adapter. */
function stopApp(p: ChildProcess, runAs?: { user: string; home: string }): Promise<boolean> {
  return stopTree(p, () => (runAs ? killTreeAs(runAs.user, p.pid) : killTree(p.pid, () => p.kill('SIGKILL'))));
}

/**
 * Run `flow` from `app` against the app started in `cwd`. Evidence lands in `outDir` (the screenshots). Throws when
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
  track(app, 'the app');
  const tail = (d: Buffer) => (appOut = (appOut + d.toString()).slice(-4000));
  app.stdout?.on('data', tail);
  app.stderr?.on('data', tail);
  app.on('error', (e) => (appOut += `\n${e.message}`));
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
    ev = await drive({ ...o, chrome, steps, base, allow: isLocal, t0 });
    return ev;
  } finally {
    // WHY: every path ends here, a thrown error included: an app left running would outlive the check.
    const notes: string[] = [];
    try {
      if (!(await stopApp(app, o.runAs))) notes.push(`the app (pid ${app.pid}) didn't stop`);
    } catch (e) {
      notes.push(`stopping the app failed: ${(e as Error).message}`);
    }
    // WHY: cleanup is reported, never a reason the flow fails.
    if (ev && notes.length) ev.notes = [...(ev.notes ?? []), ...notes];
  }
}

/** INVARIANT: a flow against a deployed preview (docs/previews.md) reaches its origin only, or an in-page scheme. */
export function isOnOrigin(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (['data:', 'blob:', 'about:'].includes(u.protocol)) return true;
  const o = new URL(origin);
  const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  return scheme === o.protocol && u.host === o.host;
}

/** docs/previews.md: a flow against an app already deployed at `origin`; nothing is started or stopped here. */
export async function runFlowAt(o: { app: AppConfig; flow: string; origin: string; outDir: string; chrome?: string | null; noSandbox?: boolean; chromeProfileRoot?: string }): Promise<FlowRun> {
  const steps = o.app.flows[o.flow];
  if (!steps) throw new Error(`no flow "${o.flow}" in app.yaml (it has: ${Object.keys(o.app.flows).join(', ')})`);
  const chrome = o.chrome === undefined ? findChrome(process.env.CHROME) : o.chrome;
  if (!chrome) return { flow: o.flow, skipped: 'no Chrome or Chromium on this machine (set CHROME to its path); browser checks skipped' };
  const base = new URL(o.origin).origin;
  return drive({ ...o, chrome, steps, base, allow: (url) => isOnOrigin(url, base), t0: Date.now() });
}

/** INVARIANT: every request `allow` refuses is refused, and Chrome is stopped however the flow ends. */
async function drive(o: { app: AppConfig; flow: string; outDir: string; chrome: string; noSandbox?: boolean; chromeProfileRoot?: string; steps: FlowStep[]; base: string; allow: (url: string) => boolean; t0: number }): Promise<FlowEvidence> {
  const { steps, base, t0 } = o;
  let browser: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let ev: FlowEvidence | null = null;
  try {
    browser = await launchChrome(o.chrome, { ...(o.noSandbox ? { noSandbox: true } : {}), ...(o.chromeProfileRoot ? { profileRoot: o.chromeProfileRoot } : {}) });
    const cdp = browser.cdp;
    ev = { flow: o.flow, ok: true, steps: [], consoleErrors: [], failedRequests: [], slowRequests: [], blockedRequests: [], trace: null, screenshot: null, views: [], viewErrors: [], durationMs: 0, ...(browser.notes.length ? { notes: [...browser.notes] } : {}) };
    // Null until the desktop shot is taken; from then on, what the page does belongs to the view being shot.
    let view: ShotView | null = null;
    watch(cdp, ev, o.app.thresholds.slow_request_ms, o.allow, () => view);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...DESKTOP_VIEWPORT });

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
    const shots = await captureShots(cdp, o.outDir, o.flow, { onView: (v) => (view = v) });
    ev.screenshot = shots.screenshot;
    ev.views = shots.views;
    ev.durationMs = Date.now() - t0;
    return ev;
  } finally {
    try {
      browser?.cdp.close();
    } catch {
      // already closed
    }
    const chromeNote = browser ? await browser.close() : null;
    if (ev && chromeNote) ev.notes = [...(ev.notes ?? []), chromeNote];
  }
}

/**
 * Collect console errors, failed and slow requests; refuse every request that isn't to the app on localhost.
 * INVARIANT: once `view()` names a view (the desktop shot is taken), console errors and failed requests go to
 * ev.viewErrors, which judgeFlow never reads: what the dark and phone relayout does can't change the verdict.
 */
export function watch(cdp: Pick<Cdp, 'send' | 'on'>, ev: FlowEvidence, slowMs: number, allow: (url: string) => boolean, view: () => ShotView | null = () => null) {
  const consoleError = (e: FlowEvidence['consoleErrors'][number]) => {
    const v = view();
    if (!v) ev.consoleErrors.push(e);
    else if (ev.viewErrors.length < VIEW_ERRORS_MAX) ev.viewErrors.push({ view: v, kind: e.kind, text: e.text });
  };
  const failedRequest = (r: FlowEvidence['failedRequests'][number]) => {
    const v = view();
    if (!v) ev.failedRequests.push(r);
    else if (ev.viewErrors.length < VIEW_ERRORS_MAX) ev.viewErrors.push({ view: v, kind: 'failed request', text: `${r.method} ${r.url} (${r.status ?? r.error ?? ''})` });
  };
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails as { text: string; url?: string; exception?: { description?: string } };
    consoleError({ kind: 'exception', text: d.exception?.description ?? d.text, ...(d.url ? { url: d.url } : {}) });
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'assert') return;
    const args = (p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ');
    consoleError({ kind: `console.${p.type}`, text: args });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry as { level: string; source: string; text: string; url?: string };
    // A request the browser logs as failed is reported once, as a failed request.
    if (e.level === 'error' && e.source !== 'network') consoleError({ kind: e.source, text: e.text, ...(e.url ? { url: e.url } : {}) });
  });
  cdp.on('Fetch.requestPaused', (p) => {
    const req = p.request as { url: string };
    if (allow(req.url)) void cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
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
    if (r.status >= 400) failedRequest({ url: r.url.slice(0, 300), method: s?.method ?? 'GET', status: r.status, error: null });
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
    failedRequest({ url: s.url.slice(0, 300), method: s.method, status: null, error: String(p.errorText) });
  });
}

async function evalIn(cdp: Pick<Cdp, 'send'>, expr: string, ms?: number): Promise<unknown> {
  const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Where a target is on the page (scrolled into view), once it's there. */
function at(cdp: Cdp, target: string) {
  return until(target, () => evalIn(cdp, `(() => { const e = ${targetExpr(target)}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>, browserTimeouts().stepMs);
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
  }, browserTimeouts().stepMs);
}
