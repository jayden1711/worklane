// #727: doctor's paste-ready pin block (src/check-pin-block.ts): each required check mapped to the workflow file whose
// jobs post it (PR-only checks too), confirmed against main's tip where it has a run, and a name more than one source
// posts listed for a manual choice, never guessed. Fixture workflows and fixture check runs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { pinBlock, pinNewConfig, pinPlan, workflowCheckNames, type TipRun } from '../src/check-pin-block.js';
import { ProjectConfig } from '../src/config/schema.js';

const WORKFLOWS: Record<string, string> = {
  '.github/workflows/ci.yml': [
    'on: [push, pull_request]',
    'jobs:',
    '  agentshield:',
    '    runs-on: ubuntu-latest',
    '  test:',
    '    name: test',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-latest]',
    '        node: [22, 24]',
    '    runs-on: ${{ matrix.os }}',
    '  shard:',
    "    name: 'test shard ${{ matrix.shard }}/2'",
    '    strategy:',
    '      matrix:',
    '        shard: [1, 2]',
    '  dynamic:',
    '    strategy:',
    '      matrix: ${{ fromJSON(needs.x.outputs.m) }}',
    '  reused:',
    '    uses: ./.github/workflows/lib.yml',
    '  scan:',
    '    runs-on: ubuntu-latest',
  ].join('\n'),
  '.github/workflows/new-deps.yml': 'on: pull_request\njobs:\n  new-deps:\n    runs-on: ubuntu-latest\n',
  '.github/workflows/gitleaks.yml': 'on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n',
  '.github/workflows/broken.yml': 'jobs: [',
};

test('check names from the workflow files: job names or keys, matrices expanded as GitHub names them, unknowable ones left out', () => {
  const names = workflowCheckNames(WORKFLOWS);
  assert.deepEqual([...names.keys()].sort(), ['agentshield', 'new-deps', 'scan', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)', 'test shard 1/2', 'test shard 2/2']);
  assert.deepEqual([...names.get('scan')!].sort(), ['.github/workflows/ci.yml', '.github/workflows/gitleaks.yml']);
});

test('the plan: confirmed on main\'s tip, from the workflow files only (a PR-only check), or a manual choice when ambiguous; never a guess', () => {
  const tip: TipRun[] = [
    { name: 'agentshield', app: 15368, workflow: '.github/workflows/ci.yml' },
    { name: 'test (ubuntu-latest, 22)', app: 15368, workflow: '.github/workflows/other.yml' },
    { name: 'scan', app: 15368, workflow: '.github/workflows/gitleaks.yml' },
    { name: 'deploy', app: 4242, workflow: null },
    { name: 'mixed', app: 4242, workflow: null },
    { name: 'mixed', app: 5555, workflow: null },
  ];
  const plan = pinPlan({ names: ['agentshield', 'new-deps', 'test (ubuntu-latest, 22)', 'scan', 'deploy', 'mixed', 'nowhere'], workflows: WORKFLOWS, tip, tipSha: 'c'.repeat(40) });
  assert.deepEqual(
    plan.pins.map((p) => [p.name, p.pin, p.evidence]),
    [
      ['agentshield', { workflow: '.github/workflows/ci.yml' }, "confirmed: its run on main's tip cccccccc is from .github/workflows/ci.yml"],
      ['new-deps', { workflow: '.github/workflows/new-deps.yml' }, "from the workflow files only: main's tip cccccccc has no run of it"],
      ['deploy', { app_id: 4242 }, "from main's tip cccccccc only: no workflow file posts it, and App 4242 does there"],
    ],
  );
  assert.deepEqual(
    plan.manual.map((m) => m.name),
    ['test (ubuntu-latest, 22)', 'scan', 'mixed', 'nowhere'],
  );
  assert.match(plan.manual.find((m) => m.name === 'scan')!.why, /more than one workflow file \(\.github\/workflows\/ci\.yml, \.github\/workflows\/gitleaks\.yml\)/);
  assert.match(plan.manual.find((m) => m.name === 'test (ubuntu-latest, 22)')!.why, /the workflow files say \.github\/workflows\/ci\.yml, but main's tip cccccccc has it from workflow \.github\/workflows\/other\.yml/);
  // Main's tip unreadable: from the workflow files only, saying so.
  assert.match(pinPlan({ names: ['agentshield'], workflows: WORKFLOWS, tip: null }).pins[0]!.evidence, /couldn't be read/);
});

test('the block pastes into config.yaml as a valid required_check_sources, with the manual choices as comments', () => {
  const plan = pinPlan({ names: ['agentshield', 'new-deps', 'test (ubuntu-latest, 22)', 'deploy', 'scan'], workflows: WORKFLOWS, tip: [{ name: 'deploy', app: 4242, workflow: null }] });
  const block = pinBlock(plan);
  const parsed = ProjectConfig.shape.required_check_sources.parse((parse(block) as { required_check_sources: unknown }).required_check_sources);
  assert.deepEqual(parsed, { agentshield: { workflow: '.github/workflows/ci.yml' }, 'new-deps': { workflow: '.github/workflows/new-deps.yml' }, 'test (ubuntu-latest, 22)': { workflow: '.github/workflows/ci.yml' }, deploy: { app_id: 4242 } });
  assert.match(block, /^# needs a manual choice: "scan": posted by more than one workflow file/m);
  assert.equal(pinBlock({ pins: [], manual: [] }), '');
});

test('a new config gets the block appended; a repo with no workflow files gets nothing', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pin-new-'));
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(repo, 'cfg'));
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), WORKFLOWS['.github/workflows/new-deps.yml']!);
  const cfgDir = join(repo, 'cfg');
  writeFileSync(join(cfgDir, 'config.yaml'), 'version: 1\n');
  pinNewConfig(cfgDir);
  assert.deepEqual((parse(readFileSync(join(cfgDir, 'config.yaml'), 'utf8')) as { required_check_sources: unknown }).required_check_sources, { 'new-deps': { workflow: '.github/workflows/ci.yml' } });
  const bare = mkdtempSync(join(tmpdir(), 'pin-new-'));
  writeFileSync(join(bare, 'config.yaml'), 'version: 1\n');
  pinNewConfig(bare);
  assert.equal(readFileSync(join(bare, 'config.yaml'), 'utf8'), 'version: 1\n');
});
