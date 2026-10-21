// The push limits' SKILL.md lint reads each touched skill by its bytes and fails closed (#724, round 2). A name that
// isn't valid UTF-8 comes back from the changed-names helper with U+FFFD, so `git show <head>:<name>` can't find it;
// the old reader took that failure as "deleted by the change" and skipped the lint: a failing
// .claude/skills/\xff/SKILL.md was pushed (0 problems, measured). Now "deleted" comes only from head's tree, each blob
// is read by its object id, and a touched SKILL.md that can't be read is a problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GOOD = '## When to use\nx\n## Inputs and access\nx\n## Steps\nx\n## Validate\nx\n## Return\nx\n## Approval\nx\n';
const BAD = '## When to use\nx\n';
const linux = { skip: process.platform !== 'linux' && 'names that are not UTF-8 on disk: Linux only' };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'push-skill-names-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(dir, 'config', k!, v!);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Write `text` at .claude/skills/<0xff>/SKILL.md (a directory whose name isn't valid UTF-8) and commit it. */
function addOddSkill(dir: string, text: string): string {
  const skills = Buffer.from(join(dir, '.claude', 'skills') + '/');
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  const odd = Buffer.concat([skills, Buffer.from([0xff])]);
  mkdirSync(odd);
  writeFileSync(Buffer.concat([odd, Buffer.from('/SKILL.md')]), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add a skill');
  return git(dir, 'rev-parse', 'HEAD');
}

const skillProblems = (p: string[]) => p.filter((x) => x.includes('skill lint'));

test('a failing SKILL.md whose directory name isn\'t valid UTF-8 is refused by the skill lint', linux, () => {
  const r = repo();
  const head = addOddSkill(r.dir, BAD);
  const p = pushProblems(r.dir, r.base, head, DEFAULT_PUSH_LIMITS);
  assert.equal(skillProblems(p).length, 1, p.join('\n'));
  assert.match(skillProblems(p)[0]!, /the "Inputs and access" section is missing|Inputs and access/);
});

test('a passing SKILL.md under the same odd name passes: it is read by its bytes, not refused for its name', linux, () => {
  const r = repo();
  const head = addOddSkill(r.dir, GOOD);
  assert.deepEqual(pushProblems(r.dir, r.base, head, DEFAULT_PUSH_LIMITS), []);
});

test('an odd-named failing SKILL.md the change deletes again is not linted: "deleted" comes from head\'s tree', linux, () => {
  const r = repo();
  addOddSkill(r.dir, BAD);
  git(r.dir, 'rm', '-q', '-r', '.claude');
  git(r.dir, 'commit', '-q', '-m', 'drop it');
  assert.deepEqual(skillProblems(pushProblems(r.dir, r.base, git(r.dir, 'rev-parse', 'HEAD'), DEFAULT_PUSH_LIMITS)), []);
});

test('a touched SKILL.md that is no file at head (a submodule link) is a problem, never a skip', () => {
  const r = repo();
  git(r.dir, 'update-index', '--add', '--cacheinfo', `160000,${r.base},.claude/skills/x/SKILL.md`);
  git(r.dir, 'commit', '-q', '-m', 'a link named SKILL.md');
  const p = pushProblems(r.dir, r.base, git(r.dir, 'rev-parse', 'HEAD'), DEFAULT_PUSH_LIMITS);
  assert.equal(skillProblems(p).length, 1, p.join('\n'));
  assert.match(skillProblems(p)[0]!, /\.claude\/skills\/x\/SKILL\.md \(can't be read at the head/);
});
