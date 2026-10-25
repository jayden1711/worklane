// The runner's own cuts (#1065): claude's stderr (its last 4000 characters), the auth status it couldn't read (its
// last 500), a rate limit's words (the first 300) and a result's (the first 500) are redacted before they are cut. A
// secret across a cut is redacted whole; it is never cut short of its rule and then passed on, as the part that was
// kept, to the run record and the event log that redact it again. Each stand-in shape (test/token-standins.ts) is put
// across each cut, cut by one character and cut in half, through a stand-in claude; each case also checks that the cut
// landed where the cap says, so a cap that changes fails here instead of silently testing less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUT_MARGIN, redactString } from '../../src/events/redact.js';
import { claudeAuthStatus, CliRunner, keepStderr, redactTail, STDERR_KEPT, type RunRequest } from '../../src/runner.js';
import { leaks, run, SHAPES } from '../token-standins.js';

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';
const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'agents@example.com' });

/** A stand-in claude reading what it prints from `dir`: auth status prints `status`, a run `stdout` and `stderr`. */
function standIn() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-cut-'));
  const bin = join(dir, 'claude');
  const at = (f: string) => JSON.stringify(join(dir, f));
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = auth ]; then cat ${at('status')}; exit 0; fi\nIFS= read -r _ || true\ncat ${at('stdout')}\ncat ${at('stderr')} >&2\nexit "$(cat ${at('code')})"\n`);
  chmodSync(bin, 0o755);
  const put = (o: { status?: string; lines?: object[]; stderr?: string; code?: number }) => {
    writeFileSync(join(dir, 'status'), o.status ?? SIGNED_IN);
    writeFileSync(join(dir, 'stdout'), (o.lines ?? []).map((l) => `${JSON.stringify(l)}\n`).join(''));
    writeFileSync(join(dir, 'stderr'), o.stderr ?? '');
    writeFileSync(join(dir, 'code'), String(o.code ?? 1));
  };
  let t = Date.now();
  const runner = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(dir, 'login') }, bin, undefined, undefined, undefined, { now: () => t, sleep: async (ms) => ((t += ms), true) });
  const req: RunRequest = { role: 'worker', prompt: 'p', cwd: dir, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 };
  return { bin, put, run: () => runner.run(req) };
}

/** Where `secret` starts in `value`, and the two cut points in it: one character short of its end, and its middle. */
function cuts(value: string, secret: string): { at: number; len: number; ks: number[] } {
  const at = value.indexOf(secret);
  return { at, len: secret.length, ks: [...new Set([at + secret.length - 1, at + Math.floor(secret.length / 2)])] };
}

/**
 * Texts that put `value` across a head cut at `cap`: its first `k` characters kept. As in the run-record case
 * (test/adversarial/run-clip-redaction.test.ts): no whitespace at the start, a space before the value.
 */
function acrossHead(cap: number, value: string, secret: string): string[] {
  const { ks } = cuts(value, secret);
  return ks.filter((k) => cap - k >= 2).map((k) => `${'w'.repeat(cap - k - 1)} ${value} and the rest of the text ${'z'.repeat(600)}`);
}

/** Texts that put `value` across a tail cut at `cap`: all of it but its first `k` characters kept. */
function acrossTail(cap: number, value: string, secret: string, lead = 600): string[] {
  const { ks } = cuts(value, secret);
  return ks.filter((k) => cap - (value.length - k) >= 2).map((k) => `START ${'w'.repeat(lead)} ${value} ${'z'.repeat(cap - (value.length - k) - 1)}`);
}

/** Shapes redaction hides in the text uncut: one it misses whole is a redaction gap (#1066), not a cut's. */
function hiddenWhole(text: string, secret: string, what: string, gaps: Set<string>): boolean {
  if (!leaks(redactString(text), secret)) return true;
  gaps.add(what);
  return false;
}

test("a secret across the cut of claude's stderr is redacted whole, never passed on as its kept end (#1065)", { skip: posixOnly }, async () => {
  const s = standIn();
  const missed: string[] = [];
  const uncut: string[] = [];
  const gaps = new Set<string>();
  for (const shape of SHAPES) {
    // A long start, so the stream is cut while it is read as well as at its end.
    for (const text of acrossTail(STDERR_KEPT, shape.value, shape.secret, 3 * STDERR_KEPT)) {
      if (!hiddenWhole(text, shape.secret, shape.what, gaps)) continue;
      s.put({ stderr: text });
      const out = await s.run();
      if (leaks(out.detail, shape.secret)) missed.push(shape.what);
      const kept = out.detail.replace(/^claude exited 1 without a result: /, '');
      if (out.reason !== 'failed' || kept === out.detail || kept.includes('START') || !kept.endsWith('z') || kept.length > STDERR_KEPT) uncut.push(`${shape.what}: ${out.reason} ${JSON.stringify(out.detail.slice(0, 60))}`);
    }
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
  assert.deepEqual([...gaps], []);
});

test("a secret across the cut of claude auth status's text is redacted whole, never passed on as its kept end (#1065)", { skip: posixOnly }, () => {
  const s = standIn();
  const missed: string[] = [];
  const uncut: string[] = [];
  const gaps = new Set<string>();
  for (const shape of SHAPES) {
    for (const text of acrossTail(500, shape.value, shape.secret)) {
      if (!hiddenWhole(text, shape.secret, shape.what, gaps)) continue;
      s.put({ status: text });
      const got = claudeAuthStatus({ PATH: process.env.PATH ?? '' }, undefined, s.bin);
      if (leaks(got.text, shape.secret)) missed.push(shape.what);
      if (got.method !== 'unknown' || got.text.includes('START') || !got.text.endsWith('z') || got.text.length > 500) uncut.push(`${shape.what}: ${got.method} ${JSON.stringify(got.text.slice(0, 60))}`);
    }
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
  assert.deepEqual([...gaps], []);
});

test("a secret across the cut of a rate limit's or a result's words is redacted whole, never passed on as its kept start (#1065)", { skip: posixOnly }, async () => {
  const s = standIn();
  const missed: string[] = [];
  const uncut: string[] = [];
  const gaps = new Set<string>();
  const sites = [
    { where: 'a rate limit', cap: 300, reason: 'rate_limited', pre: 'usage or rate limit reached: ', code: 1, line: (t: string) => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: t, num_turns: 0, total_cost_usd: 0 }) },
    { where: 'a failed result', cap: 500, reason: 'failed', pre: 'error_during_execution: ', code: 1, line: (t: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: t, num_turns: 2, total_cost_usd: 0 }) },
    { where: 'a succeeded result', cap: 500, reason: 'succeeded', pre: '', code: 0, line: (t: string) => ({ type: 'result', subtype: 'success', result: t, num_turns: 2, total_cost_usd: 0 }) },
  ];
  for (const site of sites) {
    for (const shape of SHAPES) {
      for (const text of acrossHead(site.cap, shape.value, shape.secret)) {
        if (!hiddenWhole(text, shape.secret, `${shape.what} in ${site.where}`, gaps)) continue;
        s.put({ lines: [site.line(text)], code: site.code });
        const out = await s.run();
        if (leaks(out.detail, shape.secret)) missed.push(`${shape.what} in ${site.where}`);
        if (out.reason !== site.reason || !out.detail.startsWith(`${site.pre}w`) || out.detail.length !== site.pre.length + site.cap) uncut.push(`${shape.what} in ${site.where}: ${out.reason} ${JSON.stringify(out.detail.slice(0, 60))}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
  assert.deepEqual([...gaps], []);
});

test("redactTail's window never shows its raw start, even when redaction shrinks what follows it (#1065)", () => {
  const token = `ghp_${run(36)}`;
  const line = (w: string) => [`-----${w}`, 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
  const key = [line('BEGIN'), run(CUT_MARGIN + 200), line('END')].join('\n');
  const s = `START ${token} ${key} and the end`;
  // The window (the last max + CUT_MARGIN characters) starts 20 characters into the token.
  const max = s.length - CUT_MARGIN - (s.indexOf(token) + 20);
  const got = redactTail(s, max);
  assert.ok(!leaks(got, token) && !leaks(got, run(CUT_MARGIN + 200)), got.slice(0, 80));
  assert.match(got, /and the end$/);
});

test('stderr read in any chunks is cut with a secret across the cut redacted whole, and a token still being written is kept as it came (#1065)', () => {
  const max = 200;
  const missed: string[] = [];
  for (const shape of SHAPES) {
    const { at, len } = cuts(shape.value, shape.secret);
    const text = `START ${'w'.repeat(3 * max)} ${shape.value} ${'z'.repeat(max)}\n`;
    const start = text.indexOf(shape.value) + at;
    // Each chunk boundary in and around the secret: what was kept, ended by claude's last line, holds none of it.
    for (let b = start - 2; b <= start + len + 2; b++) {
      let kept = '';
      for (const chunk of [text.slice(0, b), text.slice(b)]) kept = keepStderr(kept, chunk, max);
      assert.ok(kept.length <= 2 * max, `${shape.what}: kept to twice the cap`);
      if (leaks(redactString(kept), shape.secret)) missed.push(`${shape.what}, chunk at ${b - start}`);
    }
  }
  assert.deepEqual(missed, []);
  // Uncut until twice the cap; a part-written run at the end is not redacted on its own.
  assert.equal(keepStderr('a'.repeat(10), 'b'.repeat(10), 10), `${'a'.repeat(10)}${'b'.repeat(10)}`);
  const part = `ghp_${'A1b2C3d4'.repeat(5)}`;
  const cut = keepStderr('w '.repeat(30), part, 50);
  assert.ok(cut.length < 60 + part.length && cut.endsWith(` ${part}`), `the run still being written is kept as it came: ${cut}`);
});
