// src/tool-path.ts: a tool local init installed under the prefix (<prefix>/bin) is found there even when that folder
// isn't on PATH, by doctor, init's checklist, the secret scans and the pre-commit hook; PATH still comes first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { doctor } from '../src/doctor.js';
import { systemIo } from '../src/init.js';
import { installGitHook } from '../src/install.js';
import { which } from '../src/os/index.js';
import { scanPath } from '../src/scan/secrets.js';
import { findTool, toolBin, toolPath, withToolPath } from '../src/tool-path.js';
import { exampleProject } from './helpers.js';

const skip = process.platform === 'win32' && 'sh stand-ins (macOS and Linux)';
const PREFIX_VAR = `${BRAND.envPrefix}_PREFIX`;

/** A PATH holding node and git only (no gitleaks anywhere on it), and a prefix whose bin has a stand-in gitleaks. */
function machine() {
  const dir = mkdtempSync(join(tmpdir(), 'tool-path-'));
  const bin = join(dir, 'path-bin');
  mkdirSync(bin);
  for (const t of ['node', 'git', 'sh']) symlinkSync(which(t)!, join(bin, t));
  const prefix = join(dir, 'prefix');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const calls = join(dir, 'gitleaks-calls');
  const gl = join(prefix, 'bin', 'gitleaks');
  writeFileSync(gl, `#!/bin/sh\necho "$1" >> "${calls}"\ncase "$1" in version) echo 8.30.1-stand-in ;; esac\nexit 0\n`);
  chmodSync(gl, 0o755);
  const path = [bin, '/usr/bin', '/bin'].join(delimiter);
  return { dir, prefix, path, calls, gl };
}

/** Run `fn` with this PATH and prefix, then put both back. */
function within<T>(m: { path: string; prefix: string }, fn: () => T): T {
  const saved = { PATH: process.env.PATH, prefix: process.env[PREFIX_VAR] };
  process.env.PATH = m.path;
  process.env[PREFIX_VAR] = m.prefix;
  try {
    return fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.prefix === undefined) delete process.env[PREFIX_VAR];
    else process.env[PREFIX_VAR] = saved.prefix;
  }
}

test("the prefix's bin is searched after PATH, once", () => {
  const env = { PATH: ['/a', '/b'].join(delimiter), [PREFIX_VAR]: '/p' };
  assert.equal(toolBin(env), join('/p', 'bin'));
  assert.equal(toolPath(env.PATH, env), ['/a', '/b', join('/p', 'bin')].join(delimiter));
  assert.equal(toolPath(['/a', join('/p', 'bin')].join(delimiter), env), ['/a', join('/p', 'bin')].join(delimiter));
  assert.equal(withToolPath(env).PATH, toolPath(env.PATH, env));
});

test('a tool only in the prefix: found by the resolver and init, and PATH still wins', { skip }, () => {
  const m = machine();
  within(m, () => {
    assert.equal(which('gitleaks'), null, 'not on PATH');
    assert.equal(findTool('gitleaks'), m.gl);
    assert.equal(systemIo({ interactive: false }).which('gitleaks'), m.gl);
    // init runs tools by name: they reach the prefix too.
    assert.equal(systemIo({ interactive: false }).run('gitleaks', ['version']).stdout.trim(), '8.30.1-stand-in');
  });
  const own = join(m.dir, 'path-bin', 'gitleaks');
  writeFileSync(own, '#!/bin/sh\nexit 0\n');
  chmodSync(own, 0o755);
  within(m, () => assert.equal(findTool('gitleaks'), own));
});

test('a gitleaks only in the prefix: doctor finds it, and the scans run it', { skip }, () => {
  const m = machine();
  const { dir } = exampleProject();
  within(m, () => {
    const gl = doctor(dir).find((c) => c.name === 'gitleaks')!;
    assert.deepEqual([gl.level, gl.detail], ['ok', '8.30.1-stand-in']);
    assert.deepEqual(scanPath(join(dir, 'package.json')), { status: 'clean' });
  });
  assert.match(readFileSync(m.calls, 'utf8'), /^dir$/m, 'the scan ran the stand-in');
});

test("the pre-commit hook finds a gitleaks in the prefix when a commit's PATH lacks it", { skip }, () => {
  const m = machine();
  const { dir } = exampleProject();
  within(m, () => installGitHook(dir));
  writeFileSync(join(dir, 'new.txt'), 'x\n');
  execFileSync('git', ['add', 'new.txt'], { cwd: dir });
  const r = spawnSync('git', ['commit', '-q', '-m', 'add'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: m.path } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(m.calls, 'utf8'), /^dir$/m, 'the hook ran the stand-in');
  assert.ok(existsSync(join(dir, '.git')));
});
