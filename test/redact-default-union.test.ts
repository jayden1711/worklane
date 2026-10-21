// #889 round 6 (the round-3+4 delta check's regression finding): the default mode (redactString with no options: the
// event log, comments, the digest, the dashboard) hides at least what main's default mode hid. Each rule alone was the
// same or broader, but the rules applied one after another, and one rule's match ate the next rule's anchor
// (`wld_<key>-redis://u:<pw>@`, `<jwt>.Bearer <tok>`, `xoxb-...-lin_api_<key>`). Main's PATTERNS are kept here
// verbatim, as a fixture, from origin/main d2a549f4, applied as main applied them; on every pair of full-length shapes
// joined by each separator, and on generated fragments, every secret main hid stays hidden.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString } from '../src/events/redact.js';
import { leaks, run } from './token-standins.js';

type Replacement = string | ((match: string, ...groups: string[]) => string);
// Main's helpers for its JSON-key rule, verbatim.
const credentialShaped = (v: string) => (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) || /^[0-9a-fA-F]{32,}$/.test(v);
// check-table: never-shrink
const CREDENTIAL_WORDS = new Set(['token', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'jwt', 'bearer', 'credential', 'credentials', 'authorization']);
// check-table: never-shrink
const CREDENTIAL_ENDINGS = ['token', 'secret', 'password', 'passwd', 'accesskey'];
const credentialWord = (w: string) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_ENDINGS.some((e) => w.endsWith(e));
// check-table: never-shrink
const KEY_QUALIFIERS = new Set(['api', 'access', 'secret', 'private', 'signing', 'encryption', 'master', 'client', 'app', 'auth', 'account', 'service', 'license', 'deploy', 'admin', 'webhook', 'session', 'ssh', 'hmac', 'consumer']);
function credentialKey(k: string): boolean {
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[ _-]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  if (words.some(credentialWord) || last === 'auth') return true;
  if (last === 'key') return words.length === 1 || KEY_QUALIFIERS.has(words.at(-2)!);
  return last.endsWith('key') && KEY_QUALIFIERS.has(last.slice(0, -3));
}

/** Main's PATTERNS (src/events/redact.ts at d2a549f4), verbatim. */
// check-table: never-shrink
const MAIN_PATTERNS: [RegExp, Replacement][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, 'gh*_[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]'],
  [/(^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g, (m, pre, k, v) => (/\d/.test(v!) ? `${pre}${k}_[REDACTED]` : m)],
  [/(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, '$1AIza[REDACTED]'],
  [/(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '$1[REDACTED JWT]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA[REDACTED]'],
  [/\bxoxe[.-][A-Za-z0-9.-]{10,}\b/g, 'xoxe-[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'xox-[REDACTED]'],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, 'xapp-[REDACTED]'],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g, 'lin_[REDACTED]'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@'],
  [/\b0x[0-9a-fA-F]{64}\b/g, '0x[REDACTED-32-BYTES]'],
  [
    /(\\?")([A-Za-z0-9_-]+)\1(\s*:\s*)\1([A-Za-z0-9_\-.+/=~]{16,})\1/g,
    (m, q, k, sep, v) => (credentialKey(k!) && credentialShaped(v!) ? `${q}${k}${q}${sep}${q}[REDACTED]${q}` : m),
  ],
];
/** Main's default mode: its PATTERNS one after another. */
const mainDefault = (s: string) => MAIN_PATTERNS.reduce((t, [re, rep]) => (typeof rep === 'string' ? t.replace(re, rep) : t.replace(re, rep)), s);

const KEY_BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const KEY_END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const hex = (n: number) => 'c0ffee5ba11d0d9e'.repeat(Math.ceil(n / 16)).slice(0, n);

/** Full-length shapes, each with its own secret (no two share a 12-character piece). Prefixes put together at run time. */
const SHAPES: [string, string, string][] = (() => {
  const s = (n: number, seed: string) => run(n, seed);
  const jwtSig = s(43, 'Jw7SgN4tR9xQ');
  return [
    ['dashboard key', `${'wld'}_${s(32, 'Dk3Yq8Wm2Lp5')}`, s(32, 'Dk3Yq8Wm2Lp5')],
    ['GitHub token', `${'ghp'}_${s(36, 'Gh5Tk9Rz2Xw4')}`, s(36, 'Gh5Tk9Rz2Xw4')],
    ['fine-grained GitHub token', `${'github'}_pat_${s(60, 'Fg8Pa3Tn6Qe1')}`, s(60, 'Fg8Pa3Tn6Qe1')],
    ['Anthropic key', `${'sk'}-ant-api03-${s(40, 'An7Ck2Ey5Hb9')}`, s(40, 'An7Ck2Ey5Hb9')],
    ['plain sk- key', `${'sk'}-${s(40, 'Sp4Kx8Lm1Vd6')}`, s(40, 'Sp4Kx8Lm1Vd6')],
    ['Stripe key', `${'sk'}_live_${s(24, 'St2Rp7Ik4Yz9')}`, s(24, 'St2Rp7Ik4Yz9')],
    ['Slack bot token', `${'xoxb'}-123456789012-${s(24, 'Sl6Bt1Kq8Wn3')}`, s(24, 'Sl6Bt1Kq8Wn3')],
    ['Slack app token', `${'xapp'}-1-${s(30, 'Xa9Pp2Tk5Mr7')}`, s(30, 'Xa9Pp2Tk5Mr7')],
    ['Linear key', `${'lin'}_api_${s(40, 'Ln3Ar8Pk6Qc2')}`, s(40, 'Ln3Ar8Pk6Qc2')],
    ['JWT', `${'eyJ'}${s(20, 'hDr1Bq5Zt8')}.${'eyJ'}${s(24, 'pLd4Nx7Jv2')}.${jwtSig}`, jwtSig],
    // Unsigned (`alg: none`: an empty third part), and one whose signature starts with `+` (#889 round 7).
    ['unsigned JWT', `${'eyJ'}${s(20, 'hDr1Bq5Zt8')}.${'eyJ'}${s(60, 'uNs7Gd2Pq9Lw')}.`, s(60, 'uNs7Gd2Pq9Lw')],
    ['JWT with a +-led signature', `${'eyJ'}${s(20, 'hDr1Bq5Zt8')}.${'eyJ'}${s(60, 'pLs4Gn8Wq3Zk')}.+${s(20, 'Sx5Rt1Mv7Yb2')}`, s(60, 'pLs4Gn8Wq3Zk')],
    ['AWS key', `${'AKIA'}${'Q7RZ4KX2M9TBH3WD'}`, 'Q7RZ4KX2M9TBH3WD'],
    ['Google key', `${'AIza'}${s(35, 'Go4Gk1Ey9Ap3')}`, s(35, 'Go4Gk1Ey9Ap3')],
    ['Tailscale key', `${'tskey'}-auth-${s(30, 'Ts2Ak7Qz4Wf8')}`, s(30, 'Ts2Ak7Qz4Wf8')],
    ['bearer token', `Bearer ${s(36, 'Br5Tk2Nv8Zx3')}`, s(36, 'Br5Tk2Nv8Zx3')],
    ['URL password', `postgres://app:${s(20, 'Pw6Db3Hq9Lk1')}@db.example.com`, s(20, 'Pw6Db3Hq9Lk1')],
    // A scheme longer than 32 characters whose last 32 hold no letter (#889 round 8).
    ['URL password, long scheme', `x${'1'.repeat(40)}://app:${s(20, 'Lg7Sc4Hm2Pw9')}@db.example.com`, s(20, 'Lg7Sc4Hm2Pw9')],
    ['32-byte hex key', `0x${hex(64)}`, hex(64)],
    ['JSON value', `{"api_key":"${s(28, 'Js8Vk3Ap5Qy2')}"}`, s(28, 'Js8Vk3Ap5Qy2')],
    ['private key', `${KEY_BEGIN}\n${s(64, 'Pk1Bd7Ry4Ms9')}\n${KEY_END}`, s(64, 'Pk1Bd7Ry4Ms9')],
  ];
})();

/** Separators a log line, a URL, JSON or an ANSI-coloured terminal puts between two values. */
const SEPARATORS = ['', ' ', '-', '.', '+', '_', ':', '=', ',', '/', '"', '\n', '\u001b[1m', '\\n', 'Authorization: ', 'BEARER ', 'x.', 'a.b.'];

/** The secrets main hid in `s` that `out` shows. */
function narrowed(s: string, out: string, secrets: string[]): string[] {
  const old = mainDefault(s);
  return secrets.filter((x) => s.includes(x) && !leaks(old, x) && leaks(out, x));
}

test('on every pair of full-length shapes joined by each separator, the default mode hides everything main hid', () => {
  const missed: string[] = [];
  for (const [aName, a, aSecret] of SHAPES) {
    for (const [bName, b, bSecret] of SHAPES) {
      for (const sep of SEPARATORS) {
        for (const s of [`${a}${sep}${b}`, `x ${a}${sep}${b} y`]) {
          const shown = narrowed(s, redactString(s), [aSecret, bSecret]);
          if (shown.length && missed.length < 40) missed.push(`${aName} ${JSON.stringify(sep)} ${bName}: ${JSON.stringify(s).slice(0, 120)}`);
        }
      }
    }
  }
  assert.deepEqual(missed, []);
});

test("the delta check's cases: one rule's match no longer eats the next rule's anchor", () => {
  const pw = run(20, 'Zq4Pw8Ld2Mx6');
  const tok = run(30, 'Bt3Rq9Wv6Kc1');
  const lin = run(40, 'Li7Nk2Ey5Rb8');
  const jwt = `${'eyJ'}${run(20, 'hDr1Bq5Zt8')}.${'eyJ'}${run(24, 'pLd4Nx7Jv2')}.${run(43, 'Jw7SgN4tR9xQ')}`;
  const cases: [string, string][] = [
    [`${'wld'}_${run(32, 'Dk3Yq8Wm2Lp5')}-redis://app:${pw}@db.example.com`, pw],
    [`${jwt}.postgres://app:${pw}@db.example.com`, pw],
    [`${jwt}.Bearer ${tok}`, tok],
    [`${'xoxb'}-123456789012-${run(24, 'Sl6Bt1Kq8Wn3')}-${'lin'}_api_${lin}`, lin],
    [`${'xapp'}-1-${run(30, 'Xa9Pp2Tk5Mr7')}-${'lin'}_api_${lin}`, lin],
    [`Authorization: BEARER ${tok}+postgres://app:${pw}@db.example.com`, pw],
    [`${'tskey'}-auth-${run(30, 'Ts2Ak7Qz4Wf8')}-Bearer ${tok}`, tok],
    [`"a\\n${'sk'}-ant-oat01-${run(40, 'An7Ck2Ey5Hb9')}-postgres://app:${pw}@db.example.com"`, pw],
    // A JWT after a dotted name whose first part is long: main's rule found it from the dot.
    [`${run(16, 'Nm5Qa8Zr3Kd1')}-api_key.${jwt}`, run(43, 'Jw7SgN4tR9xQ')],
    [`see ${run(13, 'Wq2Lp6Xn9Bc4')}.${'eyJ'}${run(14, 'Hd3Rz7Kq1Mv5')}.${run(14, 'Py8Lx2Tw6Nb3')}.${run(16, 'Sg4Qe9Ja2Wz7')}`, run(16, 'Sg4Qe9Ja2Wz7')],
    // The round-5 delta check's JWT cases: a dotted segment of 11 or more characters before the token.
    [`token abcdefghijk.${jwt} end`, run(43, 'Jw7SgN4tR9xQ')],
    [`GET api.example-service.${jwt} 200`, run(43, 'Jw7SgN4tR9xQ')],
    [`Cookie: s=sess_0123456789.${jwt}`, run(43, 'Jw7SgN4tR9xQ')],
    [`https://auth.example.com/cb/abcdefghijklm.${jwt}`, run(43, 'Jw7SgN4tR9xQ')],
    [`token abcdefghijk.${'eyJ'}${run(600, 'hDr1Bq5Zt8')}.${'eyJ'}${run(24, 'pLd4Nx7Jv2')}.${run(43, 'Jw7SgN4tR9xQ')} end`, run(43, 'Jw7SgN4tR9xQ')],
  ];
  const shown = cases.filter(([s, secret]) => !leaks(mainDefault(s), secret) && leaks(redactString(s), secret)).map(([s]) => s.slice(0, 60));
  assert.deepEqual(shown, []);
});

test('on generated fragments and whole tokens, the default mode hides everything main hid', () => {
  const SECRETS = ['Q1w2E3r4', 'Z9y8X7w6V5u4', 'Mn3Bv4Cx5Zl6Kj7H', 'pL0oK9iJ8uH7yG6tF5rD4eS3'];
  const tail = SECRETS[3]!;
  const COMMON = ['.', 'bearer ', 'Bearer ', 'BEARER ', 'https://', 'git+ssh://', 'redis://', '@', ':', '=', ' ', ' ', '-', '+', '_', 'token', 'Password', 'api_key', '"', "'", '/', '\n', KEY_BEGIN, KEY_END, 'x', ',', '\u001b[1m', '\\n', '7'];
  // Prefixes alone (the delta check's `frag` set), and whole tokens ending in a secret (its `real` set).
  const SETS: [string, string[]][] = [
    ['fragments', ['ghp_', 'gho_', 'github_pat_', 'sk-ant-', 'sk-', 'xoxb-', 'xoxp-', 'xapp-', 'lin_api_', 'eyJ', 'AKIA', 'AIza', 'wld_', 'tskey-', '0x', ...COMMON]],
    [
      'whole tokens',
      [`${'ghp'}_${tail}Mn3Bv4Cx5Zl6`, `${'github'}_pat_11${tail}_Mn3Bv4Cx5Zl6Kj7H`, `${'sk'}-ant-api03-${tail}`, `${'xoxb'}-123456789012-${tail}`, `${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxIn0.${tail}`, `${'AKIA'}Q7RZ4KX2M9TBQ7RZ`, `${'tskey'}-auth-k${tail}`, `${'wld'}_${tail}Mn3Bv4Cx5Z`, `${'lin'}_api_${tail}`, ...COMMON],
    ],
  ];
  const missed: string[] = [];
  for (const [set, PIECES] of SETS) {
    let seed = 2463534242;
    const rnd = (k: number) => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed % k;
    };
    for (let i = 0; i < 40_000; i++) {
      let s = '';
      for (let j = 2 + rnd(6); j > 0; j--) s += rnd(3) === 0 ? SECRETS[rnd(SECRETS.length)] : PIECES[rnd(PIECES.length)];
      const present = SECRETS.filter((x) => s.includes(x));
      if (!present.length) continue;
      const old = mainDefault(s);
      const out = redactString(s);
      // Occurrences, as the delta check counted them: no secret is shown more often than main showed it.
      const occ = (t: string, x: string) => t.split(x).length - 1;
      if (present.some((x) => occ(out, x) > occ(old, x)) && missed.length < 20) missed.push(`${set}: ${JSON.stringify(s)}`);
    }
  }
  assert.deepEqual(missed, []);
});
