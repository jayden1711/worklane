import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { exampleProject } from './helpers.js';

const APP = `version: 1
start:
  command: npm run dev -- --port 5173
  port: 5173
ui_paths: [web/**]
flows:
  checkout:
    - goto: /cart
    - click: testid:checkout
    - type: { target: testid:email, text: a@example.com }
    - key: Enter
    - wait: testid:done
    - expect_text: { target: testid:total, text: "$10.01" }
    - wait: 500
`;

function withApp(yaml: string | null) {
  const { dir } = exampleProject();
  if (yaml !== null) writeFileSync(join(dir, BRAND.configDir, 'app.yaml'), yaml);
  return dir;
}

/** The loader's reasons for refusing an app.yaml, or null if it loads. */
function refusal(yaml: string): string | null {
  try {
    loadConfig(withApp(yaml));
    return null;
  } catch (e) {
    assert.ok(e instanceof ConfigInvalid);
    return e.errors.filter((x) => x.file === 'app.yaml').map((x) => `${x.path}: ${x.message}`).join('; ');
  }
}

test('no app.yaml: no app, so browser checks are off for the project', () => {
  assert.equal(loadConfig(withApp(null)).app, undefined);
});

test('an app.yaml: how to start the app, its UI paths, named flows of stable steps, and thresholds with defaults', () => {
  const app = loadConfig(withApp(APP)).app!;
  assert.deepEqual(app.start, { command: 'npm run dev -- --port 5173', port: 5173, ready: { path: '/', timeout_s: 60 } });
  assert.deepEqual(app.ui_paths, ['web/**']);
  assert.deepEqual(app.thresholds, { max_long_task_ms: 200, max_dropped_frame_pct: 25, slow_request_ms: 3000 });
  assert.equal(app.flows.checkout!.length, 7);
  assert.deepEqual(app.flows.checkout![2], { type: { target: 'testid:email', text: 'a@example.com' } });
});

test('app.yaml is strict: stable targets only, paths never hosts, a real port, at least one flow, no stray keys', () => {
  assert.match(String(refusal(APP.replace('click: testid:checkout', 'click: ".btn > div:nth-child(2)"'))), /a stable target: testid:<data-testid> or text:<visible text>, never a CSS path/);
  assert.match(String(refusal(APP.replace('goto: /cart', 'goto: https://example.com/cart'))), /a path on the app, starting with one \/: the host is always localhost/);
  assert.match(String(refusal(APP.replace('goto: /cart', 'goto: //example.com/cart'))), /a path on the app/, 'a protocol-relative URL is a host too');
  assert.match(String(refusal(APP.replace('port: 5173', 'port: 80'))), /start\.port/);
  assert.match(String(refusal(APP.replace(/flows:[\s\S]*/, 'flows: {}\n'))), /at least one flow/);
  assert.match(String(refusal(APP.replace('ui_paths: [web/**]', 'ui_paths: []'))), /ui_paths/);
  assert.match(String(refusal(`${APP}headless: false\n`)), /headless|Unrecognized key/);
  assert.match(String(refusal(APP.replace("  checkout:", "  Check Out:"))), /"Check Out" isn\x27t a flow name: lowercase letters, digits and dashes/);
  assert.match(String(refusal(APP.replace('    - wait: 500', '    - wait: 600000'))), /flows\.checkout\.6/, 'a pause of at most a minute');
  assert.equal(refusal(APP), null);
});
