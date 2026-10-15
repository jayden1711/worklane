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
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { findChrome, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, STEADY_PX, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

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
async function intercept(cdp: Cdp, routes: Record<string, (() => ReturnType<typeof json>) | null>) {
  const at = new Map(Object.keys(routes).map((path) => [path, { holding: false, paused: [] as string[] }]));
  const reply = (path: string, requestId: string) => {
    const answer = routes[path];
    return answer ? cdp.send('Fetch.fulfillRequest', { requestId, ...answer() }) : cdp.send('Fetch.continueRequest', { requestId });
  };
  cdp.on('Fetch.requestPaused', (p) => {
    const requestId = p.requestId as string;
    const path = new URL((p.request as { url: string }).url).pathname;
    const s = at.get(path);
    if (!s) return void cdp.send('Fetch.continueRequest', { requestId });
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
      for (const requestId of s.paused.splice(0)) await reply(path, requestId);
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

for (const held of ['/api/instance-settings', '/api/first-run', 'the on-device speech check'] as const) {
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
        const answers = await intercept(cdp, { '/api/first-run': () => json(FIRST_RUN), '/api/instance-settings': null });
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
        // A link, pressed where it is (it must hold still), opens its page.
        await pressSteady(cdp, q('settings-first-run-link'), 'settings-first-run-link');
        await until('the first-run page', () => js<boolean>(cdp, `location.pathname === '/first-run'`), 5_000);
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
        await noMoveWhenLast(cdp, net, `/api/usage (paused) on ${page}`, '/api/usage', () => answers.release('/api/usage'));
        await until('the banner', () => js<boolean>(cdp, `!!${q('usage-banner')}`), 5_000);
        await until(`the ${page} page`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`), 5_000);
        await pressShowMore(cdp, page);
      }
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
