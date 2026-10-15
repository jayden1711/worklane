// Chat conversations and Projects in a real Chrome, against a real dashboard, as a writer: the Ask panel's sidebar,
// a new conversation that keeps its thread across two turns (the coordinator's answers written as it writes them),
// a Project made from the sidebar (no share box for a writer), and a conversation deleted for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, until, type Cdp } from '../src/browser/cdp.js';
import { takeChatRequests, type ChatAnswer } from '../src/chat.js';
import { readConversation, writeConversationAnswer } from '../src/chat-conversations.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { launchTestChrome, oneChromeAtATime, pressSteady, REAL_CHROME_TIMEOUT, realChromeTests, webUiSkip } from './browser-helpers.js';
import { asDevicePerson, exampleProject, exampleRoles } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;
const all = (testid: string) => `[...document.querySelectorAll('[data-testid="${testid}"]')]`;

async function type(cdp: Cdp, testid: string, text: string) {
  await pressSteady(cdp, q(testid), testid);
  await cdp.send('Input.insertText', { text });
  assert.equal(await js<string>(cdp, `${q(testid)}.value`), text, `typed into ${testid}`);
}

const answer = (text: string): ChatAnswer => ({ turn: 't', instance: 'shop', answer: text, citations: [], unknownCitations: [], issueDraft: null, actions: [], refusedActions: [], readOnly: true, costUsd: 0.01 });

test('in a real Chrome: a writer starts a conversation that keeps its thread, makes a Project without a share box, and deletes the conversation', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'chat-conv-chrome-'));
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const { dir: root } = exampleProject();
  const slotsDir = join(dir, 'slots');
  mkdirSync(slotsDir, { recursive: true });
  const stateDir = join(dir, 'state');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir });
  const b = await launchTestChrome(chrome!, { width: 1280, height: 1000 });
  try {
    const cdp = b.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setExtraHTTPHeaders', { headers: asDevicePerson('example-collaborator') });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
    await cdp.send('Page.navigate', { url: `${d.url}/` });
    await until('the Ask button', () => js<boolean>(cdp, `!!${q('chat-open')}`), 20_000);
    await pressSteady(cdp, q('chat-open'), 'chat-open');
    await until('the sidebar, empty', () => js<boolean>(cdp, `!!${q('conv-empty')}`), 20_000);
    // WHY: the panel slides in (200 ms); a press is read only once it has stopped moving.
    await until('the panel settled', () => js<boolean>(cdp, `document.getAnimations().every((a) => a.playState !== 'running')`), 20_000);

    // A new conversation; two turns, each answered as the coordinator answers them.
    await pressSteady(cdp, q('conv-new'), 'conv-new');
    await until('the empty thread', () => js<boolean>(cdp, `!!${q('conv-thread')}`), 20_000);
    const turn = async (text: string, reply: string) => {
      await type(cdp, 'chat-input', text);
      await pressSteady(cdp, q('chat-ask'), 'chat-ask');
      const req = await until('the request', () => takeChatRequests(stateDir)[0] ?? null, 20_000);
      assert.ok(req.conversation, 'a conversation turn');
      writeConversationAnswer(stateDir, req.conversation, req.id, { answer: answer(reply) });
      await until(`the answer "${reply}"`, () => js<boolean>(cdp, `${q('conv-thread')}?.textContent.includes(${JSON.stringify(reply)})`), 20_000);
      return req.conversation;
    };
    const id = await turn('why is issue 12 stuck?', 'FIRST-ANSWER');
    await turn('and what next?', 'SECOND-ANSWER');
    assert.deepEqual(await js<string[]>(cdp, `${all('conv-question')}.map((e) => e.textContent)`), ['why is issue 12 stuck?', 'and what next?'], 'one thread, in order');
    await until('the sidebar titled from the first question', () => js<boolean>(cdp, `${all('conv-title')}.some((e) => e.textContent === 'why is issue 12 stuck?')`), 20_000);

    // A Project: a writer gets no share box.
    await pressSteady(cdp, q('project-new'), 'project-new');
    await until('the project editor', () => js<boolean>(cdp, `!!${q('project-editor')}`), 20_000);
    assert.equal(await js<boolean>(cdp, `!!${q('project-shared')}`), false, 'no share box for a writer');
    await type(cdp, 'project-name', 'Pricing');
    await type(cdp, 'project-instructions', 'Answer in bullet points.');
    await pressSteady(cdp, q('project-save'), 'project-save');
    await until('the project in the sidebar', () => js<boolean>(cdp, `${all('project-row')}.some((e) => e.textContent.includes('Pricing'))`), 20_000);

    // Delete the conversation: asked first, then gone for good.
    await pressSteady(cdp, `${q('conv-row')}.querySelector('[data-testid="conv-delete"]')`, 'conv-delete');
    await until('the confirm', () => js<boolean>(cdp, `!!${q('conv-delete-confirm')}`), 20_000);
    await pressSteady(cdp, q('conv-delete-confirm'), 'conv-delete-confirm');
    await until('the sidebar empty again', () => js<boolean>(cdp, `!!${q('conv-empty')}`), 20_000);
    assert.equal(readConversation(stateDir, id), null, 'deleted on the server');
  } finally {
    await b.close();
    await d.close();
  }
});
