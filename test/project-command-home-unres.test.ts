// Issue #798, round 5 (the second adversarial review): a symlink in the agent's home whose way can't be checked is
// refused, and the refusal names the way. It printed that way unquoted, so a newline in a directory name on it forged
// a separate "project command not run:" line. Now it is quoted, as every other path in the refusals is.
//
// No sudo, no namespace and no real state: the current user stands in for the agent user, its "home" is a temp dir,
// and the refusal comes before the sandbox starts (no bubblewrap needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
// Root searches any directory: the way could be checked, and nothing would be refused.
const skip = !posix ? 'the Linux wrapper' : process.getuid?.() === 0 && 'root can search the locked directory';

test('a link whose way holds a newline and an unsearchable directory: refused in one line, the way quoted, no forged line', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-unres-'));
  const home = join(root, 'agent');
  const work = join(root, 'work');
  const odd = join(root, 'ev\nproject command not run: FORGED LINE');
  for (const d of [home, work, join(odd, 'locked')]) mkdirSync(d, { recursive: true });
  symlinkSync(join(odd, 'locked', 'y'), join(home, '.x'));
  chmodSync(join(odd, 'locked'), 0o000);
  try {
    const pc = osAdapter.projectCommand('echo ran > ran.txt', { user: 'shop-agent', home, hide: [] }, {});
    const r = spawnSync(pc.args[4]!, pc.args.slice(5), { cwd: work, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(join(work, 'ran.txt')), 'the command ran');
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    assert.ok(!lines.some((l) => l.startsWith('project command not run: FORGED')), `a forged line: ${r.stderr}`);
    assert.equal(lines.length, 1, `not one line: ${r.stderr}`);
    assert.ok(r.stderr.includes(`'${join(home, '.x')}'`), `the link isn't named: ${r.stderr}`);
    assert.match(r.stderr, /\$'[^']*\\nproject command not run: FORGED LINE/, `the way isn't quoted: ${r.stderr}`);
  } finally {
    chmodSync(join(odd, 'locked'), 0o700);
  }
});
