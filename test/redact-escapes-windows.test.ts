// #889 round 4 (the third adversarial review):
// - A shape with a distinctive prefix is found wherever its prefix is; the rest are found after an escape sequence in
//   any encoding (the JSON escape of ESC, ESC 7/8, ESC ( B, ESC c, the 8-bit CSI, `\x1b`, `\033`, `\e`, `^[`).
// - No redaction site costs more than its window: the default URL-password rule is linear on long dotted runs, and the
//   diff view, a chat attachment, a PR section and the log views redact only what they keep plus a margin.
// - Broad mode's mask subtraction is linear; Bearer and Basic match in any case.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString } from '../src/events/redact.js';
import { readServiceLog } from '../src/dashboard.js';
import { decisionDiff, prSections } from '../src/decision-detail.js';
import { attachmentPrompt, ATTACHMENT_DEFAULT_CAPS, storeUpload } from '../src/chat-attachments.js';
import { safeLine } from '../src/gh-login.js';
import { scrub as benchScrub } from '../scripts/bench/cli.js';
import { childEnv } from '../src/os/index.js';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { leaks, run, SHAPES } from './token-standins.js';

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };
const ESC = '\u001b';
const BS = '\\';
const broad = { broad: true } as Parameters<typeof redactString>[1];

/** The five paths the review drove: default, broad, the root updater, gh-login and the bench. */
const PATHS: [string, (t: string) => string][] = [
  ['default', (t) => redactString(t)],
  ['broad', (t) => redactString(t, broad)],
  ['updater', (t) => updater.redact(t)],
  ['gh-login', (t) => safeLine(t)],
  ['bench', (t) => benchScrub(t, {}, 100_000)],
];

test('a token right after an escape sequence in any encoding is found, every token shape on every path (R1-R4)', () => {
  const escapes: [string, string][] = [
    ['JSON-escaped ESC, CSI', `${BS}u001b[1m`],
    ['JSON-escaped ESC, CSI with parameters', `${BS}u001B[32;1m`],
    ['ESC 7 (save cursor)', `${ESC}7`],
    ['ESC 8 (restore cursor)', `${ESC}8`],
    ['ESC ( B (charset)', `${ESC}(B`],
    ['ESC c (reset)', `${ESC}c`],
    ['8-bit CSI', '\u009b1m'],
    ['8-bit CSI with parameters', '\u009b32;1m'],
    ['C hex escape, CSI', `${BS}x1b[1m`],
    ['C octal escape, CSI', `${BS}033[1m`],
    ['\\e, CSI', `${BS}e[1m`],
    ['caret notation, CSI', '^[[1m'],
  ];
  const missed: string[] = [];
  for (const s of SHAPES.filter((x) => x.token && !x.value.includes('\n'))) {
    for (const [how, esc] of escapes) {
      for (const [path, out] of PATHS) {
        if (path === 'gh-login' && !s.kind.startsWith('GitHub')) continue;
        if (leaks(out(`log: ${esc}${s.value} done`), s.secret)) missed.push(`${s.what}, ${how}, via ${path}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('a shape with a distinctive prefix is found after any character, a digit or a letter included', () => {
  const missed: string[] = [];
  const distinctive = SHAPES.filter((x) => x.token && /^(?:gh[pousr]_|github_pat_|sk-ant-|xox|xapp-|lin_|tskey-|wld_|AKIA|ASIA|AIza|eyJ)/.test(x.value));
  assert.ok(distinctive.length >= 20, `${distinctive.length} stand-ins with a distinctive prefix`);
  for (const s of distinctive) for (const before of ['7', 'x', 'Z', '_', '%5F', '&#95;', 'm']) if (leaks(redactString(`${before}${s.value} end`), s.secret)) missed.push(`${s.what} after ${before}`);
  assert.deepEqual(missed, []);
});

test('Bearer and Basic match in any case, plain and in a JSON header, in default mode (R9)', () => {
  const tok = run(40, 'bR5x');
  const cred = Buffer.from(`x-access-token:${run(30)}`).toString('base64');
  for (const s of [`authorization: bEaReR ${tok}`, `{"Authorization":"bEarer ${tok}"}`]) assert.ok(!leaks(redactString(s), tok), s);
  for (const s of [`Authorization: bAsIc ${cred}`, `{"Authorization":"basiC ${cred}"}`]) assert.ok(!leaks(redactString(s), cred), s);
});

/** Long dotted runs (R6, R8): a URL scheme's characters, a dotted eyJ chain, and secret names among mask words (R7). */
const HOSTILE = (n: number) => ['ab.'.repeat(n / 3), 'ab-c+d.'.repeat(n / 7), `eyJ${'abcdefghij.'.repeat(n / 11)}`, '[hidden] token=x '.repeat(n / 17), `${'a.'.repeat(n / 4)}://x:y@h`];
const timed = (f: () => unknown) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

test('redactString, default and broad, stays linear on long dotted runs and many mask words (R6, R7, R8)', () => {
  const slow: string[] = [];
  for (const s of HOSTILE(400_000)) {
    for (const [what, f] of [['default', () => redactString(s)], ['broad', () => redactString(s, broad)], ['broad [hidden]', () => redactString(s, { broad: true, mask: '[hidden]' } as Parameters<typeof redactString>[1])]] as const) {
      const ms = timed(f);
      if (ms > 3000) slow.push(`${what} on ${JSON.stringify(s.slice(0, 12))}…: ${Math.round(ms)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test('each cut site redacts only its window: a PR section, a chat attachment, the log views (journal and file), the diff view', async () => {
  const big = HOSTILE(1_000_000).join('\n');
  const slow: string[] = [];
  const check = async (what: string, f: () => unknown) => {
    const t0 = performance.now();
    await f();
    const ms = performance.now() - t0;
    if (ms > 3000) slow.push(`${what}: ${Math.round(ms)} ms`);
  };
  await check('PR section', () => prSections(`## Fail-without\n${big}\n\n## Next\n`));
  const s = scratch('attach-');
  async function* once(b: string) {
    yield Buffer.from(b);
  }
  const m = await storeUpload({ stateDir: s, name: 'log.txt', body: once(big), caps: { ...ATTACHMENT_DEFAULT_CAPS }, by: 'example-collaborator', gitleaks: null, anyway: true });
  await check('chat attachment', () => attachmentPrompt(s, [m.id], scratch('bundle-')));
  // 300 journal entries of 48 KB (journald's LineMax): what the view reads at most.
  const entry = 'ab.'.repeat(16_000);
  const journal = () => ({ status: 0, stderr: '', stdout: Array.from({ length: 300 }, (_, i) => JSON.stringify({ MESSAGE: entry, PRIORITY: '6', __REALTIME_TIMESTAMP: String(1_767_225_600_000_000 + i) })).join('\n') });
  await check('journal view', () => readServiceLog({ unit: 'coordinator.service', file: null }, 200, journal));
  const file = join(scratch('svc-log-'), 'c.log');
  writeFileSync(file, `${Array.from({ length: 300 }, () => entry).join('\n')}\n`);
  await check('file view', () => readServiceLog({ unit: null, file }, 200));
  // The diff view: a commit adding 1 MB of dotted runs.
  const repo = scratch('diff-repo-');
  const env = { ...childEnv(), GIT_CONFIG_GLOBAL: join(repo, '.no-global'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), `${big}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'big');
  const head = git('rev-parse', 'HEAD');
  let diff: Awaited<ReturnType<typeof decisionDiff>> | null = null;
  await check('diff view', async () => {
    diff = await decisionDiff(repo, base, head);
  });
  assert.ok(diff && 'truncated' in diff! && (diff as { truncated: boolean }).truncated, 'the diff was cut');
  assert.deepEqual(slow, []);
});

test('a key cut at a window edge still fails closed: its body is not shown', () => {
  // 400 body lines (26 KB), so its END is past the cut and the margin.
  const body = Array.from({ length: 400 }, (_, i) => run(64, `W${i}nd0wKey${i}`));
  const key = [['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '), ...body, ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')].join('\n');
  // The key starts just before the PR section's 20,000-character cut, its END far past the window.
  const section = prSections(`## Fail-without\n${'x '.repeat(9_990)}\n${key}\n${'y '.repeat(20_000)}\n\n## Next\n`).failWithout!;
  assert.equal(body.filter((b) => leaks(section, b)).length, 0);
});
