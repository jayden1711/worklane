import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

// The acceptance tests that need a booted systemd run in one place, ci.yml's systemd-acceptance job on GitHub's VM
// (#1165's follow-up): the self-hosted tests runner's container skips them, and the main-only runner has no sudo.

type Script = {
  systemdTests: (text: string) => string[];
  gateCount: (text: string) => number;
  findAll: (dir: string) => { file: string; names: string[] }[];
  problems: (tap: string, names: string[]) => string[];
};
const sa = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance.mjs')).href)) as Script;

type Step = { run?: string; uses?: string; name?: string };
type Job = { name?: string; if?: string; 'runs-on'?: unknown; container?: unknown; 'continue-on-error'?: unknown; steps?: Step[] };

test('every test gated on systemCi is found by its gate, and the 3 from #1165 are among them', () => {
  const found = sa.findAll(join(repoRoot, 'test'));
  const names = found.flatMap((f) => f.names);
  for (const want of [
    "acceptance: built as a DynamicUser and installed, the engine is readable by and starts as other users, exec'd through a symlink like the services do",
    "acceptance: lib.sh's sudo_version reads the runner's real sudo -V, as 1.9.10 or later (the pattern rules' minimum)",
    "acceptance: two instances' agent users each get their own /tmp, so a fixed path like /tmp/cc-socks locks neither out",
  ]) assert.ok(names.includes(want), want);
  assert.equal(new Set(names).size, names.length, 'each name once: the run selects tests by name');
});

test('a systemCi gate outside a test() call the script reads stops it, so no gated test is left out', () => {
  // The gate's text built from parts: written whole, this file's fixtures would be gates the script finds.
  const gate = (sp = ' ') => `skip:${sp}!${'system'}Ci`;
  assert.deepEqual(sa.systemdTests(`test('a', { ${gate()} && 'x' }, () => {});\ntest("b's", { ${gate()} }, () => {});`), ['a', "b's"]);
  assert.deepEqual(sa.systemdTests(`test('it\\'s', { ${gate()} && 'x' }, () => {});`), ["it's"]);
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  writeFileSync(join(dir, 'odd.test.ts'), `const o = { ${gate()} };\ntest('a', o, () => {});\n`);
  assert.throws(() => sa.findAll(dir), /test\/odd\.test\.ts: 1 systemCi gate\(s\), 0 in a test\(\) call/);
  assert.equal(sa.gateCount(`{ ${gate()} } { ${gate('')} }`), 2);
});

test('a gated test passes the run only by running and passing: a skip, a todo, a failure or no result each fail it', () => {
  const names = ['acceptance: a', 'acceptance: b # c'];
  const ok = 'TAP version 13\nok 1 - acceptance: a\nok 2 - acceptance: b \\# c\n1..2\n';
  assert.deepEqual(sa.problems(ok, names), []);
  assert.deepEqual(sa.problems('ok 1 - acceptance: a # SKIP needs systemd\nok 2 - acceptance: b \\# c\n', names), ['acceptance: a: SKIP needs systemd (it must run here: this is the one place it does)']);
  assert.deepEqual(sa.problems('ok 1 - acceptance: a # TODO later\nok 2 - acceptance: b \\# c\n', names), ['acceptance: a: TODO later (it must run here: this is the one place it does)']);
  assert.deepEqual(sa.problems('not ok 1 - acceptance: a\nok 2 - acceptance: b \\# c\n', names), ['acceptance: a: failed']);
  assert.deepEqual(sa.problems('ok 1 - acceptance: a\n', names), ["acceptance: b # c: didn't run"]);
  // A subtest's line (indented) is not the test's own result.
  assert.deepEqual(sa.problems('    ok 1 - acceptance: a\n', ['acceptance: a']), ["acceptance: a: didn't run"]);
});

test("ci.yml's systemd-acceptance job: GitHub's VM on each push to main, never self-hosted, running the script last", () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { on: { push?: { branches?: string[] } }; jobs: Record<string, Job> };
  assert.deepEqual(wf.on.push?.branches, ['main'], 'a push runs it on main only');
  const job = wf.jobs['systemd-acceptance'];
  assert.ok(job, 'the job is there');
  assert.equal(job.name, 'systemd acceptance (real systemd)');
  assert.equal(job.if, "github.event_name == 'push'", 'each push to main, never a PR');
  // A literal GitHub image: no expression could route it to a self-hosted runner, and no container (no systemd there).
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.container, undefined);
  assert.equal(job['continue-on-error'], undefined, 'its failure is a failure');
  assert.doesNotMatch(JSON.stringify(job), /CI_SELF_HOSTED|self-hosted|trusted-/);
  const steps = job.steps ?? [];
  assert.equal(steps.at(-1)?.run, 'node scripts/ci/systemd-acceptance.mjs', 'the script is the last step, run as itself');
  const i = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const pins = i((s) => s.run === 'node scripts/ci/check-pins.mjs');
  assert.ok(i((s) => s.run === 'npm ci --ignore-scripts') >= 0 && pins > i((s) => s.run === 'npm ci --ignore-scripts'), 'installed with no package scripts, pins checked before the build');
  assert.ok(i((s) => /tsc -p tsconfig\.json/.test(s.run ?? '')) > pins, 'built with the locked tsc after the pin check');
  assert.ok(i((s) => /scripts\/setup\/machine\.sh/.test(s.run ?? '')) < steps.length - 1, 'machine.sh before the tests');
});
