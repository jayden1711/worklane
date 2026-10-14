import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const setup = join(repoRoot, 'scripts', 'setup');

/**
 * The two root installs copy a helper to a temp name, `node --check` it, then move it into place. Run that
 * exact check, on the real helper under the script's real temp name: an extension node doesn't know (such as
 * .tmp) fails before anything is installed, which CI never exercised because the step needs root.
 */
for (const [script, helper] of [
  ['machine-helper.sh', 'worklane-machine.cjs'],
  ['updates.sh', 'worklane-update.cjs'],
] as const) {
  test(`${script}: its install step's node --check passes on the temp name it uses`, () => {
    const text = readFileSync(join(setup, script), 'utf8');
    // The temp file's own name: what follows the last / on the tmp= line (the directory part may hold quotes).
    const m = text.match(/^tmp=.*\/([^/"\s]+)"?\s*$/m);
    assert.ok(m, `${script} sets tmp=`);
    const name = m![1]!;
    const at = join(mkdtempSync(join(tmpdir(), 'install-')), name);
    copyFileSync(join(repoRoot, 'scripts', 'machine', helper), at);
    const r = spawnSync(process.execPath, ['--check', at], { encoding: 'utf8' });
    assert.equal(r.status, 0, `node --check ${name}: ${r.stderr}`);
    // The check runs on that same temp name, and a leftover from the old name is removed.
    assert.match(text, /^node --check "\$tmp"$/m);
    assert.match(text, /^rm -f .*\.worklane-(machine|update)\.tmp"?\s/m);
  });
}
