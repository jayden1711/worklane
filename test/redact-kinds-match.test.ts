// #996: the attachment secret check (secretKinds) and redaction (redactString) are one matcher, and three more shapes.
// 1. secretKinds read each pattern on the raw text only: a secret redaction hides from a glue point (a token after a
//    terminal escape, a backslash escape or `_`) gave no kind, so an attachment holding it was stored unrefused. It
//    now runs the default mode's own passes and names the rule of every span, so it can't find less than redaction.
// 2. A bearer token with JSON-escaped slashes (`\/`) was only partly hidden.
// 3. A password in a single-quoted dictionary literal (Python) was shown, in both modes.
// 4. A JWT in standard base64 (`+`, `/`) or with `=` padding was shown.
// Every fixture is assembled at run time; the exact inputs of the review are held privately (#707).
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { redactCut, redactString, secretKinds } from '../src/events/redact.js';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { leaks, run, SHAPES } from './token-standins.js';

const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };
const broad = { broad: true } as Parameters<typeof redactString>[1];
/** Each path the secret must be gone from, by name; and whether secretKinds names `kind`. */
function shown(s: string, secret: string, kind: string): string[] {
  const out: string[] = [];
  for (const [path, r] of [['default', redactString(s)], ['broad', redactString(s, broad)], ['redactCut', redactCut(s, 100_000)], ['updater', updater.redact(s)]] as const) {
    if (leaks(r, secret)) out.push(`${path}: ${JSON.stringify(s.slice(0, 48))}`);
  }
  if (!secretKinds(s).includes(kind)) out.push(`secretKinds: ${JSON.stringify(s.slice(0, 48))} gave ${JSON.stringify(secretKinds(s))}`);
  return out;
}

/** What may sit right before a token (the glue points): escape sequences in each encoding, backslash escapes, `_`. */
const ESC = String.fromCharCode(27);
const GLUES = [`${ESC}[1m`, `${ESC}[0;32m`, '\\u001b[1m', '\\x1b[0m', '\\033[31m', '\\e[1m', '^[[1m', `${String.fromCharCode(0x9b)}1m`, '\\n', '\\t', '\\"', '\\\\', 'MY_', 'x_'];

test('a secret glued after an escape sequence, a backslash escape or `_` is named by secretKinds, as redaction hides it', () => {
  const missed: string[] = [];
  const tok = run(40, 'zY8xW7vU6');
  const glued: [string, string, string][] = [
    ['bearer token', `Bearer ${tok}`, tok],
    ['Stripe key', `${'sk'}_live_${run(24)}`, run(24)],
    ['32-byte hex key', `0x${'7e9b5d3c1f0a2468'.repeat(4)}`, '7e9b5d3c1f0a2468'.repeat(4)],
    ['API key (sk-)', `${'sk'}-proj-${run(48)}`, run(48)],
  ];
  // A value with JSON-escaped slashes: no glue point may split it, so each part is hidden from every glue point.
  const parts = [run(12, 'aB3cD4eF5'), run(12, 'gH6iJ7kL8'), run(12, 'mN9oP0qR1')];
  const basic = Buffer.from(`deploy:${run(20)}???abc???xyz`).toString('base64');
  assert.ok(basic.split('/').length >= 3, 'the Basic value holds two slashes');
  for (const p of parts) glued.push(['bearer token', `Bearer ${parts.join('\\/')}`, p]);
  for (const p of basic.split('/')) glued.push(['Basic credential', `Basic ${basic.split('/').join('\\/')}`, p]);
  for (const g of GLUES) for (const [kind, value, secret] of glued) missed.push(...shown(`log ${g}${value} end`, secret, kind));
  // A credential after a newline in raw JSON text: the escape is glued to it.
  missed.push(...shown(`{"detail":"retry\\nBearer ${tok}"}`, tok, 'bearer token'));
  assert.deepEqual(missed, []);
});

test('a bearer token (and a Basic value) with JSON-escaped slashes is hidden whole', () => {
  const parts = [run(12, 'aB3cD4eF5'), run(12, 'gH6iJ7kL8'), run(12, 'mN9oP0qR1')];
  const missed: string[] = [];
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const v = parts.join('\\/');
    for (const s of [`{"Authorization":"${scheme} ${v}"}`, `${scheme} ${v}`, `${scheme} \\/${v}==`]) for (const p of parts) missed.push(...shown(s, p, 'bearer token'));
  }
  const basic = Buffer.from(`deploy:${run(20)}???abc`).toString('base64');
  assert.ok(basic.includes('/'), 'the Basic value holds a slash');
  const escaped = basic.split('/').join('\\/');
  for (const p of basic.split('/')) missed.push(...shown(`{"h":"Basic ${escaped}"}`, p.slice(-10), 'Basic credential'));
  assert.deepEqual(missed, []);
});

test("a credential in a single-quoted dictionary literal is hidden in both modes; other keys and values stay", () => {
  const v = run(24, 'notArealValue7');
  const missed: string[] = [];
  for (const s of [`{'password': '${v}'}`, `cfg = {'id': 3, 'api_key': '${v}', 'n': 1}`, `{'db_password':'${v}'}`, `{'token' => '${v}'}`, `['client_secret' => '${v}']`, `{"token": '${v}'}`, `{'token': "${v}"}`]) {
    missed.push(...shown(s, v, 'secret under a JSON key'));
  }
  assert.deepEqual(missed, []);
  // The key keeps its quotes and the rest of the literal stays.
  assert.equal(redactString(`{'id': 3, 'password': '${v}'}`), "{'id': 3, 'password': '[REDACTED]'}");
  assert.equal(redactString(`{'token' => "${v}"}`), `{'token' => "[REDACTED]"}`);
  // Not a credential: a plain key, or a value that isn't credential-shaped.
  for (const s of [`{'cacheKey': '${v}'}`, `{'sort_key': '${v}'}`, "{'key': 'issue-644-redactor'}", "{'token': 'intake.triaged.v2'}", "{'password': None}", "it's a 'password': 'short'"]) {
    assert.equal(redactString(s), s, s);
    assert.deepEqual(secretKinds(s), [], s);
  }
});

test('a JWT in standard base64 or with padding is hidden whole', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
  const header = b64({ alg: 'HS256', x: '>>>???' });
  const payload = b64({ sub: '>>>???fake' });
  assert.ok(/[+/]/.test(header) && header.endsWith('=') && payload.endsWith('='), 'standard base64 with padding');
  const sig = `${run(20)}+${run(10)}/${run(11)}=`;
  const url = (s: string) => s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const missed: string[] = [];
  for (const jwt of [`${header}.${payload}.${sig}`, `${url(header)}.${url(payload)}.${sig}`, `${header}.${payload}.`, `${header}.${payload}.${url(sig)}.${run(12)}`]) {
    for (const s of [jwt, `token=${jwt}&x=1`, `Cookie: s=${jwt}; Path=/`, `GET /api/${jwt} 200`, `x.${jwt}`]) {
      for (const p of jwt.split('.').filter(Boolean)) missed.push(...shown(s, p, 'JWT'));
    }
  }
  assert.deepEqual(missed, []);
  // What a JWT is not: a path, prose and base64 with no JSON header.
  for (const s of ['eyJ is how base64 JSON starts.', 'see src/eyJ/a.b and docs/x.y', `${b64({ a: 1 }).slice(3)}.${run(12)}.${run(12)}`]) assert.deepEqual(secretKinds(s), [], s);
});

/** Every input of this corpus, for the property test: the stand-ins in many settings, and seeded random compositions. */
function corpus(): string[] {
  const out: string[] = [];
  const settings = (v: string) => [v, `deploy failed: ${v} (exit 1)`, `TOKEN=${v}`, JSON.stringify({ detail: v }), JSON.stringify(JSON.stringify({ detail: v })), ...GLUES.map((g) => `x${g}${v}`), `${v}${ESC}[0m`, `"${v}"`];
  for (const s of SHAPES) out.push(...settings(s.value), ...settings(s.secret));
  const pieces = [
    ...GLUES, ' ', '\n', '"', "'", ':', ': ', '=', '.', '/', '\\/', '_', '-', '+', 'x', '{', '}', '==',
    'Bearer ', 'Basic ', 'token', 'password', 'api_key', 'cacheKey', 'eyJ', `${'sk'}_live_`, 'sk-', '0x', 'https://', 'u:', '@h/', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----',
    run(8), run(20), run(40, 'zY8xW7vU6'), '7e9b5d3c1f0a2468'.repeat(4), ...SHAPES.map((s) => s.value),
  ];
  let seed = 996;
  const rnd = (k: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % k;
  };
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let n = 2 + rnd(8); n > 0; n--) s += pieces[rnd(pieces.length)];
    out.push(s);
  }
  return out;
}

test('whenever redaction changes a text, secretKinds names a kind: the stand-ins in many settings and random compositions', () => {
  const missed: string[] = [];
  let changed = 0;
  for (const s of corpus()) {
    if (redactString(s) === s) continue;
    changed++;
    if (secretKinds(s).length === 0 && missed.length < 20) missed.push(JSON.stringify(s.slice(0, 80)));
  }
  assert.ok(changed > 1000, `the corpus exercises redaction (${changed} changed)`);
  assert.deepEqual(missed, []);
});
