// The commit secret scan (#971), fifth round: a secret is new when a changed file holds it more times after the commit
// than before, whatever a diff algorithm would make of the change; the checkout's own path rules see each file at its
// own path; the line reader handles the remaining option and pattern spellings; and the config programs git runs while
// reading are refused exactly where git runs them, in every checkout and submodule the line reads. Scratch checkouts,
// a test token and fake keys only; real gitleaks, as test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { repoRoot } from '../helpers.js';

// WHY (#971, round 6): the host's own git config (system and user) must not change what these tests see.
const GIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gitconfig-'));
writeFileSync(join(GIT_CONFIG_DIR, 'config'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(GIT_CONFIG_DIR, 'config');

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const skip = !hasGitleaks && 'gitleaks not installed';

const TOKEN = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
const SECRET = `export const token = '${TOKEN}';\n`;
const L: Record<string, string> = {
  B: `${'-----BEGIN'} RSA PRIVATE KEY-----`,
  E: `${'-----END'} RSA PRIVATE KEY-----`,
  p: 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
  q: 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
  x: 'x',
  y: 'y',
  '': '',
};
const lines = (ks: string[]) => `${ks.map((k) => L[k]).join('\n')}\n`;
const FOUND = /gitleaks found a secret in this commit/;
const UNMODELLED = /the commit secret scan can't (tell what this command line commits|read this command line)/;
const NOT_RUN = /commit secret scan could not run/;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

function checkout(name = 'a'): string {
  const d = join(mkdtempSync(join(tmpdir(), `${name}-`)), name);
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'notes.md'), 'notes\n');
  writeFileSync(join(d, 'config.js'), 'export const x = 1;\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

const env = () => ({ HOME: mkdtempSync(join(tmpdir(), 'home-')), [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')), [`${BRAND.envPrefix}_AGENT`]: '1' });

async function decide(cwd: string, command: string): Promise<{ decision: string; reason: string }> {
  const r = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } }, env());
  assert.equal(r.exitCode, 0, r.stderr);
  if (!r.stdout) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}

async function refused(cwd: string, command: string, why: RegExp, what = command) {
  const d = await decide(cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${JSON.stringify(what)}`);
  assert.match(d.reason, why, JSON.stringify(what));
}

async function allowed(cwd: string, command: string, what = command) {
  const d = await decide(cwd, command);
  assert.equal(d.decision, 'allow', `allowed: ${JSON.stringify(what)} (${d.reason})`);
}

/** A checkout with keys.md committed as `before`, then `after` staged (or left in the working tree). */
function keyChange(before: string[], after: string[], stage: boolean, algorithm?: string): string {
  const a = checkout();
  if (algorithm) git(a, 'config', 'diff.algorithm', algorithm);
  writeFileSync(join(a, 'keys.md'), lines(before));
  git(a, 'add', 'keys.md');
  git(a, 'commit', '-q', '-m', 'before');
  writeFileSync(join(a, 'keys.md'), lines(after));
  if (stage) git(a, 'add', 'keys.md');
  return a;
}

test('attack: a multi-line secret added where a diff would split it is found, whatever the diff algorithm', { skip }, async () => {
  const shapes: [string, string[], string[], string | undefined][] = [
    ['a key whose lines a default diff scatters', ['x', 'y', 'q', '', 'q', 'p', 'q', 'E'], ['', 'B', 'p', 'E', '', '', '', '', 'p', 'x', 'q', 'E'], undefined],
    ['a key whose lines a histogram diff scatters', ['B', 'B', 'q'], ['x', '', 'q', 'p', 'B', 'E', 'x', 'q', 'q', 'B', 'E', 'B'], 'histogram'],
  ];
  for (const [what, before, after, algorithm] of shapes) {
    await refused(keyChange(before, after, true, algorithm), 'git commit -m x', FOUND, `${what}, staged`);
    await refused(keyChange(before, after, false, algorithm), 'git commit -am x', FOUND, `${what}, working tree`);
  }
});

/** The private keys gitleaks finds in `text`, each as its secret. */
function keysIn(text: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  try {
    writeFileSync(join(dir, 'f.md'), text);
    const report = join(dir, 'r.json');
    const r = spawnSync('gitleaks', ['dir', join(dir, 'f.md'), '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', '3'], { encoding: 'utf8' });
    if (r.status !== 3) return [];
    return (JSON.parse(readFileSync(report, 'utf8')) as { Secret: string }[]).map((f) => f.Secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('attack: fuzzed key changes: whatever any diff algorithm shows as a new key, the scan refuses', { skip }, async () => {
  let seed = 971;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = () => (['B', 'E', 'p', 'q', 'x', ''] as const)[Math.floor(rnd() * 6)]!;
  const seq = () => Array.from({ length: 4 + Math.floor(rnd() * 8) }, pick);
  let checked = 0;
  for (let i = 0; i < 40 && checked < 12; i++) {
    const before = seq();
    const after = seq();
    const a = keyChange(before, after, true);
    // WHY: a key that some algorithm's added lines hold, and that the file holds more often after than before, is
    // what main's diff scan could find; the scan must find it whatever placement its own reading would give.
    const had = keysIn(lines(before));
    const now = keysIn(lines(after));
    const grown = new Set(now.filter((k) => now.filter((x) => x === k).length > had.filter((x) => x === k).length));
    let shown = false;
    for (const algorithm of ['myers', 'patience', 'histogram']) {
      const diff = execFileSync('git', ['-C', a, 'diff', '--cached', '-U0', '--no-color', `--diff-algorithm=${algorithm}`, '--', 'keys.md'], { encoding: 'utf8' });
      const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
      if (keysIn(`${added}\n`).some((k) => grown.has(k))) shown = true;
    }
    if (!grown.size) continue;
    checked++;
    // WHY: refused either way: shown whole by some algorithm (what main's scan could find), or new without that.
    await refused(a, 'git commit -m x', FOUND, `case ${i}${shown ? '' : ' (a new key no diff shows whole)'}: ${JSON.stringify([before, after])}`);
  }
  assert.ok(checked >= 6, `the fuzz reached enough cases with a new key (${checked})`);
});

test('a file that already holds a secret still commits when that secret is held no more often', { skip }, async () => {
  const a = checkChange();
  await allowed(a, 'git commit -m x', 'a fixture key kept, another line changed');
  function checkChange() {
    const d = checkout();
    writeFileSync(join(d, 'fixture.md'), `${lines(['B', 'p', 'q', 'E'])}note one\n`);
    git(d, 'add', 'fixture.md');
    git(d, 'commit', '-q', '-m', 'fixture');
    writeFileSync(join(d, 'fixture.md'), `note zero\n${lines(['B', 'p', 'q', 'E'])}note two\n`);
    git(d, 'add', 'fixture.md');
    return d;
  }
});

test('attack: the checkout\'s own path rules see each file at its own path, as on main', { skip }, async () => {
  const cases: [string, string, string, 'found' | 'allowed'][] = [
    ['an anchored allowlist path that matches', '^docs/', 'docs/x.js', 'allowed'],
    ['an allowlist path needing a folder before the name', '.*/test/.*', 'test/x.js', 'found'],
    ['an allowlist path needing a slash before the name', '/config\\.js$', 'config.js', 'found'],
    ['an allowlist path for a folder the checkout does not have', '^commit/', 'src/x.js', 'found'],
    ['an unanchored allowlist path', 'docs/', 'docs/x.js', 'allowed'],
    ['an allowlist path anchored at a folder', '(^|/)docs/', 'docs/x.js', 'allowed'],
  ];
  for (const [what, re, path, want] of cases) {
    const a = checkout();
    writeFileSync(join(a, '.gitleaks.toml'), `[extend]\nuseDefault = true\n\n[allowlist]\npaths = ['''${re}''']\n`);
    git(a, 'add', '.gitleaks.toml');
    git(a, 'commit', '-q', '-m', 'rules');
    mkdirSync(join(a, path, '..'), { recursive: true });
    writeFileSync(join(a, path), SECRET);
    git(a, 'add', path);
    if (want === 'found') await refused(a, 'git commit -m x', FOUND, what);
    else await allowed(a, 'git commit -m x', what);
  }
  const r = checkout('r');
  writeFileSync(join(r, '.gitleaks.toml'), `[extend]\nuseDefault = true\n\n[[rules]]\nid = "docs-marker"\nregex = '''zzmarker[0-9]{6}'''\npath = '''^docs/'''\n`);
  git(r, 'add', '.gitleaks.toml');
  git(r, 'commit', '-q', '-m', 'rules');
  mkdirSync(join(r, 'docs'), { recursive: true });
  writeFileSync(join(r, 'docs', 'x.txt'), 'value zzmarker123456\n');
  git(r, 'add', 'docs/x.txt');
  await refused(r, 'git commit -m x', FOUND, 'a rule scoped to an anchored path');
  const s = checkout('s');
  writeFileSync(join(s, '.gitleaksignore'), SECRET);
  writeFileSync(join(s, '.gitleaksignore.content'), 'nothing\n');
  git(s, 'add', '.gitleaksignore', '.gitleaksignore.content');
  await refused(s, 'git commit -m x', FOUND, 'a secret in a file named like the scanner\'s ignore list');
});

test('attack: the remaining option and pattern spellings are read as the shell reads them', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'config.js'), SECRET);
  for (const c of [
    'echo commit | xargs -l -I SUB git SUB -am x', 'echo commit | xargs --max-lines -I SUB git SUB -am x',
    'echo commit | xargs --eof -I SUB git SUB -am x', 'echo commit | xargs -e -I SUB git SUB -am x',
    'if true; then echo commit | /usr/bin/xargs -I SUB git SUB -am x; fi',
    'git c[o\\ ]mmit -am x', 'git c[o\\;]mmit -am x', 'g[i\\ ]t commit -am x', './g[i\\ ]t commit -am x',
  ]) await refused(a, c, UNMODELLED);
});

test('the exempt programs are only ones that cannot run another program', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'config.js'), SECRET);
  for (const c of ['hash git commit', 'test git commit', '[ git commit ]', 'printf git commit']) await refused(a, c, UNMODELLED);
});

const program = (d: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'prog-')), 'prog.sh');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};

test('config programs are refused where git runs them, and only there', { skip }, async () => {
  const clean = () => {
    const d = checkout();
    writeFileSync(join(d, 'ok.js'), 'export const ok = 1;\n');
    git(d, 'add', 'ok.js');
    return d;
  };
  let a = clean();
  git(a, 'config', 'diff.external', program(a));
  await allowed(a, 'git commit -m x', 'an external diff, no diff shown before the commit');
  await refused(a, 'git diff --cached && git commit -m x', NOT_RUN, 'an external diff, a diff shown before the commit');
  a = clean();
  git(a, 'config', 'diff.hide.textconv', program(a));
  writeFileSync(join(a, '.git', 'info', 'attributes'), '*.js diff=hide\n');
  await allowed(a, 'git status && git log --oneline -3 && git commit -m x', 'a text conversion, no diff shown');
  await refused(a, 'git log -1 -p && git commit -m x', NOT_RUN, 'a text conversion, a patch shown');
  await refused(a, 'git show && git commit -m x', NOT_RUN, 'a text conversion, a commit shown');
  a = clean();
  git(a, 'config', 'core.fsmonitor', 'true');
  await allowed(a, 'git status && git commit -m x', 'git\'s own monitor daemon');
});

test('attack: a signature program the config names is refused when the line shows signatures', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'ok.js'), 'export const ok = 1;\n');
  git(a, 'add', 'ok.js');
  git(a, 'config', 'gpg.program', program(a));
  // WHY (round 6): config can ask for signatures in many ways, so with a signature program set any log refuses.
  await refused(a, 'git log -1 --oneline && git commit -m x', NOT_RUN, 'signatures not asked for in the line');
  await allowed(a, 'git commit -m x', 'no log or show before the commit');
  await refused(a, 'git log --show-signature -1 && git commit -m x', NOT_RUN, 'signatures asked for in the line');
  await refused(a, "git log -1 --format='%G?' && git commit -m x", NOT_RUN, 'a signature format asked for in the line');
  git(a, 'config', 'log.showSignature', 'true');
  await refused(a, 'git log -1 --oneline && git commit -m x', NOT_RUN, 'signatures shown by config');
});

test('attack: a submodule\'s own config and another checkout a read names are checked too', { skip }, async () => {
  const sub = checkout('sub');
  const a = checkout();
  execFileSync('git', ['-C', a, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib'], { stdio: 'ignore' });
  git(a, 'commit', '-q', '-m', 'submodule');
  git(join(a, 'lib'), 'config', 'core.fsmonitor', program(a));
  writeFileSync(join(a, 'ok.js'), 'export const ok = 1;\n');
  git(a, 'add', 'ok.js');
  await refused(a, 'git commit -m x', NOT_RUN, 'a monitor program in a submodule\'s config');
  const other = checkout('other');
  git(other, 'config', 'core.fsmonitor', program(other));
  const b = checkout('b');
  writeFileSync(join(b, 'ok.js'), 'export const ok = 1;\n');
  git(b, 'add', 'ok.js');
  await refused(b, `git -C ${other} status && git commit -m x`, NOT_RUN, 'a read in another checkout with a monitor program');
});

test('a configured filter its files use refuses with why and what to do', { skip }, async () => {
  const a = checkout();
  git(a, 'config', 'filter.lfs.clean', 'cat');
  writeFileSync(join(a, '.gitattributes'), '*.bin filter=lfs\n');
  writeFileSync(join(a, 'x.bin'), 'data\n');
  git(a, 'add', '.gitattributes', 'x.bin');
  git(a, 'commit', '-q', '-m', 'lfs');
  writeFileSync(join(a, 'ok.js'), 'export const ok = 1;\n');
  git(a, 'add', 'ok.js');
  const d = await decide(a, 'git commit -m x');
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /filter its config names \(lfs\).*a person commits here, or the owner removes the filter/);
});
