// #889 round 3 (the second adversarial review): the redactor fails closed on what it found glued or cut.
// - A token right after an ANSI escape (a coloured log line) or a JSON escape (`\n` in raw JSON) is found, on every path.
// - A private key with no END is redacted to the end of the text, one with no BEGIN from the start; PGP's key block too.
// - HTTP Basic credentials are redacted; a dashboard key after `-` or a letter, and `ghp_..._suffix`, are found.
// - The sites that cut text redact it first; doctor checks the hub's dashboard key too.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as redactModule from '../src/events/redact.js';
import { redactString } from '../src/events/redact.js';
import { readServiceLog } from '../src/dashboard.js';
import { safeLine } from '../src/gh-login.js';
import { scrub as benchScrub } from '../scripts/bench/cli.js';
import { prSections } from '../src/decision-detail.js';
import { attachmentPrompt, ATTACHMENT_DEFAULT_CAPS, storeUpload, INLINE_PER_FILE } from '../src/chat-attachments.js';
import * as doctorModule from '../src/doctor.js';
import { stateDir } from '../src/os/index.js';
import { BRAND } from '../src/brand.js';
import { exampleProject, repoRoot } from './helpers.js';
import { leaks, run, SHAPES } from './token-standins.js';

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };
const records = (t: string) => (typeof redactModule.redactRecords === 'function' ? redactModule.redactRecords(t.split('\n')).join('\n') : 'no redactRecords');
const journalView = (msgs: string[]) => {
  const journal = () => ({ status: 0, stderr: '', stdout: msgs.map((m, i) => JSON.stringify({ MESSAGE: m, PRIORITY: '6', __REALTIME_TIMESTAMP: String(1_767_225_600_000_000 + i) })).join('\n') });
  return JSON.stringify(readServiceLog({ unit: 'coordinator.service', file: null }, 200, journal).entries);
};
const fileView = (text: string) => {
  const file = join(scratch('svc-log-'), 'c.log');
  writeFileSync(file, `${text}\n`);
  return JSON.stringify(readServiceLog({ unit: null, file }, 200).entries);
};
/** Every path a line can take: the shared redactor's modes, the dashboard's views and the three modules that use it. */
const PATHS: [string, (t: string) => string][] = [
  ['redactString', (t) => redactString(t)],
  ['redactString broad', (t) => redactString(t, { broad: true } as Parameters<typeof redactString>[1])],
  ['redactRecords', records],
  ['journal view', (t) => journalView(t.split('\n'))],
  ['file view', fileView],
  ['gh-login', (t) => t.split('\n').map((l) => safeLine(l)).join('\n')],
  ['bench', (t) => benchScrub(t, {}, 100_000)],
  ['updater', (t) => updater.redact(t)],
];
const ESC = '\u001b';
const BS = '\\';

test('a token right after an ANSI colour code or a JSON escape is found, every token shape on every path', () => {
  const missed: string[] = [];
  const wraps: [string, (v: string) => string][] = [
    ['ANSI bold', (v) => `${ESC}[1m${v}${ESC}[0m`],
    ['ANSI colour after text', (v) => `error: ${ESC}[31;1m${v}${ESC}[0m failed`],
    ['JSON \\n', (v) => `{"log":"first line${BS}n${v}"}`],
    ['JSON \\t', (v) => `"a${BS}t${v}"`],
    ['JSON \\"', (v) => `"say ${BS}"${v}${BS}""`],
  ];
  for (const s of SHAPES.filter((x) => x.token && !x.value.includes('\n'))) {
    for (const [how, wrap] of wraps) {
      for (const [path, out] of PATHS) {
        if (path === 'gh-login' && !s.kind.startsWith('GitHub')) continue;
        if (leaks(out(wrap(s.value)), s.secret)) missed.push(`${s.what}, ${how}, via ${path}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  // Ordinary coloured lines and JSON text are left as they were.
  for (const s of [`${ESC}[32mok${ESC}[0m: 3 passed`, `{"msg":"line one${BS}nline two${BS}tdone"}`, 'C:\\Users\\example\\notes.txt']) assert.equal(redactString(s), s);
});

/** A 4096-bit-sized key: 50 body lines between its BEGIN and END lines. */
const BODY = Array.from({ length: 50 }, (_, i) => run(64, `K${i}eyBody${i}x9`));
const begin = (t = 'RSA') => `-----BEGIN ${t} PRIVATE KEY-----`;
const end = (t = 'RSA') => `-----END ${t} PRIVATE KEY-----`;
const bodyLeaks = (out: string) => BODY.filter((b) => leaks(out, b)).length;

test('a private key with no END line (cut short, or still being written) is redacted to the end, on every path', () => {
  const missed: string[] = [];
  const text = ['starting', begin(), ...BODY.slice(0, 20)].join('\n');
  for (const [path, out] of PATHS) if (path !== 'gh-login' && bodyLeaks(out(text))) missed.push(`${path}: ${bodyLeaks(out(text))} body lines shown`);
  assert.deepEqual(missed, []);
  assert.match(redactString(text), /^starting\n\[REDACTED PRIVATE KEY\]$/);
});

test('a private key whose BEGIN is above the window (an END with no BEGIN) is redacted from the start, on every path', () => {
  const missed: string[] = [];
  // The updater's journal tail: `journalctl -n 30` of a service that logged a 50-line key; and the dashboard's views.
  const tail = [...BODY.slice(-28), end(), 'service started'].join('\n');
  for (const [path, out] of PATHS) if (path !== 'gh-login' && bodyLeaks(out(tail))) missed.push(`${path}: ${bodyLeaks(out(tail))} body lines shown`);
  assert.deepEqual(missed, []);
  assert.match(redactString(tail), /^\[REDACTED PRIVATE KEY\]\nservice started$/);
});

test("PGP's private key block, and an OpenSSH or encrypted PEM key, are redacted", () => {
  for (const type of ['PGP', 'OPENSSH', 'ENCRYPTED']) {
    const pgp = type === 'PGP';
    const key = [`-----BEGIN ${type} PRIVATE KEY${pgp ? ' BLOCK' : ''}-----`, ...BODY.slice(0, 5), `-----END ${type} PRIVATE KEY${pgp ? ' BLOCK' : ''}-----`].join('\n');
    for (const [path, out] of PATHS) if (path !== 'gh-login') assert.equal(bodyLeaks(out(`key: ${key} done`)), 0, `${type} via ${path}`);
  }
});

test('HTTP Basic credentials are redacted, plain and as a JSON header; prose after "Basic" is not', () => {
  const cred = Buffer.from(`x-access-token:${'ghs'}_${run(36)}`).toString('base64');
  const missed: string[] = [];
  for (const line of [`Authorization: Basic ${cred}`, `{"headers":{"Authorization":"Basic ${cred}"}}`, `git -c http.extraheader="AUTHORIZATION: basic ${cred}" fetch`]) {
    for (const [path, out] of PATHS) if (path !== 'gh-login' && leaks(out(line), cred)) missed.push(`${line.slice(0, 20)}… via ${path}`);
  }
  assert.deepEqual(missed, []);
  for (const s of ['Basic Authentication is off', 'basic configuration only', 'BASIC usage']) assert.equal(redactString(s), s);
});

test('a dashboard key after a hyphen or a letter, and a GitHub token followed by `_`, are found by default', () => {
  const key = `wld_${run(32, 'Dk7-qP_2')}`;
  for (const s of [`dashboard-key-${key}`, `token${key}`, `key=${key}`]) assert.ok(!leaks(redactString(s), key), s);
  const gh = `${'ghp'}_${run(36)}`;
  assert.ok(!leaks(redactString(`${gh}_backup`), gh), 'ghp_..._backup');
  for (const s of [`xox${'b'}-${run(24)}_x`, `${'lin'}_api_${run(40)}_x`, `AKIA${'Q7RZ4KX2M9TBQ7RZ'}_x`]) assert.ok(!leaks(redactString(s), s.slice(0, -2)), s);
});

test('text cut to a size is redacted before the cut: a PR section, and a chat attachment', async () => {
  const gh = `${'ghp'}_${run(36)}`;
  // A token across the PR section's 20,000-character cut: its first 20 characters inside.
  const body = `## Fail-without\n${'x'.repeat(20_000 - 21)} ${gh} tail\n\n## Next\n`;
  const section = prSections(body).failWithout!;
  assert.ok(!section.includes(gh.slice(0, 20)), 'no piece of the token is kept');
  // An attachment cut at INLINE_PER_FILE, a token across the cut.
  const s = scratch('attach-');
  async function* once(b: string) {
    yield Buffer.from(b);
  }
  const m = await storeUpload({ stateDir: s, name: 'log.txt', body: once(`${'y'.repeat(INLINE_PER_FILE - 21)} ${gh} tail`), caps: { ...ATTACHMENT_DEFAULT_CAPS }, by: 'example-collaborator', gitleaks: null, anyway: true });
  const prompt = attachmentPrompt(s, [m.id], scratch('bundle-')).text;
  assert.ok(!prompt.includes(gh.slice(0, 20)), 'no piece of the token is kept');
});

test("doctor checks the hub's dashboard key too", () => {
  const hub = join(stateDir(), 'dashboard-hub');
  mkdirSync(hub, { recursive: true });
  const old = run(32, 'Hb9OldKey_-');
  writeFileSync(join(hub, 'dashboard-token'), old, { mode: 0o600 });
  const { dir: root } = exampleProject();
  const all = doctorModule.doctor(root);
  assert.equal(all.find((c) => c.name === 'dashboard key hub')?.level, 'warn');
  assert.ok(!JSON.stringify(all).includes(old), 'the key is never shown');
});

test('the glue pass and the fail-closed key rules run in linear time on hostile input', () => {
  const N = 100_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length));
  const slow: string[] = [];
  for (const s of [fill(`${ESC}[1m`), fill(`${BS}n`), fill(`${BS}u12`), fill(`${ESC}[`), fill(`${ESC}[1;`), fill(begin()), fill(end()), fill('-----BEGIN '), fill('-----END '), fill('Basic '), fill('Basic aaaaaaaa'), fill('wld_'), fill(`${BS}nghp_`)]) {
    for (const [what, f] of [['default', (t: string) => redactString(t)], ['broad', (t: string) => redactString(t, { broad: true } as Parameters<typeof redactString>[1])]] as const) {
      const t0 = performance.now();
      f(s);
      const ms = performance.now() - t0;
      if (ms > 2000) slow.push(`${what} on ${JSON.stringify(s.slice(0, 10))}…: ${Math.round(ms)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});
