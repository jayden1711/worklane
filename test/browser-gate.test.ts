import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config/schema.js';
import { askedFlows, browserGate, uiFilesTouched } from '../src/browser/gate.js';

const app = AppConfig.parse({
  version: 1,
  start: { command: 'npm run dev', port: 5173 },
  ui_paths: ['web/**', 'src/components/', 'styles/*.css'],
  flows: { home: [{ goto: '/' }], checkout: [{ goto: '/cart' }, { click: 'testid:pay' }] },
});

test('a change touching none of the ui_paths runs no browser check', () => {
  assert.deepEqual(browserGate({ app, changed: ['src/server/api.ts', 'README.md', 'styles/print/base.css', 'webby/x.ts'], asked: [] }), { flows: [], reason: "the change touches none of the app's ui_paths, so no browser checks", uiFiles: [] });
  assert.deepEqual(browserGate({ app, changed: [], asked: [] }).flows, [], 'an empty change runs nothing');
});

test('a change touching the ui_paths runs every flow, and says which files', () => {
  const g = browserGate({ app, changed: ['src/server/api.ts', 'web/cart/Pay.tsx', 'src/components/Button.tsx', 'styles/site.css'], asked: [] });
  assert.deepEqual(g, { flows: ['home', 'checkout'], reason: 'the change touches 3 file(s) under ui_paths, so every flow runs', uiFiles: ['web/cart/Pay.tsx', 'src/components/Button.tsx', 'styles/site.css'] });
});

test('Windows-style and ./ paths match the same globs', () => {
  assert.deepEqual(uiFilesTouched(app, ['web\\cart\\Pay.tsx', './src/components/a.tsx']), ['web/cart/Pay.tsx', 'src/components/a.tsx']);
});

test('the files named are capped at 10; the count is the whole', () => {
  const g = browserGate({ app, changed: Array.from({ length: 14 }, (_, i) => `web/f${i}.ts`), asked: [] });
  assert.equal(g.uiFiles.length, 10);
  assert.match(g.reason, /touches 14 file/);
});

test('an issue that asks runs the flows it names, whatever the change touches, and even with no app (so the check is unavailable, never skipped)', () => {
  assert.deepEqual(browserGate({ app, changed: ['src/server/api.ts'], asked: ['checkout', 'checkout'] }), { flows: ['checkout'], reason: 'the issue asks for the browser check checkout', uiFiles: [] });
  assert.deepEqual(browserGate({ app, changed: ['web/a.ts'], asked: ['checkout'] }).flows, ['checkout'], 'asking narrows: only the named flows run');
  assert.deepEqual(browserGate({ app: undefined, changed: [], asked: ['home', 'checkout'] }).flows, ['home', 'checkout']);
});

test('a project without an app runs none unless asked', () => {
  assert.deepEqual(browserGate({ app: undefined, changed: ['web/a.ts'], asked: [] }), { flows: [], reason: 'no app is declared, so no browser checks', uiFiles: [] });
});

test("the flows an issue asks for are its done_when's browser items, in order; other kinds are not", () => {
  assert.deepEqual(askedFlows([{ command: 'npm test' }, { browser: 'checkout' }, { suite: 'changed' }, { browser: 'home' }, { browser: 'Bad Name' }]), ['checkout', 'home']);
  assert.deepEqual(askedFlows([]), []);
});
