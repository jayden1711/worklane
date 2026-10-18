// A decision's detail page in a real Chrome, against a real dashboard (test/decision-fixture.ts): Details on a
// Decisions card opens it with every section; on a held PR's page, the PR body (the one part read after the rest)
// answering last moves no control or section already on screen; and the owner's Show the diff shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, STEADY_PX, webUiSkip } from './browser-helpers.js';
import { asPerson } from './helpers.js';
import { decisionFixture } from './decision-fixture.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
const SECTIONS = `[...document.querySelectorAll('[data-section]')].map((e) => e.dataset.section)`;
/** Every control and section on the page now (on screen or scrolled to later), and where. */
const NOTE = `(() => {
  const name = (e) => e.dataset.section || e.dataset.testid || (e.textContent || '').trim().slice(0, 40) || e.tagName.toLowerCase();
  window.__noted = [...document.querySelectorAll('main button, main a[href], [data-section]')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map((e) => { const r = e.getBoundingClientRect(); return { e, name: name(e), x: r.x + scrollX, y: r.y + scrollY }; });
  return window.__noted.map((n) => n.name);
})()`;
const MOVED = `window.__noted.filter((n) => { if (!n.e.isConnected) return true; const r = n.e.getBoundingClientRect(); return Math.abs(r.x + scrollX - n.x) > ${STEADY_PX} || Math.abs(r.y + scrollY - n.y) > ${STEADY_PX}; }).map((n) => n.name)`;

test('in a real Chrome: Details opens every section; the PR body answering last moves nothing; the owner sees the diff', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const f = await decisionFixture();
  const b = await launchTestChrome(chrome!, { width: 1280, height: 900 });
  try {
    const cdp = b.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.setExtraHTTPHeaders', { headers: asPerson('example-owner') });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(f.d.token)}); } catch {}` });

    // From a Decisions card.
    await cdp.send('Page.navigate', { url: `${f.base_url}/decisions` });
    await until('the landing decision card', () => js<boolean>(cdp, `!!${q('[data-decision="d-land"] [data-testid="decision-details"]')}`), 20_000);
    await pressSteady(cdp, q('[data-decision="d-land"] [data-testid="decision-details"]'), 'Details');
    await until('the detail page', () => js<boolean>(cdp, `location.pathname === '/needs-you/decisions/d-land' && !!${q('[data-testid="decision-detail"]')}`), 20_000);
    assert.equal((await js<string[]>(cdp, SECTIONS)).length, 13, 'every section');
    assert.match(await js<string>(cdp, `${q('[data-section="if-nothing"]')}.innerText`), /No timeout: it waits/);

    // The owner's diff, on a click.
    await pressSteady(cdp, q('[data-testid="decision-diff-show"]'), 'Show the diff');
    await until('the diff', () => js<boolean>(cdp, `/\\+export const refund/.test(${q('[data-testid="decision-diff-text"]')}?.innerText ?? '')`), 20_000);

    // A held PR's page, with its PR body held until everything else is drawn.
    const paused: string[] = [];
    cdp.on('Fetch.requestPaused', (p) => void paused.push(p.requestId as string));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/decisions/${f.ids.pr}/pr*`, requestStage: 'Request' }] });
    await cdp.send('Page.navigate', { url: `${f.base_url}/decisions/${f.ids.pr}` });
    await until('the PR body held', async () => paused.length > 0, 20_000);
    await until('every section drawn', () => js<boolean>(cdp, `${SECTIONS}.length === 13 && /Reading the PR body/.test(${q('[data-section="pr-body"]')}.innerText)`), 20_000);
    await sleep(300);
    assert.ok((await js<string[]>(cdp, NOTE)).length > 5, 'controls and sections on the page');
    for (const requestId of paused.splice(0)) await cdp.send('Fetch.continueRequest', { requestId });
    await cdp.send('Fetch.disable');
    await until('the fail-without section', () => js<boolean>(cdp, `/fails: 1 of 3/.test(${q('[data-testid="decision-fail-without"]')}?.innerText ?? '')`), 20_000);
    await sleep(300);
    assert.deepEqual(await js<string[]>(cdp, MOVED), [], 'the PR body answering last moved what was on the page');
    assert.match(await js<string>(cdp, `${q('[data-testid="decision-never"]')}.innerText`), /It never refunds twice/);
    // In page order, the PR body last: nothing is below the one part that answers late.
    assert.deepEqual(await js<string[]>(cdp, SECTIONS), ['summary', 'options', 'impact', 'if-nothing', 'findings', 'change', 'verdict', 'tests', 'ci', 'runs', 'links', 'diff', 'pr-body']);
  } finally {
    await b.close();
    await f.d.close();
  }
});
