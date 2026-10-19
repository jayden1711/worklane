// #727: doctor's paste-ready pin block (src/check-pin-block.ts). It maps each required check to the workflow file that
// posts it, from the files committed at one commit (never the working tree, an untracked file or a symlink's target),
// confirmed against main's tip where it has a run. Anything it can't map surely is listed for a manual choice, never
// guessed, and the block is valid under the engine's own schema or it isn't offered. Fixture repos, workflows and
// check runs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ghTipRuns, NAME_MAX, pinBlock, pinNewConfig, pinPlan, TIP_PAGES_MAX, validPins, workflowCheckNames, workflowsAt, WORKFLOW_MAX_BYTES, type Tip, type TipRun, type Workflows } from '../src/check-pin-block.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];
const job = (name: string) => `  ${JSON.stringify(name)}:\n    runs-on: ubuntu-latest\n`;
const wf = (...names: string[]) => `on: [push, pull_request]\njobs:\n${names.map(job).join('')}`;
const files = (f: Record<string, string>, skipped: Workflows['skipped'] = []): Workflows => ({ at: 'c'.repeat(40), files: f, skipped });
const tip = (runs: TipRun[], partial = false): Tip => ({ sha: 'c'.repeat(40), runs, partial });
const actions = (name: string, workflow: string | null): TipRun => ({ name, app: 15368, actions: true, workflow });
const app = (name: string, id: number): TipRun => ({ name, app: id, actions: false, workflow: null });
const ch = (code: number) => String.fromCharCode(code);

/** A repo whose committed tree has ci.yml, a symlink out of the repo, an oversize file and a subfolder; plus an untracked file and a file only on another branch. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'pin-repo-'));
  writeFileSync(join(base, 'secret.yml'), wf('SECRET-FROM-OUTSIDE-THE-REPO'));
  const dir = join(base, 'r');
  mkdirSync(join(dir, '.github', 'workflows', 'sub'), { recursive: true });
  git(base, 'init', '-q', '-b', 'main', dir);
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), wf('test', 'lint'));
  writeFileSync(join(dir, '.github', 'workflows', 'huge.yml'), `${wf('huge')}#${'x'.repeat(WORKFLOW_MAX_BYTES)}\n`);
  writeFileSync(join(dir, '.github', 'workflows', 'sub', 'nested.yml'), wf('nested'));
  writeFileSync(join(dir, '.github', 'workflows', 'notes.txt'), 'not a workflow\n');
  symlinkSync(join(base, 'secret.yml'), join(dir, '.github', 'workflows', 'leak.yml'));
  git(dir, 'add', '-A');
  git(dir, ...ident, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, '.github', 'workflows', 'branch-only.yml'), wf('branch-only'));
  git(dir, 'add', '-A');
  git(dir, ...ident, 'commit', '-q', '-m', 'other');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, '.github', 'workflows', 'untracked-local.yml'), wf('new-deps'));
  return dir;
}

test("the workflow files are main's committed tree: never the working tree, an untracked file, another branch's file, a symlink's target or an oversize file", () => {
  const dir = repo();
  const w = workflowsAt(dir, 'main')!;
  assert.equal(w.at, git(dir, 'rev-parse', 'main'));
  assert.deepEqual(Object.keys(w.files), ['.github/workflows/ci.yml']);
  assert.deepEqual(
    w.skipped.map((s) => `${s.path}: ${s.why}`),
    ['.github/workflows/huge.yml: over 256 KiB', '.github/workflows/leak.yml: a symlink: never followed'],
  );
  // The block names neither the symlink's target's job nor the untracked file's.
  const block = pinBlock(pinPlan({ names: ['test', 'new-deps', 'SECRET-FROM-OUTSIDE-THE-REPO', 'branch-only'], workflows: w, tip: null }));
  assert.doesNotMatch(block, /: \{ workflow: "\.github\/workflows\/(leak|untracked-local|branch-only)\.yml" \}/);
  assert.match(block, /^ {2}"test": \{ workflow: "\.github\/workflows\/ci\.yml" \}/m);
  assert.match(block, /^# couldn't map: \.github\/workflows\/leak\.yml: a symlink: never followed/m);
  assert.equal(workflowsAt(dir, 'no-such-ref'), null);
});

test('a new project config gets the block from its committed tree only; nothing is written when the result would be invalid', () => {
  const dir = repo();
  mkdirSync(join(dir, 'cfg'));
  writeFileSync(join(dir, 'cfg', 'config.yaml'), 'version: 1\n');
  pinNewConfig(join(dir, 'cfg'));
  const cfg = parse(readFileSync(join(dir, 'cfg', 'config.yaml'), 'utf8')) as { required_check_sources: Record<string, unknown> };
  assert.deepEqual(cfg.required_check_sources, { lint: { workflow: '.github/workflows/ci.yml' }, test: { workflow: '.github/workflows/ci.yml' } });
  // A config the block would break (it already has the key): left as it was.
  writeFileSync(join(dir, 'cfg', 'config.yaml'), 'version: 1\nrequired_check_sources: {}\n');
  pinNewConfig(join(dir, 'cfg'));
  assert.equal(readFileSync(join(dir, 'cfg', 'config.yaml'), 'utf8'), 'version: 1\nrequired_check_sources: {}\n');
});

test("a job it can't name surely is listed, never guessed: include/exclude, a non-string name, a reusable job, an expression name or matrix, an unparseable file", () => {
  const w = files({
    '.github/workflows/a.yml': [
      'jobs:',
      '  inc:\n    name: test\n    strategy:\n      matrix:\n        node: [22]\n        include:\n          - node: 22\n            extra: true',
      '  exc:\n    name: unit\n    strategy:\n      matrix:\n        node: [22, 24]\n        exclude:\n          - node: 24',
      '  deploy:\n    name: 123',
      '  call:\n    uses: ./.github/workflows/lib.yml',
      '  expr:\n    name: ${{ github.event_name }}',
      '  dyn:\n    strategy:\n      matrix: ${{ fromJSON(needs.x.outputs.m) }}',
      '  plain:\n    name: plain',
      '  mat:\n    name: m ${{ matrix.v }}\n    strategy:\n      matrix:\n        v: [1, 2]',
    ].join('\n'),
    '.github/workflows/broken.yml': 'jobs: [',
  });
  const { byName, unmapped } = workflowCheckNames(w);
  assert.deepEqual([...byName.keys()].sort(), ['m 1', 'm 2', 'plain']);
  assert.deepEqual(
    unmapped.map((u) => `${u.where} ${u.why}`),
    [
      '.github/workflows/a.yml job "inc": its matrix has include or exclude',
      '.github/workflows/a.yml job "exc": its matrix has include or exclude',
      '.github/workflows/a.yml job "deploy": its name is not a string',
      '.github/workflows/a.yml job "call": a reusable workflow, whose checks are named after its own jobs',
      '.github/workflows/a.yml job "expr": its name is an expression',
      '.github/workflows/a.yml job "dyn": its matrix is an expression',
      ".github/workflows/broken.yml the file doesn't parse",
    ],
  );
  // `deploy` is never pinned to a.yml by its key; every unmapped job shows in the block.
  const block = pinBlock(pinPlan({ names: ['deploy', 'plain'], workflows: w, tip: null }));
  assert.doesNotMatch(block, /"deploy": \{/);
  assert.equal(block.split('\n').filter((l) => l.startsWith("# couldn't map:")).length, 7);
});

test('the plan: confirmed on the tip, from the files only, an App only from a full tip read, and never the GitHub Actions App', () => {
  const w = files({ '.github/workflows/ci.yml': wf('agentshield', 'test'), '.github/workflows/new-deps.yml': wf('new-deps') });
  const t = tip([actions('agentshield', '.github/workflows/ci.yml'), actions('apimade', null), actions('test', '.github/workflows/other.yml'), app('deploy', 4242), app('mixed', 4242), app('mixed', 5555)]);
  const plan = pinPlan({ names: ['agentshield', 'new-deps', 'apimade', 'test', 'deploy', 'mixed', 'nowhere', 'agentshield'], workflows: w, tip: t });
  assert.deepEqual(
    plan.pins.map((p) => [p.name, p.pin]),
    [
      ['agentshield', { workflow: '.github/workflows/ci.yml' }],
      ['new-deps', { workflow: '.github/workflows/new-deps.yml' }],
      ['deploy', { app_id: 4242 }],
    ],
    'listed once each',
  );
  assert.deepEqual(plan.manual.map((m) => m.name), ['apimade', 'test', 'mixed', 'nowhere']);
  assert.match(plan.manual[0]!.why, /GitHub Actions outside a run that passes the workflow-pin test/);
  assert.ok(!plan.pins.some((p) => 'app_id' in p.pin && p.pin.app_id === 15368), 'never the Actions App');
  // A partial tip read proposes no App pin.
  const partial = pinPlan({ names: ['deploy'], workflows: w, tip: tip([app('deploy', 4242)], true) });
  assert.deepEqual([partial.pins, partial.manual.map((m) => m.name)], [[], ['deploy']]);
  assert.match(partial.manual[0]!.why, /read only in part/);
});

test("the block is always valid: duplicates once, names the schema or YAML can't take as comments, hostile names quoted", () => {
  const long = 'x'.repeat(NAME_MAX + 50);
  const evil = '.github/workflows/x.yml\n  "deploy": { app_id: 666 }\n#';
  // ESC, a bidi override and a Cyrillic look-alike among them, built from code points.
  const hostile = ['a\nb', '#', 'q"\\', '&a *b !!str', '{ app_id: 1 }', '- x', `esc${ch(0x1b)}[31m`, `bidi${ch(0x202e)}x`, `d${ch(0x435)}ploy`];
  // A key that long doesn't even parse as YAML: that file is listed as one it couldn't map.
  const w = files({ '.github/workflows/ci.yml': wf('__proto__', ...hostile), '.github/workflows/long.yml': wf(long), [evil]: wf('lint') });
  const plan = pinPlan({ names: ['__proto__', long, ...hostile, ...hostile, 'lint'], workflows: w, tip: tip([app('deploy', 4242)]) });
  const block = pinBlock(plan);
  assert.ok(validPins(block), block);
  const pins = (parse(block) as { required_check_sources: Record<string, unknown> }).required_check_sources;
  assert.deepEqual(Object.keys(pins).sort(), [...hostile].sort());
  assert.deepEqual(plan.manual.map((m) => m.why.split(' (')[0]), ["can't be a key in required_check_sources", "can't be a key in required_check_sources", `its pin ${JSON.stringify({ workflow: evil })} isn't one the engine's schema takes`]);
  // Comments carry no control or format character: no terminal escape, bidi override or line break.
  for (const line of block.split('\n').filter((l) => l.startsWith('#'))) assert.doesNotMatch(line, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, JSON.stringify(line));
});

test('the tip is read page by page; past the cap it is partial and says so', () => {
  const mkRuns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `c${i}`, head_sha: 'c'.repeat(40), html_url: `https://github.com/o/r/actions/runs/700/job/${i + 1}`, app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 70 } }));
  const api = (total: number) => {
    const runs = mkRuns(total);
    const asked: string[] = [];
    const f = (path: string) => {
      asked.push(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
      if (path.includes('/check-runs')) return { total_count: total, check_runs: runs.slice((page - 1) * 100, page * 100) };
      return { total_count: 1, workflow_runs: [{ id: 700, html_url: 'https://github.com/o/r/actions/runs/700', check_suite_id: 70, path: '.github/workflows/ci.yml', head_sha: 'c'.repeat(40), repository: { full_name: 'o/r' } }] };
    };
    return { f, asked };
  };
  const a = api(150);
  const t = ghTipRuns('o/r', 'main', a.f)!;
  assert.equal(t.runs.length, 150);
  assert.equal(t.partial, false);
  assert.equal(a.asked.filter((p) => p.includes('/check-runs')).length, 2);
  assert.equal(t.runs[149]!.workflow, '.github/workflows/ci.yml');
  const big = ghTipRuns('o/r', 'main', api(TIP_PAGES_MAX * 100 + 5).f)!;
  assert.equal(big.partial, true);
  assert.equal(
    ghTipRuns('o/r', 'main', () => {
      throw new Error('gh: 502');
    }),
    null,
  );
});

test('adversarial pass: a workflow file or check name with a line break never injects a pin into the block', () => {
  const evil = '.github/workflows/x.yml\n  "deploy": { app_id: 666 }\n#';
  const w = files({ [evil]: 'jobs:\n  "lint\\n  \\"deploy\\": { app_id: 777 }":\n    runs-on: ubuntu-latest\n' });
  const names = [...workflowCheckNames(w).byName.keys()];
  const block = pinBlock(pinPlan({ names: [...names, 'deploy'], workflows: w, tip: tip([app('deploy', 4242), actions(names[0]!, '.github/workflows/other.yml')]) }));
  const pins = (parse(block) as { required_check_sources?: Record<string, unknown> } | null)?.required_check_sources ?? {};
  assert.deepEqual(Object.keys(pins).sort(), ['deploy'], block);
  assert.deepEqual(pins.deploy, { app_id: 4242 }, 'only the pin the evidence gives, never the injected ones');
});
