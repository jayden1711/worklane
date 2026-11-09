// scripts/ci/fetch-pinned.sh's behaviour, with a stub curl first on PATH (no network): the one way CI downloads a
// pinned binary (#1201). WHY (#1181 review R1181j 3): soak.yml runs it and its test lived only in #1228; with the
// digest check or the https-only check removed, this PR's tests stayed green. #1228's test/ci-download-retry.test.ts
// has these too, with the lint that every pinned download goes through the helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const HELPER = 'scripts/ci/fetch-pinned.sh';
const REL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const skip = process.platform === 'win32';

/** The tools the helper calls, each by its absolute path (R1181l 2). */
const TOOLS = ['curl', 'sha256sum', 'mktemp', 'rm', 'mv'];
/** Where this machine has each (the test's own PATH): the helper's copy below calls these, and the stub curl. */
const local = Object.fromEntries(TOOLS.map((t) => [t, spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()]));

/**
 * Runs the helper with a stub curl: it logs its argv and writes `body` to its -o target, or exits `rc`. The helper
 * calls its tools by absolute path, so it runs as a copy with `/usr/bin/curl` pointing at the stub and the other
 * tools at this machine's own; nothing else in it changes. `env` adds to the helper's environment (a PATH first in
 * line, a BASH_ENV).
 */
function runHelper(args: (d: string) => string[], opts: { body?: string; rc?: number; stale?: boolean; env?: (d: string) => Record<string, string> } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  try {
    let text = readFileSync(join(repoRoot, HELPER), 'utf8');
    for (const t of TOOLS) text = text.split(`/usr/bin/${t} `).join(`${t === 'curl' ? join(d, 'curl') : local[t]} `);
    writeFileSync(join(d, 'helper.sh'), text);
    writeFileSync(
      join(d, 'curl'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n' +
        '[ "$STUB_RC" = 0 ] || exit "$STUB_RC"\nprintf %s "$STUB_BODY" > "$out"\n',
      { mode: 0o755 },
    );
    if (opts.stale) writeFileSync(join(d, 'out.bin'), 'stale');
    const r = spawnSync('bash', [join(d, 'helper.sh'), ...args(d)], {
      cwd: d,
      encoding: 'utf8',
      env: { ...process.env, STUB_LOG: join(d, 'log'), STUB_BODY: opts.body ?? '', STUB_RC: String(opts.rc ?? 0), ...(opts.env?.(d) ?? {}) },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      out: existsSync(join(d, 'out.bin')) ? readFileSync(join(d, 'out.bin'), 'utf8') : null,
      parts: readdirSync(d).filter((n) => n.includes('.part')),
      curlArgs: existsSync(join(d, 'log')) ? readFileSync(join(d, 'log'), 'utf8').trim().split('\n') : null,
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test('fetch-pinned: a matching download lands at its out file, over https only, with the retry, and nothing else is left', { skip }, () => {
  const r = runHelper((d) => [REL, sha('hello'), join(d, 'out.bin')], { body: 'hello' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out, 'hello');
  assert.deepEqual(r.parts, []);
  const a = r.curlArgs!;
  assert.equal(a[0], '-q', 'curl reads no ~/.curlrc');
  for (const flag of ['-fsSL', '--retry-all-errors', '--tlsv1.2']) assert.ok(a.includes(flag), `curl gets ${flag}`);
  assert.equal(a[a.indexOf('--proto') + 1], '=https', 'a redirect never leaves https');
  for (const insecure of ['-k', '--insecure']) assert.equal(a.includes(insecure), false, `no ${insecure}`);
  assert.ok(a.includes('--strict') || readFileSync(join(repoRoot, HELPER), 'utf8').includes('sha256sum -c - --strict'), 'the check is --strict');
  assert.ok(Number(a[a.lastIndexOf('--retry') + 1]) >= 3, 'curl retries at least 3 times');
  assert.match(a[a.indexOf('-o') + 1]!, /\/out\.bin\.part\.[A-Za-z0-9]{6}$/, 'a fresh part file beside the out file');
  assert.equal(a.at(-1), REL);
});

test('fetch-pinned: a sha256 mismatch exits 1 and leaves nothing at the out file, a stale file there included', { skip }, () => {
  for (const stale of [false, true]) {
    const r = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', stale });
    assert.equal(r.status, 1, `stale=${stale}: ${r.stderr}`);
    assert.match(r.stderr, /sha256 mismatch/);
    assert.equal(r.out, null, `stale=${stale}: nothing is at the out file`);
    assert.deepEqual(r.parts, []);
  }
});

test('fetch-pinned: a failed download exits non-zero and leaves nothing; a non-https URL or a bad argument exits 2 before any download', { skip }, () => {
  const failed = runHelper((d) => [REL, sha('x'), join(d, 'out.bin')], { rc: 22, stale: true });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.out, null);
  assert.deepEqual(failed.parts, []);
  const badArgs: Record<string, (d: string) => string[]> = {
    'an http URL': (d) => ['http://example.com/x', sha('x'), join(d, 'out.bin')],
    'an http URL naming https later': (d) => ['http://example.com/?https://x', sha('x'), join(d, 'out.bin')],
    'a file URL': (d) => ['file:///etc/hostname', sha('x'), join(d, 'out.bin')],
    'an upper-case pin': (d) => [REL, sha('x').toUpperCase(), join(d, 'out.bin')],
    'a short pin': (d) => [REL, sha('x').slice(1), join(d, 'out.bin')],
    'an empty out file': () => [REL, sha('x'), ''],
    'two arguments': () => [REL, sha('x')],
  };
  for (const [why, args] of Object.entries(badArgs)) {
    const r = runHelper(args, { body: 'x' });
    assert.equal(r.status, 2, `${why}: ${r.stderr}`);
    assert.equal(r.curlArgs, null, `${why}: curl never ran`);
    assert.equal(r.out, null, `${why}: nothing at the out file`);
  }
});

test('fetch-pinned: every tool is called by its absolute path, so a stand-in first on PATH or a function from BASH_ENV never checks the download (#1181 review R1181l 2)', { skip }, () => {
  const text = readFileSync(join(repoRoot, HELPER), 'utf8');
  for (const line of text.split('\n').filter((l) => !l.startsWith('#'))) {
    for (const t of TOOLS) assert.ok(!new RegExp(`(^|[\\s|;&(\'"$])${t}(\\s|$)`).test(line.replaceAll(`/usr/bin/${t}`, '')), `${t} named bare: ${line}`);
  }
  // A sha256sum that passes anything, first on PATH, and the same as a function a BASH_ENV defines: a tampered body is
  // still refused.
  const fake = '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n';
  const onPath = runHelper((d) => {
    writeFileSync(join(d, 'sha256sum'), fake, { mode: 0o755 });
    return [REL, sha('expected'), join(d, 'out.bin')];
  }, { body: 'tampered', env: (d) => ({ PATH: `${d}:${process.env.PATH}` }) });
  assert.equal(onPath.status, 1, onPath.stderr);
  assert.equal(onPath.out, null);
  const viaBashEnv = runHelper((d) => {
    writeFileSync(join(d, 'env.sh'), 'sha256sum() { cat >/dev/null; return 0; }\nexport -f sha256sum\n');
    return [REL, sha('expected'), join(d, 'out.bin')];
  }, { body: 'tampered', env: (d) => ({ BASH_ENV: join(d, 'env.sh') }) });
  assert.equal(viaBashEnv.status, 1, viaBashEnv.stderr);
  assert.equal(viaBashEnv.out, null);
});
