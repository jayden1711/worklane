// An instance's name never gives it a machine user, group or unit that is already another's (an instance test-shop
// would be wl-test-shop, instance shop's sandboxed test user). The rules live once per language: the setup scripts
// (scripts/setup/lib.sh instance_name_problem, copied into the testrun helper), the machine helper (instanceNameProblem
// in scripts/machine/worklane-machine.cjs) and the engine (src/instance-name.ts); held equal here, word for word. And
// the names the scripts make are held to ENGINE_NAMES, which no two allowed names can map onto the same string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ciRunnerNameProblem, ENGINE_NAMES, instanceNameOk, instanceNameProblem } from '../src/instance-name.js';
import { initInstance, InstanceFile } from '../src/instance.js';
import { addProjectNameOk } from '../src/machine.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const machineDir = join(repoRoot, 'scripts', 'machine');
const lib = join(setupDir, 'lib.sh');
const helper = createRequire(import.meta.url)(join(machineDir, `${BRAND.cli}-machine.cjs`)) as { instanceNameProblem: (s: unknown) => string | null };

/** Names that are another's: each prefix, suffix and exact name the rules refuse. */
const REFUSED = ['exp-shop', 'score-shop', 'egress', 'test-foo', 'test-a-b', 'ci-x', 'ci-shop', 'dashboard-shop', 'dash', 'hub', 'hub-setup', 'update', 'tailscale', 'claude-account', 'agent', 'eval', 'work', 'shop-agent', 'shop-eval', 'shop-work', 'shop-mcp', 'shop-mcpc', 'shop-mcpctl', 'plugin-fetch-shop', 'mcp', 'mcpc', 'mcpctl'];
/** Names that stay fine, hyphens and all (test and ci themselves: CI runs an instance named ci). */
// check-table: never-grow
const ALLOWED = ['shop', 'a', 'a-b-c', 'test', 'ci', 'exp', 'score', 'expert', 'egresses', 'tests', 'testx', 'cix', 'my-test-app', 'shop-ci', 'agents', 'dashboards', 'hubby', 'abcdefghijklmnopqrstu', 'mcps', 'shop-mcps', 'plugin-fetch', 'plugin-shop'];
// check-table: never-shrink
const BAD_SHAPE = ['', 'Shop', '1a', '-a', 'a_b', 'a b', 'abcdefghijklmnopqrstuv'];

/** lib.sh's answer for each name: its message, or '' when the name may be an instance's. */
function shellProblems(fn: string, names: string[], file = lib): string[] {
  const r = spawnSync('bash', ['-c', `source "$1"; shift; for n in "$@"; do printf '%s\\x1e' "$(${fn} "$n")"; done`, '_', file, ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\x1e').slice(0, -1);
}

test('test-foo, ci-x and every other name that is already another\'s are refused by the shell scripts, the machine helper and the engine; a-b-c and other names pass', { skip: !posix }, () => {
  const all = [...REFUSED, ...ALLOWED, ...BAD_SHAPE];
  const shell = shellProblems('instance_name_problem', all);
  all.forEach((n, i) => {
    const engine = instanceNameProblem(n);
    assert.equal(engine === null, ALLOWED.includes(n), `engine on ${JSON.stringify(n)}: ${engine}`);
    assert.equal(helper.instanceNameProblem(n), engine, `the machine helper says what the engine says about ${JSON.stringify(n)}`);
    assert.equal(shell[i], engine ?? '', `lib.sh says what the engine says about ${JSON.stringify(n)}`);
    assert.equal(addProjectNameOk(n), engine === null, `add-project on ${JSON.stringify(n)}`);
    // An instance file, and `instance init`, refuse it too (the shape there may be longer: 41).
    if (n.length <= 21 && /^[a-z][a-z0-9-]*$/.test(n)) assert.equal(InstanceFile.shape.name.safeParse(n).success, engine === null, `instance.yaml name ${n}`);
  });
  for (const n of REFUSED) assert.match(instanceNameProblem(n)!, /wl-|\.service/, `${n}'s refusal names what it would collide with`);
  assert.equal(instanceNameProblem('test-foo'), 'wl-test-foo is the test user of instance foo');
  assert.equal(instanceNameProblem('ci-x'), 'wl-ci-x is the user of CI runner x');
  assert.throws(() => initInstance('test-foo', '.', 'example/foo', mkdtempSync(join(tmpdir(), 'iname-'))), /instance name "test-foo": wl-test-foo is the test user of instance foo/);

  // The testrun helper is installed alone, so it holds a copy of lib.sh's function: the same text.
  const fnText = (src: string) => /^instance_name_problem\(\) \{\n[\s\S]*?\n\}\n/m.exec(src)?.[0];
  const libText = fnText(readFileSync(lib, 'utf8'));
  assert.ok(libText);
  assert.equal(fnText(readFileSync(join(machineDir, `${BRAND.cli}-testrun.sh`), 'utf8')), libText, 'the testrun helper checks names as lib.sh does');
  assert.equal(fnText(readFileSync(join(machineDir, `${BRAND.cli}-exp.sh`), 'utf8')), libText, 'the experiments helper checks names as lib.sh does');
  assert.equal(instanceNameProblem('exp-shop'), 'wl-exp-shop is the experiment job user of instance shop');

  // Every setup script that takes an instance name checks it with lib.sh's rules, not a regex of its own.
  for (const s of ['instance.sh', 'test-user.sh', 'machine-helper.sh', 'dashboards.sh', 'add-project.sh', 'experiments.sh']) assert.match(readFileSync(join(setupDir, s), 'utf8'), /need_instance_name "\$name"/, s);
  // And the two that check before root say so, with the collision named.
  const t = spawnSync('bash', [join(setupDir, 'test-user.sh'), 'check', 'test-foo'], { encoding: 'utf8' });
  assert.equal(t.status, 2);
  assert.match(t.stderr, /the instance name test-foo: wl-test-foo is the test user of instance foo/);
  const c = spawnSync('bash', [join(setupDir, 'ci-runner.sh'), 'check', 'example/shop', '--name', 'agent'], { encoding: 'utf8' });
  assert.equal(c.status, 2);
  assert.match(c.stderr, /--name: wl-ci-agent is instance ci's agent name, got agent/);
});

test("a CI runner's name: lib.sh and the engine's model of it agree", { skip: !posix }, () => {
  const names = ['shop', 'a-b-c', 'agent', 'eval', 'work', 'shop-docker', 'shop-reset', 'docker', 'reset', 'shop-firewall', 'test-x', 'ci', 'Bad', ''];
  const shell = shellProblems('ci_runner_name_problem', names);
  names.forEach((n, i) => assert.equal(shell[i], ciRunnerNameProblem(n) ?? '', JSON.stringify(n)));
});

/** Every user, group and unit name the setup scripts and the engine make, as a pattern with <n> for the name. */
function namesMade(): Set<string> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(sh|cjs|mjs|ts)$/.test(e) || !e.includes('.')) files.push(p);
    }
  };
  for (const d of [setupDir, machineDir, join(repoRoot, 'src')]) walk(d);
  const vars = (s: string) => s.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9]|<[a-z]+>/g, '<n>');
  const norm = (s: string) => vars(s).replace(/[}.-]+$/, '');
  const out = new Set<string>();
  const unit = new RegExp(`${BRAND.cli}-[A-Za-z0-9_\${}.<>@-]*?\\.(service|timer|slice|socket|path)\\b`, 'g');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bwl-[A-Za-z0-9_${}.<>-]*/g)) out.add(norm(m[0]));
    for (const m of src.matchAll(unit)) out.add(vars(m[0]).replace(/@<n>\./, '@.'));
  }
  // Not machine names: the bare prefix (wl-*, ^wl-), a tree hash's tag, and Wayland's clipboard tool.
  for (const x of ['wl', 'wl-tree-v1', 'wl-copy']) out.delete(x);
  return out;
}

test('ENGINE_NAMES lists every user, group and unit the scripts make, and no two allowed names ever share one', () => {
  const listed = new Set(ENGINE_NAMES.map((e) => e.pattern));
  const made = namesMade();
  // A literal name (an example in a comment, a fixed user) is one of the listed patterns filled in.
  const filled = [...listed].map((p) => new RegExp(`^${p.replace(/[.@]/g, '\\$&').replaceAll('<n>', '[a-z0-9-]+')}$`));
  for (const p of made) {
    const ok = p.includes('<n>') ? listed.has(p) : filled.some((r) => r.test(p));
    assert.ok(ok, `the scripts make ${p}, which src/instance-name.ts ENGINE_NAMES doesn't list: add it there, then make the names that would collide with it refused`);
  }

  // Candidate names from every word in those patterns (and two plain ones), up to three words: if a new kind of name
  // could make two of the machine's names equal, some such name shows it.
  const words = [...new Set(ENGINE_NAMES.flatMap((e) => e.pattern.split(/[^a-z0-9]+/)).filter(Boolean)), 'a', 'b'];
  const names = new Set<string>();
  for (const x of words) {
    names.add(x);
    for (const y of words) {
      names.add(`${x}-${y}`);
      for (const z of words) names.add(`${x}-${y}-${z}`);
    }
  }
  const owner = new Map<string, string>();
  const claim = (made: string, by: string) => {
    const prior = owner.get(made);
    assert.ok(prior === undefined || prior === by, `${made} would be both ${prior}'s and ${by}'s`);
    owner.set(made, by);
  };
  for (const e of ENGINE_NAMES) if (e.of === 'fixed') claim(e.pattern, 'the machine');
  // A legacy test run's unit (before protocol 9): never any other kind's name (its last part is a process id: digits).
  const legacy = ENGINE_NAMES.find((e) => e.of === 'test-run-legacy')!.pattern;
  assert.equal(legacy, `${BRAND.cli}-test-<n>-<n>-<n>.service`);
  const runUnit = new RegExp(`^${BRAND.cli}-test-[a-z0-9-]+-[0-9]+\\.service$`);
  const fill = (p: string, ...parts: string[]) => parts.reduce((s, x) => s.replace('<n>', x), p);
  // WHY the helper checks User= for these: two instances' legacy units can be the same name.
  assert.equal(fill(legacy, 'a', 'b-c', '1'), fill(legacy, 'a-b', 'c', '1'));
  assert.deepEqual([...owner.keys()].filter((k) => runUnit.test(k)), [], 'no fixed name looks like a test run\'s unit');
  for (const n of names) {
    for (const e of ENGINE_NAMES) {
      if (e.of === 'instance' && instanceNameOk(n)) claim(e.pattern.replace('<n>', n), `instance ${n}`);
      if (e.of === 'runner' && ciRunnerNameProblem(n) === null) claim(e.pattern.replace('<n>', n), `CI runner ${n}`);
    }
  }
  assert.deepEqual([...owner.keys()].filter((k) => runUnit.test(k)), [], 'no instance or runner name looks like a legacy test run\'s unit');
  // A test run's unit now: each (instance, run id) pair has its own, and none is any other kind's. Run ids take the
  // helper's shape ([a-z0-9][a-z0-9-]{0,47}); instance a's run b-c and instance a-b's run c are told apart here.
  const run = ENGINE_NAMES.find((e) => e.of === 'test-run')!.pattern;
  const short = [...names].filter((n) => n.split('-').length <= 2);
  for (const n of short.filter((x) => instanceNameOk(x))) for (const id of short) claim(fill(run, n, id, '1'), `instance ${n}'s run ${id}`);
  assert.notEqual(fill(run, 'a', 'b-a', '1'), fill(run, 'a-b', 'a', '1'));
  // An experiment job's step unit: each (instance, job, step) its own, and none any other kind's.
  const step = ENGINE_NAMES.find((e) => e.of === 'exp-step')!.pattern;
  for (const n of short.filter((x) => instanceNameOk(x))) for (const job of short) for (const st of ['train', 'score']) claim(fill(step, n, job, st, '1'), `instance ${n}'s job ${job} ${st}`);
  assert.notEqual(fill(step, 'a', 'b-a', 'train', '1'), fill(step, 'a-b', 'a', 'train', '1'));
});
