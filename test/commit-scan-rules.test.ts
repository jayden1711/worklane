// #1128 (R124b on #1124): the commit scan read the gitleaks rules from the working tree's `.gitleaks.toml`, which the
// agent can write, so it chose which secrets the scan looked for. The scan's rules now come only from the scanner's
// built-in rules and the project's rules as committed on origin's default branch, each scanned on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedRules, scanCommit } from '../src/scan/secrets.js';

const skip = spawnSync('gitleaks', ['version']).status !== 0 && 'gitleaks not installed';
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const CUSTOM = `ACME_${'Q7W8E9R0T1Y2U3I4O5P6'}`;
const PROJECT_RULES = `[extend]\nuseDefault = true\n\n[[rules]]\nid = "acme-key"\ndescription = "the project's own key"\nregex = '''ACME_[A-Z0-9]{20}'''\n`;
/** Every way a rules file can turn the scan off: no built-in rules, and an allowlist over every path. */
const WEAKENED = `[extend]\nuseDefault = false\n\n[allowlist]\npaths = ['''.*''']\nregexes = ['''.*''']\n`;
const STAGED = { unstaged: false, untracked: false, head: false };

/** A clone whose origin's main commits `rules` (or none), with a fresh commit's worth of work to scan. */
function clone(rules: string | null) {
  const base = mkdtempSync(join(tmpdir(), 'scan-rules-'));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd: string, m: string) => git(cwd, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', m);
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  if (rules !== null) writeFileSync(join(seed, '.gitleaks.toml'), rules);
  git(seed, 'add', '-A');
  commit(seed, 'base');
  git(base, 'clone', '-q', seed, 'work');
  const top = join(base, 'work');
  return { top, git: (...a: string[]) => git(top, ...a) };
}

test('#1128: a working-tree .gitleaks.toml that turns the rules off never hides a staged secret', { skip }, () => {
  for (const committed of [null, PROJECT_RULES]) {
    const c = clone(committed);
    writeFileSync(join(c.top, '.gitleaks.toml'), WEAKENED);
    writeFileSync(join(c.top, 'config.js'), `export const token = '${TOKEN}';\n`);
    c.git('add', 'config.js');
    const r = scanCommit(c.top, STAGED);
    assert.equal(r.status, 'leaks', `committed rules ${committed ? 'present' : 'absent'}: ${JSON.stringify(r)}`);
  }
});

test('#1128: a staged .gitleaks.toml, in the commit itself, never sets the rules either', { skip }, () => {
  const c = clone(null);
  writeFileSync(join(c.top, '.gitleaks.toml'), WEAKENED);
  writeFileSync(join(c.top, 'config.js'), `export const token = '${TOKEN}';\n`);
  c.git('add', '.gitleaks.toml', 'config.js');
  assert.equal(scanCommit(c.top, STAGED).status, 'leaks');
});

test('#1128: the project\'s own committed rules still hold, whatever the working tree says', { skip }, () => {
  const c = clone(PROJECT_RULES);
  assert.ok(committedRules(c.top)?.toString('utf8').includes('acme-key'));
  writeFileSync(join(c.top, '.gitleaks.toml'), WEAKENED);
  writeFileSync(join(c.top, 'keys.txt'), `key = ${CUSTOM}\n`);
  c.git('add', 'keys.txt');
  const r = scanCommit(c.top, STAGED);
  assert.ok(r.status === 'leaks' && r.findings.some((f) => f.rule === 'acme-key'), JSON.stringify(r));
});

test('#1128: a clean change stays clean, with and without committed rules', { skip }, () => {
  for (const committed of [null, PROJECT_RULES]) {
    const c = clone(committed);
    writeFileSync(join(c.top, 'a.js'), 'export const a = 1;\n');
    c.git('add', 'a.js');
    assert.equal(scanCommit(c.top, STAGED).status, 'clean');
  }
});
