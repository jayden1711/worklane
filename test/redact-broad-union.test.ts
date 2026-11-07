// #889 round 3 (the round-2 final check's regression finding): the broad mode hides at least what each module's own
// rules hid on main. The root updater's redact(), gh-login's safeLine and the bench's scrub had their own token rules
// (kept here verbatim, as fixtures, from origin/main 41f6dd42); each now goes through the shared redactor's broad mode,
// which masks the union of what every rule finds on the text as it was. On generated input, every secret one of the
// old rules hid stays hidden, and so do the three classes the check found (user info after `-`, `.` or `+`; a bearer
// value that starts JWT-shaped and goes on; one rule's marker eating the next rule's text).
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { redactString } from '../src/events/redact.js';
import { safeLine } from '../src/gh-login.js';
import { scrub as benchScrub } from '../scripts/bench/cli.js';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';

const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };

/** The root updater's redact() on main. */
const oldUpdater = (text: string) =>
  String(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '[redacted]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
/** gh-login's TOKENISH on main. */
const oldGhLogin = (line: string) => line.replace(/\b(gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[hidden]');
/** The bench's token and email rules on main, then its control characters. */
const oldBench = (text: string) =>
  text
    .replace(/sk-ant-[\w-]+|\bgh[opsur]_\w{16,}|\bgithub_pat_\w{16,}|\bxox[abprs]-[\w-]+|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ');

/** A small seeded generator, so a failure names an input that can be run again. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ESC = '\u001b';
// A key's BEGIN and END lines, put together at run time so no key-shaped literal is committed.
const KEY_BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const KEY_END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** One generated input and the secrets in it: the random parts a rule exists to hide. */
function generate(r: () => number): { text: string; secrets: string[] } {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const word = (n: number, chars = ALNUM) => Array.from({ length: n }, () => pick([...chars])).join('');
  const secrets: string[] = [];
  const secret = (n: number, chars = ALNUM) => {
    const s = word(n, chars);
    secrets.push(s);
    return s;
  };
  const jwt = () => `eyJ${secret(12)}.${secret(14)}.${secret(16)}`;
  const segments: (() => string)[] = [
    () => `${pick(['ghp', 'gho', 'ghu', 'ghs', 'ghr'])}_${secret(8 + Math.floor(r() * 32))}`,
    () => `github_pat_${secret(10)}_${secret(10 + Math.floor(r() * 50))}`,
    () => `sk-ant-${pick(['', 'api03-', 'oat01-'])}${secret(8 + Math.floor(r() * 40))}`,
    () => `${pick(['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs'])}-${secret(4 + Math.floor(r() * 30))}`,
    () => `${pick(['Bearer', 'bearer', 'BEARER'])} ${secret(8 + Math.floor(r() * 30), `${ALNUM}._~+/-`)}`,
    () => `${pick(['Bearer', 'bearer'])} ${jwt()}`,
    () => `Bearer ${jwt()}.${secret(20)}.${secret(16)}`,
    () => `Bearer ${jwt()}${pick(['+/', '==', '.x'])}${secret(12)}`,
    () => `${pick(['https', 'git+https', 'ssh', 'http'])}://${pick(['', `${word(5)}:`])}${secret(10 + Math.floor(r() * 20))}@${pick(['github.com', 'git.example.test'])}/o/r.git`,
    () => `${pick(['token', 'GH_TOKEN', 'api_key', 'apikey', 'secret', 'password', 'db_password', 'x-api-key', 'passwd'])}${pick(['=', ': ', ':', ' = '])}${pick(['', '"', "'"])}${secret(8 + Math.floor(r() * 20))}`,
    () => jwt(),
    () => `${KEY_BEGIN}\n${secret(64)}\n${KEY_END}`,
  ];
  const joiners = ['', ' ', '-', '.', '+', '_', '/', ':', '=', '"', ', ', '\n', `${ESC}[1m`, '\\n', ' -', ' +', ' .'];
  const heads = ['', 'error: ', 'x', 'apikey', 'see ', 'clone failed: '];
  let text = pick(heads);
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) text += (i ? pick(joiners) : '') + pick(segments)();
  return { text: text + pick(['', ' tail', '\n', '"']), secrets };
}

/** How many inputs per module, and a seed offset: fixed in CI; a longer run sets REDACT_FUZZ_N and REDACT_FUZZ_SEED. */
const N = Number(process.env.REDACT_FUZZ_N) || 6000;
const SEED = Number(process.env.REDACT_FUZZ_SEED) || 0;

/** The inputs where the new output shows a secret the old one hid, at most `max` of them. */
function narrowings(old: (t: string) => string, now: (t: string) => string, seed: number, n: number, max = 10): string[] {
  const r = rng(seed);
  const found: string[] = [];
  for (let i = 0; i < n && found.length < max; i++) {
    const { text, secrets } = generate(r);
    const a = old(text);
    const b = now(text);
    for (const s of secrets) if (!a.includes(s) && b.includes(s)) found.push(`${JSON.stringify(text)} -> ${JSON.stringify(b)}`);
  }
  return found;
}

test("the root updater: on generated input, every secret main's five rules hid is still hidden", () => {
  assert.deepEqual(narrowings(oldUpdater, (t) => updater.redact(t), SEED + 889, N), []);
});

test("gh-login: on generated input, every secret main's rule hid is still hidden", () => {
  assert.deepEqual(narrowings(oldGhLogin, (t) => redactString(t, { broad: true, mask: '[hidden]' } as Parameters<typeof redactString>[1]), SEED + 921, N), []);
  // safeLine itself: one line, cut to 200 characters.
  const r = rng(SEED + 7);
  const found: string[] = [];
  for (let i = 0; i < N / 2; i++) {
    const { text, secrets } = generate(r);
    const line = text.replace(/\n/g, ' ');
    // Hidden by the old rule (not only cut off by the 200-character cut), and shown now.
    for (const s of secrets) if (!oldGhLogin(line).includes(s) && safeLine(line).includes(s)) found.push(line);
  }
  assert.deepEqual(found.slice(0, 10), []);
});

test("the bench: on generated input, every secret main's rules hid is still hidden", () => {
  assert.deepEqual(narrowings(oldBench, (t) => benchScrub(t, {}, 1_000_000), SEED + 1729, N), []);
});

/** The final check's fragment fuzz: secrets and pieces of token shapes, joined at random; none shown more often now. */
const SECRETS = ['Q1w2E3r4', 'Z9y8X7w6V5u4', 'Mn3Bv4Cx5Zl6Kj7H', 'pL0oK9iJ8uH7yG6tF5rD4eS3'];
const REAL = [`${'ghp'}_${SECRETS[3]}Mn3Bv4Cx5Zl6`, `github_pat_11${SECRETS[3]}_Mn3Bv4Cx5Zl6Kj7H`, `${'sk'}-ant-api03-${SECRETS[3]}`, `${'xoxb'}-123456789012-${SECRETS[3]}`, `${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxIn0.${SECRETS[3]}`, `${'AKIA'}Q7RZ4KX2M9TBQ7RZ`, `tskey-auth-k${SECRETS[3]}`, `wld_${SECRETS[3]}Mn3Bv4Cx5Z`];
const PIECES: readonly (readonly string[])[] = [
  [...REAL, '.', 'bearer ', 'Bearer ', 'https://', 'git+https://', '@', ':', '=', ' ', ' ', '-', '+', '_', 'token', 'TOKEN', 'Password', 'secret', 'api_key', '"', "'", '/', '\n', `${KEY_BEGIN}\n`, `\n${KEY_END}`, 'x', ',', 'Authorization: ', 'fatal: ', `${ESC}[1m`, '\\n'],
  ['ghp_', 'gho_', 'github_pat_', 'sk-ant-', 'xoxb-', 'xoxp-', 'eyJ', '.', 'bearer ', 'Bearer ', 'BEARER ', 'https://', 'git+ssh://', '@', ':', '=', ' ', ' ', '-', '+', '_', 'token', 'TOKEN', 'Password', 'secret', 'api_key', 'apikey', '"', "'", '/', '\n', KEY_BEGIN, KEY_END, 'AKIA', 'wld_', 'tskey-', '0x', 'x', ',', `${ESC}[1m`, '\\n', 'Basic '],
];

test("the final check's fragment fuzz: no module shows a secret more often than its own rules on main did", () => {
  const r = rng(SEED + 2463);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const mods: [string, (t: string) => string, (t: string) => string][] = [
    ['updater', oldUpdater, (t) => updater.redact(t)],
    ['gh-login', oldGhLogin, (t) => redactString(t, { broad: true, mask: '[hidden]' } as Parameters<typeof redactString>[1])],
    ['bench', oldBench, (t) => benchScrub(t, {}, 1_000_000)],
  ];
  const found: string[] = [];
  for (let i = 0; i < N * 2 && found.length < 10; i++) {
    const pieces = pick(PIECES);
    let s = '';
    for (let j = 0, k = 2 + Math.floor(r() * 6); j < k; j++) s += r() < 1 / 3 ? pick(SECRETS) : pick(pieces);
    for (const [who, old, now] of mods) {
      const a = old(s);
      const b = now(s);
      for (const x of SECRETS) if (b.split(x).length > a.split(x).length) found.push(`${who}: ${JSON.stringify(s)} -> ${JSON.stringify(b)}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the three classes the final check found, each hidden by the updater, gh-login and the bench', () => {
  const tok = `${'ghp'}_${'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa'}`;
  const jwt = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiJmYWtlIn0'}.${'c2lnbmF0dXJlMTIz'}`;
  const tail = 'Q2lwaGVydGV4dEFuZFRhZw';
  const s = 'PrivSecretValue9876';
  const cases: [string, string][] = [
    [`error: -https://${tok}@github.com/o/r.git`, tok],
    [`x +git+https://${tok}@github.com/o/r.git`, tok],
    [`see .https://${tok}@github.com`, tok],
    [`Authorization: Bearer ${jwt}.${tail}.${tail}`, tail],
    [`Bearer ${jwt}.${tail}`, tail],
    [`Bearer ${jwt}+/${tail}==`, tail],
    [`xoxb-Bearer ${s}`, s],
    [`apikeysk-ant-secret:${s}`, s],
    [`sk-ant-BEARER ${s}`, s],
  ];
  const missed: string[] = [];
  for (const [text, secret] of cases) {
    for (const [who, out] of [['updater', updater.redact(text)], ['broad', redactString(text, { broad: true } as Parameters<typeof redactString>[1])], ['bench', benchScrub(text, {})]] as const) {
      if (out.includes(secret)) missed.push(`${who}: ${out}`);
    }
  }
  assert.deepEqual(missed, []);
});
