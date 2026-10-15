// The first-run walk's last step and the Issues page's "Not picked up" (#468), in a real Chrome against a real
// dashboard with a file backlog standing in for GitHub: Your first task is filled in and filed (ready created, the
// issue's done_when the coordinator's parser takes); an outsider's issue with no ready label shows why it is ignored,
// and Add ready from the page fixes that much.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { parseContract } from '../src/backlog/types.js';
import { findChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import type { SetupProbe } from '../src/setup-steps.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, webUiSkip } from './browser-helpers.js';
import { exampleProject } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

const probe: SetupProbe = { which: (c) => `/stand-in/${c}`, run: () => ({ status: 1, stdout: '', stderr: 'stand-in' }), serviceRunning: () => false, systemUnitActive: () => false, linger: () => null };

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
const tid = (id: string) => `[data-testid="${id}"]`;

/** Type into a field as a person would: focus it by a real press, then insert the text. */
async function type(cdp: Cdp, sel: string, text: string) {
  await pressSteady(cdp, q(sel), sel);
  await cdp.send('Input.insertText', { text });
  assert.equal(await js<string>(cdp, `${q(sel)}.value`), text, `typed into ${sel}`);
}

test('#468 in a real Chrome: Your first task is filed from the first-run page; an outsider\'s issue shows why it is ignored, and Add ready fixes that', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  new EventLog(join(stateDir, 'events.db')).close();
  const path = join(mkdtempSync(join(tmpdir(), 'ftc-backlog-')), 'backlog.json');
  const outsider = await new FileBacklog(path, 'someone-else').createIssue('please add dark mode', 'no contract here', []);
  const backlog = new FileBacklog(path, 'example-owner');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', slotsDir: mkdtempSync(join(tmpdir(), 'ftc-slots-')), setupProbe: probe, backlog: () => backlog });
  const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
  try {
    const cdp = b.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
    await cdp.send('Page.navigate', { url: `${d.url}/first-run?step=first-task` });
    const row = '[data-testid="first-run-step"][data-step="first-task"]';
    await until('the first-task form', () => js<boolean>(cdp, `!!${q(`${row} ${tid('first-task-form')}`)}`), 30_000, 200);
    await type(cdp, `${row} ${tid('first-task-title')}`, 'Say hello');
    await type(cdp, `${row} ${tid('first-task-outcome')}`, 'The greeting prints.');
    await type(cdp, `${row} ${tid('first-task-test')}`, 'test/hello.test.ts');
    await pressSteady(cdp, q(`${row} ${tid('first-task-review')}`), 'Review the issue');
    await until('the preview', () => js<boolean>(cdp, `!!${q(`${row} ${tid('first-task-preview')}`)}`), 15_000, 100);
    assert.match(await js<string>(cdp, `${q(`${row} ${tid('first-task-preview')}`)}.textContent`), /```done_when\n- test: "test\/hello\.test\.ts"\n```/);
    assert.equal((await backlog.openIssues()).length, 1, 'nothing filed by Review');
    await pressSteady(cdp, q(`${row} ${tid('first-task-file')}`), 'File it');
    const said = await until('filed', () => js<string | null>(cdp, `${q(`${row} ${tid('first-task-result')}`)}?.textContent ?? null`), 15_000, 100);
    assert.match(said, /^filed as #2 \(the ready label was created\): the coordinator picks it up within a minute; watch it on the Board/);
    const filed = (await backlog.openIssues()).find((i) => i.number === 2)!;
    assert.deepEqual(filed.labels, ['ready']);
    assert.ok(parseContract(filed.body).ok);

    // The Issues page: the outsider's issue, why, and the fix.
    await cdp.send('Page.navigate', { url: `${d.url}/issues` });
    await until('the Issues page', () => js<boolean>(cdp, `!!${q(tid('issues-tab'))}`), 30_000, 200);
    await pressSteady(cdp, `[...document.querySelectorAll('[data-testid="issues-tab"]')].find((e) => e.textContent.startsWith('Not picked up'))`, 'Not picked up');
    const item = `[data-testid="issue-ignored"][data-issue="${outsider}"]`;
    await until('the ignored issue', () => js<boolean>(cdp, `!!${q(item)}`), 20_000, 200);
    assert.deepEqual(await js<string[]>(cdp, `[...document.querySelectorAll(${JSON.stringify(`${item} [data-testid="issue-ignored-reason"]`)})].map((e) => e.dataset.kind)`), ['no-ready', 'contract']);
    await pressSteady(cdp, q(`${item} ${tid('issue-ignored-add-ready')}`), 'Add ready');
    await until('ready added', async () => (await backlog.get(outsider)).labels.includes('ready'), 15_000, 100);
    await until('the reasons read again', () => js<boolean>(cdp, `!${q(`${item} [data-kind="no-ready"]`)}`), 15_000, 200);
    assert.deepEqual(await backlog.labelAdders(outsider, 'ready'), ['example-owner']);
  } finally {
    await b.close();
    await d.close();
  }
});
