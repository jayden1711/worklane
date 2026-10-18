import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';
import { engineCli, exampleProject } from './helpers.js';

const script = fileURLToPath(new URL('../../scripts/check-comments.mjs', import.meta.url));

/** WHY: a managed repo runs the CLI and this repo runs the script (#330); both must say the same, word for word. */
function both(dir: string, args: string[]) {
  const run = (argv: string[]) => {
    const r = spawnSync('node', argv, { cwd: dir, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cli = run([engineCli, 'check-comments', ...args]);
  const viaScript = run([script, ...args]);
  assert.deepEqual(cli, viaScript, 'the CLI and the script agree');
  return cli;
}

/** WHY: a committed base with the policy on or off (#330: CI reads the base's config), and a git helper. */
function project(on: boolean) {
  const { dir } = exampleProject();
  if (on) appendFileSync(join(dir, BRAND.configDir, 'config.yaml'), 'comment_policy: { enabled: true }\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const change = (text: string) => {
    writeFileSync(join(dir, 'src', 'x.ts'), text);
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  };
  return { dir, base, change };
}

test('check-comments: a finding exits 1 with file:line, the same from the CLI and the script', () => {
  const { dir, base, change } = project(true);
  change('// untagged\nexport const x = 1;\n');
  const r = both(dir, ['--base', base, '--head', 'HEAD']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^src\/x\.ts:1: no WHY:, INVARIANT: or issue\/decision id$/m);
});

test('check-comments: a passing change exits 0; the policy off at the base exits 0 saying "off"', () => {
  const on = project(true);
  on.change('// WHY: the API counts from 1 (#4)\nexport const x = 1;\n');
  const pass = both(on.dir, ['--base', on.base]);
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /every comment added in .* passes/);
  const off = project(false);
  off.change('// untagged\nexport const x = 1;\n');
  const r = both(off.dir, ['--base', off.base, '--head', 'HEAD']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^comment policy: off in the config at /);
});

test('check-comments: no --base, or a base git can\'t resolve, exits 2', () => {
  const { dir } = project(true);
  assert.equal(spawnSync('node', [engineCli, 'check-comments'], { cwd: dir, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script], { cwd: dir, encoding: 'utf8' }).status, 2);
  const r = both(dir, ['--base', 'no-such-rev']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comment policy: could not check no-such-rev\.\.HEAD/);
});
