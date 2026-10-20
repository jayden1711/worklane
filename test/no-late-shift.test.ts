// No late answer moves a control already on screen, on Settings, Inbox and Decisions (#455; the Machine page's is
// test/machine-no-shift.test.ts). Measured before the fix, in a real Chrome at 1280 x 1000 (each answer made last):
// on Settings the instance settings moved every control below them down by their height (75 px here, 1117 px with a
// full table), the setup screens 1042 px (413 px with six steps; their live checks take 11 s), and the browser's
// on-device speech check 28 px (it adds a line and a button); a usage-limit pause's banner moved every page 83 px; a
// decision asked while the Inbox was open went above the cards, newest first, and moved them 195 px, and on Decisions,
// scrolled down, its list change scrolled the page back to the selected card (329 px). Each is checked here the same
// way: hold the one answer until every other request has answered and the page is drawn, note where every control on
// screen is, let it through, and none may have moved; then a control is pressed where it is (pressSteady).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BRAND } from '../src/brand.js';
import { findChrome, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, STEADY_PX, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

/** How long a page waits for the usage's first answer (web/src/components/Usage.tsx USAGE_WAIT_MS; checked below). */
const USAGE_WAIT_MS = 3_000;

/**
 * What the page's own clock saw (performance.now(), from its navigation start): when each USAGE_WAIT_MS timer it set
 * started and was cleared (null: never), and when the page first showed (null: never).
 */
export interface UsageWaitSeen {
  timers: { start: number; clearedAt: number | null }[];
  shownAt: number | null;
}

/**
 * Whether the page waited for the usage, measured on the page's own clock from the moment its wait began (#865).
 * WHY: the test's clock started only once its poll saw the request held, which comes after the page's timer starts
 * (its hub wait, the request's dispatch, the poll's lag between), so a loaded runner measured a correct page short
 * (2476 ms in a release run). Here the start is the page's own timer start, so load can only make the wait longer.
 * The wait counted is the latest USAGE_WAIT_MS timer still running (or fired) when the page showed: a page that shows
 * before it, or started none, or cleared it first, fails; one that never shows, or past `longest`, fails too.
 * `tolerance` covers only the page clock's coarseness, not load.
 */
export function usageWaitVerdict(seen: UsageWaitSeen, o: { waitMs: number; tolerance: number; longest: number }): { ok: true; waited: number } | { ok: false; why: string } {
  const { shownAt } = seen;
  if (shownAt === null) return { ok: false, why: 'the page never showed' };
  const running = seen.timers.filter((t) => t.start <= shownAt && (t.clearedAt === null || t.clearedAt >= shownAt));
  if (!running.length) return { ok: false, why: `the page showed at ${Math.round(shownAt)} ms with no ${o.waitMs} ms wait running (timers seen: ${JSON.stringify(seen.timers)})` };
  const waited = shownAt - Math.max(...running.map((t) => t.start));
  if (waited < o.waitMs - o.tolerance) return { ok: false, why: `the page showed ${Math.round(waited)} ms after its wait began, before its ${o.waitMs} ms wait was up` };
  if (waited > o.longest) return { ok: false, why: `the page showed ${Math.round(waited)} ms after its wait began, past ${o.longest} ms` };
  return { ok: true, waited };
}

/** In the page, from before its own scripts: records its USAGE_WAIT_MS timers and when `shown` first matches (UsageWaitSeen). */
const WATCH_USAGE_WAIT = (shown: string) => `(() => {
  const seen = (window.__usageWait = { timers: [], shownAt: null });
  const set = window.setTimeout, clear = window.clearTimeout, byId = new Map();
  window.setTimeout = function (fn, ms, ...rest) {
    const id = set.call(window, fn, ms, ...rest);
    if (ms === ${USAGE_WAIT_MS}) {
      const t = { start: performance.now(), clearedAt: null };
      seen.timers.push(t);
      byId.set(id, t);
    }
    return id;
  };
  window.clearTimeout = function (id) {
    const t = byId.get(id);
    if (t && t.clearedAt === null) t.clearedAt = performance.now();
    return clear.call(window, id);
  };
  const look = () => {
    if (seen.shownAt !== null || !document.querySelector(${JSON.stringify(shown)})) return;
    seen.shownAt = performance.now();
    watch.disconnect();
  };
  const watch = new MutationObserver(look);
  watch.observe(document, { childList: true, subtree: true, attributes: true });
})()`;

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;

/** In the page: every control on screen (shown, with a box inside the viewport) and where it is. */
const NOTE = `(() => {
  const name = (e) => (e.closest('[data-decision]')?.dataset.decision ?? '') + ' ' + (e.dataset.testid || e.dataset.option || e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 40) || e.tagName.toLowerCase());
  window.__noted = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter((e) => {
    const r = e.getBoundingClientRect();
    return e.checkVisibility() && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  }).map((e) => { const r = e.getBoundingClientRect(); return { e, name: name(e), x: r.x, y: r.y }; });
  return window.__noted.map((n) => n.name);
})()`;
/** In the page: each noted control that has moved since (or left the page), with where it was and is. */
const MOVED = `window.__noted.filter((n) => { if (!n.e.isConnected) return true; const r = n.e.getBoundingClientRect(); return Math.abs(r.x - n.x) > ${STEADY_PX} || Math.abs(r.y - n.y) > ${STEADY_PX}; })
  .map((n) => n.name + ': (' + Math.round(n.x) + ', ' + Math.round(n.y) + ') -> ' + (n.e.isConnected ? '(' + Math.round(n.e.getBoundingClientRect().x) + ', ' + Math.round(n.e.getBoundingClientRect().y) + ')' : 'gone'))`;

const json = (body: unknown) => ({ responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });

/** The first-run answer the Settings page lists its setup screens from: six steps with a screen (the live checks take seconds). */
const FIRST_RUN = { setup: { groups: [{ steps: Array.from({ length: 6 }, (_, i) => ({ id: `step-${i}`, title: `Setup step ${i}`, done: i % 2 === 0, skipped: false, automation: `${BRAND.cli} step ${i}`, fix: { kind: 'action', action: `step-${i}` } })) }] } };

/** A server instance's Siri devices, for its owner: on, none made yet (the card with its name field and button). */
const SIRI = { enabled: true, server: true, owner: true, createRefused: null, devices: [] };

/** An instance paused on the Claude usage limit, as /api/usage says it. */
const PAUSED = () => ({ instance: 'example', paused: { since: new Date(Date.now() - 60_000).toISOString(), resetAt: new Date(Date.now() + 3_600_000).toISOString(), source: 'claude', kind: null }, today: { runs: 3, limitHits: 1 }, lastHit: new Date().toISOString() });

/**
 * The browser's on-device speech check (SpeechRecognition.available), answered only when the test says: a recognizer
 * that can recognize on-device once its model is downloaded, as Chrome reports it (the answer with the Download button).
 */
const HELD_ON_DEVICE = `(() => {
  let release;
  const answered = new Promise((ok) => (release = ok));
  window.__releaseOnDevice = () => release();
  class Recognition { start() {} stop() {} abort() {} addEventListener() {} removeEventListener() {} }
  Recognition.prototype.processLocally = false;
  Recognition.available = () => answered.then(() => 'downloadable');
  Recognition.install = async () => true;
  window.SpeechRecognition = Recognition;
})()`;

/** Watches a page's API requests: whether every one but those held has answered, and for a moment. */
function watchRequests(cdp: Cdp) {
  const open = new Map<string, string>();
  let last = Date.now();
  cdp.on('Network.requestWillBeSent', (p) => {
    const url = (p.request as { url: string }).url;
    if (/\/api\//.test(url)) (open.set(p.requestId as string, url), (last = Date.now()));
  });
  cdp.on('Network.responseReceived', (p) => {
    if (/event-stream/.test((p.response as { mimeType: string }).mimeType)) open.delete(p.requestId as string);
  });
  const done = (p: Record<string, unknown>) => {
    if (open.delete(p.requestId as string)) last = Date.now();
  };
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);
  return {
    restart: () => (last = Date.now()),
    /** Every request answered but `held`'s, none for 500 ms. */
    settled: (held: string | null = null) => [...open.values()].every((u) => new URL(u).pathname === held) && Date.now() - last > 500,
    waiting: () => [...open.values()].join(', ') || 'none',
  };
}

/**
 * Answers each of `routes`' requests (that path exactly, any query) with its answer, or lets the server's through
 * (null); one held (hold) waits until let through (release).
 */
export async function intercept(cdp: Cdp, routes: Record<string, (() => ReturnType<typeof json>) | null>) {
  const at = new Map(Object.keys(routes).map((path) => [path, { holding: false, paused: [] as string[] }]));
  // Every answer on its way, so stop() can wait for them before the browser closes (one still being sent when it
  // closed failed a test on CI: "Fetch.fulfillRequest: the DevTools connection closed").
  const sending = new Set<Promise<unknown>>();
  // WHY: stop() used to turn interception off first, then wait: an answer still on its way, or a request paused just
  // before, then went to a Fetch domain already off ("Fetch.fulfillRequest: Fetch domain is not enabled", #514's CI).
  // Once stopping, nothing new is answered here: Fetch.disable lets every request still paused through to the server.
  let stopping = false;
  const send = (p: Promise<unknown>) => {
    sending.add(p);
    void p.finally(() => sending.delete(p)).catch(() => {});
    return p;
  };
  const reply = (path: string, requestId: string) => {
    const answer = routes[path];
    return send(answer ? cdp.send('Fetch.fulfillRequest', { requestId, ...answer() }) : cdp.send('Fetch.continueRequest', { requestId }));
  };
  cdp.on('Fetch.requestPaused', (p) => {
    if (stopping) return;
    const requestId = p.requestId as string;
    const path = new URL((p.request as { url: string }).url).pathname;
    const s = at.get(path);
    if (!s) return void send(cdp.send('Fetch.continueRequest', { requestId }));
    if (s.holding) s.paused.push(requestId);
    else void reply(path, requestId);
  });
  await cdp.send('Fetch.enable', { patterns: Object.keys(routes).map((path) => ({ urlPattern: `*${path}*`, requestStage: 'Request' as const })) });
  return {
    hold: (path: string) => void (at.get(path)!.holding = true),
    held: (path: string) => at.get(path)!.paused.length > 0,
    release: async (path: string) => {
      const s = at.get(path)!;
      s.holding = false;
      if (stopping) return;
      for (const requestId of s.paused.splice(0)) await reply(path, requestId);
    },
    /** Stop answering: every answer on its way is sent, and the page's requests go to the server again. */
    stop: async () => {
      stopping = true;
      // Every answer already on its way is sent while the domain is still on; only then is it turned off.
      while (sending.size) await Promise.allSettled([...sending]);
      await cdp.send('Fetch.disable');
    },
  };
}

async function openTab(cdp: Cdp, token: string, person?: string) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  if (person) await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson(person) });
  // #418: the key goes in the tab's session storage, as the page's key form keeps it: never in a URL.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(token)}); } catch {}` });
}

/**
 * Note the controls on screen once every other request has answered (with `around`, if it is shown, in the middle of
 * the view: where a reader would be looking); let the held answer through; nothing may move.
 */
async function noMoveWhenLast(cdp: Cdp, net: ReturnType<typeof watchRequests>, what: string, heldPath: string | null, release: () => Promise<unknown>, around?: string) {
  await until('every other request answered', async () => net.settled(heldPath), 20_000, 100).catch((e: Error) => {
    throw new Error(`${e.message}; still waiting on: ${net.waiting()}`);
  });
  await sleep(300);
  if (around) await js(cdp, `(() => { const e = ${around}; if (e?.checkVisibility()) e.scrollIntoView({ block: 'center' }); return 1; })()`);
  const noted = await js<string[]>(cdp, NOTE);
  assert.ok(noted.length > 0, 'some control is on screen');
  await release();
  await until(`${what} answered and everything settled`, async () => net.settled(), 20_000, 100);
  await sleep(300);
  assert.deepEqual(await js<string[]>(cdp, MOVED), [], `${what} answering last moved controls on screen (was -> now)`);
}

for (const held of ['/api/instance-settings', '/api/first-run', '/api/siri-devices', 'the on-device speech check'] as const) {
  test(
    `in a real Chrome: ${held} answering last moves no control on the Settings page, and a link there still opens its page`,
    { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
    async (ctx) => {
      await oneChromeAtATime(ctx);
      const dir = mkdtempSync(join(tmpdir(), 'settings-no-shift-'));
      const eventsDb = join(dir, 'events.db');
      new EventLog(eventsDb).close();
      const { dir: root } = exampleProject();
      const slotsDir = join(dir, 'slots');
      mkdirSync(slotsDir, { recursive: true });
      const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, machineOwnersFile: machineOwnersFile('example-owner') });
      const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
      try {
        const cdp = b.cdp;
        await openTab(cdp, d.token, 'example-owner');
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELD_ON_DEVICE });
        const net = watchRequests(cdp);
        // The setup screens' answer is the test's own (six steps), held when it is the one under test.
        // And the Siri devices card as a server instance shows it (on this checkout it would show nothing).
        const answers = await intercept(cdp, { '/api/first-run': () => json(FIRST_RUN), '/api/instance-settings': null, '/api/siri-devices': () => json(SIRI) });
        if (held === 'the on-device speech check') {
          await cdp.send('Page.navigate', { url: `${d.url}/settings` });
          await until('the Settings page', async () => js<boolean>(cdp, `!!${q('page-settings')}`), 20_000);
          // Its answer changes the voice section's own line: the controls right below it are the ones it would move.
          await noMoveWhenLast(cdp, net, held, null, () => js(cdp, 'window.__releaseOnDevice()'), q('voice-on-device'));
        } else {
          answers.hold(held);
          await cdp.send('Page.navigate', { url: `${d.url}/settings` });
          await until(`${held} held`, async () => answers.held(held), 20_000);
          await js(cdp, 'window.__releaseOnDevice()');
          await noMoveWhenLast(cdp, net, held, held, () => answers.release(held));
        }
        // Everything shown, the setup screens last.
        await until('every part shown', () => js<boolean>(cdp, `${q('settings-panels')}?.dataset.loaded === 'true'`), 20_000);
        assert.equal(await js<number>(cdp, `document.querySelectorAll('[data-testid="setup-screen"]').length`), 6, 'the six setup screens');
        assert.ok(await js<boolean>(cdp, `!!${q('voice-install')}`), "the on-device check's answer is shown");
        assert.ok(await js<boolean>(cdp, `!!${q('settings-siri')}`), 'the Siri devices card is shown');
        // A link, pressed where it is (it must hold still), opens its page.
        await pressSteady(cdp, q('settings-first-run-link'), 'settings-first-run-link');
        await until('the first-run page', () => js<boolean>(cdp, `location.pathname === '/first-run'`), 5_000);
        await answers.stop();
      } finally {
        await b.close();
        await d.close();
      }
    },
  );
}

/** A long prose recommendation: clamped to four lines, with Show more. */
const LONG_PROSE =
  'Release the stale claim in the first sweep instead of the second: the lock is only freed in reconcile.js:472 (pinned by the lease check) after a second sweep, so a coordinator that crashes between sweeps leaves the task claimed until its lease expires an hour later. ' +
  'Free it as soon as the lease holder is gone, keep the lease check for live holders, and add a test that stops the holder between two sweeps and expects the next sweep to free the task, so the next change to the reconciler keeps it that way. ' +
  'Nothing else in the reconciler needs to change; the retry window and the lease length can stay as they are.';

/** The demo instance with two open decisions (seedDemo's, plus a prose and an option one). */
async function demoWithDecisions() {
  const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'no-shift-statedir-'));
  const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'no-shift-demo-')), 'demo')).finally(() => {
    if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
    else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
  });
  const log = new EventLog(demo.eventsDb);
  log.append('decision.asked', { id: 'd-option', kind: 'question', issue: null, owner: 'example-owner', question: 'Which export format?', options: ['csv', 'json'], recommendation: 'csv', receipts: [] }, 'coordinator');
  log.append('decision.asked', { id: 'd-old-prose', kind: 'question', issue: null, owner: 'example-owner', question: 'How should this proceed?', options: ['approve-fix', 'investigate-more', 'close'], recommendation: LONG_PROSE, receipts: ['confidence high'] }, 'coordinator');
  log.close();
  const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'no-shift-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'no-shift-slots-')) });
  return { d, eventsDb: demo.eventsDb };
}

/** Show more on the prose decision, pressed where it is, opens it. */
async function pressShowMore(cdp: Cdp, page: string) {
  const toggle = `document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"] [data-testid="decision-recommendation-toggle"]')`;
  await pressSteady(cdp, toggle, `the ${page} page's Show more`);
  await until(`the ${page} page's Show more to open`, () => js<boolean>(cdp, `${toggle}?.getAttribute('aria-expanded') === 'true'`), 5_000);
}

test(
  "in a real Chrome: a usage-limit pause's banner answering last moves no control on Inbox or Decisions",
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const { d } = await demoWithDecisions();
    const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await openTab(cdp, d.token);
      const net = watchRequests(cdp);
      const answers = await intercept(cdp, { '/api/usage': () => json(PAUSED()) });
      for (const page of ['inbox', 'decisions']) {
        // Each page load asks for the usage afresh (none kept from the page before).
        answers.hold('/api/usage');
        net.restart();
        await cdp.send('Page.navigate', { url: `${d.url}/${page}` });
        await until('/api/usage held', async () => answers.held('/api/usage'), 20_000);
        const heldAt = Date.now();
        // Past USAGE_WAIT_MS the page shows without the usage (the test below), and a banner after that may move it.
        await noMoveWhenLast(cdp, net, `/api/usage (paused) on ${page}`, '/api/usage', async () => {
          assert.ok(Date.now() - heldAt < USAGE_WAIT_MS, `the usage was held ${Date.now() - heldAt} ms, past the page's ${USAGE_WAIT_MS} ms wait for it`);
          await answers.release('/api/usage');
        });
        await until('the banner', () => js<boolean>(cdp, `!!${q('usage-banner')}`), 5_000);
        await until(`the ${page} page`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`), 5_000);
        await pressShowMore(cdp, page);
      }
      await answers.stop();
    } finally {
      await b.close();
      await d.close();
    }
  },
);

test(
  'in a real Chrome: a /api/usage that never answers holds no page: it shows within the wait for the usage',
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    assert.match(readFileSync(join(repoRoot, 'web', 'src', 'components', 'Usage.tsx'), 'utf8'), /export const USAGE_WAIT_MS = 3_000;/, "the test's bound is the page's");
    const { d } = await demoWithDecisions();
    const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await openTab(cdp, d.token);
      const shown = '[data-testid="page-inbox"] [data-decision="d-old-prose"]';
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_USAGE_WAIT(shown) });
      const answers = await intercept(cdp, { '/api/usage': null });
      answers.hold('/api/usage');
      await cdp.send('Page.navigate', { url: `${d.url}/inbox` });
      await until('/api/usage asked for', async () => answers.held('/api/usage'), 20_000);
      // Never let through: the page shows anyway, once the wait is up. The upper bound on the test's clock starts
      // after the page's wait began, so it is at least this long on the page's.
      await until('the Inbox, with the usage still unanswered', () => js<boolean>(cdp, `!!document.querySelector(${JSON.stringify(shown)})`), USAGE_WAIT_MS + 5_000, 100);
      assert.ok(answers.held('/api/usage'), 'the usage request is still unanswered');
      // #865: the lower bound on the page's own clock, from its own wait's start (load can't shorten it).
      const verdict = usageWaitVerdict(await js<UsageWaitSeen>(cdp, 'window.__usageWait'), { waitMs: USAGE_WAIT_MS, tolerance: 50, longest: USAGE_WAIT_MS + 5_000 });
      assert.ok(verdict.ok, `the page waited for the usage: ${verdict.ok ? '' : verdict.why}`);
      await answers.stop();
    } finally {
      await b.close();
      await d.close();
    }
  },
);

test(
  'in a real Chrome: a decision asked while Inbox or Decisions is open moves no control on it, at the top or scrolled',
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const { d, eventsDb } = await demoWithDecisions();
    // Short enough that the cards run past the bottom, so the page can scroll.
    const b = await launchTestChrome(chrome!, { width: 1280, height: 700 });
    try {
      const cdp = b.cdp;
      await openTab(cdp, d.token);
      const net = watchRequests(cdp);
      let n = 0;
      for (const page of ['inbox', 'decisions']) {
        for (const scrolled of [0, 150]) {
          net.restart();
          await cdp.send('Page.navigate', { url: `${d.url}/${page}` });
          await until(`the ${page} page's decisions`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`), 20_000);
          await until('every request answered', async () => net.settled(), 20_000, 100);
          await js(cdp, `document.querySelector('main').scrollTop = ${scrolled}`);
          await sleep(300);
          const id = `d-new-${++n}`;
          await noMoveWhenLast(cdp, net, `a decision asked on ${page}, scrolled ${scrolled} px`, null, async () => {
            const log = new EventLog(eventsDb);
            log.append('decision.asked', { id, kind: 'question', issue: null, owner: 'example-owner', question: `A new question ${n}?`, options: ['yes', 'no'], recommendation: 'yes', receipts: [] }, 'coordinator');
            log.close();
            await until(`${id} on the page`, () => js<boolean>(cdp, `!!document.querySelector('[data-decision="${id}"]')`), 20_000);
          });
          await pressShowMore(cdp, page);
        }
      }
    } finally {
      await b.close();
      await d.close();
    }
  },
);

test('intercept: stop() sends every answer on its way before turning interception off, and answers nothing after (#514 CI)', async () => {
  // A stand-in DevTools connection: Fetch.* after Fetch.disable fails as Chrome's does; each answer resolves a tick later.
  let enabled = false;
  const late: string[] = [];
  let paused: ((p: Record<string, unknown>) => void) | null = null;
  const fake = {
    on: (method: string, fn: (p: Record<string, unknown>) => void) => void (method === 'Fetch.requestPaused' && (paused = fn)),
    send: async (method: string) => {
      if (method === 'Fetch.enable') return void (enabled = true);
      if (method === 'Fetch.disable') return void (enabled = false);
      await new Promise((r) => setTimeout(r, 5));
      if (!enabled) late.push(method);
      return {};
    },
  } as unknown as Cdp;
  const i = await intercept(fake, { '/api/x': () => json({ ok: true }) });
  paused!({ requestId: 'a', request: { url: 'http://127.0.0.1/api/x' } }); // its answer is on its way
  const stopped = i.stop();
  paused!({ requestId: 'b', request: { url: 'http://127.0.0.1/api/x' } }); // paused just as stop() began
  await stopped;
  assert.deepEqual(late, [], 'no Fetch call reached Chrome after interception was turned off');
});

// #865: the real-Chrome test's lower bound, on the page's own clock. Times are ms from the page's navigation start.
const WAIT = { waitMs: USAGE_WAIT_MS, tolerance: 50, longest: USAGE_WAIT_MS + 5_000 };

test('usageWaitVerdict: a correct page under a 1 s hub delay on a loaded runner passes; the old clock failed it (#865)', () => {
  // Loaded: the page's timer starts at 800 ms; its hub answers 1 s later, so /api/usage goes at 1800; the test's
  // poll sees it held at 2100; the timer fires at 3800 and the page shows at 3830.
  const timerStart = 800;
  const heldSeen = 2100;
  const shownAt = 3830;
  const v = usageWaitVerdict({ timers: [{ start: timerStart, clearedAt: null }], shownAt }, WAIT);
  assert.deepEqual(v, { ok: true, waited: 3030 });
  // The old bound (from when the test saw the request held, with 500 ms slack) measured the same page short.
  assert.ok(shownAt - heldSeen < USAGE_WAIT_MS - 500, 'the old clock failed this correct page');
});

test('usageWaitVerdict: a page that shows before its wait is up fails, whatever the load (#865)', () => {
  // Its timer started, but the page showed 50 ms later.
  assert.match((usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: 850 }, WAIT) as { why: string }).why, /50 ms after its wait began, before its 3000 ms wait/);
  // Even after a slow load: shown 3500 ms after navigation, only 100 ms after its wait began.
  assert.equal(usageWaitVerdict({ timers: [{ start: 3400, clearedAt: null }], shownAt: 3500 }, WAIT).ok, false);
  // Short by more than the clock's tolerance.
  assert.equal(usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: 800 + USAGE_WAIT_MS - 51 }, WAIT).ok, false);
  // No wait at all, or one cleared before it showed (a StrictMode-style first mount leaves one; it isn't the wait).
  assert.match((usageWaitVerdict({ timers: [], shownAt: 850 }, WAIT) as { why: string }).why, /no 3000 ms wait running/);
  assert.equal(usageWaitVerdict({ timers: [{ start: 800, clearedAt: 820 }], shownAt: 850 }, WAIT).ok, false);
  assert.match((usageWaitVerdict({ timers: [{ start: 0, clearedAt: 1 }], shownAt: 3_100 }, WAIT) as { why: string }).why, /no 3000 ms wait running/);
  // A wait started after it showed doesn't count for it.
  assert.equal(usageWaitVerdict({ timers: [{ start: 900, clearedAt: null }], shownAt: 850 }, WAIT).ok, false);
  // Two waits running: the later one is the one measured (the strict choice), so the earlier can't excuse it.
  assert.equal(usageWaitVerdict({ timers: [{ start: 0, clearedAt: null }, { start: 3000, clearedAt: null }], shownAt: 3100 }, WAIT).ok, false);
  // Cleared only after it showed: it was still running when the page showed.
  assert.equal(usageWaitVerdict({ timers: [{ start: 800, clearedAt: 900 }], shownAt: 850 }, WAIT).ok, false);
});

test('usageWaitVerdict: a page that never shows, or shows past the upper bound, fails (#865)', () => {
  assert.deepEqual(usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: null }, WAIT), { ok: false, why: 'the page never showed' });
  assert.match((usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: 800 + USAGE_WAIT_MS + 5_001 }, WAIT) as { why: string }).why, /past 8000 ms/);
  // At the bounds exactly: passes.
  assert.equal(usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: 800 + USAGE_WAIT_MS - 50 }, WAIT).ok, true);
  assert.equal(usageWaitVerdict({ timers: [{ start: 800, clearedAt: null }], shownAt: 800 + USAGE_WAIT_MS + 5_000 }, WAIT).ok, true);
});

test("the page-side watch records the usage wait's timers and when the page shows, as usageWaitVerdict reads them (#865)", () => {
  // The script the real-Chrome test puts in the page, run against a stand-in window (no Chrome here).
  let now = 0;
  let present = false;
  const watching: { fn: (() => void) | null } = { fn: null };
  const native: { set: number[]; cleared: number[] } = { set: [], cleared: [] };
  const win: Record<string, unknown> = {
    setTimeout: (_fn: unknown, ms: number) => native.set.push(ms),
    clearTimeout: (id: number) => void native.cleared.push(id),
  };
  runInNewContext(WATCH_USAGE_WAIT('#shown'), {
    window: win,
    performance: { now: () => now },
    document: { querySelector: (s: string) => (present && s === '#shown' ? {} : null) },
    MutationObserver: class {
      constructor(fn: () => void) {
        watching.fn = fn;
      }
      observe() {}
      disconnect() {
        watching.fn = null;
      }
    },
  });
  const setT = win.setTimeout as (fn: unknown, ms: number) => number;
  const clearT = win.clearTimeout as (id: number) => void;
  now = 5;
  const first = setT(() => {}, USAGE_WAIT_MS);
  now = 6;
  clearT(first);
  now = 7;
  const second = setT(() => {}, USAGE_WAIT_MS);
  setT(() => {}, 10);
  watching.fn!(); // a change before the page shows: nothing recorded
  now = 3_020;
  present = true;
  watching.fn!();
  assert.equal(watching.fn, null, 'it stops watching once the page shows');
  now = 9_000;
  clearT(second);
  assert.deepEqual(native, { set: [USAGE_WAIT_MS, USAGE_WAIT_MS, 10], cleared: [1, 2] }, 'every timer still reaches the page');
  const seen = JSON.parse(JSON.stringify(win.__usageWait)) as UsageWaitSeen;
  assert.deepEqual(seen, { timers: [{ start: 5, clearedAt: 6 }, { start: 7, clearedAt: 9_000 }], shownAt: 3_020 });
  assert.deepEqual(usageWaitVerdict(seen, WAIT), { ok: true, waited: 3_013 });
});
