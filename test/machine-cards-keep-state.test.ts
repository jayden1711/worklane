// The Machine page's cards keep what an owner is doing across new data: a machine change landing (an install
// finishing, a Tailscale step) while they type a signer, or read the message their request left, is new props for
// the cards, never a remount that wipes the inputs and the message. Checked in a real Chrome, against a real
// dashboard, by typing and then logging one more machine change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { ALLOWED_SIGNERS } from '../src/updater-setup.js';
import { REAL_CHROME_TIMEOUT, realChromeTests } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

test('the machine settings are never keyed on their data: new data is new props, and each input follows what is set until the owner types', () => {
  const src = readFileSync(join(repoRoot, 'web', 'src', 'components', 'MachineSettings.tsx'), 'utf8');
  assert.match(src, /return <MachineSettingsView data=\{data\} onChanged=\{setData\} \/>;/);
  assert.doesNotMatch(src, /<MachineSettingsView key=/);
  assert.doesNotMatch(src, /useState\(String\(data\./, 'no input copies the data once, at mount');
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);
const built = existsSync(join(repoRoot, 'dist', 'web', 'index.html'));

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;

/** A real mouse click at the element's centre. */
async function click(cdp: Cdp, testid: string) {
  await until(`${testid} to show`, () => js<boolean>(cdp, `!!${q(testid)} && !${q(testid)}.disabled`), 20_000);
  const at = await js<{ x: number; y: number }>(cdp, `(() => { const e = ${q(testid)}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}

/** Typed as keystrokes would be, into the focused element (its old text selected, so replaced). */
async function type(cdp: Cdp, element: string, text: string) {
  await js(cdp, `(() => { const e = ${element}; e.scrollIntoView({ block: 'center' }); e.focus(); e.select(); })()`);
  await cdp.send('Input.insertText', { text });
}

test(
  'in a real Chrome: a signer half typed, a slot cap typed and the request message all survive a machine change landing',
  { timeout: REAL_CHROME_TIMEOUT, skip: (!chrome && 'no Chrome or Chromium') || (!built && 'web UI not built (npm run build:web)') || (process.platform === 'win32' && 'checked on macOS and Linux') },
  async () => {
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
      const base = d.url.split('/?')[0]!;
      await cdp.send('Page.navigate', { url: `${base}/machine?t=${d.url.split('?t=')[1]!}` });

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
