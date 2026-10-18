// The pre-push hook loads the gate and its rules from origin's default branch, fetched on that push
// (scripts/push-gate-hook.mjs, installed by scripts/setup-hooks.mjs). Real repos: a bare origin, a seed clone
// that moves origin on, and a work clone that is stale unless a test fetches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const launcher = join(repoRoot, 'scripts', 'push-gate-hook.mjs');
const installer = join(repoRoot, 'scripts', 'setup-hooks.mjs');
const skip = !which('gitleaks') && 'gitleaks not installed';
const AGENT = `${BRAND.envPrefix}_AGENT`;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const files = JSON.parse(execFileSync('node', [launcher, '--print-gate-files'], { encoding: 'utf8' })) as { code: string[]; rules: { required: string[]; optional: string[] } };
const realPatterns = (JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] }).patterns;
const rules = (...terms: string[]) => JSON.stringify({ hashed: terms.map(sha), patterns: realPatterns });

type Run = SpawnSyncReturns<string>;
interface Clone {
  dir: string;
  git: (...a: string[]) => string;
  write: (file: string, text: string) => void;
  commit: (file: string, text: string, msg?: string) => void;
}

function clone(dir: string): Clone {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  return {
    dir,
    git,
    write,
    commit: (file, text, msg = 'change') => {
      write(file, text);
      git('add', file);
      git('commit', '-q', '-m', msg);
    },
  };
}

function identity(c: Clone) {
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) c.git('config', k!, v!);
}

/**
 * A bare origin whose main holds `tree` (default: this repo's real gate, its launcher and one denied term,
 * "secretproject"), a seed clone to move origin on with, and a work clone with the hook installed.
 */
function world(o: { tree?: Record<string, string>; originBranch?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pushhook-'));
  const origin = join(base, 'origin.git');
  const branch = o.originBranch ?? 'main';
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin]);
  mkdirSync(join(base, 'seed'));
  const seed = clone(join(base, 'seed'));
  seed.git('init', '-q', '-b', branch);
  identity(seed);
  if (o.tree) for (const [f, text] of Object.entries(o.tree)) seed.write(f, text);
  else {
    for (const f of [...files.code, 'scripts/push-gate-hook.mjs']) cpSync(join(repoRoot, f), join(seed.dir, f));
    seed.write('.denylist.json', rules('secretproject'));
  }
  seed.write('README.md', 'hello\n');
  seed.git('add', '-A');
  seed.git('commit', '-q', '-m', 'init');
  seed.git('remote', 'add', 'origin', origin);
  seed.git('push', '-q', 'origin', branch);
  execFileSync('git', ['clone', '-q', origin, join(base, 'work')], { stdio: 'ignore' });
  const work = clone(join(base, 'work'));
  identity(work);
  const installed = execFileSync('node', [installer], { cwd: work.dir, encoding: 'utf8' });
  const tmp = join(base, 'tmp');
  mkdirSync(tmp);
  // WHY: the launcher's private directory goes under a temp root of the test's own, so a test can see it come and go.
  // WHY: a person's push unless a test says otherwise: this suite may itself be run by an agent, whose marker would refuse the hatch.
  const env = (extra: Record<string, string> = {}) => {
    const e: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    delete e[AGENT];
    delete e.PUSH_GATE_BOOTSTRAP;
    return { ...e, ...extra };
  };
  const push = (extra: Record<string, string> = {}, remote = 'origin', from = work.dir): Run => spawnSync('git', ['push', '-q', remote, 'HEAD:refs/heads/feature'], { cwd: from, encoding: 'utf8', env: env(extra) });
  const range = (extra: Record<string, string> = {}, from = work.dir): Run => spawnSync('node', [launcher, '--range', `origin/${branch}..HEAD`], { cwd: from, encoding: 'utf8', env: env(extra) });
  /** Land a change on origin's default branch, behind the work clone's back. */
  const land = (file: string, text: string) => {
    seed.commit(file, text, 'move origin on');
    seed.git('push', '-q', 'origin', branch);
  };
  /** A second, reachable remote, and origin made unreachable: the fetch fails while the push can go ahead. */
  const offline = () => {
    execFileSync('git', ['init', '-q', '--bare', join(base, 'mirror.git')]);
    work.git('remote', 'add', 'mirror', join(base, 'mirror.git'));
    work.git('remote', 'set-url', 'origin', join(base, 'gone.git'));
  };
  const pushed = (remote = 'origin') => work.git('ls-remote', remote, 'refs/heads/feature') !== '';
  return { base, origin, seed, work, tmp, installed, push, range, land, offline, pushed, env };
}

const refused = (p: Run, why: RegExp) => {
  assert.notEqual(p.status, 0, `the push must be refused; stderr: ${p.stderr}`);
  assert.match(p.stderr, why);
};

test('the launcher\'s gate file set is exactly what the gate imports, transitively', () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(join(repoRoot, file), 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) walk(posix.join(posix.dirname(file), m[1]!));
  };
  walk('scripts/push-gate.mjs');
  assert.deepEqual([...seen].sort(), [...files.code].sort(), 'GATE_CODE in scripts/push-gate-hook.mjs must list the gate and every file it imports');
  assert.equal(files.code[0], 'scripts/push-gate.mjs', 'the entry comes first');
  const gate = [...seen].map((f) => readFileSync(join(repoRoot, f), 'utf8')).join('\n');
  // INVARIANT: the rule files the gate names must all be carried too.
  for (const f of ['.denylist.json', '.denylist-allow']) {
    assert.ok(gate.includes(f));
    assert.ok([...files.rules.required, ...files.rules.optional].includes(f), `${f} is read by the gate`);
  }
  assert.ok(files.rules.optional.includes('.gitleaks.toml'), 'gitleaks reads its config from the directory the gate runs in');
});

test('a stale checkout is judged by origin\'s rules as fetched on this push', { skip }, () => {
  const w = world();
  // WHY: the owner's case. Origin has since denied a new term and allowed an intentional mention; the work clone has fetched neither.
  w.land('.denylist.json', rules('secretproject', 'newsecret'));
  w.land('.denylist-allow', 'notes.md secretproject\n');
  const stale = w.work.git('rev-parse', 'origin/main');
  w.work.commit('notes.md', 'deployed by secretproject\n');
  const ok = w.push();
  assert.equal(ok.status, 0, `the allowance that landed on origin counts: ${ok.stderr}`);
  assert.notEqual(w.work.git('rev-parse', 'origin/main'), stale, 'the push fetched origin/main');
  assert.match(ok.stderr, new RegExp(`gate and rules from origin/main at ${w.work.git('rev-parse', '--short', 'origin/main')}`));
  w.work.commit('more.md', 'and newsecret too\n');
  refused(w.push(), /more\.md:1: denied term "newsecret"/);
});

test('the branch being pushed cannot change the gate or the allowlist that judges it', { skip }, () => {
  const tamper: [string, string, string][] = [
    ['an allowlist entry of its own', '.denylist-allow', 'notes.md secretproject\n'],
    ['its own rules', '.denylist.json', rules()],
    ['its own gate', 'scripts/push-gate.mjs', 'console.log("push gate: all fine");\n'],
    ['its own scanner', 'scripts/lib/denylist.mjs', 'export const loadRules = () => ({});\nexport const scanText = () => [];\nexport const SKIP = new Set();\n'],
    ['its own launcher', 'scripts/push-gate-hook.mjs', 'process.exit(0);\n'],
  ];
  for (const [what, file, text] of tamper) {
    const w = world();
    w.work.commit(file, text, 'adjust');
    w.work.commit('notes.md', 'deployed by secretproject\n');
    refused(w.push(), /notes\.md:1: denied term "secretproject"/);
    assert.equal(w.pushed(), false, `with ${what}, nothing reached the remote`);
    refused(w.range(), /notes\.md:1: denied term "secretproject"/);
  }
});

test('a refusal says whose rules judged it and that the allowlist counts once it is on origin', { skip }, () => {
  const w = world();
  w.work.commit('notes.md', 'deployed by secretproject\n');
  refused(w.push(), /judged by the rules of origin\/main at [0-9a-f]+ .*counts once it is on origin's default branch/);
});

test('offline: the last-fetched origin rules under a loud warning; the branch\'s own allowlist still does not count', { skip }, () => {
  const w = world();
  w.offline();
  const at = w.work.git('rev-parse', '--short', 'origin/main');
  w.work.commit('ok.md', 'fine\n');
  const ok = w.push({}, 'mirror');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /!{20,}\n!! PUSH GATE: could not fetch origin\/main \(.+\)\.\n!! Using the gate and rules of origin\/main AS LAST FETCHED: /);
  assert.ok(ok.stderr.includes(`AS LAST FETCHED: ${at} (`), 'the warning names the commit the rules come from');
  w.work.commit('.denylist-allow', 'notes.md secretproject\n');
  w.work.commit('notes.md', 'deployed by secretproject\n');
  refused(w.push({}, 'mirror'), /notes\.md:1: denied term "secretproject"/);
});

test('offline and never fetched: the checkout\'s own copy, with its commit and how far behind in the warning; no gate anywhere refuses', { skip }, () => {
  const w = world();
  w.offline();
  w.work.git('update-ref', '-d', 'refs/remotes/origin/main');
  w.work.commit('ok.md', 'fine\n');
  const head = w.work.git('rev-parse', '--short', 'HEAD');
  const ok = w.push({}, 'mirror');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /!! PUSH GATE: could not fetch origin\/main/);
  assert.match(ok.stderr, /!! and this clone has never fetched it\. Falling back to THE CHECKOUT'S OWN COPY/);
  assert.ok(ok.stderr.includes(`!!   checkout at ${head} (`), 'the warning names the checkout\'s commit');
  assert.match(ok.stderr, /!! {3}how far behind origin\/main: unknown/);
  w.work.commit('notes.md', 'deployed by secretproject\n');
  refused(w.push({}, 'mirror'), /notes\.md:1: denied term "secretproject"/);
  w.work.git('rm', '-q', 'scripts/push-gate.mjs', 'notes.md');
  w.work.git('commit', '-q', '-m', 'drop the gate');
  refused(w.push({}, 'mirror'), /push gate: REFUSED\. no gate found at all/);
});

test('a fetch that never answers is cut off at the timeout', { skip: skip || (process.platform === 'win32' && 'the hanging transport is a POSIX sleep') }, () => {
  const w = world();
  w.work.git('remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git');
  w.work.commit('ok.md', 'fine\n');
  const start = Date.now();
  const p = w.range({ GIT_SSH_COMMAND: 'sleep 60;:', PUSH_GATE_FETCH_TIMEOUT: '1' });
  assert.ok(Date.now() - start < 30_000, `the hook waited ${Date.now() - start} ms on a dead fetch`);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /could not fetch origin\/main \(no answer within 1s\)/);
});

test('a fetch cut off at the timeout says "no answer" even when the wall clock reads under it (ETIMEDOUT, a clock stepped back)', { skip: skip || (process.platform === 'win32' && 'the hanging transport is a POSIX sleep') }, () => {
  const w = world();
  w.work.git('remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git');
  w.work.commit('ok.md', 'fine\n');
  // The hook's own Date.now() never moves: its elapsed time reads 0 s, as after a step back, while spawnSync's timeout
  // (a monotonic timer) still fires: the error is ETIMEDOUT with the clock under the limit.
  const frozen = join(w.base, 'frozen-clock.mjs');
  writeFileSync(frozen, 'Date.now = () => 1_700_000_000_000;\n');
  const p = w.range({ GIT_SSH_COMMAND: 'sleep 60;:', PUSH_GATE_FETCH_TIMEOUT: '1', NODE_OPTIONS: `--import ${pathToFileURL(frozen).href}` });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /could not fetch origin\/main \(no answer within 1s\)/);
});

test('first-time setup: origin\'s default branch without the gate refuses, and says how to bootstrap', { skip }, () => {
  const w = world({ tree: { 'notes.txt': 'no gate here yet\n' } });
  for (const f of files.code) cpSync(join(repoRoot, f), join(w.work.dir, f));
  w.work.write('.denylist.json', rules('secretproject'));
  w.work.git('add', '-A');
  w.work.git('commit', '-q', '-m', 'add the gate');
  const p = w.push();
  refused(p, /push gate: REFUSED\. origin\/main has no scripts\/push-gate\.mjs\./);
  assert.match(p.stderr, /First-time setup .*PUSH_GATE_BOOTSTRAP=1/);
  assert.equal(w.pushed(), false);
  const boot = w.push({ PUSH_GATE_BOOTSTRAP: '1' });
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stderr, /!! PUSH GATE: PUSH_GATE_BOOTSTRAP=1\. origin\/main has no scripts\/push-gate\.mjs\.\n!! FIRST-TIME-SETUP HATCH USED by \S.* at \d{4}-\d\d-\d\dT[\d:.]+Z: this push is NOT judged by origin's rules\.\n!! Using THE CHECKOUT'S OWN COPY/);
  assert.match(boot.stderr, /!! {3}0 commit\(s\) behind origin\/main as last fetched/);
  w.work.commit('notes.md', 'deployed by secretproject\n');
  refused(w.push({ PUSH_GATE_BOOTSTRAP: '1' }), /notes\.md:1: denied term "secretproject"/);
});

/** A work clone whose origin holds no gate yet, with the gate committed in the checkout: the one case the hatch answers. */
function firstTime() {
  const w = world({ tree: { 'notes.txt': 'no gate here yet\n' } });
  for (const f of files.code) cpSync(join(repoRoot, f), join(w.work.dir, f));
  w.work.write('.denylist.json', rules('secretproject'));
  w.work.git('add', '-A');
  w.work.git('commit', '-q', '-m', 'add the gate');
  const log = join(w.work.dir, '.git', 'push-gate-bootstrap.log');
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>) : []);
  return { ...w, log, records };
}

test('each use of the hatch is said loudly in the push output and recorded in the git dir; a refused or ordinary push records nothing', { skip }, () => {
  const w = firstTime();
  refused(w.push(), /First-time setup/);
  assert.deepEqual(w.records(), [], 'no hatch, no record');
  const boot = w.push({ PUSH_GATE_BOOTSTRAP: '1' });
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stderr, /!! FIRST-TIME-SETUP HATCH USED by \S.* at \S+: this push is NOT judged by origin's rules\./);
  assert.match(boot.stderr, /!! Recorded in .*push-gate-bootstrap\.log\n/);
  const [one, ...more] = w.records();
  assert.deepEqual(more, []);
  assert.equal(one!.head, w.work.git('rev-parse', 'HEAD'));
  assert.equal(one!.branch, 'main');
  assert.equal(one!.mode, 'push to origin');
  assert.equal(one!.default_branch, 'origin/main');
  assert.match(one!.at!, /^\d{4}-\d\d-\d\dT/);
  assert.ok(one!.user);
  assert.match(one!.why!, /origin\/main has no scripts\/push-gate\.mjs/);
  // By hand (--range), the same line and a second record.
  const byHand = w.range({ PUSH_GATE_BOOTSTRAP: '1' });
  assert.equal(byHand.status, 0, byHand.stderr);
  assert.match(byHand.stderr, /FIRST-TIME-SETUP HATCH USED/);
  assert.deepEqual(w.records().map((r) => r.mode), ['push to origin', '--range origin/main..HEAD']);
  // INVARIANT: the record is in the git dir, never in the work tree, so no push carries or rewrites it.
  assert.equal(w.work.git('status', '--porcelain'), '');
});

test('the hatch set where it does not apply (origin has the gate) changes nothing and records nothing', { skip }, () => {
  const w = world();
  w.work.commit('notes.md', 'fine\n');
  const p = w.push({ PUSH_GATE_BOOTSTRAP: '1' });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /push gate: gate and rules from origin\/main at /);
  assert.doesNotMatch(p.stderr, /HATCH USED/);
  assert.equal(existsSync(join(w.work.dir, '.git', 'push-gate-bootstrap.log')), false);
});

test('an agent run never gets the hatch: refused with the reason, nothing pushed, nothing recorded; a person\'s push still may', { skip }, () => {
  const w = firstTime();
  const agent = w.push({ PUSH_GATE_BOOTSTRAP: '1', [AGENT]: '1' });
  refused(agent, /push gate: REFUSED\. origin\/main has no scripts\/push-gate\.mjs\.\nPUSH_GATE_BOOTSTRAP=1 is set, but this is an agent run \(/);
  assert.ok(agent.stderr.includes(`this is an agent run (${AGENT}=1)`), agent.stderr);
  assert.doesNotMatch(agent.stderr, /HATCH USED/);
  assert.equal(w.pushed(), false);
  assert.deepEqual(w.records(), []);
  refused(w.range({ PUSH_GATE_BOOTSTRAP: '1', [AGENT]: '1' }), /this is an agent run/);
  // An agent's ordinary push (no hatch) is refused as anyone's is here, and told why.
  refused(w.push({ [AGENT]: '1' }), /First-time setup/);
  const person = w.push({ PUSH_GATE_BOOTSTRAP: '1' });
  assert.equal(person.status, 0, person.stderr);
  assert.equal(w.pushed(), true);
  assert.equal(w.records().length, 1);
});

test('a use of the hatch that cannot be recorded is refused', { skip }, () => {
  const w = firstTime();
  // WHY: a directory in the record's place stands in for a git dir the pusher can't write.
  mkdirSync(w.log);
  refused(w.push({ PUSH_GATE_BOOTSTRAP: '1' }), /push gate: REFUSED\. PUSH_GATE_BOOTSTRAP=1, but its use could not be recorded in .*push-gate-bootstrap\.log/);
  assert.equal(w.pushed(), false);
});

test('rules missing on origin refuse even when the gate is there', { skip }, () => {
  const tree: Record<string, string> = {};
  for (const f of files.code) tree[f] = readFileSync(join(repoRoot, f), 'utf8');
  const w = world({ tree });
  w.work.commit('.denylist.json', rules());
  refused(w.push(), /push gate: REFUSED\. origin\/main has no \.denylist\.json\./);
});

test('no default branch on origin, or no origin at all: refused with the reason', () => {
  const noMain = world({ originBranch: 'trunk', tree: { 'a.txt': 'a\n' } });
  noMain.work.git('remote', 'set-head', 'origin', '-d');
  noMain.work.commit('ok.md', 'fine\n');
  refused(noMain.push(), /push gate: REFUSED\. origin has no main branch, so there is no gate to load from it\./);
  const noOrigin = world({ tree: { 'a.txt': 'a\n' } });
  noOrigin.work.git('remote', 'rename', 'origin', 'upstream');
  noOrigin.work.commit('ok.md', 'fine\n');
  refused(noOrigin.push({}, 'upstream'), /push gate: REFUSED\. this repo has no "origin" remote/);
});

test('origin/HEAD names the default branch the gate is loaded from', () => {
  const stub = 'console.error(`STUB GATE on trunk`);\n';
  const w = world({ originBranch: 'trunk', tree: { 'scripts/push-gate.mjs': stub, 'scripts/lib/denylist.mjs': '', '.denylist.json': '{}' } });
  w.work.commit('ok.md', 'fine\n');
  const p = w.push();
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /gate and rules from origin\/trunk at /);
  assert.match(p.stderr, /STUB GATE on trunk/);
});

test('the gate runs in a private directory of its own, removed afterwards, pass or refuse', () => {
  // WHY: a stand-in gate on origin that reports where it runs and what is beside it, and refuses on demand.
  const stub = [
    "import { statSync, existsSync, readFileSync } from 'node:fs';",
    "import './lib/denylist.mjs';",
    "const mode = (statSync(process.cwd()).mode & 0o777).toString(8);",
    "console.error(`STUB cwd=${process.cwd()} mode=${mode} rules=${existsSync('.denylist.json')} allow=${existsSync('.denylist-allow')} args=${process.argv.slice(2).join(',')} stdin=${readFileSync(0, 'utf8').trim().split(' ').length}`);",
    "process.exit(process.env.STUB_REFUSE ? 1 : 0);",
  ].join('\n');
  const w = world({ tree: { 'scripts/push-gate.mjs': stub, 'scripts/lib/denylist.mjs': '', '.denylist.json': '{}' } });
  w.work.commit('ok.md', 'fine\n');
  w.work.commit('.denylist-allow', 'ok.md anything\n');
  for (const refuse of [false, true]) {
    w.work.commit(`n-${refuse}.md`, 'more\n');
    const p = w.push(refuse ? { STUB_REFUSE: '1' } : {});
    assert.equal(p.status === 0, !refuse, p.stderr);
    const m = /STUB cwd=(.+) mode=(\d+) rules=true allow=false args=origin,.* stdin=4/.exec(p.stderr);
    assert.ok(m, `the gate ran with the hook's arguments and input, without the branch's allowlist: ${p.stderr}`);
    assert.ok(m[1]!.includes('push-gate-') && !m[1]!.startsWith(w.work.dir), 'not in the checkout');
    if (process.platform !== 'win32') assert.equal(m[2], '700');
    assert.equal(existsSync(m[1]!), false, 'the directory is removed');
    assert.deepEqual(readdirSync(w.tmp), [], 'nothing is left in the temp root');
  }
});

test('setup-hooks installs into the common hooks dir: a linked worktree is gated, by push and by --range', { skip }, () => {
  const w = world();
  assert.match(w.installed, /push gate installed: .*pre-push/);
  const hooks = join(w.work.dir, '.git', 'hooks');
  assert.match(readFileSync(join(hooks, 'pre-push'), 'utf8'), /^#!\/bin\/sh\n# managed by setup-hooks: push gate/);
  assert.equal(readFileSync(join(hooks, 'push-gate-hook.mjs'), 'utf8'), readFileSync(launcher, 'utf8'));
  const wt = join(w.base, 'wt');
  w.work.git('worktree', 'add', '-q', '-b', 'topic', wt);
  const tree = clone(wt);
  tree.commit('.denylist-allow', 'notes.md secretproject\n');
  tree.commit('notes.md', 'deployed by secretproject\n');
  refused(w.push({}, 'origin', wt), /notes\.md:1: denied term "secretproject"/);
  refused(w.range({}, wt), /notes\.md:1: denied term "secretproject"/);
  tree.git('rm', '-q', 'notes.md');
  tree.git('commit', '-q', '-m', 'take it out');
  // INVARIANT: the commit that added it is still in what would be pushed.
  refused(w.range({}, wt), /notes\.md:1: denied term "secretproject"/);
  const clean = w.range();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /push gate: 0 commit\(s\) and 1 tip\(s\) clean/);
});

test('setup-hooks replaces an earlier gate hook (kept beside it), leaves core.hooksPath=.githooks behind, and refuses another hook', () => {
  const w = world({ tree: { 'a.txt': 'a\n' } });
  const hooks = join(w.work.dir, '.git', 'hooks');
  const install = () => spawnSync('node', [installer], { cwd: w.work.dir, encoding: 'utf8' });
  assert.equal(install().status, 0, 'running it again replaces its own install');
  assert.equal(existsSync(join(hooks, 'pre-push.before-push-gate')), false);
  const old = '#!/bin/sh\ncd /somewhere/else && exec node scripts/push-gate.mjs "$@"\n';
  writeFileSync(join(hooks, 'pre-push'), old);
  w.work.git('config', 'core.hooksPath', '.githooks');
  const again = install();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(hooks, 'pre-push.before-push-gate'), 'utf8'), old);
  assert.match(readFileSync(join(hooks, 'pre-push'), 'utf8'), /managed by setup-hooks: push gate/);
  assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: w.work.dir, encoding: 'utf8' }).stdout, '', 'the hook from the checked-out branch is no longer the one git runs');
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  const foreign = install();
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /is another pre-push hook/);
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n', 'left as it was');
  rmSync(join(hooks, 'pre-push'));
  w.work.git('config', 'core.hooksPath', join(w.base, 'elsewhere'));
  const other = install();
  assert.equal(other.status, 1);
  assert.match(other.stderr, /core\.hooksPath is .*elsewhere/);
});

test('an installed hook that is no longer origin\'s says how to reinstall', { skip }, () => {
  const w = world();
  w.work.commit('ok.md', 'fine\n');
  const note = /note: the installed hook differs from origin\/main's scripts\/push-gate-hook\.mjs\. Reinstall it from an up-to-date checkout: npm run setup:hooks/;
  assert.doesNotMatch(w.push().stderr, note);
  w.land('scripts/push-gate-hook.mjs', `${readFileSync(launcher, 'utf8')}// a later version\n`);
  const p = w.push();
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, note);
});
