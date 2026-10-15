// The Machine page's cards keep what an owner is doing across new data: a machine change landing (an install
// finishing, a Tailscale step) while they type a signer, or read the message their request left, is new props for
// the cards, never a remount that wipes the inputs and the message. Checked in a real Chrome, against a real
// dashboard, by typing and then logging one more machine change. And a look that fails (the network, a 5xx) keeps
// the last good data on screen with a note, while a refusal (401, 403) still hides the panel (web/src/refresh.tsx).
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launchChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { TailscaleStatus } from '../src/tailscale-setup.js';
import { ALLOWED_SIGNERS } from '../src/updater-setup.js';
import { REAL_CHROME_TIMEOUT, oneChromeAtATime, pressSteady, realChromeTests, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

test('the machine settings are never keyed on their data: new data is new props, and each input follows what is set until the owner types', () => {
  const src = readFileSync(join(repoRoot, 'web', 'src', 'components', 'MachineSettings.tsx'), 'utf8');
  assert.match(src, /return <MachineSettingsView data=\{data\} onChanged=\{setData\} \/>;/);
  assert.doesNotMatch(src, /<MachineSettingsView key=/);
  assert.doesNotMatch(src, /useState\(String\(data\./, 'no input copies the data once, at mount');
});

type Loaded = { data: unknown; stale: string | null };
let r: { afterLoad: (prev: Loaded, x: { data: unknown } | { error: unknown }) => Loaded; NOTHING_YET: Loaded; ApiError: new (m: string, status: number) => Error; isRefusal: (e: unknown) => boolean };
before(async () => {
  // The page's own code, bundled for Node with the project's vite, as the render checks do.
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'refresh-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as typeof r;
});

test('a look that fails keeps the last good data and says why; only a refusal (401, 403, no such view) clears it; new data replaces it', () => {
  const good: Loaded = { data: { n: 1 }, stale: null };
  const transient: [unknown, string][] = [
    [new TypeError('Failed to fetch'), 'Failed to fetch'],
    [new r.ApiError('HTTP 502', 502), 'HTTP 502'],
    [new r.ApiError('the instance is restarting', 503), 'the instance is restarting'],
    [new r.ApiError('HTTP 500', 500), 'HTTP 500'],
    [new DOMException('The operation timed out.', 'TimeoutError'), 'The operation timed out.'],
    ['a string', 'no answer'],
  ];
  for (const [error, why] of transient) {
    assert.equal(r.isRefusal(error), false, why);
    assert.deepEqual(r.afterLoad(good, { error }), { data: { n: 1 }, stale: why }, why);
  }
  for (const status of [401, 403, 404]) {
    const e = new r.ApiError('not for you', status);
    assert.equal(r.isRefusal(e), true, String(status));
    assert.deepEqual(r.afterLoad(good, { error: e }), r.NOTHING_YET, `${status} hides`);
  }
  // Nothing loaded yet: still nothing, but stale, so the panel tries again.
  assert.deepEqual(r.afterLoad(r.NOTHING_YET, { error: new TypeError('Failed to fetch') }), { data: null, stale: 'Failed to fetch' });
  assert.deepEqual(r.afterLoad({ data: { n: 1 }, stale: 'HTTP 502' }, { data: { n: 2 } }), { data: { n: 2 }, stale: null });
});

test('the live panels (Tailscale, Claude account, Discord) take every failed look through afterLoad and retry; none drops its data on any error', () => {
  for (const f of ['TailscaleSetup.tsx', 'ClaudeAccount.tsx', 'DiscordSetup.tsx']) {
    const src = readFileSync(join(repoRoot, 'web', 'src', 'components', f), 'utf8');
    assert.match(src, /setLoaded\(\(p\) => afterLoad\(p, \{ error \}\)\)/, f);
    assert.match(src, /useRetry\(loaded, /, f);
    assert.match(src, /<StaleNote stale=\{loaded\.stale\} \/>/, f);
    assert.doesNotMatch(src, /\(\) => setData\(null\)|setV\(\{ error/, `${f}: no error that wipes the panel`);
  }
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;

/** A real mouse click at the element's centre, which must hold still from the read to the press (pressSteady). */
async function click(cdp: Cdp, testid: string) {
  await until(`${testid} to show`, () => js<boolean>(cdp, `!!${q(testid)} && !${q(testid)}.disabled`), 20_000);
  await pressSteady(cdp, q(testid), testid);
}

/** Every Machine panel has had its first answer and is shown (web/src/in-order.tsx). */
const machineLoaded = (cdp: Cdp) => until('every Machine panel loaded', () => js<boolean>(cdp, `document.querySelector('[data-testid="machine-panels"]')?.dataset.loaded === 'true'`), 20_000);

/** Typed as keystrokes would be, into the focused element (its old text selected, so replaced). */
async function type(cdp: Cdp, element: string, text: string) {
  await js(cdp, `(() => { const e = ${element}; e.scrollIntoView({ block: 'center' }); e.focus(); e.select(); })()`);
  await cdp.send('Input.insertText', { text });
}

test(
  'in a real Chrome: a signer half typed, a slot cap typed and the request message all survive a machine change landing',
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const dir = mkdtempSync(join(tmpdir(), 'machine-cards-'));
    const updatesConfigPath = join(dir, 'updates.json');
    writeFileSync(updatesConfigPath, JSON.stringify({ enabled: false, channel: 'release', allowed_signers: ALLOWED_SIGNERS, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }));
    const changesPath = join(dir, 'changes.jsonl');
    const eventsDb = join(dir, 'events.db');
    new EventLog(eventsDb).close();
    const { dir: root } = exampleProject();
    const slotsDir = join(dir, 'slots');
    mkdirSync(slotsDir, { recursive: true });
    const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, machine: { updatesConfigPath, signersPath: join(dir, 'allowed_signers'), pendingSignersPath: join(dir, 'pending-signers.json'), changesPath, updatesLogPath: join(dir, 'updates.jsonl') }, machineOwnersFile: machineOwnersFile('example-owner') });
    const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');
      // The machine owner, from an allowed console device, as the hub names them.
      await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson('example-owner') });
      // #418: the key goes in the tab's session storage, as the page's key form keeps it: never in a URL.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
      await cdp.send('Page.navigate', { url: `${d.url}/machine` });
      await machineLoaded(cdp);

      // Ask for the install and confirm it: the message says it was requested, and the page now looks again every
      // few seconds while the request waits for the coordinator.
      await click(cdp, 'updater-install');
      await click(cdp, 'updater-confirm');
      await until('the request message', () => js<boolean>(cdp, `/^requested: /.test(${q('updater-message')}?.textContent ?? '')`), 20_000);
      const message = await js<string>(cdp, `${q('updater-message')}.textContent`);

      // Mid-way through staging a signer, and a new slot cap typed.
      const key = `ssh-ed25519 ${generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')}`;
      await type(cdp, q('updater-signer-principal'), 'release@example.com');
      await type(cdp, q('updater-signer-key'), key);
      const slots = `document.querySelector('[data-setting="slots"] [data-testid="machine-setting-input"]')`;
      await type(cdp, slots, '3');
      const typed = () => js<[string, string, string, string | null]>(cdp, `[${q('updater-signer-principal')}?.value ?? '', ${q('updater-signer-key')}?.value ?? '', ${slots}?.value ?? '', ${q('updater-message')}?.textContent ?? null]`);
      assert.deepEqual(await typed(), ['release@example.com', key, '3', message]);

      // A machine change lands (a Tailscale step, logged by the helper), and the page's next look shows it.
      const rows = () => js<number>(cdp, `document.querySelectorAll('[data-testid="machine-change-row"]').length`);
      const before = await rows();
      appendFileSync(changesPath, `${JSON.stringify({ at: new Date().toISOString(), by: 'wl-site', what: 'tailscale', from: null, to: 'install' })}\n`);
      await until('the new change on the page', async () => (await rows()) === before + 1, 20_000);

      assert.deepEqual(await typed(), ['release@example.com', key, '3', message], 'what was typed and the message are still there');
    } finally {
      await b.close();
      await d.close();
    }
  },
);

test(
  "in a real Chrome: Tailscale's looks failing mid-confirm keep the step's confirmation open, with a note; a 403 then hides the panel",
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const dir = mkdtempSync(join(tmpdir(), 'tailscale-refresh-'));
    const eventsDb = join(dir, 'events.db');
    new EventLog(eventsDb).close();
    const { dir: root } = exampleProject();
    const tsDir = mkdtempSync(join(tmpdir(), 'tailscale-dir-'));
    const status: TailscaleStatus = { installed: true, version: '1.104.1', pinnedVersion: '1.104.1', state: 'NeedsLogin', name: null, https: false, serve: false, other443: false, breakGlassForwarded: false, funnel: false, hubUrl: 'https://hub.example.test' };
    const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), instance: 'alpha', machineOwnersFile: machineOwnersFile('example-owner'), tailscaleDir: tsDir, tailscaleStatus: async () => status });
    const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');
      await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson('example-owner') });
      // The panel's looks at /api/tailscale, answered as the test says: let through, cut off, or refused.
      let mode: 'through' | 'down' | 'refused' = 'through';
      let looked = 0;
      cdp.on('Fetch.requestPaused', (p) => {
        const requestId = p.requestId as string;
        looked++;
        if (mode === 'through') void cdp.send('Fetch.continueRequest', { requestId });
        else if (mode === 'down') void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
        else void cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 403, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'not a machine owner' })).toString('base64') });
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/tailscale*', requestStage: 'Request' }] });
      // #418: the key goes in the tab's session storage, as the page's key form keeps it: never in a URL.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
      await cdp.send('Page.navigate', { url: `${d.url}/machine` });

      // The next step's confirmation, open.
      const next = `document.querySelector('[data-testid="tailscale-step"][data-next="true"]')`;
      await until('the Tailscale steps', () => js<boolean>(cdp, `!!${next}?.querySelector('[data-testid="tailscale-step-run"]')`), 20_000);
      const step = await js<string>(cdp, `${next}.dataset.step`);
      await machineLoaded(cdp);
      await pressSteady(cdp, `${next}.querySelector('[data-testid="tailscale-step-run"]')`, 'tailscale-step-run');
      const open = `!!document.querySelector('[data-testid="tailscale-step"][data-step="${step}"] [data-testid="tailscale-step-confirm"]')`;
      await until('the confirmation', () => js<boolean>(cdp, open), 10_000);

      // The instance goes away: the next look (every 20 s while nothing runs) fails.
      mode = 'down';
      const before = looked;
      await until('a failed look', () => looked > before, 40_000, 250);
      await until('the note', () => js<boolean>(cdp, `/^couldn't refresh: .+, retrying$/.test(document.querySelector('[data-testid="refresh-stale"]')?.textContent ?? '')`), 10_000);
      assert.equal(await js<boolean>(cdp, open), true, 'the confirmation is still open');
      assert.equal(await js<boolean>(cdp, `!!document.querySelector('[data-testid="tailscale-setup"]')`), true, 'the last good data is still shown');

      // Back, but refusing: the retry (5 s) hides the panel, as a refusal always did.
      mode = 'refused';
      await until('the panel hidden', () => js<boolean>(cdp, `!document.querySelector('[data-testid="tailscale-setup"]') && !document.querySelector('[data-testid="refresh-stale"]')`), 20_000);
    } finally {
      await b.close();
      await d.close();
    }
  },
);
