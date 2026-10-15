// Auto-config: init's "Repo config" step for a repo with no config folder yet. It reads the default branch (in a
// scratch worktree, never the person's checkout), detects the project's ecosystems and their test commands
// (package.json scripts and the package manager from the lockfile, pytest/pyproject, go.mod, Cargo.toml, Makefile
// targets), drafts tests.yaml (runner.changed / full / one, the test globs, the worktree setup) and config.yaml, runs
// each drafted command on the default branch through the project-command path (src/coordinator/shared.ts sh: the
// project env only, no credentials, a time limit), and proposes the result as a PR from a branch of its own. It never
// commits to or pushes the default branch.
//
// Never a silent guess: anything ambiguous or unknown (two test commands, none, a monorepo, two lockfiles, no way to
// run one test file, a command that fails on the default branch) is a question with its choices. Init asks it on the
// terminal, or records it for `init --answer <id>=<choice>` and the dashboard's First-run page; the answers are kept
// in init's state, and the next run picks up from them.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { TestsConfig } from './config/schema.js';
import { sh } from './coordinator/shared.js';
import type { Config } from './config/load.js';
import type { RunAs } from './runner.js';
import { projectStateDir } from './guardrails/context.js';
import { scaffoldConfig } from './install.js';
import { defaultBranchRefusal } from './push-guard.js';
import { createWorktree, removeWorktree, type WorktreeOptions } from './worktrees.js';

export type Slot = 'setup' | 'full' | 'changed' | 'one';
export const SLOTS: readonly Slot[] = ['setup', 'full', 'changed', 'one'];

export interface Choice {
  id: string;
  label: string;
  /** The command this choice sets, when it sets one. */
  command?: string;
}

export interface Question {
  id: string;
  ask: string;
  choices: Choice[];
  /** Whether a typed command is also an answer (`custom:<command>`). */
  custom: boolean;
  /** The command a "fails on the default branch" question is about. */
  about?: string;
}

export interface Answer {
  choice: string;
  /** A typed command (choice `custom`). */
  command?: string;
}

export interface Verification {
  slot: Slot;
  command: string;
  /** The default branch's commit it ran on. */
  base: string;
  /** Exit status; null: it was stopped at the time limit, or didn't start. */
  code: number | null;
  passed: boolean;
  ms: number;
  tail: string;
  at: string;
}

export interface AutoConfigState {
  /** Answers to the detection questions, by question id. */
  answers: Record<string, Answer>;
  /** Commands set by answering "fails on the default branch" (null: left out). */
  overrides: Partial<Record<Slot, string | null>>;
  /** Commands kept although they failed on the default branch ("use it anyway"). */
  accepted: string[];
  /** The questions still open, as last asked (the checklist and the First-run page show them). */
  questions: Question[];
  verified: Verification[];
  base: string | null;
  /** The setup PR, once opened. */
  pr: { number: number | null; url: string; branch: string } | null;
  /**
   * WHY (#468): the drafted config held for the person to preview before any PR (the dashboard's draft): the top-level
   * YAML files as drafted (and edited on the page), the commit it was drafted on, and the PR body. Absent from the
   * terminal's init, which proposes at once.
   */
  draft?: HeldDraft | null;
}

export interface HeldDraft {
  /** The default branch and the commit the draft was made (and its commands run) on. */
  branch: string;
  base: string;
  owner: string | null;
  /** The config folder's top-level *.yaml files, by name. */
  yaml: Record<string, string>;
  body: string;
  at: string;
}

export const emptyAutoConfig = (): AutoConfigState => ({ answers: {}, overrides: {}, accepted: [], questions: [], verified: [], base: null, pr: null });

/** The branch the scaffold is proposed from (scripts/setup/checkout.sh pushes the same one on a server). */
export const SETUP_BRANCH = `${BRAND.cli}/setup`;

// ---------- detection ----------

interface Cand {
  command: string;
  from: string;
}

/** One ecosystem's findings at the repo root or in one subdirectory. */
interface Part {
  name: string;
  full: Cand[];
  changed: Cand | null;
  one: Cand | null;
  setup: string[];
  /** A workspace-wide test command (a monorepo's "all of them"). */
  all: Cand | null;
  monorepo: string | null;
  questions: Question[];
  notes: string[];
}

const part = (name: string, o: Partial<Part> = {}): Part => ({ name, full: [], changed: null, one: null, setup: [], all: null, monorepo: null, questions: [], notes: [], ...o });

/** Where an ecosystem was found: the root ('') or a subdirectory, and the repo's tracked files. */
interface At {
  dir: string;
  rel: string;
  files: string[];
  has(file: string): boolean;
  read(file: string): string | null;
  /** A command run from here (the subdirectory's commands `cd` into it first). */
  cd(command: string): string;
  /** A question id, per subdirectory. */
  qid(id: string): string;
  /** "frontend/: " for a subdirectory, '' at the root. */
  where: string;
}

function at(dir: string, rel: string, files: string[]): At {
  const p = rel ? `${rel}/` : '';
  const set = new Set(files);
  return {
    dir,
    rel,
    files,
    has: (f) => set.has(p + f),
    read: (f) => {
      if (!set.has(p + f)) return null;
      try {
        return readFileSync(join(dir, p + f), 'utf8');
      } catch {
        return null;
      }
    },
    cd: (c) => (rel ? `cd ${rel} && ${c}` : c),
    qid: (id) => (rel ? `${id}:${rel}` : id),
    where: p,
  };
}

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';
const PMS: readonly Pm[] = ['npm', 'pnpm', 'yarn', 'bun'];
const LOCKS: Record<string, Pm> = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
const EXEC: Record<Pm, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };
const runScript = (pm: Pm, name: string) => (name === 'test' ? `${pm} test` : `${pm} run ${name}`);
const installFor = (pm: Pm, locked: boolean) => (!locked ? `${pm} install` : pm === 'npm' ? 'npm ci' : `${pm} install --frozen-lockfile`);
const ALL_TESTS: Record<Pm, string> = { npm: 'npm test --workspaces --if-present', pnpm: 'pnpm -r test', yarn: 'yarn workspaces foreach -A run test', bun: "bun run --filter '*' test" };
/** npm's placeholder for a project with no tests. */
const NO_TEST = /no test specified/;
const FAST_SCRIPTS = ['test:changed', 'test:fast', 'test:related'];

function node(a: At, answers: Record<string, Answer>): Part | null {
  const text = a.read('package.json');
  if (text === null) return null;
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown; packageManager?: string };
  try {
    pkg = JSON.parse(text) as typeof pkg;
  } catch {
    return part('node', { notes: [`${a.where}package.json doesn't parse: its scripts weren't read`] });
  }
  const lockPms = [...new Set(Object.keys(LOCKS).filter((f) => a.has(f)).map((f) => LOCKS[f]!))];
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? '')?.[1] as Pm | undefined;
  let pm: Pm | undefined = declared ?? (lockPms.length === 1 ? lockPms[0] : undefined);
  const questions: Question[] = [];
  if (!pm) {
    const id = a.qid('package-manager');
    const opts = lockPms.length ? lockPms : PMS;
    const ans = answers[id]?.choice as Pm | undefined;
    if (ans && opts.includes(ans)) pm = ans;
    else {
      const ask = lockPms.length ? `${a.where}package.json has lockfiles for ${lockPms.join(' and ')}: which package manager runs it?` : `${a.where}package.json has no lockfile and no packageManager field: which package manager runs it?`;
      questions.push({ id, ask, choices: opts.map((p) => ({ id: p, label: p })), custom: false });
      return part('node', { questions });
    }
  }
  const scripts = pkg.scripts ?? {};
  const usable = (n: string) => typeof scripts[n] === 'string' && !NO_TEST.test(scripts[n]!) && !/watch/i.test(n);
  const full = Object.keys(scripts)
    .filter((n) => /^test(:|$)/.test(n) && usable(n) && !FAST_SCRIPTS.includes(n))
    .map((n) => ({ command: a.cd(runScript(pm, n)), from: `${a.where}package.json scripts.${n}` }));
  const fast = FAST_SCRIPTS.find(usable);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const x = EXEC[pm];
  const testScript = scripts.test ?? '';
  // A single test file, by the framework the project depends on; only at the root (one runs with a repo-relative path).
  const one = a.rel
    ? null
    : deps.vitest
      ? `${x} vitest run {file}`
      : deps.jest
        ? `${x} jest {file}`
        : deps.mocha
          ? `${x} mocha {file}`
          : deps.ava
            ? `${x} ava {file}`
            : /\btsx\s+--test\b/.test(testScript)
              ? `${x} tsx --test {file}`
              : /\bnode\s+(?:[^|&;]*\s)?--test\b/.test(testScript)
                ? 'node --test {file}'
                : null;
  const workspaces = pkg.workspaces !== undefined || a.has('pnpm-workspace.yaml') || a.has('lerna.json') || a.has('nx.json') || a.has('turbo.json');
  return part(`node (${pm}${declared ? ', from packageManager' : lockPms.length ? ', from its lockfile' : ', as answered'})`, {
    full,
    changed: fast ? { command: a.cd(runScript(pm, fast)), from: `${a.where}package.json scripts.${fast}` } : null,
    one: one ? { command: one, from: `${a.where}package.json devDependencies` } : null,
    setup: [a.cd(installFor(pm, lockPms.includes(pm)))],
    all: workspaces ? { command: a.cd(ALL_TESTS[pm]), from: `every ${pm} workspace's test script` } : null,
    monorepo: workspaces ? `${a.where}package.json workspaces` : null,
    questions,
  });
}

const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt', 'Pipfile', 'pytest.ini', 'tox.ini'];
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;

function python(a: At): Part | null {
  const markers = PY_MARKERS.filter((f) => a.has(f));
  const p = a.rel ? `${a.rel}/` : '';
  const tests = a.files.filter((f) => f.startsWith(p) && PY_TEST.test(f));
  if (!markers.length && !tests.length) return null;
  const text = markers.map((f) => a.read(f) ?? '').join('\n');
  const [via, run, setup]: [string, string, string | null] = a.has('uv.lock')
    ? ['uv', 'uv run ', 'uv sync']
    : a.has('poetry.lock')
      ? ['poetry', 'poetry run ', 'poetry install']
      : a.has('pdm.lock')
        ? ['pdm', 'pdm run ', 'pdm install']
        : a.has('Pipfile')
          ? ['pipenv', 'pipenv run ', 'pipenv install --dev']
          : ['python3', '', null];
  const pytest = a.has('pytest.ini') || a.has('conftest.py') || a.files.some((f) => f.startsWith(p) && f.endsWith('/conftest.py')) || /\bpytest\b/.test(text);
  const notes = setup ? [] : [`${a.where}no Python lockfile (uv, poetry, pdm, pipenv): worktree.setup installs nothing, so the tests run with whatever this machine's python3 has`];
  if (pytest) {
    const cmd = run ? `${run}pytest` : 'python3 -m pytest';
    return part(`python (pytest via ${via})`, { full: [{ command: a.cd(cmd), from: `${a.where}${markers[0] ?? 'conftest.py'} (pytest)` }], one: a.rel ? null : { command: `${cmd} {file}`, from: 'pytest' }, setup: setup ? [a.cd(setup)] : [], notes });
  }
  if (tests.length) {
    const cmd = run ? `${run}python -m unittest` : 'python3 -m unittest';
    return part(`python (unittest via ${via})`, { full: [{ command: a.cd(`${cmd} discover`), from: `${a.where}test_*.py files (no pytest)` }], one: a.rel ? null : { command: `${cmd} {file}`, from: 'unittest' }, setup: setup ? [a.cd(setup)] : [], notes });
  }
  return part(`python (${via})`, { setup: setup ? [a.cd(setup)] : [], notes: [...notes, `${a.where}${markers.join(', ')}: no pytest and no test files`] });
}

function go(a: At): Part | null {
  if (!a.has('go.mod')) return null;
  return part('go', {
    full: [{ command: a.cd('go test ./...'), from: `${a.where}go.mod` }],
    one: a.rel ? null : { command: 'go test "./$(dirname {file})"', from: 'go test (the file\'s package)' },
    setup: [a.cd('go mod download')],
    monorepo: a.has('go.work') ? `${a.where}go.work` : null,
  });
}

function rust(a: At): Part | null {
  const text = a.read('Cargo.toml');
  if (text === null) return null;
  const ws = /^\[workspace\]/m.test(text);
  return part(ws ? 'rust (cargo workspace)' : 'rust', {
    full: [{ command: a.cd(ws ? 'cargo test --workspace' : 'cargo test'), from: `${a.where}Cargo.toml` }],
    one: a.rel ? null : { command: 'cargo test --test "$(basename {file} .rs)"', from: 'cargo test (an integration test under tests/)' },
  });
}

function make(a: At): Part | null {
  const file = ['GNUmakefile', 'Makefile', 'makefile'].find((f) => a.has(f));
  if (!file) return null;
  const text = a.read(file) ?? '';
  const targets = new Set([...text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.\/-]*)\s*:(?!=)/gm)].map((m) => m[1]!));
  const t = targets.has('test') ? 'test' : targets.has('check') ? 'check' : null;
  return part('make', { full: t ? [{ command: a.cd(`make ${t}`), from: `${a.where}${file} target ${t}` }] : [], notes: t ? [] : [`${a.where}${file} has no test or check target`] });
}

const ECOSYSTEMS = [node, python, go, rust, make] as const;
const SKIP_DIRS = /^(\.|node_modules$|vendor$|dist$|build$|target$)/;

/** What the repo is, from its tracked files at `dir`. Questions it can't settle without the person are in `questions`. */
export interface Detection {
  ecosystems: string[];
  full: Cand[];
  changed: Cand | null;
  one: Cand | null;
  setup: string[];
  all: Cand | null;
  monorepo: string | null;
  testFiles: string[];
  testGlobs: string[];
  assertion: string | null;
  appPaths: string[];
  questions: Question[];
  notes: string[];
}

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const GO_TEST = /_test\.go$/;
const RS_TEST = /(^|\/)tests\/[^/]+\.rs$/;
const SOURCE = /\.([cm]?[jt]sx?|py|go|rs)$/;
const ASSERTIONS: [RegExp, string][] = [
  [JS_TEST, '\\b(assert|expect)\\b'],
  [PY_TEST, '\\bassert\\b'],
  [GO_TEST, '\\bt\\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\\b'],
  [RS_TEST, '\\bassert(_eq|_ne)?!'],
];
const isTest = (f: string) => ASSERTIONS.some(([re]) => re.test(f));

/** Globs for the test files that are there: `<top dir>/**​/<pattern>`, or the pattern alone at the root. */
export function testGlobsOf(testFiles: string[]): string[] {
  const out = new Set<string>();
  for (const f of testFiles) {
    const name = f.split('/').pop()!;
    const pat = JS_TEST.test(name)
      ? `*.${name.match(JS_TEST)![1]}.${name.split('.').pop()}`
      : PY_TEST.test(name)
        ? name.startsWith('test_') ? 'test_*.py' : '*_test.py'
        : GO_TEST.test(name)
          ? '*_test.go'
          : '*.rs';
    const top = f.includes('/') ? f.split('/')[0]! : '';
    out.add(top ? `${top}/**/${pat}` : pat);
  }
  return [...out].sort();
}

export function detectProject(dir: string, files: string[], answers: Record<string, Answer> = {}): Detection {
  const findAt = (rel: string) => ECOSYSTEMS.map((e) => e(at(dir, rel, files), answers)).filter((p): p is Part => p !== null);
  let parts = findAt('');
  const notes: string[] = [];
  let monorepo: string | null = null;
  if (!parts.length) {
    // Nothing at the root: the projects in its top-level directories.
    const tops = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))].filter((d) => !SKIP_DIRS.test(d)).sort();
    const found = tops.map((d) => [d, findAt(d)] as const).filter(([, p]) => p.length);
    parts = found.flatMap(([, p]) => p);
    if (found.length > 1) monorepo = `projects in ${found.map(([d]) => `${d}/`).join(', ')}`;
    else if (found.length === 1) notes.push(`nothing at the root; the project in ${found[0]![0]}/ (its commands run there)`);
  }
  monorepo ??= parts.find((p) => p.monorepo)?.monorepo ?? null;
  const testFiles = files.filter(isTest);
  const assertion = ASSERTIONS.filter(([re]) => testFiles.some((f) => re.test(f))).map(([, a]) => a);
  const tops = [...new Set(files.filter((f) => SOURCE.test(f) && !isTest(f) && f.includes('/')).map((f) => f.split('/')[0]!))].filter((d) => !SKIP_DIRS.test(d) && !/^(tests?|spec|__tests__|examples?|docs?|scripts?)$/.test(d));
  const appPaths = tops.sort().slice(0, 8).map((d) => `${d}/**`);
  const first = <T>(xs: (T | null)[]) => xs.find((v) => v !== null) ?? null;
  return {
    ecosystems: parts.map((p) => p.name),
    full: parts.flatMap((p) => p.full),
    changed: first(parts.map((p) => p.changed)),
    one: first(parts.map((p) => p.one)),
    setup: parts.flatMap((p) => p.setup),
    all: first(parts.map((p) => p.all)),
    monorepo,
    testFiles,
    testGlobs: testGlobsOf(testFiles),
    assertion: assertion.length ? assertion.join('|') : null,
    appPaths: appPaths.length ? appPaths : testFiles.length ? ['**'] : [],
    questions: parts.flatMap((p) => p.questions),
    notes: [...notes, ...parts.flatMap((p) => p.notes)],
  };
}

// ---------- the plan: detection plus answers ----------

/** "No tests yet": the gates run this, which passes, until a real command is set. */
export const NO_TESTS = 'true';
const CUSTOM: Choice = { id: 'custom', label: 'another command (custom:<command>)' };

export interface Plan {
  detection: Detection;
  /** Questions with no answer yet. Nothing is drafted or run while there are any. */
  open: Question[];
  commands: Record<Slot, string | null>;
  notes: string[];
}

function pick(q: Question, a: Answer | undefined): string | null | undefined {
  if (!a) return undefined;
  if (a.choice === 'custom') return q.custom && a.command?.trim() ? a.command.trim() : undefined;
  const c = q.choices.find((x) => x.id === a.choice);
  return c ? (c.command ?? null) : undefined;
}

export function planFrom(d: Detection, s: Pick<AutoConfigState, 'answers' | 'overrides'>): Plan {
  const open: Question[] = [...d.questions];
  const notes = [...d.notes];
  if (open.length) return { detection: d, open, commands: { setup: null, full: null, changed: null, one: null }, notes };
  const numbered = (cs: Cand[]): Choice[] => cs.map((c, i) => ({ id: String(i + 1), label: `${c.command}   (${c.from})`, command: c.command }));
  let full: string | null | undefined;
  if (d.monorepo) {
    const choices = numbered(d.full);
    if (d.all && !d.full.some((c) => c.command === d.all!.command)) choices.push({ id: 'all', label: `${d.all.command}   (${d.all.from})`, command: d.all.command });
    else if (d.full.length > 1) choices.push({ id: 'all', label: `all of them, one after the other`, command: d.full.map((c) => c.command).join(' && ') });
    const q: Question = { id: 'monorepo', ask: `This looks like a monorepo (${d.monorepo}): which command runs the tests?`, choices: [...choices, CUSTOM], custom: true };
    full = pick(q, s.answers[q.id]);
    if (full === undefined) open.push(q);
  } else if (d.full.length > 1) {
    const q: Question = { id: 'test-command', ask: `${d.full.length} test commands found: which one is the full test run?`, choices: [...numbered(d.full), { id: 'all', label: 'all of them, one after the other', command: d.full.map((c) => c.command).join(' && ') }, CUSTOM], custom: true };
    full = pick(q, s.answers[q.id]);
    if (full === undefined) open.push(q);
  } else if (d.full.length === 1) full = d.full[0]!.command;
  else {
    const q: Question = { id: 'no-test-command', ask: `No test command found${d.ecosystems.length ? ` (${d.ecosystems.join(', ')})` : ''}: how do the tests run?`, choices: [CUSTOM, { id: 'none', label: `no tests yet: the gates run \`${NO_TESTS}\` (pass everything) until you set one in tests.yaml`, command: NO_TESTS }], custom: true };
    full = pick(q, s.answers[q.id]);
    if (full === undefined) open.push(q);
  }
  let one: string | null | undefined = d.one?.command ?? null;
  if (!d.one && full && full !== NO_TESTS) {
    const q: Question = { id: 'one-test-file', ask: 'No way found to run a single test file (tests.yaml runner.one, optional): set one?', choices: [{ id: 'none', label: 'leave it unset (per-file checks report it unavailable)' }, { ...CUSTOM, label: 'a command with {file} (custom:<command>)' }], custom: true };
    one = pick(q, s.answers[q.id]);
    if (one === undefined) open.push(q);
    else if (one && !one.includes('{file}')) {
      delete s.answers[q.id];
      open.push({ ...q, ask: `${q.ask} (it must contain {file})` });
      one = undefined;
    }
  }
  if (open.length) return { detection: d, open, commands: { setup: null, full: null, changed: null, one: null }, notes };
  const o = s.overrides;
  const fullCmd = o.full !== undefined ? o.full : full!;
  const changed = o.changed !== undefined ? o.changed : (d.changed?.command ?? fullCmd);
  if (!d.changed && o.changed === undefined && fullCmd && fullCmd !== NO_TESTS) notes.push('runner.changed is the full run: no impact-selected test command was found (set one in tests.yaml to make the fast tier faster)');
  const setup = o.setup !== undefined ? o.setup : d.setup.length ? d.setup.join(' && ') : null;
  return { detection: d, open, commands: { setup, full: fullCmd ?? NO_TESTS, changed: changed ?? NO_TESTS, one: o.one !== undefined ? o.one : (one ?? null) }, notes };
}

/** The "fails on the default branch" question for a slot's command. */
export function failureQuestion(slot: Slot, command: string, d: Detection): Question {
  const others = slot === 'full' || slot === 'changed' ? d.full.filter((c) => c.command !== command) : [];
  const skip: Record<Slot, string> = {
    setup: 'skip: no setup steps (worktree.setup stays empty)',
    full: `skip: leave it out (the gates run \`${NO_TESTS}\` until you set one in tests.yaml)`,
    changed: `skip: leave it out (the fast tier runs \`${NO_TESTS}\` until you set one in tests.yaml)`,
    one: 'skip: leave runner.one unset',
  };
  const what: Record<Slot, string> = { setup: 'The worktree setup', full: 'The full test run', changed: 'The fast test run (runner.changed)', one: 'The single-file test run (runner.one)' };
  return {
    id: `${slot}-fails`,
    ask: `${what[slot]} \`${command}\` fails on the default branch: use it anyway, pick another, or skip?`,
    about: command,
    choices: [{ id: 'use', label: 'use it anyway (it fails on the default branch today)', command }, ...others.map((c, i) => ({ id: String(i + 1), label: `${c.command}   (${c.from})`, command: c.command })), { ...CUSTOM, label: 'pick another: type a command (custom:<command>)' }, { id: 'skip', label: skip[slot] }],
    custom: true,
  };
}

/** Record an answer: a detection question's in `answers`; a failure question's as an override, or as accepted. */
export function applyAnswer(s: AutoConfigState, q: Question, a: Answer): string | null {
  const known = a.choice === 'custom' ? q.custom && !!a.command?.trim() : q.choices.some((c) => c.id === a.choice);
  if (!known) return `"${a.choice}" isn't an answer to ${q.id}: ${q.choices.map((c) => c.id).join(', ')}`;
  const slot = /^(setup|full|changed|one)-fails$/.exec(q.id)?.[1] as Slot | undefined;
  if (!slot) {
    s.answers[q.id] = a.choice === 'custom' ? { choice: 'custom', command: a.command!.trim() } : { choice: a.choice };
    return null;
  }
  if (a.choice === 'use') s.accepted = [...new Set([...s.accepted, q.about!])];
  else if (a.choice === 'skip') s.overrides[slot] = slot === 'full' || slot === 'changed' ? NO_TESTS : null;
  else s.overrides[slot] = a.choice === 'custom' ? a.command!.trim() : q.choices.find((c) => c.id === a.choice)!.command!;
  return null;
}

/** An answer as typed: a choice's id or number, or `custom:<command>`. */
export function parseAnswer(q: Question, text: string): Answer | null {
  const t = text.trim();
  const m = /^custom:\s*(.+)$/s.exec(t);
  if (m) return q.custom ? { choice: 'custom', command: m[1]!.trim() } : null;
  const c = q.choices.find((x) => x.id === t);
  return c ? { choice: c.id } : null;
}

// ---------- the draft ----------

const verifiedLine = (v: Verification | undefined) => (!v ? 'not run' : v.passed ? `passed on ${v.base.slice(0, 8)} in ${Math.round(v.ms / 1000)} s` : `FAILED on ${v.base.slice(0, 8)} (exit ${v.code ?? 'none: time limit'}), kept as answered`);

/** tests.yaml as drafted: the commands, the test globs and the worktree setup; validated against the schema. */
export function draftTests(p: Plan, verified: Verification[]): string {
  const d = p.detection;
  const c = p.commands;
  const doc = {
    version: 1,
    runner: { kind: 'command', changed: c.changed ?? NO_TESTS, full: c.full ?? NO_TESTS, ...(c.one ? { one: c.one } : {}) },
    ...(d.testGlobs.length && d.assertion && d.appPaths.length ? { vacuity: { test_globs: d.testGlobs, assertion_pattern: d.assertion, app_paths: d.appPaths, dynamic: false } } : {}),
    worktree: { root: '.claude/worktrees', setup: c.setup ? c.setup.split(' && ') : [] },
    env: {},
    checks: [],
    tiers: [],
  };
  const r = TestsConfig.safeParse(doc);
  if (!r.success) throw new Error(`the drafted tests.yaml doesn't validate: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const find = (_slot: Slot, cmd: string | null) => verified.find((v) => v.command === cmd);
  const head = [
    `# How the project's tests run. Drafted by \`${BRAND.cli} init\` from what the repo has (${d.ecosystems.join(', ') || 'nothing detected'}),`,
    `# each command run on the default branch first. Review it before merging; every line can be changed.`,
    ...(['setup', 'full', 'changed', 'one'] as const).filter((s) => c[s]).map((s) => `#   ${s === 'setup' ? 'worktree.setup' : `runner.${s}`}: ${c[s]}  -> ${c[s] === NO_TESTS ? 'no tests yet, as answered' : verifiedLine(find(s, c[s]))}`),
    ...p.notes.map((n) => `# note: ${n}`),
  ];
  return `${head.join('\n')}\n${stringify(doc, { lineWidth: 0 })}`;
}

// ---------- verification, the branch and the PR ----------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What auto-config does to the world: git, gh (the person's own login), the terminal. Commands run through sh. */
export interface AutoConfigIo {
  git(args: string[], cwd: string): RunResult;
  /** gh's command line (local mode), or the same few calls answered over GitHub's REST API (src/server-auto-config.ts). */
  gh(args: string[], cwd: string): RunResult | Promise<RunResult>;
  /** null: there's no terminal to ask on. */
  ask(question: string): Promise<string | null>;
  say(line: string): void;
}

export interface AutoConfigOptions {
  root: string;
  repo: string;
  io: AutoConfigIo;
  state: AutoConfigState;
  /** Answers given up front (`init --answer id=choice`). */
  given?: Record<string, string>;
  /** Each command's time limit (default 15 minutes). */
  timeoutMs?: number;
  /** Keep the state (each answer and result is saved as it comes). */
  save(): void;
  /** Server mode: the drafted commands run as the instance's agent user, never as the user holding the credentials. */
  runAs?: RunAs;
  /** Where the scratch worktree goes (default: under the project's state dir), and where its ownership record is kept. */
  worktreeRoot?: string;
  worktreeStateDir?: string;
  /** The config's owner when gh can't say who is running it (an App's token has no user): the machine's first owner. */
  owner?: string;
  /** Fit the drafted config folder to its setting before it is validated (a server instance's policy: budget, workers). */
  adjust?(cfgDir: string): void;
  /** Problems beyond the schema (an instance's policy), each one line: any stops the proposal. */
  check?(cfg: Config): string[];
  /** WHY (#468): draft and hold it for a preview (state.draft); no branch is pushed and no PR opened until proposeHeldDraft. */
  hold?: boolean;
}

export type AutoConfigResult =
  | { kind: 'questions'; open: Question[]; detail: string }
  | { kind: 'proposed'; detail: string }
  | { kind: 'drafted'; detail: string }
  | { kind: 'merged'; branch: string }
  | { kind: 'failed'; detail: string };

export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

async function defaultBranchOf(o: AutoConfigOptions): Promise<string | null> {
  const gh = await o.io.gh(['repo', 'view', o.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], o.root);
  const name = gh.status === 0 ? gh.stdout.trim() : '';
  if (/^[A-Za-z0-9._/-]+$/.test(name)) return name;
  const head = o.io.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], o.root);
  return head.status === 0 && head.stdout.trim().startsWith('origin/') ? head.stdout.trim().slice('origin/'.length) : null;
}

async function ask(o: AutoConfigOptions, q: Question): Promise<Answer | null> {
  const given = o.given?.[q.id];
  if (given !== undefined) {
    const a = parseAnswer(q, given);
    if (a) return a;
    o.io.say(`   --answer ${q.id}=${given}: not one of ${q.choices.map((c) => c.id).join(', ')}`);
  }
  o.io.say(`   ? ${q.ask}`);
  for (const c of q.choices) o.io.say(`       ${c.id})  ${c.label}`);
  for (let tries = 0; tries < 3; tries++) {
    const t = await o.io.ask(`     answer (${q.choices.map((c) => c.id).join(' / ')}): `);
    if (t === null) return null;
    if (t.trim() === 'custom' && q.custom) {
      const cmd = await o.io.ask('     the command: ');
      if (cmd === null) return null;
      if (cmd.trim()) return { choice: 'custom', command: cmd.trim() };
      continue;
    }
    const a = parseAnswer(q, t);
    if (a) return a;
    o.io.say(`     "${t.trim()}" isn't one of them`);
  }
  return null;
}

/** Ask the open questions; false when one stays unanswered (no terminal, or no valid answer). */
async function settle(o: AutoConfigOptions, open: Question[]): Promise<boolean> {
  for (const q of open) {
    const a = await ask(o, q);
    if (!a) return false;
    const why = applyAnswer(o.state, q, a);
    if (why) {
      o.io.say(`     ${why}`);
      return false;
    }
    o.save();
  }
  return true;
}

const questionsDetail = (open: Question[]) =>
  `${open.length} question${open.length === 1 ? '' : 's'} to answer before the config is proposed: ${open.map((q) => `${q.id} (${q.choices.map((c) => c.id).join(' / ')})`).join('; ')}. Run \`${BRAND.cli} init\` in a terminal to answer, or \`${BRAND.cli} init --answer <id>=<choice>\``;

/**
 * Detect, ask, verify on the default branch, and propose the config as a PR. Resumable: answers and results are in
 * the state, and an open PR is checked rather than opened again.
 */
export async function autoConfigure(o: AutoConfigOptions): Promise<AutoConfigResult> {
  const s = o.state;
  const git = (args: string[], cwd = o.root) => o.io.git(args, cwd);
  const branch = await defaultBranchOf(o);
  if (!branch) return { kind: 'failed', detail: `can't tell ${o.repo}'s default branch (gh repo view, origin/HEAD): run \`git remote set-head origin --auto\`, then init again` };
  if (branch === SETUP_BRANCH) return { kind: 'failed', detail: `the default branch is ${SETUP_BRANCH}, the branch the config would be proposed from` };
  const fetch = git(['fetch', '-q', 'origin', branch]);
  if (fetch.status !== 0) return { kind: 'failed', detail: `git fetch origin ${branch} failed: ${fetch.stderr.trim().split('\n')[0] ?? ''}` };
  if (git(['cat-file', '-e', `origin/${branch}:${BRAND.configDir}/config.yaml`]).status === 0) return { kind: 'merged', branch };
  if (s.pr?.number) {
    const v = await o.io.gh(['pr', 'view', String(s.pr.number), '--repo', o.repo, '--json', 'state', '--jq', '.state'], o.root);
    const state = v.status === 0 ? v.stdout.trim() : '';
    if (state === 'OPEN') return { kind: 'proposed', detail: `proposed in PR #${s.pr.number} (${s.pr.url}), from ${s.pr.branch}: review and merge it, then run \`${BRAND.cli} init\` again (it picks up here)` };
    if (state === 'MERGED') return { kind: 'failed', detail: `PR #${s.pr.number} merged, but origin/${branch} has no ${BRAND.configDir}/config.yaml: fetch, check, and run init again` };
    s.pr = null; // closed unmerged: propose again
    o.save();
  }
  const base = git(['rev-parse', `origin/${branch}`]).stdout.trim();
  s.base = base;
  const wt: WorktreeOptions = { repo: o.root, root: o.worktreeRoot ?? join(projectStateDir(o.root), 'worktrees'), stateDir: o.worktreeStateDir ?? projectStateDir(o.root), setup: [] };
  let path: string;
  try {
    path = createWorktree(wt, 'setup', SETUP_BRANCH, base).path;
  } catch (e) {
    return { kind: 'failed', detail: `couldn't make a scratch worktree of origin/${branch}: ${(e as Error).message.split('\n')[0]}` };
  }
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    let setUp = false;
    for (let round = 0; round < 12; round++) {
      const files = git(['ls-files'], path).stdout.split('\n').filter(Boolean);
      const d = detectProject(path, files, s.answers);
      const p = planFrom(d, s);
      if (p.open.length) {
        s.questions = p.open;
        o.save();
        if (await settle(o, p.open)) continue;
        return { kind: 'questions', open: p.open, detail: questionsDetail(p.open) };
      }
      // Run what isn't verified at this commit yet: setup first (its deps are what the tests need), then each command.
      const runs: [Slot, string][] = [];
      for (const slot of SLOTS) {
        const cmd = p.commands[slot];
        if (!cmd || cmd === NO_TESTS || runs.some(([, c]) => c === cmd)) continue;
        if (!s.verified.some((v) => v.command === cmd && v.base === base)) runs.push([slot, cmd]);
      }
      if (runs.length && !setUp && p.commands.setup && !runs.some(([slot]) => slot === 'setup')) runs.unshift(['setup', p.commands.setup]);
      for (const [slot, cmd] of runs) {
        const sample = slot === 'one' ? d.testFiles[0] : undefined;
        if (slot === 'one' && !sample) continue;
        const command = sample ? cmd.replaceAll('{file}', sample) : cmd;
        o.io.say(`   running ${slot === 'setup' ? 'the setup' : `runner.${slot}`} on ${branch} (${base.slice(0, 8)}): ${command}`);
        const t0 = Date.now();
        const r = await sh(command, path, timeoutMs, o.runAs);
        if (slot === 'setup') setUp = true;
        const v: Verification = { slot, command: cmd, base, code: r.code, passed: r.code === 0, ms: Date.now() - t0, tail: r.tail.slice(-2000), at: new Date().toISOString() };
        s.verified = [...s.verified.filter((x) => !(x.command === cmd && x.base === base)), v];
        o.io.say(`     ${v.passed ? 'passed' : `FAILED (exit ${r.code ?? `none: stopped at the ${Math.round(timeoutMs / 1000)} s limit`})`} in ${Math.round(v.ms / 1000)} s`);
        o.save();
      }
      // One question per failing command (runner.changed is often the full run's command: asked once, as the full run).
      const asked = new Set<string>();
      const failing = SLOTS.flatMap((slot) => {
        const cmd = p.commands[slot];
        const v = s.verified.find((x) => x.command === cmd && x.base === base);
        if (!cmd || !v || v.passed || s.accepted.includes(cmd) || asked.has(cmd)) return [];
        asked.add(cmd);
        return [failureQuestion(slot, cmd, d)];
      });
      if (failing.length) {
        s.questions = failing;
        o.save();
        if (await settle(o, failing)) continue;
        return { kind: 'questions', open: failing, detail: questionsDetail(failing) };
      }
      s.questions = [];
      o.save();
      return await propose(o, p, path, branch, base);
    }
    return { kind: 'failed', detail: 'the answers kept changing the commands: run init again' };
  } finally {
    try {
      removeWorktree(wt, 'setup');
    } catch {
      // already gone
    }
    git(['branch', '-D', SETUP_BRANCH]);
  }
}

async function propose(o: AutoConfigOptions, p: Plan, path: string, branch: string, base: string): Promise<AutoConfigResult> {
  const login = await o.io.gh(['api', 'user', '--jq', '.login'], o.root);
  const owner = login.status === 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login.stdout.trim()) ? login.stdout.trim() : o.owner;
  const cfgDir = join(path, BRAND.configDir);
  if (existsSync(cfgDir)) rmSync(cfgDir, { recursive: true, force: true });
  scaffoldConfig(cfgDir, { name: o.repo.split('/')[1]!, repo: o.repo, defaultBranch: branch, ...(owner ? { owner } : {}) });
  try {
    writeFileSync(join(cfgDir, 'tests.yaml'), draftTests(p, o.state.verified));
    o.adjust?.(cfgDir);
    const problems = o.check?.(loadConfig(path)) ?? [];
    if (problems.length) return { kind: 'failed', detail: `the drafted config doesn't fit: ${problems.join('; ')}` };
  } catch (e) {
    return { kind: 'failed', detail: (e as Error).message.split('\n').slice(0, 3).join(' ') };
  }
  const body = prBody(p, o.state, branch, base, owner);
  if (o.hold) {
    o.state.draft = { branch, base, owner: owner ?? null, yaml: topYaml(cfgDir), body, at: new Date().toISOString() };
    o.save();
    return { kind: 'drafted', detail: 'drafted: preview it on the first-run page, then Confirm proposes it as a PR' };
  }
  return commitAndOpen(o, path, branch, body);
}

/** The config folder's top-level YAML files as text, by name: what the preview shows and Confirm proposes. */
function topYaml(cfgDir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(cfgDir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, readFileSync(join(cfgDir, f), 'utf8')]));
}

/** Commit the config folder in the scratch worktree, push it to the setup branch (never the default one) and open its PR. */
async function commitAndOpen(o: Pick<AutoConfigOptions, 'io' | 'repo' | 'root' | 'state' | 'save'>, path: string, branch: string, body: string): Promise<AutoConfigResult> {
  const git = (...args: string[]) => o.io.git(args, path);
  const add = git('add', '--', BRAND.configDir);
  if (add.status !== 0) return { kind: 'failed', detail: `git add failed: ${add.stderr.trim()}` };
  const commit = git('commit', '-q', '-m', `Add ${BRAND.name} config (detected and checked on ${branch})`);
  if (commit.status !== 0) return { kind: 'failed', detail: `git commit failed: ${(commit.stderr || commit.stdout).trim().split('\n')[0]}` };
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const ref = `HEAD:refs/heads/${SETUP_BRANCH}`;
  const refused = defaultBranchRefusal({ defaultBranch: branch, blocked: () => undefined }, ref, head);
  if (refused) return { kind: 'failed', detail: refused };
  // An open PR from the setup branch (an earlier run's, its state lost): reused as it is, never pushed over, since
  // the person may have changed the config on it while reviewing.
  const listed = await o.io.gh(['pr', 'list', '--repo', o.repo, '--head', SETUP_BRANCH, '--state', 'open', '--json', 'number,url', '--jq', '.[0] | "\\(.number) \\(.url)"'], o.root);
  let number: number | null = null;
  let url = '';
  const m = /^(\d+) (\S+)/.exec(listed.status === 0 ? listed.stdout.trim() : '');
  if (m) {
    [number, url] = [Number(m[1]), m[2]!];
    o.io.say(`   ${SETUP_BRANCH} already has an open PR (#${number}): kept as it is`);
  } else {
    let push = git('push', '-q', 'origin', ref);
    if (push.status !== 0 && /non-fast-forward|rejected|fetch first/.test(push.stderr)) {
      // A setup branch from before with no open PR (an earlier run's, or a closed PR's): this run's draft replaces it,
      // only while it is still the commit seen here (a lease: nothing pushed meanwhile is lost).
      const seen = /^([0-9a-f]{40})\s/.exec(git('ls-remote', 'origin', `refs/heads/${SETUP_BRANCH}`).stdout)?.[1];
      if (seen) {
        o.io.say(`   origin has a ${SETUP_BRANCH} from before (${seen.slice(0, 8)}) with no open PR: replacing it with this draft`);
        push = git('push', '-q', `--force-with-lease=refs/heads/${SETUP_BRANCH}:${seen}`, 'origin', ref);
      }
    }
    if (push.status !== 0) return { kind: 'failed', detail: `pushing ${SETUP_BRANCH} failed: ${push.stderr.trim().split('\n')[0] ?? ''}` };
    const created = await o.io.gh(['pr', 'create', '--repo', o.repo, '--base', branch, '--head', SETUP_BRANCH, '--title', `Add ${BRAND.name} config`, '--body', body], o.root);
    if (created.status !== 0) return { kind: 'failed', detail: `${SETUP_BRANCH} is pushed, but opening its PR failed: ${created.stderr.trim().split('\n')[0] ?? ''}` };
    url = created.stdout.trim().split('\n').pop() ?? '';
    const n = /\/pull\/(\d+)/.exec(url)?.[1];
    number = n ? Number(n) : null;
  }
  o.state.pr = { number, url, branch: SETUP_BRANCH };
  o.save();
  return { kind: 'proposed', detail: `proposed in PR ${number ? `#${number} ` : ''}(${url}), from ${SETUP_BRANCH}: review and merge it, then run \`${BRAND.cli} init\` again (it picks up here)` };
}

function prBody(p: Plan, s: AutoConfigState, branch: string, base: string, owner: string | undefined): string {
  const c = p.commands;
  const row = (slot: Slot) => {
    const cmd = c[slot];
    if (!cmd) return `| ${slot} | (unset) | |`;
    const v = s.verified.find((x) => x.command === cmd && x.base === base);
    return `| ${slot} | \`${cmd}\` | ${cmd === NO_TESTS ? 'no tests yet (as answered)' : verifiedLine(v)} |`;
  };
  const answered = Object.entries(s.answers).map(([id, a]) => `- ${id}: ${a.choice === 'custom' ? `\`${a.command}\`` : a.choice}`);
  return [
    `${BRAND.name}'s config for this repo, drafted by \`${BRAND.cli} init\`: detected from the repo (${p.detection.ecosystems.join(', ') || 'nothing detected'}), and each command run on \`${branch}\` at ${base.slice(0, 12)} before it was proposed. Nothing is pushed to \`${branch}\`; merging this PR is what turns the config on.`,
    '',
    '| slot | command | on the default branch |',
    '| --- | --- | --- |',
    ...(['setup', 'full', 'changed', 'one'] as const).map(row),
    '',
    ...(answered.length ? ['Answered during setup:', ...answered, ''] : []),
    ...(p.notes.length ? ['Notes:', ...p.notes.map((n) => `- ${n}`), ''] : []),
    owner ? `Owner and writer: @${owner} (the GitHub login that ran init); add others in config.yaml owners.` : 'Set the owners in config.yaml (owners.default, owners.writers) before merging.',
    'Review agents.yaml (budget, models), guardrails.yaml and review.yaml too: they start from the templates.',
  ].join('\n');
}

/**
 * WHY (#468): Confirm on the preview. The held draft (as previewed, with any change made there) is committed on a
 * scratch worktree of the commit it was drafted on, pushed to the setup branch and opened as the setup PR, as init's
 * own proposal is. Nothing is pushed to the default branch. The draft is let go once its PR is open.
 */
export async function proposeHeldDraft(o: Pick<AutoConfigOptions, 'io' | 'repo' | 'root' | 'state' | 'save' | 'worktreeRoot' | 'worktreeStateDir'>): Promise<AutoConfigResult> {
  const d = o.state.draft;
  if (!d) return { kind: 'failed', detail: 'nothing drafted to propose: draft the config first' };
  if (o.state.pr?.number) return { kind: 'failed', detail: `already proposed in PR #${o.state.pr.number}` };
  const wt: WorktreeOptions = { repo: o.root, root: o.worktreeRoot ?? join(projectStateDir(o.root), 'worktrees'), stateDir: o.worktreeStateDir ?? projectStateDir(o.root), setup: [] };
  let path: string;
  try {
    path = createWorktree(wt, 'setup', SETUP_BRANCH, d.base).path;
  } catch (e) {
    return { kind: 'failed', detail: `couldn't make a scratch worktree of ${d.base.slice(0, 12)}: ${(e as Error).message.split('\n')[0]}` };
  }
  try {
    const cfgDir = join(path, BRAND.configDir);
    if (existsSync(cfgDir)) rmSync(cfgDir, { recursive: true, force: true });
    scaffoldConfig(cfgDir, { name: o.repo.split('/')[1]!, repo: o.repo, defaultBranch: d.branch, ...(d.owner ? { owner: d.owner } : {}) });
    for (const [f, text] of Object.entries(d.yaml)) {
      if (!/^[A-Za-z0-9_-]+\.ya?ml$/.test(f)) return { kind: 'failed', detail: `not a config file name: ${f.slice(0, 60)}` };
      writeFileSync(join(cfgDir, f), text);
    }
    try {
      loadConfig(path);
    } catch (e) {
      return { kind: 'failed', detail: (e as Error).message.split('\n').slice(0, 3).join(' ') };
    }
    const r = await commitAndOpen(o, path, d.branch, d.body);
    if (r.kind === 'proposed') {
      o.state.draft = null;
      o.save();
    }
    return r;
  } finally {
    try {
      removeWorktree(wt, 'setup');
    } catch {
      // already gone
    }
    o.io.git(['branch', '-D', SETUP_BRANCH], o.root);
  }
}
