// Issue #864: a dashboard 500 never carries a raw error message, an absolute path or a file name under the state dir.
// The request handler's outer catch answers every error it doesn't know with one fixed text and logs the detail on
// the machine only; the messages the dashboard means to show (src/user-facing-error.ts) still reach the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { CREDENTIAL_REFUSED } from '../src/claude-credential-guard.js';
import { errorAnswer, INTERNAL_ERROR_TEXT, startDashboard } from '../src/dashboard.js';
import { UserFacingError, userFacing } from '../src/user-facing-error.js';
import { exampleProject, exampleRoles } from './helpers.js';

const posix = process.platform !== 'win32';
/** The one text a 500 the dashboard didn't mean carries. */
const INTERNAL = /^the dashboard hit an internal error; the detail is in its log on the machine$/;

async function dashboard() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-500-'));
  const { dir: root } = exampleProject();
  const stateDir = join(dir, 'state');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const send = async (method: string, path: string, body?: string) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { d, dir, stateDir, views: join(stateDir, 'dashboard-views.json'), send };
}

/** console.error's lines while `f` runs: where the dashboard logs a 500's detail. */
async function logged<T>(f: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { result: await f(), lines };
  } finally {
    console.error = was;
  }
}

/** A 500 the dashboard didn't mean: the fixed text alone, nothing of the error, the file or where it is. */
function assertOpaque(r: { status: number; text: string; body: Record<string, unknown> }, dir: string, why: string): void {
  assert.equal(r.status, 500, `${why}: ${r.text}`);
  assert.deepEqual(Object.keys(r.body), ['error'], why);
  assert.match(String(r.body.error), INTERNAL, why);
  for (const leak of [dir, tmpdir(), 'dashboard-views', 'ENOENT', 'EACCES', 'EISDIR', 'open ', '/']) assert.ok(!r.text.includes(leak), `${why}: ${JSON.stringify(leak)} in ${r.text}`);
}

test('#864: a route whose handler throws ENOENT naming a path under the state dir answers 500 with one fixed text; the detail is logged on the machine', { skip: !posix && 'symlinks' }, async () => {
  const s = await dashboard();
  try {
    // The views file is a link into a directory that doesn't exist: writeFileSync throws ENOENT with the full path.
    symlinkSync(join(s.dir, 'gone', 'views.json'), s.views);
    const { result: r, lines } = await logged(() => s.send('PUT', '/api/views?probe=query-marker', JSON.stringify([{ name: 'v' }])));
    assertOpaque(r, s.dir, 'ENOENT');
    assert.ok(lines.some((l) => l.includes('ENOENT') && l.includes(s.views)), `the detail is logged server-side: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes('PUT /api/views')), 'the log names the route');
    assert.ok(!lines.some((l) => l.includes('query-marker')), 'never the query, which can hold a key');
  } finally {
    await s.d.close();
  }
});

test('#864: EISDIR naming the path (the views file is a directory) answers the same fixed 500', async () => {
  const s = await dashboard();
  try {
    mkdirSync(s.views, { recursive: true });
    const { result: r } = await logged(() => s.send('PUT', '/api/views', JSON.stringify([{ name: 'v' }])));
    assertOpaque(r, s.dir, 'EISDIR');
  } finally {
    await s.d.close();
  }
});

test('#864: EACCES naming the path (a mode-000 views file) answers the same fixed 500', { skip: (!posix || process.getuid?.() === 0) && 'root (or Windows) reads a mode-000 file' }, async () => {
  const s = await dashboard();
  try {
    writeFileSync(s.views, '[]');
    chmodSync(s.views, 0o000);
    const { result: r, lines } = await logged(() => s.send('GET', '/api/views'));
    assertOpaque(r, s.dir, 'EACCES');
    assert.ok(lines.some((l) => l.includes('EACCES')), 'the detail is logged server-side');
  } finally {
    chmodSync(s.views, 0o600);
    await s.d.close();
  }
});

test("#864: a parse error never quotes the file it read (JSON.parse's message holds the file's text)", async () => {
  const s = await dashboard();
  try {
    writeFileSync(s.views, 'not-json-file-text-marker');
    const { result: r } = await logged(() => s.send('GET', '/api/views'));
    assertOpaque(r, s.dir, 'SyntaxError');
    assert.ok(!r.text.includes('marker') && !/JSON/.test(r.text), r.text);
  } finally {
    await s.d.close();
  }
});

test("#864: errorAnswer: anything thrown that isn't a UserFacingError (a string, an object, a forgery) is the fixed 500; a log that throws changes nothing", () => {
  const path = '/srv/instance-home/policy.yaml';
  const forged = Object.assign(Object.create(UserFacingError.prototype) as object, { status: 400, message: path });
  for (const thrown of [new Error(`EACCES: permission denied, open '${path}'`), path, { status: 400, message: path }, forged, null, undefined]) {
    const lines: string[] = [];
    const a = errorAnswer(thrown, { method: 'GET' }, '/api/x', (l) => void lines.push(l));
    assert.deepEqual(a, { status: 500, body: { error: INTERNAL_ERROR_TEXT } }, String(thrown));
    assert.match(INTERNAL_ERROR_TEXT, INTERNAL);
    assert.equal(lines.length, 1, 'logged once');
  }
  const broken = errorAnswer(new Error(path), {}, '/api/x', () => {
    throw new Error('the log is gone');
  });
  assert.deepEqual(broken, { status: 500, body: { error: INTERNAL_ERROR_TEXT } });
  const meant = errorAnswer(userFacing(409, 'a vetted text'), { method: 'POST' }, '/api/x', () => assert.fail('a vetted answer is not an internal error'));
  assert.deepEqual(meant, { status: 409, body: { error: 'a vetted text' } });
});

test('#864: every message the dashboard means for the page still reaches it through the outer catch', async () => {
  const s = await dashboard();
  try {
    // readBody's size cap (every route that reads a body): 500, as before, with its text.
    const big = await s.send('PUT', '/api/views', JSON.stringify(['x'.repeat(70_000)]));
    assert.deepEqual([big.status, big.body], [500, { error: 'body too large' }]);
    // The Claude credential refusal (issue #711): 400 with its fixed text, never the value.
    const cred = await s.send('PUT', '/api/views', JSON.stringify([{ name: `sk-ant-oat01-${'A'.repeat(40)}` }]));
    assert.deepEqual([cred.status, cred.body], [400, { error: CREDENTIAL_REFUSED }]);
    // A body that isn't JSON: the requester's mistake, a fixed text that never quotes the body back.
    const bad = await s.send('PUT', '/api/views', 'not-json-body-marker');
    assert.deepEqual([bad.status, bad.body], [400, { error: "the request body isn't JSON" }]);
  } finally {
    await s.d.close();
  }
});
