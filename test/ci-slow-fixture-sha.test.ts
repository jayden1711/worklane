// ci-slow's plugin steps fetch the test fixtures (test/fixtures/plugins/*) from GitHub by commit (#631). On a pull
// request the job runs the merge of the PR into main (its checkout, github.sha), so the fixtures must come from that
// same commit: fetched from the PR head instead, a PR branched before a fixture change ran main's steps against its
// old fixture (PR #619's add-project, run 39103725841: the escape fixture had no kernel server yet). And the kernel
// probe stops at a failed preview with the fetch unit's journal, which has the reason, instead of going on to
// readPreview's misleading "fetch it first". These tests read the workflow and the probe, and run only the probe's
// check, with stand-ins for sudo and journalctl; never the escape fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');
const posix = process.platform !== 'win32';
const hasJq = posix && spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

test('ci-slow fetches each plugin fixture from the commit under test (github.sha), never the PR head (#631)', () => {
  const yml = read('.github', 'workflows', 'ci-slow.yml');
  const shas = yml.split('\n').filter((l) => /^\s*FIXTURE_SHA:/.test(l));
  assert.ok(shas.length >= 2, 'the plugins step and the MCP broker step each set it');
  for (const l of shas) assert.equal(l.trim(), 'FIXTURE_SHA: ${{ github.sha }}');
  // The PR head is only the scope job's, for which paths the PR touches.
  const heads = yml.split('\n').filter((l) => l.includes('pull_request.head.sha'));
  assert.deepEqual(heads.map((l) => l.trim()), ['PR_HEAD: ${{ github.event.pull_request.head.sha }}']);
  assert.ok(yml.indexOf('pull_request.head.sha') < yml.indexOf('\n  bootstrap:'), "in the scope job");
  // Every fixture fetch through the machine helper, in the workflow and in the scripts it runs, takes that sha.
  const fetches = [yml, read('scripts', 'ci', 'mcp-broker-kernel.sh')].flatMap((t) => t.split('\n')).filter((l) => l.includes('"$HELPER" plugin-fetch'));
  assert.ok(fetches.length >= 3, 'kit and refused in the plugins step, kit and escape in the broker step');
  for (const l of fetches) assert.match(l, /plugin-fetch \S+ "\$url" "\$FIXTURE_SHA" /, l.trim());
});

/** The kernel probe's preview check (preview_done in mcp-broker-kernel.sh), run as it is there with this status file. */
function previewDone(status: string | null): { code: number | null; stderr: string } {
  const sh = read('scripts', 'ci', 'mcp-broker-kernel.sh');
  const fn = /^preview_done\(\) \{.*\}$/m.exec(sh);
  assert.ok(fn, "the probe's preview_done");
  const dir = mkdtempSync(join(tmpdir(), 'kernel-probe-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // sudo runs the command as is; journalctl says what it was asked for. Nothing of the machine's is read.
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    writeFileSync(join(bin, 'journalctl'), '#!/bin/sh\necho "journal: $*"\n');
    for (const f of ['sudo', 'journalctl']) chmodSync(join(bin, f), 0o755);
    const st = join(dir, 'ci.json');
    if (status !== null) writeFileSync(st, status);
    const script = `set -euo pipefail\nname=ci\nst="$1"\n${fn[0]}\npreview_done escape-kernel\necho reached`;
    const r = spawnSync('bash', ['-c', script, 'probe', st], { encoding: 'utf8', env: { PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`, LANG: 'C' } });
    if (r.status === 0) assert.equal(r.stdout.trim(), 'reached');
    return { code: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the kernel probe stops at a failed preview and prints the fetch unit's journal, not readPreview's 'fetch it first' (#631)", { skip: !hasJq && 'bash and jq' }, () => {
  // Its place: right after the preview's wait, before anything reads the preview.
  const sh = read('scripts', 'ci', 'mcp-broker-kernel.sh');
  const preview = sh.indexOf('sudo -u "wl-$name" sudo -n "$HELPER" mcp-preview "$id" escape kernel && wait_status "$id"\npreview_done "$id"\n');
  assert.ok(preview > 0, 'preview_done right after the preview');
  assert.ok(preview < sh.indexOf('d="$(digest)"'), 'before the digest reads the preview');
  // Done: on to the digest, the journal not printed.
  const ok = previewDone('{"id":"escape-kernel","state":"done","reason":"","at":"2026-10-18T06:35:25Z"}\n');
  assert.equal(ok.code, 0);
  assert.doesNotMatch(ok.stderr, /journal:/);
  // Failed (run 39103725841's status), still running when the wait gave up, another id's, or no status at all: the
  // step stops here with the fetch unit's journal (the unit worklane-machine starts for mcp-preview) and the status.
  for (const s of [
    '{"id":"escape-kernel","state":"failed","reason":"the preview could not be made","at":"2026-10-18T06:35:25Z"}\n',
    '{"id":"escape-kernel","state":"running","reason":"","at":"2026-10-18T06:35:25Z"}\n',
    '{"id":"escape","state":"done","reason":"","at":"2026-10-18T06:35:25Z"}\n',
    null,
  ]) {
    const r = previewDone(s);
    assert.notEqual(r.code, 0, `${s}`);
    assert.match(r.stderr, /^journal: -u worklane-plugin-fetch-ci\.service --no-pager$/m, `${s}`);
    assert.match(r.stderr, /the preview of escape-kernel didn't finish/, `${s}`);
    if (s) assert.ok(r.stderr.includes(JSON.stringify(JSON.parse(s))), `the status, ${s}`);
  }
  // That unit's name is the one worklane-machine gives it.
  assert.ok(read('scripts', 'machine', 'worklane-machine.cjs').includes("const PLUGIN_FETCH_UNIT = 'worklane-plugin-fetch';"));
});
