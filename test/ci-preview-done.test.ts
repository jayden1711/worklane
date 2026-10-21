// Every MCP preview in ci-slow's add-project job stops at a failed preview with its real reason (#631, #677): the
// fetch unit's journal tail and the status, instead of a later jq or grep of a preview file that isn't there, or
// readPreview's misleading "fetch it first". One preview_done (scripts/ci/preview-done.sh), sourced by the MCP broker
// step and by mcp-broker-kernel.sh, so the three previews can't drift apart. Its journal tail never prints a line
// holding an MCP secret's value, masked or not. These tests run the shared script with stand-ins for sudo, journalctl
// and getent, and read the workflow and the probe; they never run the escape fixture, sudo or systemd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');
const posix = process.platform !== 'win32';
const hasJq = posix && spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const SHARED = join(repoRoot, 'scripts', 'ci', 'preview-done.sh');

/**
 * preview_done <instance> <id> from the shared script, as the step (bash -e) or the probe (set -euo pipefail) runs it:
 * this status file, this journal, these MCP secret files (under the mcp user's home, as getent gives it).
 * sudoFails: a sudo that fails any command whose words hold this text (else it runs it as is). getent: the broker user
 * found (as a home), absent (getent's exit 2), or the lookup failing (exit 1). unreadable: the secrets dir mode 000.
 */
function previewDone(o: { status: string | null; id?: string; journal?: string[]; secrets?: Record<string, string>; flags?: string; sudoFails?: string; getent?: 'user' | 'absent' | 'error'; unreadable?: boolean }): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'preview-done-'));
  const home = join(dir, 'mcp-home');
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [rel, value] of Object.entries(o.secrets ?? {})) {
      mkdirSync(join(home, 'secrets', rel, '..'), { recursive: true });
      writeFileSync(join(home, 'secrets', rel), value);
    }
    if (o.unreadable) chmodSync(join(home, 'secrets'), 0o000);
    writeFileSync(join(dir, 'journal.txt'), (o.journal ?? []).map((l) => `${l}\n`).join(''));
    // sudo runs the command as is (or fails it); journalctl says what it was asked for, then the journal.
    writeFileSync(join(bin, 'sudo'), `#!/bin/sh\n${o.sudoFails ? `case "$*" in *'${o.sudoFails}'*) echo "sudo: refused" >&2; exit 1 ;; esac\n` : ''}exec "$@"\n`);
    writeFileSync(join(bin, 'journalctl'), `#!/bin/sh\necho "journal: $*"\ncat '${join(dir, 'journal.txt')}'\n`);
    const getent = o.getent ?? 'user';
    writeFileSync(join(bin, 'getent'), getent === 'user' ? `#!/bin/sh\n[ "$1 $2" = "passwd wl-ci-mcp" ] && echo "wl-ci-mcp:x:990:990::${home}:/usr/sbin/nologin" || exit 2\n` : `#!/bin/sh\nexit ${getent === 'absent' ? 2 : 1}\n`);
    for (const f of ['sudo', 'journalctl', 'getent']) chmodSync(join(bin, f), 0o755);
    const status = join(dir, 'status');
    mkdirSync(status);
    if (o.status !== null) writeFileSync(join(status, 'ci.json'), o.status);
    const script = `${o.flags ?? 'set -e'}\n. "$1"\npreview_done ci ${o.id ?? 'escape-kernel'}\necho reached`;
    const r = spawnSync('bash', ['-c', script, 'step', SHARED], { encoding: 'utf8', env: { PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`, LANG: 'C', FETCH_STATUS_DIR: status } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    if (o.unreadable) chmodSync(join(home, 'secrets'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}
const statusOf = (id: string, state: string, reason = '') => `${JSON.stringify({ id, state, reason, at: '2026-10-18T06:35:25Z' })}\n`;

test("preview_done passes a done preview and stops any other with the fetch unit's journal and the status (#631, #677)", { skip: !hasJq && 'bash and jq' }, () => {
  for (const flags of ['set -e', 'set -euo pipefail']) {
    const ok = previewDone({ status: statusOf('escape-kernel', 'done'), journal: ['should not print'], flags });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'reached');
    assert.doesNotMatch(ok.stderr, /journal:|should not print/);
    // Failed (run 39103725841's status), still running when the wait gave up, another id's, or no status at all.
    for (const s of [statusOf('escape-kernel', 'failed', 'the preview could not be made'), statusOf('escape-kernel', 'running'), statusOf('escape', 'done'), null]) {
      const r = previewDone({ status: s, journal: ['plugin escape has no MCP server kernel'], flags });
      assert.notEqual(r.code, 0, `${flags} ${s}`);
      assert.doesNotMatch(r.stdout, /reached/, 'the step stops there');
      assert.match(r.stderr, /^journal: -u worklane-plugin-fetch-ci\.service --no-pager$/m, `${s}`);
      assert.match(r.stderr, /^plugin escape has no MCP server kernel$/m, 'the real reason, from the unit');
      assert.match(r.stderr, /the preview of escape-kernel didn't finish/, `${s}`);
      if (s) assert.ok(r.stderr.includes(JSON.stringify(JSON.parse(s))), `the status, ${s}`);
      else assert.match(r.stderr, /no status/);
    }
  }
  // That unit's name is the one worklane-machine gives it.
  assert.ok(read('scripts', 'machine', 'worklane-machine.cjs').includes("const PLUGIN_FETCH_UNIT = 'worklane-plugin-fetch';"));
});

test('the journal tail never prints a line holding an MCP secret, masked or not; the other lines still print (#677)', { skip: !hasJq && 'bash and jq' }, () => {
  const tok = 'tok-0123456789abcdef01234567';
  const r = previewDone({
    status: statusOf('kit-notes', 'failed', 'the preview could not be made'),
    id: 'kit-notes',
    journal: ['before', `server env NOTES_TOKEN=${tok}`, `${tok}`, 'after'],
    secrets: { 'kit-notes/NOTES_TOKEN': `${tok}\n`, 'other/EMPTY': '', 'other/BLANKS': '\n\n' },
  });
  assert.notEqual(r.code, 0);
  assert.ok(!r.stderr.includes(tok), r.stderr);
  assert.match(r.stderr, /^before$/m);
  assert.match(r.stderr, /^after$/m, 'a secret file that is empty, or only empty lines, hides nothing else');
  assert.match(r.stderr, /2 journal lines holding an MCP secret left out/);
  // No secrets dir yet (none set), or no broker user at all (getent's 2): nothing to hide, every line prints.
  for (const getent of ['user', 'absent'] as const) {
    const none = previewDone({ status: null, id: 'kit-notes', journal: ['a', 'b'], getent });
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /^a$/m, getent);
    assert.match(none.stderr, /^b$/m, getent);
    assert.doesNotMatch(none.stderr, /left out/, getent);
  }
});

test("when the MCP secrets can't be read, the journal is left out, never printed unchecked: fail closed (#677)", { skip: !hasJq && 'bash and jq' }, () => {
  const tok = 'tok-feedfacefeedfacefeedface';
  const unreadable = posix && process.getuid?.() !== 0;
  for (const [why, o] of [
    ['a sudo that fails the secrets read (find)', { sudoFails: 'find' }],
    ['a sudo that fails a root shell', { sudoFails: 'sh -c' }],
    ["the broker user's lookup failing", { getent: 'error' as const }],
    ...(unreadable ? [['a secrets dir that cannot be read', { unreadable: true }] as const] : []),
  ] as const) {
    for (const flags of ['set -e', 'set -euo pipefail']) {
      const r = previewDone({
        status: statusOf('escape-kernel', 'failed', 'the preview could not be made'),
        journal: [`server env NOTES_TOKEN=${tok}`, 'plugin escape has no MCP server kernel'],
        secrets: { 'kit-notes/NOTES_TOKEN': `${tok}\n` },
        flags,
        ...o,
      });
      assert.notEqual(r.code, 0, `${why}: still stops`);
      assert.doesNotMatch(r.stdout, /reached/, why);
      assert.ok(!r.stderr.includes(tok), `${why}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /^journal:|no MCP server kernel/m, `${why}: no journal line at all`);
      assert.match(r.stderr, /\(the journal is left out: the MCP secrets of wl-ci-mcp couldn't be read, so its lines can't be checked for them\)/, why);
      assert.match(r.stderr, /the preview of escape-kernel didn't finish: \{"id":"escape-kernel","state":"failed"/, `${why}: the status still prints`);
    }
  }
  // Its default status dir is the one plugins.sh writes.
  assert.match(read('scripts', 'setup', 'plugins.sh'), /^STATUS_DIR=\/var\/lib\/worklane\/plugins\/fetch-status\b/m);
  assert.ok(read('scripts', 'ci', 'preview-done.sh').includes('st="${FETCH_STATUS_DIR:-/var/lib/worklane/plugins/fetch-status}/$name.json"'));
});

/**
 * Why this step's secret could reach the log unmasked, or null: the variable piped into mcp-broker.sh's secret must be
 * masked (echo "::add-mask::$v" or ${v}) on a line before that use. Both must be there: a missing one is a problem.
 */
function maskProblem(step: string): string | null {
  const use = /printf '%s\\n' "\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?" \| sudo bash scripts\/setup\/mcp-broker\.sh ci secret /.exec(step);
  if (!use) return 'no secret use found';
  const mask = new RegExp(`echo "::add-mask::\\$\\{?${use[1]}\\}?"`).exec(step);
  if (!mask) return `$${use[1]} is never masked`;
  if (mask.index > use.index) return `$${use[1]} is masked only after its use`;
  return null;
}

test('the secret the broker step makes is masked before it is used, and the check sees a mask gone, moved or reworded (#677)', () => {
  const yml = read('.github', 'workflows', 'ci-slow.yml');
  const at = yml.indexOf('      - name: "MCP broker: ');
  assert.ok(at > 0);
  const step = yml.slice(at, yml.indexOf('\n      - name:', at + 1));
  assert.equal(maskProblem(step), null);
  const maskLine = 'tok="tok-$(openssl rand -hex 12)"; echo "::add-mask::$tok"\n';
  const useLine = `printf '%s\\n' "$tok" | sudo bash scripts/setup/mcp-broker.sh ci secret kit-notes NOTES_TOKEN`;
  assert.ok(step.includes(maskLine) && step.includes(useLine), 'the lines as the step has them');
  // In-memory mutations of the step: the mask removed, moved after the use, or written ${tok}.
  assert.equal(maskProblem(step.replace(maskLine, 'tok="tok-$(openssl rand -hex 12)"\n')), '$tok is never masked');
  assert.equal(maskProblem(step.replace('; echo "::add-mask::$tok"', '').replace(useLine, `${useLine}\n          echo "::add-mask::$tok"`)), '$tok is masked only after its use');
  assert.equal(maskProblem(step.replace('echo "::add-mask::$tok"', 'echo "::add-mask::${tok}"')), null, '${tok} is the same mask');
  assert.equal(maskProblem(step.replace(useLine, useLine.replace('"$tok"', '"${tok}"'))), null, 'and the same use');
  assert.equal(maskProblem(step.replace('echo "::add-mask::$tok"', 'echo "::add-mask::$other"')), '$tok is never masked', 'another variable masked');
  assert.equal(maskProblem(step.replace(useLine, '')), 'no secret use found');
});

test("every MCP preview in the add-project job is checked right after its wait, before anything reads it, by the one shared preview_done (#677)", () => {
  const yml = read('.github', 'workflows', 'ci-slow.yml');
  const at = yml.indexOf('      - name: "MCP broker: ');
  const step = yml.slice(at, yml.indexOf('\n      - name:', at + 1));
  assert.ok(step.includes('. scripts/ci/preview-done.sh\n'), 'the step sources the shared check');
  for (const [preview, reads] of [
    ['mcp-preview kit-notes kit notes && wait_status kit-notes\n          preview_done ci kit-notes\n', 'p=/var/lib/worklane/plugins/previews/ci/kit-notes/preview.json'],
    ['mcp-preview escape-probe escape probe && wait_status escape-probe\n          preview_done ci escape-probe\n', 'tries="$(jq -r \'.snapshot.tools[0].description\' /var/lib/worklane/plugins/previews/ci/escape-probe/preview.json)"'],
  ] as const) {
    const i = step.indexOf(preview);
    assert.ok(i > 0, preview);
    assert.ok(i < step.indexOf(reads), `before: ${reads}`);
  }
  // Every mcp-preview in the step, and in the kernel probe, is followed by preview_done on its own id.
  const sh = read('scripts', 'ci', 'mcp-broker-kernel.sh');
  for (const [text, call] of [[step, /mcp-preview (\S+) \S+ \S+ && wait_status \1\n\s*preview_done ci \1\n/g], [sh, /mcp-preview "\$id" escape kernel && wait_status "\$id"\npreview_done "\$name" "\$id"\n/g]] as const) {
    const previews = text.split('\n').filter((l) => /\bmcp-preview\b/.test(l) && !/^\s*#/.test(l)).length;
    assert.ok(previews > 0);
    assert.equal([...text.matchAll(call)].length, previews, 'each preview, checked');
  }
  assert.ok(sh.includes('. "$(dirname "${BASH_SOURCE[0]}")/preview-done.sh"\n'), 'the probe sources the shared check');
  assert.doesNotMatch(sh, /^preview_done\(\)/m, 'no copy of its own');
  const call = sh.indexOf('preview_done "$name" "$id"');
  const digest = sh.indexOf('d="$(digest)"');
  assert.ok(call > 0 && digest > call, 'before the digest reads the preview');
});
