// On the Machine page no panel that answers late moves a control already on screen. Each panel loads its own data;
// when the Updates panel (GET /api/updates) answered after the machine settings, it appeared above them, 184 px tall,
// and moved Install down 208 px: a press aimed at Install landed on the "Machine settings" heading, and the
// confirmation never showed (#453's CI failure of test/machine-cards-keep-state.test.ts). The page now shows its
// panels in page order (web/src/in-order.tsx). Checked in a real Chrome, against a real dashboard, by holding each
// panel's request in turn until every other request has answered and the page has drawn, noting where every visible
// control is, then letting it through: none may move. Then Install is pressed, and its confirmation must open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, sleep, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { ALLOWED_SIGNERS } from '../src/updater-setup.js';
import { REAL_CHROME_TIMEOUT, STEADY_PX, oneChromeAtATime, pressSteady, realChromeTests, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

/** Each panel's own request on the Machine page, held last in turn. */
const LATE = ['/api/test-runs', '/api/health', '/api/claude-account', '/api/tailscale', '/api/updates', '/api/machine'];

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;

/**
 * In the page: with Install in the middle of the view if it is shown (as a press at it would have it: #453's), note
 * every control on screen (shown, with a box inside the viewport) and where it is.
 */
const NOTE = `(() => {
  const install = ${q('updater-install')};
  if (install?.checkVisibility()) install.scrollIntoView({ block: 'center' });
  const name = (e) => e.dataset.testid || e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 40) || e.tagName.toLowerCase();
  window.__noted = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter((e) => {
    const r = e.getBoundingClientRect();
    return e.checkVisibility() && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  }).map((e) => { const r = e.getBoundingClientRect(); return { e, name: name(e), x: r.x, y: r.y }; });
  return window.__noted.map((n) => n.name);
})()`;
/** In the page: each noted control that has moved since (or left the page), with where it was and is. */
const MOVED = `window.__noted.filter((n) => { if (!n.e.isConnected) return true; const r = n.e.getBoundingClientRect(); return Math.abs(r.x - n.x) > ${STEADY_PX} || Math.abs(r.y - n.y) > ${STEADY_PX}; })
  .map((n) => n.name + ': (' + Math.round(n.x) + ', ' + Math.round(n.y) + ') -> ' + (n.e.isConnected ? '(' + Math.round(n.e.getBoundingClientRect().x) + ', ' + Math.round(n.e.getBoundingClientRect().y) + ')' : 'gone'))`;

for (const held of LATE) {
  test(
    `in a real Chrome: ${held} answering last moves no control on the Machine page, and Install still opens its confirmation`,
    { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
    async (ctx) => {
      await oneChromeAtATime(ctx);
      const dir = mkdtempSync(join(tmpdir(), 'machine-no-shift-'));
      const updatesConfigPath = join(dir, 'updates.json');
      writeFileSync(updatesConfigPath, JSON.stringify({ enabled: false, channel: 'release', allowed_signers: ALLOWED_SIGNERS, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }));
      const eventsDb = join(dir, 'events.db');
      new EventLog(eventsDb).close();
      const { dir: root } = exampleProject();
      const slotsDir = join(dir, 'slots');
      mkdirSync(slotsDir, { recursive: true });
      const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, machine: { updatesConfigPath, signersPath: join(dir, 'allowed_signers'), pendingSignersPath: join(dir, 'pending-signers.json'), changesPath: join(dir, 'changes.jsonl'), updatesLogPath: join(dir, 'updates.jsonl') }, machineOwnersFile: machineOwnersFile('example-owner') });
      const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
      try {
        const cdp = b.cdp;
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');
        await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson('example-owner') });
        // #418: the key goes in the tab's session storage, as the page's key form keeps it: never in a URL.
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });

        // The page's API requests, so the test knows when every one but the held one has answered.
        const open = new Map<string, string>();
        const streams = new Set<string>();
        let last = Date.now();
        cdp.on('Network.requestWillBeSent', (p) => {
          const url = (p.request as { url: string }).url;
          if (/\/api\//.test(url)) (open.set(p.requestId as string, url), (last = Date.now()));
        });
        cdp.on('Network.responseReceived', (p) => {
          if (/event-stream/.test((p.response as { mimeType: string }).mimeType)) (streams.add(p.requestId as string), open.delete(p.requestId as string));
        });
        const done = (p: Record<string, unknown>) => {
          if (open.delete(p.requestId as string)) last = Date.now();
        };
        cdp.on('Network.loadingFinished', done);
        cdp.on('Network.loadingFailed', done);
        const paused: string[] = [];
        // Fetch's patterns know only * and ? (any one character), so every request under the path is caught, and only
        // the panel's own (this path exactly, any query) is held.
        cdp.on('Fetch.requestPaused', (p) => {
          const requestId = p.requestId as string;
          if (new URL((p.request as { url: string }).url).pathname === held) paused.push(requestId);
          else void cdp.send('Fetch.continueRequest', { requestId });
        });
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `*${held}*`, requestStage: 'Request' }] });
        await cdp.send('Page.navigate', { url: `${d.url}/machine` });

        // Held, with every other request answered for a moment and the page drawn from them.
        await until(`${held} held`, async () => paused.length > 0, 20_000);
        const othersSettled = () => [...open.values()].every((u) => new URL(u).pathname === held) && Date.now() - last > 500;
        await until('every other request answered', async () => othersSettled(), 20_000, 100).catch((e: Error) => {
          throw new Error(`${e.message}; still waiting on: ${[...open.values()].join(', ') || 'none'}; last request ${Date.now() - last} ms ago`);
        });
        await sleep(300);
        const noted = await js<string[]>(cdp, NOTE);
        assert.ok(noted.length > 0, 'some control is on screen');

        // Let it through: it answers last.
        for (const requestId of paused.splice(0)) await cdp.send('Fetch.continueRequest', { requestId });
        await cdp.send('Fetch.disable');
        await until(`${held} answered and everything settled`, async () => othersSettled() && ![...open.values()].length, 20_000, 100);
        await sleep(300);
        assert.deepEqual(await js<string[]>(cdp, MOVED), [], `${held} answering last moved controls on screen (was -> now)`);

        // Install, pressed where it is (it must hold still), opens its confirmation.
        await until('Install', () => js<boolean>(cdp, `!!${q('updater-install')}?.checkVisibility() && !${q('updater-install')}.disabled`), 20_000);
        await pressSteady(cdp, q('updater-install'), 'updater-install');
        await until('updater-confirm to show', () => js<boolean>(cdp, `!!${q('updater-confirm')}`), 5_000);
      } finally {
        await b.close();
        await d.close();
      }
    },
  );
}
