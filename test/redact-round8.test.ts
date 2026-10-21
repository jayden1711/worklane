// #889 round 8 (the round-7 second review): four places the shared redactor showed what it should hide.
// 1. A URL password after a scheme longer than 32 characters whose last 32 hold no letter: main's rule took a scheme
//    of any length; the bounded rule needed a letter within 32 characters of `://`.
// 2. The Tailscale login link glued after a token: the link was replaced after redaction, which had taken its `https`.
// 3. A short HTTP Basic value (base64 of a short `user:password`, no digit, `+`, `/` or `=`).
// 4. The helper tables the rules read (the glued prefixes, the glue sequences, the key words) carry never-shrink marks,
//    in the module and in the updater's copy, and a plain `sk-` key glued to a name is found.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString, secretKinds } from '../src/events/redact.js';
import { registrationsOf } from '../src/merge-policy-weakening.js';
import { readStepLines } from '../src/tailscale-setup.js';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { run } from './token-standins.js';

const updaterPath = join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`);
const updater = createRequire(import.meta.url)(updaterPath) as { redact(text: string): string };
const broad = { broad: true } as Parameters<typeof redactString>[1];

test('a URL password after a long scheme whose last 32 characters hold no letter is hidden: default, broad, the updater, secretKinds', () => {
  const pw = run(18, 'Pw9xSeCrEt77');
  const cases = [`x${'1'.repeat(40)}://deploy:${pw}@db.example.com/x`, `git${'-'.repeat(33)}://deploy:${pw}@db.example.com/x`, `svn+${'.'.repeat(32)}+0://u:${pw}@h/`];
  const shown: string[] = [];
  for (const s of cases) {
    for (const [path, out] of [['default', redactString(s)], ['broad', redactString(s, broad)], ['updater', updater.redact(s)]] as const) {
      if (out.includes(pw)) shown.push(`${path}: ${s.slice(0, 40)}`);
    }
    if (!secretKinds(s).includes('password in a URL')) shown.push(`secretKinds: ${s.slice(0, 40)}`);
  }
  assert.deepEqual(shown, []);
});

test('the Tailscale login link glued after a token is still replaced, and the token redacted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-steps-'));
  const link = `https://login.tailscale.com/a/${'1a2b3c4d5e6f'}`;
  const tokens = [`${'tskey'}-auth-${run(30, 'kAbc1DEF2CNT')}`, `${'ghp'}_${run(36)}`, `${'wld'}_${run(32, 'kQ9zX7mP2vAB')}`];
  const at = new Date().toISOString();
  writeFileSync(join(dir, 'steps.jsonl'), `${tokens.map((t) => JSON.stringify({ at, step: 'up', state: 'waiting', detail: `open ${t}${link} now` })).join('\n')}\n`);
  const lines = readStepLines(dir);
  assert.equal(lines.length, tokens.length);
  for (const l of lines) {
    assert.ok(!l.detail.includes('login.tailscale.com'), `the link is shown: ${l.detail}`);
    assert.ok(!l.detail.includes('1a2b3c4d5e6f'), `the link's id is shown: ${l.detail}`);
    assert.ok(l.detail.includes('[the login link]'), l.detail);
  }
  for (const t of tokens) assert.ok(!JSON.stringify(lines).includes(t.slice(-16)), 'the token is redacted');
});

test('a short Basic value (a short user:password) is hidden on every path; Basic prose is left as it was', () => {
  const pairs = [['user', 'pass'], ['admin', 'hunter'], ['bot', 'Secretpw'], ['deploy', 'abcdefghijk']].map(([u, p]) => Buffer.from(`${u}:${p}`).toString('base64'));
  const shown: string[] = [];
  for (const v of pairs) {
    const s = `Authorization: Basic ${v}`;
    for (const [path, out] of [['default', redactString(s)], ['broad', redactString(s, broad)], ['updater', updater.redact(s)]] as const) {
      if (out.includes(v)) shown.push(`${path}: ${v}`);
    }
  }
  assert.deepEqual(shown, []);
  for (const prose of ['Use Basic Authentication here.', 'basic authentication', 'Basic Authorization header', 'the basic credentials flow']) assert.equal(redactString(prose), prose);
});

test('the helper tables carry never-shrink marks in the module and the updater copy; a plain sk- key glued to a name is found', () => {
  const want = ['GLUED_PREFIXES', 'GLUE_PARTS', 'KEY_QUALIFIERS', 'CREDENTIAL_ENDINGS'];
  for (const file of [join(repoRoot, 'src', 'events', 'redact.ts'), updaterPath]) {
    const marked = registrationsOf(readFileSync(file, 'utf8'))
      .tables.filter((t) => t.kind === 'never-shrink')
      .map((t) => t.table);
    assert.deepEqual(
      want.filter((n) => !marked.includes(n)),
      [],
      file,
    );
  }
  const key = `${'sk'}-proj-${run(48)}`;
  for (const s of [`OPENAI_KEY_${key}`, `x_${key}`]) assert.ok(!redactString(s).includes(key.slice(-20)), s);
});
