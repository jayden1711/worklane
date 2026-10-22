// The commit secret scan (#971), round 7: a large-file object path that is a named pipe refuses the commit with its
// reason, instead of blocking the guard on a read. Kept apart from the other round-7 tests: on a build without the
// check, this read blocks the whole test process, so it can't be part of a fail-without run. POSIX only (mkfifo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { repoRoot } from '../helpers.js';

// WHY: the host's own git config (system and user) must not change what these tests see.
const GIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gitconfig-'));
writeFileSync(join(GIT_CONFIG_DIR, 'config'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(GIT_CONFIG_DIR, 'config');

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const hasMkfifo = spawnSync('mkfifo', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = process.platform === 'win32' ? 'named pipes need POSIX' : !hasGitleaks ? 'gitleaks not installed' : !hasMkfifo && 'mkfifo not installed';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

test('attack: a large-file object that is a named pipe refuses the commit, never blocks the guard', { skip }, async () => {
  const d = join(mkdtempSync(join(tmpdir(), 'fifo-')), 'a');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const [k, v] of [['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.smudge', 'git-lfs smudge -- %f'], ['filter.lfs.process', 'git-lfs filter-process'], ['filter.lfs.required', 'true']]) git(d, 'config', k!, v!);
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'attributes');
  const oid = 'b'.repeat(64);
  mkdirSync(join(d, '.git', 'lfs', 'objects', 'bb', 'bb'), { recursive: true });
  execFileSync('mkfifo', [join(d, '.git', 'lfs', 'objects', 'bb', 'bb', oid)]);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`;
  const blob = execFileSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { input: pointer, encoding: 'utf8' }).trim();
  git(d, 'update-index', '--add', '--cacheinfo', `100644,${blob},a.txt`);
  writeFileSync(join(d, 'a.txt'), pointer);
  const r = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: d, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, {
    HOME: mkdtempSync(join(tmpdir(), 'home-')),
    [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')),
    [`${BRAND.envPrefix}_AGENT`]: '1',
  });
  assert.match(r.stdout ?? '', /"permissionDecision":"deny"/);
  assert.match(r.stdout ?? '', /not a regular file/);
});
