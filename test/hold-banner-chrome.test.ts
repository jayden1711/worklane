// #470 in a real Chrome, against a real dashboard: a disk hold forced with stand-in disk stats (22 GB free of 460 GB,
// through the coordinator's own rule) shows on the Board as a banner with its numbers and fix while the page is open;
// it clears when the hold ends, and neither moves a control on the page; its link opens Settings, which shows the
// floor's rule and the machine's numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { diskHold, diskRoom } from '../src/governor-holds.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, STEADY_PX, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;
/** Where each control on the page is (buttons, links, the columns), by name. */
const PLACES = `(() => { const seen = {}; return Object.fromEntries([...document.querySelectorAll('button, a[href], [data-testid="board-column"]')].filter((e) => e.checkVisibility()).map((e) => { const r = e.getBoundingClientRect(); const name = e.dataset.column || e.dataset.testid || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30); seen[name] = (seen[name] || 0) + 1; return [name + '#' + seen[name], [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10]]; })); })()`;

test('in a real Chrome: a disk hold shows on the Board with its numbers and fix, clears on release, moves nothing, and its link opens Settings', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'hold-banner-'));
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const slotsDir = join(dir, 'slots');
  mkdirSync(slotsDir, { recursive: true });
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, diskFree: () => ({ freeGb: 22, totalGb: 460 }) });
  const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
  try {
    const cdp = b.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson('example-owner') });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
    await cdp.send('Page.navigate', { url: `${d.url}/` });
    await until('the Board with nothing held', () => js<boolean>(cdp, `${q('board-hold')}?.dataset.held === 'false'`), 20_000);
    const before = await js<Record<string, [number, number]>>(cdp, PLACES);
    const height = () => js<number>(cdp, `${q('board-hold')}.getBoundingClientRect().height`);
    const h0 = await height();

    // The hold, as the coordinator records it from stand-in disk stats: 22 GB free of 460 GB, floor 23 GB.
    const room = diskRoom({ freeGb: 22, totalGb: 460 }, cfg.project.governor, cfg.tests.worktree.est_size_gb);
    const hold = diskHold(room, cfg.project.governor, 1);
    assert.ok(hold, 'the stand-in disk is under the floor');
    log.append('governor.hold', { reason: hold.reason, load: hold.load, free_disk_pct: hold.freeDiskPct, kind: hold.kind, facts: hold.facts! }, 'c');
    await until('the banner while the page is open', () => js<boolean>(cdp, `${q('board-hold')}?.dataset.held === 'true'`), 20_000);
    assert.equal(await js<string>(cdp, `${q('board-hold')}.dataset.kind`), 'disk');
    assert.equal(await js<string>(cdp, `${q('board-hold-numbers')}.textContent`), '22 GB free of 460 GB (4.8%); the floor is 23 GB (the larger of 10 GB and 5% of the disk); one more worktree needs ~1 GB');
    assert.equal(await js<string>(cdp, `${q('board-hold-fix')}.textContent`), 'Free ~2 GB on this disk, or change the floor in Settings.');
    assert.ok(Math.abs((await height()) - h0) <= STEADY_PX, 'the banner keeps the strip its height');
    const moved = (now: Record<string, [number, number]>) => Object.entries(before).filter(([k, [x, y]]) => !now[k] || Math.abs(now[k][0] - x) > STEADY_PX || Math.abs(now[k][1] - y) > STEADY_PX).map(([k]) => k);
    assert.deepEqual(moved(await js(cdp, PLACES)), [], 'the hold moved nothing');

    // It ends: the banner clears, still moving nothing.
    log.append('governor.release', { load: 1, free_disk_pct: null }, 'c');
    await until('the banner cleared', () => js<boolean>(cdp, `${q('board-hold')}?.dataset.held === 'false'`), 20_000);
    assert.deepEqual(moved(await js(cdp, PLACES)), [], 'the release moved nothing');

    // Held again: its link opens Settings, with the floor's rule and this machine's numbers.
    log.append('governor.hold', { reason: hold.reason, load: hold.load, free_disk_pct: hold.freeDiskPct, kind: hold.kind, facts: hold.facts! }, 'c');
    await until('the link', () => js<boolean>(cdp, `!!${q('board-hold-link')}`), 20_000);
    await pressSteady(cdp, q('board-hold-link'), 'board-hold-link');
    await until('Settings with the disk floor', () => js<boolean>(cdp, `!!${q('settings-disk-machine')}`), 20_000);
    assert.match(await js<string>(cdp, `${q('settings-disk-floor')}.textContent`), /the larger of 10 GB and 5% of the disk/);
    assert.equal(await js<string>(cdp, `${q('settings-disk-machine')}.dataset.level`), 'warn');
    assert.match(await js<string>(cdp, `${q('settings-disk-machine')}.textContent`), /22 GB free of 460 GB/);
  } finally {
    await b.close();
    await d.close();
    log.close();
  }
});
