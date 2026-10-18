// The dashboard's speed over the owner's link, in a real Chrome against a hub and four instance dashboards on
// loopback, each with a synthetic event log (test/synthetic-events.ts; the busiest has 200 000 events):
// - a cold first load (empty browser cache) shows the Overview's own numbers for the instance in under COLD_MS from
//   navigation start (performance.timeOrigin), the median of 3;
// - once the first load and its prefetch are done, an instance switch and a page switch each show the new view's
//   own data in under SWITCH_MS, from a performance.mark at the click to the frame after it is in the page, the
//   median of 5. That is a render from what the page kept (web/src/cache.ts): no network is in its path, so a
//   loaded runner shifts it little.
// Gated: 120 ms latency at 10 Mbit/s. Measured, never gated: the relay's 385 kbit/s at the same latency (printed).
// The same switches with the cache off (this tab's dash-cache-off) take longer than SWITCH_MS, so the test can tell.
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, freePort, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { launchTestChrome, oneChromeAtATime, REAL_CHROME_TIMEOUT, realChromeTests, webUiSkip } from './browser-helpers.js';
import { exampleProject, exampleRoles } from './helpers.js';
import { writeSyntheticLog } from './synthetic-events.js';

/** The owner's targets (the 0.5.0 release gate). Never loosened to get green. */
const SWITCH_MS = 300;
const COLD_MS = 3000;
const SWITCHES = 5;
const COLD_LOADS = 3;
/** The gated link, and the relay's (measured, not gated). */
const GATED = { name: '120 ms, 10 Mbit/s', latency: 120, kbps: 10_000 };
const RELAY = { name: '120 ms, 385 kbit/s', latency: 120, kbps: 385 };
type Link = typeof GATED;
/** Log sizes as the owner's measurement had them; different, so each instance's newest PR is its own. */
const INSTANCES = [
  { name: 'busy', events: 200_000 },
  { name: 'b', events: 50_000 },
  { name: 'c', events: 20_000 },
  { name: 'd', events: 5_000 },
];
/** The switches go b -> busy -> b ... and end on busy, where the page switches are timed. */
const [BUSY, OTHER] = ['busy', 'b'];

realChromeTests();
const chrome = findChrome(process.env.CHROME);
const skip = webUiSkip(chrome);

type Servers = { hub: Awaited<ReturnType<typeof startHub>>; dashboards: Awaited<ReturnType<typeof startDashboard>>[]; dir: string; lastId: Record<string, number>; db: Record<string, string>; newest?: number; first?: number };
let s: Servers | null = null;

before(async () => {
  if (skip) return;
  const dir = mkdtempSync(join(tmpdir(), 'switch-speed-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const dashboards = [];
  const instances = [];
  const db: Record<string, string> = {};
  for (const [i, x] of INSTANCES.entries()) {
    const stateDir = join(dir, x.name);
    mkdirSync(stateDir, { recursive: true });
    const eventsDb = join(stateDir, 'events.db');
    writeSyntheticLog(eventsDb, { count: x.events, seed: 7 + i, instance: x.name, end: new Date() });
    db[x.name] = eventsDb;
    const d = await startDashboard({ root, cfg, eventsDb, stateDir, slotsDir: join(dir, 'slots'), user: 'example-owner', roleOf: exampleRoles, instance: x.name, port: 0, policyFile: null });
    dashboards.push(d);
    instances.push({ name: x.name, port: Number(new URL(d.url).port), tokenFile: join(stateDir, 'dashboard-token') });
  }
  const hub = await startHub({ instances, stateDir: join(dir, 'hub'), port: await freePort(), breakGlassPort: await freePort() });
  s = { hub, dashboards, dir, lastId: {}, db };
  // The instances' servers run for days: the first read of each log (all of it) is not a page load's, so it is done here.
  for (const x of INSTANCES) {
    s.lastId[x.name] = (await view<{ lastId: number }>(x.name, '/state')).lastId;
    for (const v of ['/board', '/prs', '/test-runs', '/usage', '/health/incidents']) await view(x.name, v);
  }
  s.newest = await newestMerged(BUSY);
  s.first = await firstInProgress(BUSY);
});

after(async () => {
  if (!s) return;
  await s.hub.close();
  for (const d of s.dashboards) await d.close();
  rmSync(s.dir, { recursive: true, force: true, maxRetries: 3 });
});

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** A view as the owner's break-glass reads it through the hub (from this process, not the browser). */
async function view<T>(instance: string, path: string): Promise<T> {
  const r = await fetch(`${s!.hub.breakGlassUrl}/api/i/${instance}${path}`, { headers: { authorization: `Bearer ${s!.hub.token}` } });
  assert.equal(r.status, 200, `${instance}${path}`);
  return (await r.json()) as T;
}

/** The newest merged PR of an instance: the first merged row its PR page shows. */
async function newestMerged(instance: string): Promise<number> {
  const v = await view<{ prs: { number: number; merged: { at: string } | null }[] }>(instance, '/prs');
  const merged = v.prs.filter((p) => p.merged).sort((a, b) => b.merged!.at.localeCompare(a.merged!.at));
  assert.ok(merged.length, `${instance} has merged PRs`);
  return merged[0]!.number;
}

/** The first PR the PR page lists (its "In progress" rows come first: no PR waits in these logs), from the server. */
async function firstInProgress(instance: string): Promise<number> {
  const v = await view<{ prs: { number: number; phase: string }[] }>(instance, '/prs');
  const moving = v.prs.filter((p) => ['fixing', 'resolving', 'light_check', 'checks', 'ready'].includes(p.phase));
  assert.equal(v.prs.filter((p) => ['waiting', 'gave_up'].includes(p.phase)).length, 0, `${instance}: nothing waits, so In progress is the first list`);
  assert.ok(moving.length, `${instance} has PRs in progress`);
  return moving[0]!.number;
}

/**
 * In the page: an animation that ends (an entrance: a fade, a pop), as opposed to one that loops (a spinner).
 */
const ENTRANCE_ANIM = `((x) => x.effect && x.effect.getComputedTiming().iterations !== Infinity)`;
/**
 * In the page: whether an element is fully shown (owner-approved, option A): a non-zero box inside the viewport, not
 * in a hidden or inert container, nothing up the tree display:none or visibility:hidden, its opacity and every
 * ancestor's at least 0.99, and no entrance animation still running on it or inside it.
 */
const VISIBLE = `((el) => {
  if (!el || !el.isConnected || el.closest('[hidden],[inert]')) return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0) || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
  for (let e = el; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) < 0.99) return false;
  }
  return !el.getAnimations({ subtree: true }).some((x) => ${ENTRANCE_ANIM}(x) && x.playState !== 'finished');
})`;
/** In the page: an entrance animation anywhere in the page's main area (a cached switch must show none). */
const ENTERING = `[...(document.querySelector('main')?.getAnimations({ subtree: true }) ?? [])].some((x) => ${ENTRANCE_ANIM}(x) && x.playState !== 'finished')`;
/** In the page: the switcher marks `instance` as the one shown (on a hub). */
const selected = (instance: string) => `([...document.querySelectorAll('[data-testid="instance-row"][aria-current="true"]')].map((e) => e.textContent.trim()).join() === ${JSON.stringify(instance)})`;
/** In the page: the Board shows `instance`'s own cards (each card's instance is the one its data names), no other's, at least one of them visible, with `instance` selected. */
const boardOf = (instance: string) =>
  `(() => { const cards = [...document.querySelectorAll('[data-testid="page-board"] [data-testid="board-card"]')]; return cards.length > 0 && cards.every((c) => c.dataset.cardInstance === ${JSON.stringify(instance)}) && cards.some((c) => ${VISIBLE}(c)) && ${selected(instance)}; })()`;
/**
 * In the page: the PR page of `instance` (selected): the newest merged PR it has (a number only that instance has) is
 * in the page, and its first PR in progress, also its own, is visible.
 */
const prsOf = (instance: string, newest: number, first: number) =>
  `(() => { const row = document.querySelector('[data-testid="page-prs"] [data-testid="pr-row"]'); return !!document.querySelector('[data-testid="page-prs"] [data-testid="pr-merged-row"][data-pr="${newest}"]') && !!row && row.dataset.taskRow === 'pr-${first}' && ${VISIBLE}(row) && ${selected(instance)}; })()`;
/** In the page: the Overview's numbers, from the instance's own state (its log's last id), visible, with `instance` selected. */
const overviewOf = (instance: string, lastId: number) =>
  `(() => { const el = document.querySelector('[data-testid="page-overview"] [data-testid="overview-stats"]'); return el?.dataset.lastId === ${JSON.stringify(String(lastId))} && ${VISIBLE}(el) && ${selected(instance)}; })()`;

/** In the page: a Board card of any instance but `instance` is on the page. */
const otherCards = (instance: string) => `[...document.querySelectorAll('[data-testid="board-card"]')].some((c) => c.dataset.cardInstance !== ${JSON.stringify(instance)})`;

/**
 * Click `click` (a JS expression for the element) with a performance.mark, and resolve with the ms from the mark to
 * the frame after `shown` first holds (checked on every change to the page, and right after the click), and whether
 * `wrong` held at any change on the way or in that frame (another instance's data under the new one). `shown` must
 * be false before the click: a switch whose target is already on screen is refused, never timed.
 */
const timedSwitch = (click: string, shown: string, wrong = 'false') => `new Promise((resolve, reject) => {
  const done = () => ${shown};
  if (done()) return reject(new Error('the target was already shown before the click: the switch would time nothing'));
  let over = false;
  let sawWrong = false;
  let sawEntrance = false;
  const look = () => {
    if (${wrong}) sawWrong = true;
    if (${ENTERING}) sawEntrance = true;
  };
  const finish = () => {
    if (over) return;
    over = true;
    obs.disconnect();
    requestAnimationFrame(() => {
      performance.mark('switch-shown');
      look();
      resolve({ ms: performance.measure('switch', 'switch-click', 'switch-shown').duration, wrong: sawWrong, entrance: sawEntrance });
    });
  };
  const obs = new MutationObserver(() => {
    look();
    if (done()) finish();
  });
  obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  performance.clearMarks();
  performance.clearMeasures();
  performance.mark('switch-click');
  // Right after the click React hasn't rendered yet (the old page, the old instance still marked): from the first
  // change to the page on, it's the new one's, and \`wrong\` must never hold.
  ${click}.click();
  if (done()) finish();
  // And every frame: a target can become visible without a change to the DOM (a row's fade-in reaching past
  // opacity 0), so the mutations alone could stop the clock late, at some unrelated later change.
  const frame = () => {
    if (over) return;
    look();
    if (done()) finish();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setTimeout(() => { if (!over) { over = true; obs.disconnect(); resolve({ ms: -1, wrong: sawWrong, entrance: sawEntrance }); } }, 60000);
})`;

type Timed = { ms: number; wrong: boolean; entrance: boolean };

const instanceRow = (name: string) => `[...document.querySelectorAll('[data-testid="instance-row"]')].find((e) => e.textContent.trim() === ${JSON.stringify(name)})`;
const navRow = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
}
const list = (xs: number[]) => `${xs.map(Math.round).join(', ')} ms (median ${Math.round(median(xs))})`;

/** A fresh Chrome (empty cache), as the owner's break-glass, with `instance` selected, over `link`. */
async function browser(link: Link, instance: string, o: { cache?: boolean; firstUseful?: string } = {}) {
  const b = await launchTestChrome(chrome!, { width: 1280, height: 900 });
  const cdp = b.cdp;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  const inflight = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (p) => {
    const url = (p.request as { url: string }).url;
    if (!/\/stream(\?|$)/.test(url)) inflight.set(p.requestId as string, url);
  });
  const finished = (p: Record<string, unknown>) => void inflight.delete(p.requestId as string);
  cdp.on('Network.loadingFinished', finished);
  cdp.on('Network.loadingFailed', finished);
  // The break-glass: a header on every request, the page's own included (a session's cookie, through sign-in).
  await cdp.send('Network.setExtraHTTPHeaders', { headers: { authorization: `Bearer ${s!.hub.token}` } });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { if (!sessionStorage.getItem('dash-token')) { sessionStorage.setItem('dash-token', ${JSON.stringify(s!.hub.token)}); sessionStorage.setItem('dash-instance', ${JSON.stringify(instance)}); ${o.cache === false ? "sessionStorage.setItem('dash-cache-off', '1');" : ''} } } catch {}
      ${o.firstUseful ? `window.__firstUseful = -1; const useful = () => { if (window.__firstUseful < 0 && (${o.firstUseful})) window.__firstUseful = performance.now(); return window.__firstUseful > 0; }; new MutationObserver((_, obs) => useful() && obs.disconnect()).observe(document, { subtree: true, childList: true, attributes: true }); const frame = () => useful() || requestAnimationFrame(frame); requestAnimationFrame(frame);` : ''}`,
  });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: link.latency, downloadThroughput: (link.kbps * 1000) / 8, uploadThroughput: (link.kbps * 1000) / 8 });
  /** Nothing asked (but the live stream) for 1.5 s. */
  const quiet = async () => {
    let still = 0;
    const giveUp = Date.now() + 240_000;
    while (still < 1500) {
      await sleep(100);
      still = inflight.size ? 0 : still + 100;
      if (Date.now() > giveUp) throw new Error(`never quiet: ${[...inflight.values()].join(', ')}`);
    }
  };
  return { cdp, quiet, close: () => b.close() };
}

/** Cold first loads of the busy instance's Overview: ms from navigation start to its own numbers on the page. */
async function coldLoads(link: Link): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < COLD_LOADS; i++) {
    const b = await browser(link, BUSY, { firstUseful: overviewOf(BUSY, s!.lastId[BUSY]!) });
    try {
      await b.cdp.send('Page.navigate', { url: `${s!.hub.breakGlassUrl}/overview` });
      await until("the busy instance's Overview", () => js<boolean>(b.cdp, 'window.__firstUseful > 0'), 240_000, 100);
      out.push(await js<number>(b.cdp, 'window.__firstUseful'));
    } finally {
      await b.close();
    }
  }
  return out;
}

/**
 * The Board of b over `link`, the first load and the prefetch done; then 5 instance switches (b <-> busy, on the
 * Board) and 5 page switches (Board <-> PRs, on busy), each once the page has gone quiet again.
 */
async function switches(link: Link, cache: boolean): Promise<{ instance: number[]; page: number[] }> {
  const b = await browser(link, OTHER, { cache });
  try {
    const { cdp, quiet } = b;
    await cdp.send('Page.navigate', { url: `${s!.hub.breakGlassUrl}/` });
    await until(`${OTHER}'s Board`, () => js<boolean>(cdp, boardOf(OTHER)), 240_000, 100);
    if (cache) await until(`${BUSY}'s board prefetched`, () => js<boolean>(cdp, `performance.getEntriesByType('resource').some((e) => /\\/api\\/i\\/${BUSY}\\/board$/.test(e.name))`), 240_000, 200);
    await quiet();
    const instance: number[] = [];
    const page: number[] = [];
    let on: string = OTHER;
    for (let i = 0; i < SWITCHES; i++) {
      const to = on === OTHER ? BUSY : OTHER;
      assert.equal(await js<boolean>(cdp, boardOf(to)), false, `${to}'s Board isn't shown before the switch to it`);
      const r: Timed = await js(cdp, timedSwitch(instanceRow(to), boardOf(to), otherCards(to)));
      assert.ok(r.ms >= 0, `the switch to ${to} showed its own Board`);
      if (cache) assert.equal(r.entrance, false, `the switch to ${to} from cache showed no entrance animation`);
      assert.equal(r.wrong, false, `no card of another instance was on the page at any moment after the switch to ${to}`);
      instance.push(r.ms);
      on = to;
      await quiet();
      // Read again in the background meanwhile: still its own, and still shown.
      assert.equal(await js<boolean>(cdp, boardOf(to)), true, `${to}'s Board after its fresh answer`);
    }
    const shownPrs = prsOf(on, await newestMerged(on), await firstInProgress(on));
    let onPrs = false;
    for (let i = 0; i < SWITCHES; i++) {
      const target: string = onPrs ? boardOf(on) : shownPrs;
      assert.equal(await js<boolean>(cdp, target), false, `the ${onPrs ? 'Board' : 'PR page'} isn't shown before the switch to it`);
      const r: Timed = await js(cdp, onPrs ? timedSwitch(navRow('tab-board'), target, otherCards(on)) : timedSwitch(navRow('tab-prs'), target, otherCards(on)));
      assert.ok(r.ms >= 0, `the switch to the ${onPrs ? 'Board' : 'PR page'} showed ${on}'s own data`);
      if (cache) assert.equal(r.entrance, false, `the switch to the ${onPrs ? 'Board' : 'PR page'} from cache showed no entrance animation`);
      assert.equal(r.wrong, false, `no card of another instance on ${on}'s pages`);
      page.push(r.ms);
      onPrs = !onPrs;
      await quiet();
      assert.equal(await js<boolean>(cdp, target), true, `the ${onPrs ? 'PR page' : 'Board'} after its fresh answer`);
    }
    return { instance, page };
  } finally {
    await b.close();
  }
}

test('the test can tell the instances apart: each has its own newest PR, its own cards and its own last event', { skip, timeout: 60_000 }, async () => {
  assert.notEqual(await newestMerged(BUSY), await newestMerged(OTHER));
  assert.notEqual(await firstInProgress(BUSY), await firstInProgress(OTHER));
  assert.notEqual(s!.lastId[BUSY], s!.lastId[OTHER]);
  for (const name of [BUSY, OTHER]) {
    const board = await view<{ cards: { instance: string }[] }>(name, '/board');
    assert.ok(board.cards.length > 0, `${name} has cards`);
    assert.ok(board.cards.every((c) => c.instance === name), `${name}'s cards are its own`);
  }
});

test(`gated, ${GATED.name}: a cold first load shows the busy instance's Overview in under ${COLD_MS} ms (median of ${COLD_LOADS})`, { skip, timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const ms = await coldLoads(GATED);
  const line = `${GATED.name}: cold first load ${list(ms)}`;
  ctx.diagnostic(line);
  assert.ok(median(ms) < COLD_MS, line);
});

test(`gated, ${GATED.name}: an instance switch and a page switch from cache each show the new view's own data in under ${SWITCH_MS} ms (median of ${SWITCHES})`, { skip, timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const m = await switches(GATED, true);
  const line = `${GATED.name}, from cache: instance switch ${list(m.instance)}; page switch ${list(m.page)}`;
  ctx.diagnostic(line);
  assert.ok(median(m.instance) < SWITCH_MS, line);
  assert.ok(median(m.page) < SWITCH_MS, line);
});

test(`${GATED.name}, without the cache (dash-cache-off): the same switches take over ${SWITCH_MS} ms, so the test above would catch a cache that stopped working`, { skip, timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const m = await switches(GATED, false);
  const line = `${GATED.name}, without the cache: instance switch ${list(m.instance)}; page switch ${list(m.page)}`;
  ctx.diagnostic(line);
  assert.ok(median(m.instance) > SWITCH_MS, line);
  assert.ok(median(m.page) > SWITCH_MS, line);
});

/** The owner's rule for data new on a page: a fade of at most this long (web/src/components/patterns.tsx ENTRANCE_MS). */
const NEW_DATA_FADE_MAX_MS = 150;

test(`gated, ${GATED.name}: a PR opened while its page is shown fades in, in at most ${NEW_DATA_FADE_MAX_MS} ms; the rows already shown don't`, { skip, timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const b = await browser(GATED, BUSY);
  try {
    const { cdp, quiet } = b;
    await cdp.send('Page.navigate', { url: `${s!.hub.breakGlassUrl}/prs` });
    await until("busy's PR page", () => js<boolean>(cdp, prsOf(BUSY, s!.newest ?? 0, s!.first ?? 0)), 240_000, 100);
    await quiet();
    const pr = 99_001;
    const row = `[data-task-row="pr-${pr}"], [data-testid="pr-wait-card"][data-pr="${pr}"]`;
    // Each entrance animation, as the new row mounts and on the frames after (an inline animation starts on style).
    await js(cdp, `(() => {
      window.__newRow = null;
      window.__others = [];
      const describe = (x) => { const t = x.effect?.target; const r = t?.closest('[data-task-row],[data-testid]'); return (x.animationName ?? '?') + ' on ' + (t?.tagName ?? '?') + ' in ' + (r ? (r.dataset.taskRow ?? r.dataset.testid) : 'nothing marked'); };
      const see = () => {
        const el = document.querySelector(${JSON.stringify(row)});
        // Running ones only: a finished fade with fill 'both' is still listed, long after it ran.
        const anims = [...(document.querySelector('main')?.getAnimations({ subtree: true }) ?? [])].filter((x) => ${ENTRANCE_ANIM}(x) && x.playState !== 'finished');
        if (el) {
          getComputedStyle(el).animationName;
          const own = el.getAnimations({ subtree: true }).filter((x) => ${ENTRANCE_ANIM}(x));
          window.__newRow ??= own.map((x) => ({ name: x.animationName ?? '', ms: Number(x.effect.getComputedTiming().duration) }));
          for (const x of anims) if (!own.includes(x)) window.__others.push(describe(x));
          return true;
        }
        for (const x of anims) window.__others.push(describe(x));
        return false;
      };
      const frame = () => see() || requestAnimationFrame(frame);
      requestAnimationFrame(frame);
    })()`);
    const log = new EventLog(s!.db[BUSY]!);
    try {
      log.append('issue.seen', { issue: 9001, title: 'A PR opened while the page is shown', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: 'opened by writer example-owner' }, 'coordinator');
      log.append('pr.opened', { issue: 9001, number: pr, url: `https://github.com/example-org/shop/pull/${pr}`, head: 'f'.repeat(40), draft: false }, 'coordinator');
    } finally {
      log.close();
    }
    // The busy instance's log moved on: what later tests expect of it follows.
    s!.lastId[BUSY] = (await view<{ lastId: number }>(BUSY, '/state')).lastId;
    await until('the new PR on the page', () => js<boolean>(cdp, 'window.__newRow !== null'), 60_000, 50);
    const anims = await js<{ name: string; ms: number }[]>(cdp, 'window.__newRow');
    ctx.diagnostic(`the new row's entrance: ${JSON.stringify(anims)}`);
    assert.ok(anims.length > 0, 'the new row fades in');
    for (const a of anims) assert.ok(a.ms <= NEW_DATA_FADE_MAX_MS, `${a.name}: ${a.ms} ms is over ${NEW_DATA_FADE_MAX_MS} ms`);
    assert.deepEqual(await js<string[]>(cdp, 'window.__others'), [], 'no row already shown animated again');
  } finally {
    await b.close();
  }
});

/** Measured on the relay's link and printed; never a failure (the owner's gate is the 10 Mbit/s link). */
async function measuredOnly(ctx: TestContext, what: string, run: () => Promise<string>) {
  try {
    ctx.diagnostic(`${RELAY.name} (measured, not gated): ${await run()}`);
  } catch (e) {
    ctx.diagnostic(`${RELAY.name} (measured, not gated): ${what} not measured: ${(e as Error).message}`);
  }
}

test(`measured, not gated, ${RELAY.name}: the cold first load and the switches from cache`, { skip, timeout: REAL_CHROME_TIMEOUT * 2 }, async (ctx) => {
  await oneChromeAtATime(ctx);
  await measuredOnly(ctx, 'cold first load', async () => `cold first load ${list(await coldLoads(RELAY))}`);
  await measuredOnly(ctx, 'switches', async () => {
    const m = await switches(RELAY, true);
    return `from cache: instance switch ${list(m.instance)}; page switch ${list(m.page)}`;
  });
});
