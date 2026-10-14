// The updater keeps the root helpers (scripts/machine/, installed by the setup scripts) in step with each engine it
// installs: a differing one is replaced atomically with the installed file's owner and mode; sudoers is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const machineDir = join(repoRoot, 'scripts', 'machine');

type Helper = { dest: string; src: string; check: 'bash' | 'node' };
const updater = createRequire(import.meta.url)(join(machineDir, 'worklane-update.cjs')) as {
  syncHelpers(engineDir: string, helpers?: Helper[]): { path: string; state: string }[];
  HELPERS: Helper[];
};

test('the updater knows every root helper the setup scripts install from scripts/machine/', () => {
  assert.deepEqual(updater.HELPERS.map((h) => h.src).sort(), readdirSync(machineDir).filter((f) => f !== 'worklane-update.cjs').map((f) => `scripts/machine/${f}`).sort());
  for (const h of updater.HELPERS) assert.match(h.dest, /^\/usr\/local\/libexec\/worklane-[a-z-]+$/);
});

test('the updater reinstalls a helper that differs from the new engine\'s: atomically, same owner and mode; leaves an equal one and never installs an absent one', { skip: !posix && 'POSIX modes' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'helper-sync-'));
  const engine = join(d, 'engine');
  const libexec = join(d, 'libexec');
  mkdirSync(join(engine, 'scripts', 'machine'), { recursive: true });
  mkdirSync(libexec);
  const put = (f: string, text: string, mode = 0o755) => {
    writeFileSync(f, text);
    chmodSync(f, mode);
  };
  put(join(engine, 'scripts', 'machine', 'a.sh'), '#!/bin/bash\necho new\n');
  put(join(engine, 'scripts', 'machine', 'b.sh'), '#!/bin/bash\necho same\n');
  put(join(engine, 'scripts', 'machine', 'c.cjs'), 'module.exports = 1;\n');
  put(join(libexec, 'a'), '#!/bin/bash\necho old\n', 0o750);
  put(join(libexec, 'b'), '#!/bin/bash\necho same\n');
  const helpers: Helper[] = [
    { dest: join(libexec, 'a'), src: 'scripts/machine/a.sh', check: 'bash' },
    { dest: join(libexec, 'b'), src: 'scripts/machine/b.sh', check: 'bash' },
    { dest: join(libexec, 'c'), src: 'scripts/machine/c.cjs', check: 'node' },
  ];
  const before = { a: statSync(join(libexec, 'a')), b: statSync(join(libexec, 'b')) };
  assert.deepEqual(updater.syncHelpers(engine, helpers), [
    { path: join(libexec, 'a'), state: 'updated' },
    { path: join(libexec, 'b'), state: 'same' },
    { path: join(libexec, 'c'), state: 'absent' },
  ]);
  const a = statSync(join(libexec, 'a'));
  assert.equal(readFileSync(join(libexec, 'a'), 'utf8'), '#!/bin/bash\necho new\n');
  assert.equal(a.mode & 0o7777, 0o750, 'the installed mode, not the source\'s');
  assert.deepEqual([a.uid, a.gid], [before.a.uid, before.a.gid]);
  assert.notEqual(a.ino, before.a.ino, 'renamed over it (a running helper keeps its old file), not written in place');
  assert.equal(statSync(join(libexec, 'b')).ino, before.b.ino, 'an equal helper is left alone');
  assert.ok(!existsSync(join(libexec, 'c')), 'a helper the machine does not have is never installed');
  assert.deepEqual(readdirSync(libexec).sort(), ['a', 'b'], 'no temp file left');

  // A new engine's helper that doesn't parse: refused, the installed one unchanged, no temp file left.
  put(join(libexec, 'c'), 'module.exports = 0;\n');
  put(join(engine, 'scripts', 'machine', 'c.cjs'), 'module.exports = (;\n');
  assert.throws(() => updater.syncHelpers(engine, helpers), /couldn't replace .*\/c with .*c\.cjs/);
  assert.equal(readFileSync(join(libexec, 'c'), 'utf8'), 'module.exports = 0;\n');
  put(join(engine, 'scripts', 'machine', 'a.sh'), '#!/bin/bash\nif then\n');
  assert.throws(() => updater.syncHelpers(engine, helpers), /couldn't replace .*\/a with/);
  assert.equal(readFileSync(join(libexec, 'a'), 'utf8'), '#!/bin/bash\necho new\n');
  assert.deepEqual(readdirSync(libexec).sort(), ['a', 'b', 'c']);
  rmSync(d, { recursive: true, force: true });
});
