// A decision's recommendation is one of its options or nothing (src/decision-ask.ts); prose, from an agent or
// stored by an older engine, is shown as wrapped text with Show more, never as a one-line pill cut mid-sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { findChrome, launchChrome, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { RECOMMENDATION_PREFIX, settleRecommendation } from '../src/decision-ask.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { INVESTIGATION_OPTIONS, INVESTIGATION_SCHEMA, WORKER_SCHEMA } from '../src/roles.js';
import { REAL_CHROME_TIMEOUT, STEADY_PX, oneChromeAtATime, realChromeTests, webUiSkip } from './browser-helpers.js';
import { exampleRoles, repoRoot } from './helpers.js';

/** A long prose recommendation, as an older engine stored it (the one seen cut at "reconcile.js:472 (pin"). */
const LONG_PROSE =
  'Release the stale claim in the first sweep instead of the second: the lock is only freed in reconcile.js:472 (pinned by the lease check) after a second sweep, so a coordinator that crashes between sweeps leaves the task claimed until its lease expires an hour later. ' +
  'Free it as soon as the lease holder is gone, keep the lease check for live holders, and add a test that stops the holder between two sweeps and expects the next sweep to free the task, so the next change to the reconciler keeps it that way. ' +
  'Nothing else in the reconciler needs to change; the retry window and the lease length can stay as they are.';

test('a recommendation that is not one of the options moves, whole, into the detail and is left empty', () => {
  assert.deepEqual(settleRecommendation(['approve-fix', 'investigate-more', 'close'], LONG_PROSE, ['confidence high']), {
    recommendation: '',
    receipts: ['confidence high', `${RECOMMENDATION_PREFIX}${LONG_PROSE}`],
  });
  // An option stays (spaces around it aside), and nothing recommended adds nothing.
  assert.deepEqual(settleRecommendation(['approve', 'reject'], ' approve ', ['head abc']), { recommendation: 'approve', receipts: ['head abc'] });
  assert.deepEqual(settleRecommendation(['approve', 'reject'], '', []), { recommendation: '', receipts: [] });
  // Close to an option is not an option.
  assert.deepEqual(settleRecommendation(['approve', 'reject'], 'Approve', []), { recommendation: '', receipts: [`${RECOMMENDATION_PREFIX}Approve`] });
});

test('the roles that ask put an option in the recommendation: an enum where the options are fixed', () => {
  const inv = INVESTIGATION_SCHEMA.properties.recommended;
  assert.deepEqual([...inv.enum], [...INVESTIGATION_OPTIONS]);
  assert.ok((INVESTIGATION_SCHEMA.required as readonly string[]).includes('recommended'));
  const ask = WORKER_SCHEMA.properties.ask.properties;
  assert.match(ask.recommendation.description, /copied exactly from options/);
  assert.ok('detail' in ask, "the worker's reasoning has its own field");
});

test("the dashboard's prefix for a recommendation's detail line is the engine's", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(repoRoot, 'web', 'src', 'pages', 'Decisions.tsx'), 'utf8');
  assert.ok(src.includes(`export const RECOMMENDATION_PREFIX = ${JSON.stringify(RECOMMENDATION_PREFIX).replace(/"/g, "'")};`), 'web/src/pages/Decisions.tsx has the same prefix');
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);

test(
  'Inbox and Decisions in a real Chrome: prose wraps, whole, clamped to four lines at a word, with Show more; the pill is only for an option',
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
    process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'rec-statedir-'));
    const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'rec-demo-')), 'demo')).finally(() => {
      if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
      else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
    });
    // An event an older engine stored: prose straight in the recommendation. And one whose recommendation is an option.
    const log = new EventLog(demo.eventsDb);
    log.append('decision.asked', { id: 'd-old-prose', kind: 'question', issue: null, owner: 'example-owner', question: 'How should this proceed?', options: ['approve-fix', 'investigate-more', 'close'], recommendation: LONG_PROSE, receipts: ['confidence high'] }, 'coordinator');
    log.append('decision.asked', { id: 'd-option', kind: 'question', issue: null, owner: 'example-owner', question: 'Which export format?', options: ['csv', 'json'], recommendation: 'csv', receipts: [] }, 'coordinator');
    log.close();
    const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'rec-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'rec-slots-')) });
    const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const base = d.url;
      // The key goes in the tab's session storage, as the page's key form keeps it: never in a URL.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
      for (const page of ['decisions', 'inbox']) {
        await cdp.send('Page.navigate', { url: `${base}/${page}` });
        await until(`the ${page} page's two decisions`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]') && !!document.querySelector('[data-decision="d-option"]')`), 20_000);
        const card = `document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`;
        const seen = await js<{ pill: number; text: string; clamp: string; lines: number; overflows: boolean; wraps: boolean; toggle: string | null; shown: string; next: string }>(
          cdp,
          `(() => {
            const card = ${card};
            const p = card.querySelector('[data-testid="decision-recommendation-text"]');
            const pill = card.querySelectorAll('[data-testid="decision-recommended"]').length;
            if (!p) return { pill, text: card.textContent, clamp: '', lines: 0, overflows: false, wraps: false, toggle: null, shown: '', next: '' };
            const cs = getComputedStyle(p);
            const line = parseFloat(cs.lineHeight);
            // The last character that shows, and the one after it: a clamp ends a line between words, never inside one.
            const node = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > 100);
            const bottom = p.getBoundingClientRect().bottom + 0.5;
            const r = document.createRange();
            let last = -1;
            for (let i = 0; i < node.textContent.length; i++) {
              r.setStart(node, i); r.setEnd(node, i + 1);
              const rect = r.getClientRects()[0];
              if (!rect || rect.width === 0) continue;
              if (rect.bottom <= bottom) last = i; else break;
            }
            const t = node.textContent;
            return {
              pill,
              text: p.textContent,
              clamp: cs.webkitLineClamp,
              lines: Math.round(p.clientHeight / line),
              overflows: p.scrollHeight > p.clientHeight + 1,
              wraps: p.scrollWidth <= p.clientWidth + 1 && p.getBoundingClientRect().right <= card.getBoundingClientRect().right,
              toggle: card.querySelector('[data-testid="decision-recommendation-toggle"]')?.textContent ?? null,
              shown: t.slice(Math.max(0, last - 15), last + 1),
              next: t[last + 1] ?? '',
            };
          })()`,
        );
        assert.equal(seen.pill, 0, `${page}: prose is not a pill`);
        assert.ok(seen.text.includes(LONG_PROSE), `${page}: the whole recommendation is in the page`);
        assert.equal(seen.clamp, '4', `${page}: clamped by CSS to four lines`);
        assert.equal(seen.lines, 4, `${page}: four lines show`);
        assert.ok(seen.overflows && seen.wraps, `${page}: it wraps within the card and runs past four lines`);
        assert.equal(seen.toggle, 'Show more', `${page}: Show more`);
        assert.ok(/\s$/.test(seen.shown) || /^\s$/.test(seen.next), `${page}: the fourth line ends between words, not inside one ("…${seen.shown}" then "${seen.next}")`);

        await click(cdp, `${card}.querySelector('[data-testid="decision-recommendation-toggle"]')`, `the ${page} page, decision d-old-prose`);
        const open = await js<{ clamp: string; overflows: boolean; toggle: string | null; expanded: string | null }>(
          cdp,
          `(() => { const card = ${card}; const p = card.querySelector('[data-testid="decision-recommendation-text"]'); const t = card.querySelector('[data-testid="decision-recommendation-toggle"]'); return { clamp: getComputedStyle(p).webkitLineClamp, overflows: p.scrollHeight > p.clientHeight + 1, toggle: t?.textContent ?? null, expanded: t?.getAttribute('aria-expanded') ?? null }; })()`,
        );
        assert.deepEqual(open, { clamp: 'none', overflows: false, toggle: 'Show less', expanded: 'true' }, `${page}: Show more shows it all`);

        // An option is the pill, as it always was, and its button is the primary one.
        const option = await js<{ pill: string | null; prose: number; primary: string | null }>(
          cdp,
          `(() => { const card = document.querySelector('[data-testid="page-${page}"] [data-decision="d-option"]'); return { pill: card.querySelector('[data-testid="decision-recommended"]')?.textContent ?? null, prose: card.querySelectorAll('[data-testid="decision-recommendation"]').length, primary: card.querySelector('[data-option][title="recommended"]')?.getAttribute('data-option') ?? null }; })()`,
        );
        assert.deepEqual(option, { pill: 'Recommended: csv', prose: 0, primary: 'csv' }, `${page}: an option is a pill`);
      }
    } finally {
      await b.close();
      await d.close();
    }
  },
);

/** A 1 x 3 PNG: a person's picture taller than it is wide. */
const TALL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAADCAIAAADdv/LVAAAADklEQVR4nGNwaDjAAMUAGYwEgS6QGrIAAAAASUVORK5CYII=';

// #452: on CI the Show more toggle moved 60 px between the click's read and its press, from (438, 494) to (438, 434).
// Each card's avatar is a picture from GitHub; when it failed, the broken image grew from 18 px to its alt text's
// height until the initials replaced it, so each card above the toggle grew 30 px for that moment. Here every picture
// request is held until the page is drawn and every control on screen noted, then answered (failed, or a picture taller than
// wide), and where each control is gets read in the image's own error or load event, before the page's
// handler runs, and again once it has settled: none may have moved. Then the toggle is clicked where it is.
for (const outcome of ['fails', 'is taller than wide'] as const) {
  test(
    `Inbox and Decisions in a real Chrome: a person's picture that ${outcome} moves no control on the page (#452)`,
    { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
    async (ctx) => {
      await oneChromeAtATime(ctx);
      const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
      process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'rec-statedir-'));
      const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'rec-demo-')), 'demo')).finally(() => {
        if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
        else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
      });
      const log = new EventLog(demo.eventsDb);
      log.append('decision.asked', { id: 'd-option', kind: 'question', issue: null, owner: 'example-owner', question: 'Which export format?', options: ['csv', 'json'], recommendation: 'csv', receipts: [] }, 'coordinator');
      log.append('decision.asked', { id: 'd-old-prose', kind: 'question', issue: null, owner: 'example-owner', question: 'How should this proceed?', options: ['approve-fix', 'investigate-more', 'close'], recommendation: LONG_PROSE, receipts: ['confidence high'] }, 'coordinator');
      log.close();
      const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'rec-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'rec-slots-')) });
      const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
      try {
        const cdp = b.cdp;
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
        // Each page asks for the pictures again, rather than taking the first page's from the cache.
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        const held: string[] = [];
        cdp.on('Fetch.requestPaused', (p) => void held.push(p.requestId as string));
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/*', requestStage: 'Request' }] });
        for (const page of ['decisions', 'inbox']) {
          held.length = 0;
          await cdp.send('Page.navigate', { url: `${d.url}/${page}` });
          const card = `document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`;
          await until(`the ${page} page's two decisions, and a picture asked for`, async () => held.length > 0 && (await js<boolean>(cdp, `!!${card} && !!document.querySelector('[data-testid="page-${page}"] [data-decision="d-option"]')`)), 20_000);
          await sleep(300);
          // Every control on screen and where it is; read again in each picture's own event, before the page's handler.
          const noted = await js<string[]>(
            cdp,
            `(() => {
              const name = (e) => (e.closest('[data-decision]')?.dataset.decision ?? '') + ' ' + (e.dataset.testid || e.dataset.option || (e.textContent || '').trim().slice(0, 30));
              window.__noted = [...document.querySelectorAll('[data-testid="page-${page}"] button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; })
                .map((e) => { const r = e.getBoundingClientRect(); return { e, name: name(e), x: r.x, y: r.y }; });
              window.__moved = () => window.__noted.filter((n) => { if (!n.e.isConnected) return true; const r = n.e.getBoundingClientRect(); return Math.abs(r.x - n.x) > ${STEADY_PX} || Math.abs(r.y - n.y) > ${STEADY_PX}; })
                .map((n) => n.name + ': (' + Math.round(n.x) + ', ' + Math.round(n.y) + ') -> ' + (n.e.isConnected ? '(' + Math.round(n.e.getBoundingClientRect().x) + ', ' + Math.round(n.e.getBoundingClientRect().y) + ')' : 'gone'));
              window.__atImage = [];
              for (const type of ['error', 'load']) addEventListener(type, (ev) => { if (ev.target instanceof HTMLImageElement) window.__atImage.push(...window.__moved().map((m) => 'at its ' + type + ': ' + m)); }, true);
              return window.__noted.map((n) => n.name);
            })()`,
          );
          assert.ok(noted.some((n) => n.includes('decision-recommendation-toggle')), `${page}: the toggle is on screen (${noted.join('; ')})`);

          for (const requestId of held.splice(0)) {
            if (outcome === 'fails') await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
            else await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: TALL_PNG });
          }
          await until(`every picture on the ${page} page answered`, async () => !held.length && (await js<boolean>(cdp, `[...document.querySelectorAll('img')].every((i) => i.complete)`)), 20_000);
          await sleep(300);
          const moved = await js<string[]>(cdp, `[...new Set([...window.__atImage, ...window.__moved().map((m) => 'settled: ' + m)])]`);
          assert.deepEqual(moved, [], `${page}: a picture that ${outcome} moved controls on screen (was -> now)`);

          await click(cdp, `${card}.querySelector('[data-testid="decision-recommendation-toggle"]')`, `the ${page} page, decision d-old-prose`);
        }
      } finally {
        await b.close();
        await d.close();
      }
    },
  );
}

// The click helper itself, on a page of its own: a covered target fails at once naming the cover, and a target its
// ancestor is still moving into place is clicked where it ends up, while an endless pulse around it is not waited on.
const CLICK_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px sans-serif">
<div id="pulse"><div id="slide" style="padding:40px"><button id="moving" aria-expanded="false">Show more</button></div></div>
<div style="position:relative;padding:40px"><button id="covered" aria-expanded="false">Show more</button>
<div id="cover" data-testid="click-cover" style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div></div>
<script>window.presses = { moving: 0, covered: 0 };
for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => { window.presses[b.id]++; b.setAttribute('aria-expanded', 'true'); });</script>`;

test(
  'the real-Chrome click: a covered target fails naming what is under the cursor; a moving one is clicked once it settles',
  { timeout: REAL_CHROME_TIMEOUT, skip: (!chrome && 'no Chrome or Chromium') || (process.platform === 'win32' && 'checked on macOS and Linux') },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const b = await launchChrome(chrome!, { width: 800, height: 600 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(CLICK_PAGE)}` });
      await until('the click page', () => js<boolean>(cdp, `!!window.presses && !!document.getElementById('cover')`), 20_000);

      await assert.rejects(click(cdp, `document.getElementById('covered')`), /would land on <div id="cover" data-testid="click-cover"/, 'a covered target fails, naming the cover');
      assert.equal(await js<number>(cdp, 'window.presses.covered'), 0, 'and nothing was pressed');

      // Start the moves now, so the click begins mid-entrance: the slide (finite, an ancestor) ends 300px above where it starts.
      await js(cdp, `(() => {
        document.getElementById('pulse').animate([{ opacity: 1 }, { opacity: 0.9 }], { duration: 400, iterations: Infinity });
        document.getElementById('slide').animate([{ transform: 'translateY(300px)' }, { transform: 'none' }], { duration: 700 });
        return true;
      })()`);
      await click(cdp, `document.getElementById('moving')`);
      assert.equal(await js<number>(cdp, 'window.presses.moving'), 1, 'the moving target is pressed once, where it settled');

      await js(cdp, `(document.getElementById('cover').remove(), true)`);
      await click(cdp, `document.getElementById('covered')`);
      assert.equal(await js<number>(cdp, 'window.presses.covered'), 1, 'uncovered, it is pressed');
    } finally {
      await b.close();
    }
  },
);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/**
 * A real mouse click at the element's centre, once it holds still and is what the mouse would hit there. The finite
 * animations on it or an ancestor (a card's entrance moves it) are awaited first, inside the one evaluate the command
 * timeout already bounds; endless ones (a pulse, a spinner) are not. Then the point is hit-tested: a press that would
 * land on something else fails at once, naming what is under the cursor, rather than waiting out a click that never lands.
 *
 * A press that was hit-tested but still never lands (main went red on it once, and it never failed again in 20 runs)
 * fails after the same 5 s, now saying what happened: `what` (the page and decision), what the press reached, the
 * toggle's aria-expanded and its card's identity at the press and now, every change to the card since the press, any
 * scroll, and whether the click reached the toggle. All of it is recorded by listeners the test adds to the page;
 * nothing in the product changes.
 */
async function click(cdp: Cdp, element: string, what: string = element) {
  const at = await js<{ x: number; y: number; hit: string | null; moved: string | null }>(
    cdp,
    `(async () => {
      const e = ${element};
      e.scrollIntoView({ block: 'center' });
      const moving = document.getAnimations().filter((a) => {
        const t = a.effect && a.effect.target;
        return t && (t === e || t.contains(e)) && a.effect.getComputedTiming().endTime !== Infinity;
      });
      await Promise.all(moving.map((a) => a.finished.catch(() => {})));
      const r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      // Read again two frames later, just before the press: a toggle that moved in between fails at once
      // (test/browser-helpers.ts steadyCentre), never a press that lands on something else.
      await Promise.race([new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))), new Promise((ok) => setTimeout(ok, 250))]);
      const r2 = e.getBoundingClientRect();
      const x2 = r2.x + r2.width / 2, y2 = r2.y + r2.height / 2;
      if (!e.isConnected || Math.abs(x2 - x) > ${STEADY_PX} || Math.abs(y2 - y) > ${STEADY_PX}) return { x, y, hit: null, moved: 'from (' + Math.round(x) + ', ' + Math.round(y) + ') to ' + (e.isConnected ? '(' + Math.round(x2) + ', ' + Math.round(y2) + ')' : 'out of the page') };
      const h = document.elementFromPoint(x, y);
      const name = (n) => n ? '<' + n.tagName.toLowerCase() + [...n.attributes].map((a) => ' ' + a.name + '="' + a.value.slice(0, 60) + '"').join('') + '>' : 'nothing';
      const hit = h === e || (h && e.contains(h)) ? null : name(h);
      if (!hit) {
        // What the press does, for the timeout's message: recorded from here on, by the test's own listeners.
        const t0 = performance.now();
        const ms = () => Math.round(performance.now() - t0);
        const card = e.closest('[data-decision]') ?? e.parentElement;
        const scrollers = [document.scrollingElement, ...document.querySelectorAll('main')].filter(Boolean);
        const rec = { t0, toggle: e, card, x, y, ariaAtPress: e.getAttribute('aria-expanded'), cardAtPress: card ? name(card) : 'nothing', scrollAtPress: scrollers.map((s) => s.scrollTop), events: [], mutations: [], scrolls: [] };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          document.addEventListener(type, (ev) => rec.events.push(type + '@' + ms() + 'ms on ' + name(ev.target) + (ev.target === e || e.contains(ev.target) ? ' (the toggle)' : ' (not the toggle)')), true);
        }
        if (card) new MutationObserver((list) => {
          for (const m of list) rec.mutations.push(ms() + 'ms ' + (m.type === 'attributes' ? m.attributeName + ' on ' + name(m.target) + ' (was ' + JSON.stringify(m.oldValue) + ')' : m.type === 'childList' ? (m.addedNodes.length ? '+' + m.addedNodes.length : '') + (m.removedNodes.length ? '-' + m.removedNodes.length : '') + ' children of ' + name(m.target) : 'text in ' + name(m.target.parentElement)));
        }).observe(card, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
        for (const s of scrollers) (s === document.scrollingElement ? window : s).addEventListener('scroll', () => rec.scrolls.push(ms() + 'ms ' + (s === document.scrollingElement ? 'window' : 'main') + ' to ' + s.scrollTop), { passive: true });
        window.__clickRecord = rec;
      }
      return { x, y, hit, moved: null };
    })()`,
  );
  if (at.moved) throw new Error(`${what} moved between the read and the press: ${at.moved}`);
  if (at.hit) throw new Error(`the click at (${Math.round(at.x)}, ${Math.round(at.y)}) would land on ${at.hit}, not on ${element}`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  try {
    await until('the click to land', () => js<boolean>(cdp, `${element}?.getAttribute('aria-expanded') === 'true'`), 5_000);
  } catch (err) {
    throw new Error(`${(err as Error).message} (${what})\n${await clickRecord(cdp, element).catch((e: Error) => `(no record: ${e.message})`)}`);
  }
}

/** What the page recorded from the press on (click() above), as lines for a failure message. */
async function clickRecord(cdp: Cdp, element: string): Promise<string> {
  return js<string>(
    cdp,
    `(() => {
      const rec = window.__clickRecord;
      if (!rec) return 'nothing recorded at the press';
      const name = (n) => n ? '<' + n.tagName.toLowerCase() + [...n.attributes].map((a) => ' ' + a.name + '="' + a.value.slice(0, 60) + '"').join('') + '>' : 'nothing';
      const now = ${element};
      const card = now ? now.closest('[data-decision]') ?? now.parentElement : null;
      const scrollers = [document.scrollingElement, ...document.querySelectorAll('main')].filter(Boolean);
      const reached = rec.events.some((x) => x.startsWith('click@') && x.endsWith('(the toggle)'));
      const list = (xs, max = 25) => xs.length ? xs.slice(0, max).map((x) => '    ' + x).join('\\n') + (xs.length > max ? '\\n    … and ' + (xs.length - max) + ' more' : '') : '    none';
      return [
        '  pressed at (' + Math.round(rec.x) + ', ' + Math.round(rec.y) + '); under the pointer now: ' + name(document.elementFromPoint(rec.x, rec.y)),
        '  the click reached the toggle: ' + (reached ? 'yes' : 'no') + " (React's handler is not visible from here; had it run, aria-expanded would show among the card's changes)",
        '  aria-expanded: at the press ' + JSON.stringify(rec.ariaAtPress) + ', on the toggle pressed now ' + JSON.stringify(rec.toggle.getAttribute('aria-expanded')) + ', on the toggle found now ' + JSON.stringify(now ? now.getAttribute('aria-expanded') : null),
        '  the toggle found now is ' + (now === rec.toggle ? 'the one pressed' : now ? 'another element (the one pressed is ' + (rec.toggle.isConnected ? 'still in the page' : 'gone from the page') + ')' : 'missing'),
        '  card at the press ' + rec.cardAtPress + '; now ' + name(card) + (card === rec.card ? ' (the same element)' : ' (another element; the one pressed is ' + (rec.card && rec.card.isConnected ? 'still in the page' : 'gone from the page') + ')'),
        '  scroll at the press ' + JSON.stringify(rec.scrollAtPress) + ', now ' + JSON.stringify(scrollers.map((s) => s.scrollTop)) + (rec.scrolls.length ? '' : ' (no scroll event)'),
        '  pointer events since the press:', list(rec.events),
        '  changes to the card since the press (' + rec.mutations.length + '):', list(rec.mutations),
        ...(rec.scrolls.length ? ['  scrolls since the press:', list(rec.scrolls)] : []),
      ].join('\\n');
    })()`,
  );
}
