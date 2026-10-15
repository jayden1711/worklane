// WHY (#469): a repo with no CI dead-ended at the first-run step "Required checks named": GitHub ran no checks, so
// there was nothing to name, and an empty required_checks means no PR is ever ready. The step drafts a starter
// GitHub Actions workflow from what auto-config detects, shows it (a plain summary, then the file), and on Confirm
// hands it to GitHub's own new-file page, prefilled: the person commits it and opens its PR as themselves.
//
// INVARIANT: the engine never writes, commits or pushes a workflow. The agent App has no Workflows permission, by
// design (src/setup/app-manifest.ts, scripts/setup/app-permissions.mjs); this only drafts text and builds a link.
// Once the workflow ran on the default branch, its check is offered for required_checks as an ordinary config
// change the person reviews and proposes (src/config-change.ts), never written here.
import { spawnSync } from 'node:child_process';
import { BRAND } from './brand.js';
import { detectProject, NO_TESTS, type Detection } from './auto-config.js';
import { GITHUB_WEB } from './github-hosts.js';

/** Where the starter workflow goes, and its one job: the job's name is the check name a PR waits on. */
export const STARTER_CI_PATH = '.github/workflows/ci.yml';
export const STARTER_CI_CHECK = 'test';

/**
 * Actions pinned by commit, each checked against its release tag (GitHub's API: git/ref/tags/<tag>, a commit).
 * checkout and setup-node are the pins this repo's own workflows use.
 */
export const PINNED = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  node: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  python: 'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
  go: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
  bun: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0',
} as const;

export interface StarterCi {
  path: string;
  /** The check name it reports: config.yaml required_checks takes this once it has run. */
  check: string;
  /** One plain sentence: what runs, on what, and when. */
  summary: string;
  file: string;
  /** No test command was found: its one test step fails until it is edited, so nothing passes by accident. */
  placeholder: boolean;
  /** The test command it runs (null: the placeholder). */
  command: string | null;
}

const NODE_DEFAULT = '22';
const PYTHON_DEFAULT = '3.12';

/** A YAML double-quoted scalar. */
const q = (s: string) => JSON.stringify(s);

/** The test command: the config's own (tests.yaml runner.full) when it is a real one, else what detection found. */
function testCommand(d: Detection, configured: string | null): string | null {
  if (configured && configured.trim() && configured.trim() !== NO_TESTS) return configured.trim();
  if (d.monorepo && d.all) return d.all.command;
  if (d.full.length === 1) return d.full[0]!.command;
  if (d.full.length > 1) return d.full.map((c) => c.command).join(' && ');
  return null;
}

/**
 * The starter workflow for a repo: its files (`git ls-files` at the default branch's tip), read from `dir`. The
 * toolchains come from the ecosystems detection found; the test command from `configured` (tests.yaml runner.full)
 * or detection. Nothing found: a placeholder test step that fails until replaced.
 */
export function draftStarterCi(o: { dir: string; files: string[]; branch: string; configured?: string | null }): StarterCi {
  const d = detectProject(o.dir, o.files);
  const has = (f: string) => o.files.includes(f);
  const eco = d.ecosystems.join(' ');
  const steps: string[] = [`      - uses: ${PINNED.checkout}`, '        with:', '          persist-credentials: false'];
  const on: string[] = [];
  const nodeEco = d.ecosystems.find((e) => e.startsWith('node'));
  // The package manager, when detection settled it (a lockfile or packageManager); unsettled, Node alone.
  const nodePm = /^node \((npm|pnpm|yarn|bun)/.exec(nodeEco ?? '')?.[1];
  if (nodeEco) {
    const versionFile = ['.nvmrc', '.node-version'].find(has);
    steps.push(`      - uses: ${PINNED.node}`, '        with:', versionFile ? `          node-version-file: ${versionFile}` : `          node-version: ${q(NODE_DEFAULT)}`);
    if (nodePm === 'npm' && has('package-lock.json')) steps.push('          cache: npm');
    if (nodePm === 'pnpm' || nodePm === 'yarn') steps.push('      - run: corepack enable');
    if (nodePm === 'bun') steps.push(`      - uses: ${PINNED.bun}`);
    on.push(versionFile ? `Node (the version in ${versionFile})` : `Node ${NODE_DEFAULT}`);
  }
  if (/\bpython\b/.test(eco)) {
    const versionFile = has('.python-version') ? '.python-version' : null;
    steps.push(`      - uses: ${PINNED.python}`, '        with:', versionFile ? `          python-version-file: ${versionFile}` : `          python-version: ${q(PYTHON_DEFAULT)}`);
    const via = /python \((?:pytest|unittest) via (\w+)\)|python \((\w+)\)/.exec(d.ecosystems.find((e) => e.startsWith('python')) ?? '');
    const tool = via?.[1] ?? via?.[2] ?? 'python3';
    if (tool !== 'python3') steps.push(`      - run: python -m pip install ${tool}`);
    else {
      for (const r of ['requirements.txt', 'requirements-dev.txt'].filter(has)) steps.push(`      - run: python -m pip install -r ${r}`);
      if (/pytest/.test(eco)) steps.push('      - run: python -m pip install pytest');
    }
    on.push(versionFile ? `Python (the version in ${versionFile})` : `Python ${PYTHON_DEFAULT}`);
  }
  if (/\bgo\b/.test(eco)) {
    steps.push(`      - uses: ${PINNED.go}`, '        with:', '          go-version-file: go.mod');
    on.push('Go (the version in go.mod)');
  }
  if (/\brust\b/.test(eco)) on.push("Rust (the runner's stable toolchain)");
  for (const s of d.setup) steps.push(`      - run: ${q(s)}`);
  const command = testCommand(d, o.configured ?? null);
  if (command) steps.push(`      - run: ${q(command)}`);
  else {
    steps.push(
      '      - name: no test command yet (replace this step)',
      '        run: |',
      `          echo "No test command was found for this repo: replace this step in ${STARTER_CI_PATH} with the command that runs your tests." >&2`,
      '          exit 1',
    );
  }
  const branch = o.branch;
  const file = [
    `# The starter CI ${BRAND.name}'s first-run page drafted. Its job's name, ${STARTER_CI_CHECK}, is the check a PR waits on`,
    `# (${BRAND.configDir}/config.yaml required_checks). Edit it freely; if you rename the job, rename the check there too.`,
    'name: ci',
    'on:',
    '  pull_request:',
    '  push:',
    `    branches: [${q(branch)}]`,
    'permissions:',
    '  contents: read',
    'jobs:',
    `  ${STARTER_CI_CHECK}:`,
    `    name: ${STARTER_CI_CHECK}`,
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    ...steps,
    '',
  ].join('\n');
  const where = `for every PR and every push to ${branch}`;
  const summary = command
    ? `Runs \`${command}\`${on.length ? ` on ${on.join(', ')}` : ''} ${where}, as the check \`${STARTER_CI_CHECK}\`, with read-only permissions.`
    : `No test command was found: its test step fails ${where} until you replace it with yours, so nothing passes by accident. The check is \`${STARTER_CI_CHECK}\`.`;
  return { path: STARTER_CI_PATH, check: STARTER_CI_CHECK, summary, file, placeholder: !command, command };
}

/**
 * GitHub's new-file page for the workflow, prefilled (the `value` is added by whoever has the final text: the page,
 * after the person's edits). There the person commits it, on a new branch with a PR, as themselves.
 */
export function newFileUrl(repo: string, branch: string, web = GITHUB_WEB): string {
  return `${web}/${repo.split('/').map(encodeURIComponent).join('/')}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent(STARTER_CI_PATH)}`;
}

/** The new-file page with the file in it. */
export const newFileUrlWith = (base: string, file: string) => `${base}&value=${encodeURIComponent(file)}`;

export interface StarterCiView extends StarterCi {
  /** The default branch it runs on and is committed to. */
  branch: string;
  /** GitHub's new-file page, without the file (the page adds it as `value`). */
  newFile: string;
  /** Whether the default branch has a workflow at this path already (merged). */
  onBranch: boolean;
  /**
   * The starter check on the default branch's tip, as GitHub reports it: `none` (not run there yet), `running`, or
   * finished with its conclusion. Finished: its name is offered for required_checks (a config change to confirm).
   */
  firstRun: { state: 'none' | 'running' | 'done'; conclusion: string | null };
}

type Run = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
const realRun: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * The step's view: the draft from origin/<branch>'s files (as fetched here), whether that branch has the workflow,
 * and the starter check's run on its tip. `gh` reads GitHub (the dashboard's own gh); nothing is written anywhere.
 */
export function starterCiView(o: { root: string; repo: string; branch: string; configured: string | null; gh: (args: string[]) => { status: number | null; stdout: string; stderr: string }; run?: Run }): StarterCiView {
  const run = o.run ?? realRun;
  const ref = `origin/${o.branch}`;
  const files = run('git', ['ls-tree', '-r', '--name-only', ref], o.root);
  const list = files.status === 0 ? files.stdout.split('\n').filter(Boolean) : run('git', ['ls-files'], o.root).stdout.split('\n').filter(Boolean);
  const draft = draftStarterCi({ dir: o.root, files: list, branch: o.branch, configured: o.configured });
  const onBranch = list.includes(STARTER_CI_PATH);
  let firstRun: StarterCiView['firstRun'] = { state: 'none', conclusion: null };
  const sha = run('git', ['rev-parse', ref], o.root).stdout.trim();
  if (onBranch && /^[0-9a-f]{40}$/.test(sha)) {
    const r = o.gh(['api', `repos/${o.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(STARTER_CI_CHECK)}`, '--jq', '.check_runs[] | [.status, (.conclusion // "")] | @tsv']);
    const rows = r.status === 0 ? r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
    if (rows.some(([s]) => s !== 'completed')) firstRun = { state: 'running', conclusion: null };
    else if (rows.length) firstRun = { state: 'done', conclusion: rows[0]![1] || null };
  }
  return { ...draft, branch: o.branch, newFile: newFileUrl(o.repo, o.branch), onBranch, firstRun };
}
