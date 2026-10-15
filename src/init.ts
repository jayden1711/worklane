// `init`: the guided first setup, one checklist walked in order. Each step is checked first; only a step
// that isn't done yet does anything (installs, a login, a hand-off), and it is checked again before the next one
// starts. A required step that still isn't done stops the walk, saying what to do; run init again and it picks up
// there (the state file keeps what is done, and when). The steps and their checks come from the setup step registry
// (src/setup-steps.ts): `doctor` and the dashboard's first-run page check the same steps the same way, live.
//
// Two modes, chosen explicitly (asked when not given):
//   local   runs as you, on your own machine (macOS, Linux, or Windows through WSL2): no separate OS users, no ssh,
//           no root. Tools go under ~/.local; you sign in to Claude and to GitHub (gh) yourself.
//   server  the hardened multi-user Linux setup: as root, the setup scripts (bootstrap --hardened installs the
//           tools; scripts/setup/add-project.sh makes the instance, the GitHub App through the manifest flow, the
//           agent's Claude token and the checkout). Init never installs tools there: that stays the owner's step.
//
// What local mode can't do is listed plainly (unavailableIn), in doctor and on the dashboard, never left to fail.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { autoConfigure, emptyAutoConfig, type AutoConfigState, type Question, type Verification } from './auto-config.js';
import { BRAND } from './brand.js';
import { protectionAdvice } from './branch-protection.js';
import { loadConfig } from './config/load.js';
import { projectStateDir } from './guardrails/context.js';
import { gitRemoteRepo, install } from './install.js';
import { readWatchState } from './main-watch.js';
import { handOffFromNpx, type HandOff } from './npx-engine.js';
import { findTool, withToolPath } from './tool-path.js';
import { detectOs, isRoot, shareReadWithGroup, stateDir, which, writeOwnerOnly } from './os/index.js';
import { coordinatorUser } from './setup/app-manifest.js';
import { checkSetup, checkSetupOffThread, detectClaudeLogin, detectGithubLogin, detectRepoConfig, detectTailscale, detectTools, GROUPS, MODES, type DetectCache, type Detected, type Mode, type RunResult, type SetupContext, type SetupProbe, type SetupView } from './setup-steps.js';
import { describeInstall, httpDownload, INSTALLABLE, installPlan, installTool, type Download, type InstallableTool, type ToolInstall } from './tool-install.js';
import { srvCheckoutPath, varLibPath } from './os/system-paths.js';
import { ciChoiceProblem } from './ci-choice.js';
import { ProjectConfig } from './config/schema.js';
import { parse as parseYaml } from 'yaml';

export { MODES, type Mode, type RunResult };
export type StepId = 'tools' | 'claude' | 'github' | 'repo-config' | 'coordinator' | 'protection' | 'discord' | 'tailscale';
export type StepStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface StepDef {
  id: StepId;
  title: string;
  optional: boolean;
  modes: readonly Mode[];
}

/**
 * The checklist, in order: the registry's walked groups (src/setup-steps.ts), so init, doctor and the page share one
 * list. Server mode's Coordinator running is add-project's last steps (the coordinator's service, test user, machine
 * helper, dashboards); local mode starts the coordinator with `up` after init, so it has no such step.
 */
export const STEPS: readonly StepDef[] = GROUPS.filter((g) => g.walked).map((g) => ({ id: g.id as StepId, title: g.title, optional: g.optional, modes: g.modes }));
export const stepsFor = (mode: Mode) => STEPS.filter((s) => s.modes.includes(mode));

export interface StepRecord {
  status: StepStatus;
  detail: string;
  /** When it last changed. */
  at: string;
}

export interface InitState {
  version: 1;
  mode: Mode;
  /** local: the repo's directory; server: owner/name. */
  target: string;
  /** owner/name on GitHub, when known. */
  repo: string | null;
  /** server: the instance's name. */
  instance: string | null;
  steps: Partial<Record<StepId, StepRecord>>;
  /** server: add-project.sh's last state per step. */
  handoff: Record<string, string>;
  /** server: add-project.sh's last detail per step (how the App was made, the setup PR it waits for). */
  handoffDetail?: Record<string, string>;
  /** Local mode: auto-config's answers, open questions, command results and setup PR (src/auto-config.ts). */
  autoConfig?: AutoConfigState;
  updatedAt: string;
  finishedAt: string | null;
}

export const INIT_FILE = 'init.json';
/** Local mode's state: beside the project's other machine-local state (the dashboard's state dir for it). */
export const localInitFile = (root: string) => join(projectStateDir(root), INIT_FILE);
/**
 * Server mode's state, per instance: written by root (init runs add-project.sh as root), in the machine's state
 * (machineInitDir(), 0755), each file root's and readable by that instance's coordinator group only (0640), so
 * `doctor` run as the coordinator, and the instance's dashboard, show what init recorded. No secret is in it.
 */
export const serverInitFile = (instance: string) => join(machineInitDir(), `${instance}.json`);
/** The machine's init records (tests point it elsewhere). */
export const machineInitDir = () => process.env[`${BRAND.envPrefix}_MACHINE_INIT_DIR`] ?? varLibPath('init');
/** Where an engine before this kept it: root's own state, which the coordinator can't read. Read once, to carry it over. */
export const legacyServerInitFile = (instance: string) => join(stateDir(), 'init', `${instance}.json`);

export function readInitState(file: string): InitState | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as InitState;
    return s.version === 1 && MODES.includes(s.mode) ? s : null;
  } catch {
    return null;
  }
}

/** Why a state file that is there can't be read (as this user), or null: doctor says so rather than "not reached". */
export function initStateUnreadable(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    readFileSync(file, 'utf8');
    return null;
  } catch (e) {
    return `can't read init's record ${file} as this user (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
}

export function writeInitState(file: string, s: InitState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeOwnerOnly(file, JSON.stringify(s, null, 2) + '\n');
}

/** Server mode: write the state, then open it to the instance's coordinator group (read only). */
export function writeServerInitState(file: string, s: InitState, instance: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  writeOwnerOnly(file, JSON.stringify(s, null, 2) + '\n');
  shareReadWithGroup(file, coordinatorUser(instance));
}

export interface Unavailable {
  feature: string;
  why: string;
}

/** What this mode can't do, each with why. Server mode has everything; local mode lacks what needs root or other users. */
export function unavailableIn(mode: Mode, has: (cmd: string) => boolean = (c) => findTool(c) !== null): Unavailable[] {
  if (mode === 'server') return [];
  const out: Unavailable[] = [
    { feature: 'separate OS users', why: `local mode runs the agents as you, with your files and your logins; agents as a user of their own that holds no credentials and can't read yours need a Linux server set up in server mode (sudo bash scripts/bootstrap.sh --hardened)` },
    { feature: 'root-run add-project', why: `the dashboard's Add project runs scripts/setup/add-project.sh as root through the machine helper, and local mode has neither root nor the helper; set up another repo with \`${BRAND.cli} init <repo>\`` },
  ];
  if (!has('docker')) out.push({ feature: 'test sandbox', why: `the test-run sandbox (tests.yaml test_run) needs Docker in local mode (there is no systemd-run and no test user), and docker isn't on PATH; install Docker to turn it on` });
  return out;
}

/** Everything a step does to the world, so tests can stand in for it. */
export interface InitIo {
  which(cmd: string): string | null;
  run(cmd: string, args: string[], o?: { cwd?: string }): RunResult;
  /** Run a command on the person's terminal (a login): its exit status. */
  interactive(cmd: string, args: string[]): Promise<number>;
  /** Ask on the terminal; null when there is none (then nothing interactive happens). */
  ask(question: string): Promise<string | null>;
  say(line: string): void;
  download: Download;
  /** The pinned install for a missing tool (src/tool-install.ts), or null where none is pinned. */
  plan(tool: InstallableTool, prefix: string): ToolInstall | null;
  /** Server mode: run add-project.sh, reporting each step line; its exit status and each step's last state and detail. */
  addProject(name: string, repo: string, timeoutMinutes?: number): Promise<{ code: number; steps: Record<string, string>; details?: Record<string, string>; last: string }>;
}

export interface InitContext {
  mode: Mode;
  /** local: the repo directory. */
  root: string | null;
  repo: string | null;
  instance: string | null;
  /** Where installs go (bin/ under it). */
  prefix: string;
  /** Whether to go ahead without asking (installs). Logins still need a terminal. */
  yes: boolean;
  /** Is there a terminal to ask on and run logins in? */
  interactive: boolean;
  io: InitIo;
  state: InitState;
  /** Answers to auto-config's questions given on the command line (`--answer id=choice`). */
  answers?: Record<string, string>;
  /** Keep the state now (runInit sets it): auto-config saves each answer and result as it comes. */
  save?: () => void;
  /** Server mode: how long add-project waits for a GitHub click or the setup PR's merge, in minutes (its default: 15). */
  timeout?: number;
  /** Server mode: add-project's run in this init, once it has run (it runs at most once). */
  handedOff?: { code: number; last: string };
}

export interface StepResult {
  status: Exclude<StepStatus, 'pending'>;
  detail: string;
  /** Failed only for want of a CI choice (#469): the wizard makes it (init's exit CI_CHOICE_EXIT). */
  ciChoice?: true;
}

/**
 * init's exit when everything before it is done and only the CI choice is missing (#469): bootstrap then still starts
 * the dashboard and prints the wizard's URL, where the choice is made (Required checks named).
 */
export const CI_CHOICE_EXIT = 5;

/** A registry detector's answer as a walked step's result. */
const asStep = (d: Detected): StepResult => ({ status: d.done ? 'done' : 'failed', detail: d.detail });

function verifyTools(c: InitContext): StepResult & { missing: string[] } {
  const d = detectTools(c.mode, c.io);
  return { ...asStep(d), missing: d.missing };
}

async function tools(c: InitContext, act: boolean): Promise<StepResult> {
  const v = verifyTools(c);
  if (v.status === 'done' || !act || !v.missing.length) return v;
  if (c.mode === 'server') return { status: 'failed', detail: `missing: ${v.missing.join(', ')}. On a server, installing tools is the owner's step: sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo> (scripts/setup/tools.sh)` };
  const plans = v.missing.map((t) => ({ t, p: (INSTALLABLE as string[]).includes(t) ? c.io.plan(t as InstallableTool, c.prefix) : null }));
  const manual = plans.filter((x) => !x.p).map((x) => x.t);
  if (manual.length) {
    const how = manual.includes('git') ? ' (git: on macOS `xcode-select --install`; on Linux your package manager)' : '';
    return { status: 'failed', detail: `missing, and not something ${BRAND.cli} installs here: ${manual.join(', ')}${how}; install, then run \`${BRAND.cli} init\` again` };
  }
  c.io.say(`   to install (each checked against the checksum pinned in the engine before it is unpacked):`);
  for (const { p } of plans) c.io.say(`     ${describeInstall(p!)}`);
  let go = c.yes;
  if (!go) {
    const a = await c.io.ask('   Install these? [y/N] ');
    if (a === null) return { status: 'failed', detail: `missing: ${v.missing.join(', ')}; run \`${BRAND.cli} init --yes\` to install them as shown, or install them yourself` };
    go = /^y(es)?$/i.test(a.trim());
  }
  if (!go) return { status: 'failed', detail: `missing: ${v.missing.join(', ')}; not installed (you said no)` };
  for (const { p } of plans) {
    const r = await installTool(p!, { download: c.io.download });
    if (!r.ok) return { status: 'failed', detail: r.error };
    c.io.say(`     installed ${p!.tool} ${p!.version} at ${p!.dest}`);
  }
  // This run finds them at once; the person's shell needs the prefix on PATH.
  const bin = join(c.prefix, 'bin');
  const path = process.env.PATH ?? '';
  if (!path.split(delimiter).includes(bin)) {
    process.env.PATH = `${bin}${delimiter}${path}`;
    c.io.say(`   note: ${bin} isn't on your PATH: add it in your shell profile (export PATH="${bin}:$PATH")`);
  }
  return verifyTools(c);
}

/** add-project.sh's steps that make each server checklist step. */
const HANDOFF: Partial<Record<StepId, string[]>> = {
  claude: ['claude-token'],
  github: ['instance', 'app', 'checkout'],
  'repo-config': ['checkout', 'policy'],
  coordinator: ['service', 'test-user', 'machine-helper', 'dashboards'],
};

async function handoff(c: InitContext, id: StepId, act: boolean): Promise<StepResult> {
  const need = HANDOFF[id]!;
  // The repo config isn't done while the service waits for its setup PR to merge (as in local mode, where it is done
  // once the PR has merged): that wait is this step's, and the walk stops here saying so.
  const watch = id === 'repo-config' ? [...need, 'service'] : need;
  const done = () => need.every((s) => c.state.handoff[s] === 'done') && !watch.some((s) => c.state.handoff[s] === 'waiting');
  const detail = (s: string) => c.state.handoffDetail?.[s] ?? '';
  const what = (): string => {
    // How the App was made, as add-project's app step found it recorded (never assumed).
    const app = /, (made [^;]*|how it was made is not recorded)$/.exec(detail('app'))?.[1] ?? 'how it was made is not recorded';
    const checkout = detail('checkout');
    return {
      claude: `the agent's Claude login, stored for its user only (add-project: claude-token)`,
      github: `the instance, its GitHub App (${app}) and the checkout (add-project: instance, app, checkout)`,
      'repo-config': `the checkout's ${BRAND.configDir}/ and the instance's policy (add-project: checkout, policy)${checkout ? `: ${checkout}` : ''}`,
      coordinator: `the coordinator's service, the machine helper and the dashboards (add-project: ${need.join(', ')})`,
    }[id as 'claude' | 'github' | 'repo-config' | 'coordinator'];
  };
  // A step add-project left waiting (the service, for the setup PR) is not done: say what it waits for.
  const notDone = (): StepResult => {
    const waiting = watch.find((s) => c.state.handoff[s] === 'waiting');
    if (waiting) return { status: 'failed', detail: `${detail(waiting) || 'waiting'} (add-project: ${waiting}); run \`${BRAND.cli} init --mode server ${c.repo} --instance ${c.instance}\` again once it has` };
    return { status: 'failed', detail: `not yet: ${need.filter((s) => c.state.handoff[s] !== 'done').join(', ')} (add-project)` };
  };
  if (done()) return { status: 'done', detail: what() };
  if (!act) return notDone();
  // add-project runs once per init: it walks all of its steps, and a later checklist step reads what it left.
  let r = c.handedOff;
  if (!r) {
    c.io.say(`   handing off to scripts/setup/add-project.sh ${c.instance} ${c.repo} (as root; each of its steps is skipped when done)`);
    // Each run's states replace the last run's: a step it didn't reach this time is no longer "waiting" or "failed".
    const ran = await c.io.addProject(c.instance!, c.repo!, c.timeout);
    c.state.handoff = { ...Object.fromEntries(Object.entries(c.state.handoff).filter(([, v]) => v === 'done')), ...ran.steps };
    c.state.handoffDetail = { ...c.state.handoffDetail, ...ran.details };
    r = c.handedOff = { code: ran.code, last: ran.last };
  }
  if (done()) return { status: 'done', detail: what() };
  if (r.code === 3) return notDone();
  return { status: 'failed', detail: `add-project stopped (exit ${r.code})${r.last ? `: ${r.last}` : ''}; fix that, then run \`${BRAND.cli} init --mode server ${c.repo} --instance ${c.instance}\` again` };
}

async function coordinator(c: InitContext, act: boolean): Promise<StepResult> {
  return handoff(c, 'coordinator', act);
}

const claudeStatus = (c: InitContext): StepResult => asStep(detectClaudeLogin(c.io));

async function claude(c: InitContext, act: boolean): Promise<StepResult> {
  if (c.mode === 'server') return handoff(c, 'claude', act);
  const v = claudeStatus(c);
  if (v.status === 'done' || !act) return v;
  if (!c.interactive || !c.io.which('claude')) return { status: 'failed', detail: `${v.detail}: run \`claude auth login\`, then \`${BRAND.cli} init\` again (it picks up here)` };
  c.io.say('   opening the Claude login (claude auth login)');
  await c.io.interactive('claude', ['auth', 'login']);
  return claudeStatus(c);
}

const githubStatus = (c: InitContext): StepResult => asStep(detectGithubLogin(c.io, c.repo));

async function github(c: InitContext, act: boolean): Promise<StepResult> {
  if (c.mode === 'server') return handoff(c, 'github', act);
  const v = githubStatus(c);
  if (v.status === 'done' || !act) return v;
  if (!/not signed in/.test(v.detail)) return v;
  if (!c.interactive) return { status: 'failed', detail: `${v.detail}: run \`gh auth login\`, then \`${BRAND.cli} init\` again (it picks up here)` };
  c.io.say('   opening the GitHub login (gh auth login)');
  await c.io.interactive('gh', ['auth', 'login']);
  return githubStatus(c);
}

/**
 * Auto-config, for a checkout with no config folder: detect the project's commands on the default branch, ask what
 * can't be settled without the person, run each command there, and propose the config as a PR from its own branch
 * (src/auto-config.ts). null: the config is on the default branch now (its PR merged) and this checkout has it, so
 * the hooks can be installed from it.
 */
export type AutoConfig = (c: InitContext) => Promise<StepResult | null>;
export const autoConfig: AutoConfig = async (c) => {
  if (!c.repo) return { status: 'failed', detail: `no GitHub origin: the config is proposed as a PR on GitHub (the GitHub step)` };
  c.state.autoConfig ??= emptyAutoConfig();
  const r = await autoConfigure({
    root: c.root!,
    repo: c.repo,
    state: c.state.autoConfig,
    ...(c.answers ? { given: c.answers } : {}),
    io: { git: (args, cwd) => c.io.run('git', args, { cwd }), gh: (args, cwd) => c.io.run('gh', args, { cwd }), ask: (q) => (c.interactive ? c.io.ask(q) : Promise.resolve(null)), say: c.io.say },
    save: () => c.save?.(),
  });
  if (r.kind !== 'merged') return { status: 'failed', detail: r.detail };
  // Merged: bring this checkout up to it when it's on the default branch (a fast-forward only), else say so.
  const on = c.io.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: c.root! }).stdout.trim();
  if (on !== r.branch) return { status: 'failed', detail: `the config is on origin/${r.branch} now, but this checkout is on ${on}: switch to ${r.branch} and pull, then run \`${BRAND.cli} init\` again` };
  const ff = c.io.run('git', ['merge', '--ff-only', '-q', `origin/${r.branch}`], { cwd: c.root! });
  if (ff.status !== 0) return { status: 'failed', detail: `the config is on origin/${r.branch} now, but ${r.branch} here can't fast-forward to it (${ff.stderr.trim().split('\n')[0] ?? ''}): pull it, then run \`${BRAND.cli} init\` again` };
  c.io.say(`   the config PR merged: fast-forwarded ${r.branch} to origin/${r.branch}`);
  return null;
};

const repoConfigStatus = (c: InitContext): StepResult => asStep(detectRepoConfig(c.root!, c.state.autoConfig?.questions.length ?? 0, c.state.autoConfig?.pr?.url ?? null));

async function repoConfig(c: InitContext, act: boolean): Promise<StepResult> {
  if (c.mode === 'server') return handoff(c, 'repo-config', act);
  const v = repoConfigStatus(c);
  if (v.status === 'done' || !act) return v;
  // No config folder at all: auto-config proposes one (a folder already here is the person's, used as it is).
  if (!existsSync(join(c.root!, BRAND.configDir))) {
    const drafted = await autoConfig(c);
    if (drafted) return drafted;
  }
  try {
    const r = install({ root: c.root! });
    c.io.say(`   ${r.scaffolded ? 'scaffolded' : 'kept'} ${BRAND.configDir}/; hooks merged into ${r.settingsPath}`);
    for (const n of r.notes) c.io.say(`   note: ${n}`);
  } catch (e) {
    return { status: 'failed', detail: (e as Error).message.split('\n')[0] ?? 'install failed' };
  }
  return repoConfigStatus(c);
}

/** Reported, not set up: the protection step (rulesets, or the main watch) comes in its own change. */
async function protection(c: InitContext): Promise<StepResult> {
  const later = 'reported only; setting protection up comes later';
  if (c.mode === 'server') return { status: 'done', detail: `GitHub's enforcement or the main watch (policy main_watch: auto), on the dashboard's Settings once the coordinator has asked; ${later}` };
  if (!c.repo) return { status: 'done', detail: `no GitHub origin: nothing to protect; ${later}` };
  let branch = 'main';
  let advice = '';
  try {
    const p = loadConfig(c.root!).project;
    branch = p.project.default_branch;
    advice = `; ${protectionAdvice(p)}`;
  } catch {
    // the repo-config step reported it
  }
  const watch = readWatchState(join(projectStateDir(c.root!), 'main-watch.json'));
  if (watch.mode === 'github') return { status: 'done', detail: `GitHub enforces protection on ${branch}${advice}; ${later}` };
  if (watch.mode === 'main_watch') return { status: 'done', detail: `GitHub doesn't protect ${branch}: the main watch guards it${advice}; ${later}` };
  const r = c.io.run('gh', ['api', `repos/${c.repo}/branches/${branch}/protection`, '--silent']);
  if (r.status === 0) return { status: 'done', detail: `GitHub enforces protection on ${branch}${advice}; ${later}` };
  const code = r.stderr.match(/HTTP (\d{3})/)?.[1];
  return { status: 'done', detail: `GitHub doesn't protect ${branch}${code ? ` (HTTP ${code})` : ''}: every change still lands through a PR you merge (land_mode pr)${advice}; ${later}` };
}

async function discord(): Promise<StepResult> {
  return { status: 'skipped', detail: 'optional, not set up here; the Discord setup page comes later (docs/intake.md has it by hand)' };
}

async function tailscale(c: InitContext): Promise<StepResult> {
  const t = detectTailscale(c.io);
  return t ? asStep(t) : { status: 'skipped', detail: 'optional, not on a tailnet: the dashboard stays on this machine (docs/dashboard.md sets up Tailscale sign-in)' };
}

/**
 * The project configs a choice of CI is judged on: the checkout's working tree and its origin/<default> as last
 * fetched (server mode: the coordinator keeps it fetched; read as root, so git is told the coordinator's checkout is
 * safe). A choice in either counts: one merged on GitHub and fetched, or one pulled into the checkout. Empty: nothing
 * readable here.
 */
function projectsForCiChoice(c: InitContext): Pick<ProjectConfig, 'land_mode' | 'required_checks' | 'ci'>[] {
  const root = c.mode === 'local' ? c.root : c.instance && c.repo ? srvCheckoutPath(c.instance, c.repo.split('/')[1]!) : null;
  if (!root || !existsSync(join(root, BRAND.configDir, 'config.yaml'))) return [];
  const out: ProjectConfig[] = [];
  try {
    out.push(loadConfig(root).project);
  } catch {
    // the repo-config step reports an invalid config
  }
  const branch = out[0]?.project.default_branch ?? 'main';
  const r = c.io.run('git', ['-c', `safe.directory=${root}`, 'show', `origin/${branch}:${BRAND.configDir}/config.yaml`], { cwd: root });
  if (r.status === 0) {
    try {
      const p = ProjectConfig.safeParse(parseYaml(r.stdout));
      if (p.success) out.push(p.data);
    } catch {
      // unparseable on the branch: the coordinator's config_invalid incident says so
    }
  }
  return out;
}

/**
 * WHY (#469): init never finishes on a config that can never mark a PR ready (an empty required_checks in PR mode):
 * the repo-config step stays failed, saying what to choose, until the choice is on the default branch.
 */
const withCiChoice =
  (run: (c: InitContext, act: boolean) => Promise<StepResult>) =>
  async (c: InitContext, act: boolean): Promise<StepResult> => {
    const r = await run(c, act);
    if (r.status !== 'done') return r;
    const ps = projectsForCiChoice(c);
    const problem = ps.length && ps.every((p) => ciChoiceProblem(p)) ? ciChoiceProblem(ps[0]!) : null;
    return problem ? { status: 'failed', detail: `${r.detail}; but ${problem}. Then run \`${BRAND.cli} init\` again (it picks up here)`, ciChoice: true } : r;
  };

const RUN: Record<StepId, (c: InitContext, act: boolean) => Promise<StepResult>> = { tools, claude, github, 'repo-config': withCiChoice(repoConfig), coordinator, protection, discord, tailscale };

export interface ChecklistItem extends StepDef {
  status: StepStatus;
  detail: string;
  at: string | null;
}

/** The checklist from a state file alone (the dashboard): each step's recorded status, pending when not reached. */
export function recordedChecklist(state: InitState | null, mode: Mode): ChecklistItem[] {
  return stepsFor(mode).map((s) => {
    const r = state?.mode === mode ? state.steps[s.id] : undefined;
    return { ...s, status: r?.status ?? 'pending', detail: r?.detail ?? 'not reached yet', at: r?.at ?? null };
  });
}

const now = () => new Date().toISOString();

export function newState(mode: Mode, target: string, repo: string | null, instance: string | null): InitState {
  return { version: 1, mode, target, repo, instance, steps: {}, handoff: {}, updatedAt: now(), finishedAt: null };
}

/**
 * Walk the checklist. Exit status: 0 when every required step is done, 1 when one stopped the walk (the state says
 * which, and what to do).
 */
export async function runInit(c: InitContext, file: string): Promise<number> {
  const steps = stepsFor(c.mode);
  const save = () => {
    c.state.updatedAt = now();
    if (c.mode === 'server' && c.instance) writeServerInitState(file, c.state, c.instance);
    else writeInitState(file, c.state);
  };
  c.save = save;
  const doneEarlier = steps.filter((s) => ['done', 'skipped'].includes(c.state.steps[s.id]?.status ?? '')).length;
  c.io.say(`${BRAND.cli} init, ${c.mode} mode: ${c.mode === 'local' ? c.root : `${c.repo} as instance ${c.instance}`}`);
  if (doneEarlier) c.io.say(`resuming: ${doneEarlier} of ${steps.length} steps done earlier (${file})`);
  for (const [n, s] of steps.entries()) {
    const before = c.state.steps[s.id];
    c.io.say(`\n[${n + 1}/${steps.length}] ${s.title}${s.optional ? ' (optional)' : ''}`);
    // An optional step skipped earlier stays skipped (init --reset asks again).
    if (s.optional && before?.status === 'skipped') {
      c.io.say(`   skipped earlier: ${before.detail}`);
      continue;
    }
    let r = await RUN[s.id](c, false);
    const earlier = r.status === 'done' && before?.status === 'done';
    if (r.status !== 'done') r = await RUN[s.id](c, true);
    c.state.steps[s.id] = { status: r.status, detail: r.detail, at: earlier ? before.at : now() };
    save();
    const tag = r.status === 'done' ? (earlier ? 'done earlier' : 'done') : r.status === 'skipped' ? 'skipped' : 'FAILED';
    c.io.say(`   ${tag}: ${r.detail}`);
    if (r.status === 'failed' && !s.optional) {
      const left = steps.length - n;
      c.io.say(`\nstopped at ${s.title} (${left} step${left === 1 ? '' : 's'} left). Run \`${BRAND.cli} init\` again once that's fixed: it picks up here.`);
      c.state.finishedAt = null;
      save();
      if (c.mode === 'local' && s.id === 'repo-config' && c.root && !existsSync(join(c.root, BRAND.configDir))) await offerSetupPage(c);
      return r.ciChoice ? CI_CHOICE_EXIT : 1;
    }
  }
  c.state.finishedAt = now();
  save();
  c.io.say(`\nall ${steps.length} steps done or skipped. \`${BRAND.cli} doctor\` shows this checklist again${c.mode === 'local' ? `; \`${BRAND.cli} up\` starts the coordinator, \`${BRAND.cli} dashboard\` opens the dashboard (its First-run page has this checklist)` : ''}.`);
  for (const u of unavailableIn(c.mode)) c.io.say(`   not in ${c.mode} mode: ${u.feature}: ${u.why}`);
  return 0;
}

/**
 * WHY: auto-config's questions and its setup PR are easier in the browser: with a terminal, init offers the
 * dashboard's setup mode (src/setup-mode.ts), which hands over to the dashboard once the config is in.
 */
async function offerSetupPage(c: InitContext): Promise<void> {
  const cmd = `${BRAND.cli} dashboard --root ${c.root}`;
  if (!c.interactive) {
    c.io.say(`or finish in the browser: \`${cmd}\` opens the setup page`);
    return;
  }
  const a = await c.io.ask('Finish in the browser (answer the questions, draft and merge the config)? [Y/n] ');
  if (a === null || /^n/i.test(a.trim())) {
    c.io.say(`later: \`${cmd}\` opens the setup page`);
    return;
  }
  await c.io.interactive(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'dashboard', '--root', c.root!]);
}

/** The engine's own checkout (where scripts/ lives), from this module's place in dist/src/. */
export const engineRoot = () => fileURLToPath(new URL('../../', import.meta.url));

/** The real world: commands, the terminal, downloads and add-project.sh. */
export function systemIo(o: { interactive: boolean }): InitIo {
  let rl: ReturnType<typeof createInterface> | null = null;
  return {
    which: (cmd) => findTool(cmd),
    run: (cmd, args, opt = {}) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, env: withToolPath(), ...(opt.cwd ? { cwd: opt.cwd } : {}) });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
    },
    interactive: (cmd, args) =>
      new Promise((done) => {
        rl?.close();
        rl = null;
        const p = spawn(cmd, args, { stdio: 'inherit', env: withToolPath() });
        p.on('exit', (code) => done(code ?? 1));
        p.on('error', () => done(1));
      }),
    ask: async (q) => {
      if (!o.interactive) return null;
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((done) => rl!.question(q, done));
    },
    say: (line) => console.log(line),
    download: httpDownload,
    plan: (tool, prefix) => installPlan(tool, prefix),
    addProject: (name, repo, timeoutMinutes) =>
      new Promise((done) => {
        const script = join(engineRoot(), 'scripts', 'setup', 'add-project.sh');
        if (!existsSync(script)) return done({ code: 2, steps: {}, last: `no ${script}: server mode runs from the engine's checkout (bootstrap --hardened installs it)` });
        const p = spawn('bash', [script, name, repo, ...(timeoutMinutes ? ['--timeout', String(timeoutMinutes)] : [])], { stdio: ['inherit', 'pipe', 'inherit'] });
        const steps: Record<string, string> = {};
        const details: Record<string, string> = {};
        let last = '';
        createInterface({ input: p.stdout! }).on('line', (line) => {
          try {
            const j = JSON.parse(line) as { step: string; state: string; detail?: string; retry?: string };
            steps[j.step] = j.state;
            if (j.state === 'started') return;
            if (j.detail) details[j.step] = j.detail;
            last = `${j.step} ${j.state}${j.detail ? `: ${j.detail}` : ''}${j.retry ? ` (retry: ${j.retry})` : ''}`;
            console.log(`     add-project ${last}`);
          } catch {
            // not a step line
          }
        });
        // 'close', not 'exit': every line read before the result is taken.
        p.on('close', (code) => done({ code: code ?? 1, steps, details, last }));
        p.on('error', (e) => done({ code: 1, steps, last: e.message }));
      }),
  };
}

/** The GitHub repo a local checkout works on: its origin on github.com, else its config's project.repo. */
export function localRepo(root: string): string | null {
  const origin = gitRemoteRepo(root);
  if (origin) return origin;
  try {
    const r = loadConfig(root).project.project.repo;
    return /^[^/]+\/[^/]+$/.test(r) && r !== 'owner/repo' ? r : null;
  } catch {
    return null;
  }
}

export interface InitArgs {
  target: string | undefined;
  mode: Mode | undefined;
  instance: string | undefined;
  yes: boolean;
  reset: boolean;
  /** Where the CLI was run (local mode's default repo). */
  cwd: string;
  prefix: string;
  interactive: boolean;
  /** `--answer id=choice`, for auto-config's questions. */
  answers?: Record<string, string>;
  /** Server mode: add-project's --timeout, in minutes. */
  timeout?: number;
}

/**
 * `init`: the mode (asked when not given), the context, then the walk. Local mode run through npx hands over to an
 * install of its own first (src/npx-engine.ts).
 */
export async function initCommand(a: InitArgs, io: InitIo = systemIo({ interactive: a.interactive }), root = isRoot, handOff: HandOff = handOffFromNpx): Promise<number> {
  let mode = a.mode;
  // A directory that exists is a checkout (local mode); anything else is taken as owner/name (server mode).
  const localRoot = a.target === undefined ? resolve(a.cwd) : existsSync(a.target) ? resolve(a.target) : null;
  const recorded = localRoot ? readInitState(localInitFile(localRoot)) : null;
  if (!mode && recorded && !a.reset) mode = recorded.mode;
  if (!mode) {
    const answer = await io.ask(`Where should ${BRAND.name} run?\n  local   on this machine, as you (macOS, Linux, or Windows through WSL2); no server, no ssh\n  server  a hardened multi-user Linux server (as root: separate users per project)\nlocal or server? `);
    if (answer === null) {
      io.say(`init: give --mode local or --mode server (there's no terminal to ask on)`);
      return 2;
    }
    const m = answer.trim().toLowerCase();
    mode = m.startsWith('s') ? 'server' : m.startsWith('l') ? 'local' : undefined;
    if (!mode) {
      io.say(`init: "${answer.trim()}" is neither local nor server`);
      return 2;
    }
  }
  if (mode === 'local') {
    if (!localRoot) {
      io.say(`init: no directory ${a.target}: local mode sets up a checkout (default: here)`);
      return 2;
    }
    if (!existsSync(localRoot) || io.run('git', ['rev-parse', '--git-dir'], { cwd: localRoot }).status !== 0) {
      io.say(`init: ${localRoot} is not a git repository`);
      return 2;
    }
    if (detectOs() === 'windows') {
      io.say('init: on Windows, run it inside WSL2 (Ubuntu): local mode is Linux there');
      return 2;
    }
    const handed = await handOff({ root: localRoot, prefix: a.prefix, yes: a.yes, reset: a.reset, ...(a.answers ? { answers: a.answers } : {}), say: (l) => io.say(l) });
    if (handed !== null) return handed;
    const file = localInitFile(localRoot);
    let state = readInitState(file);
    if (!state || a.reset) state = newState('local', localRoot, null, null);
    state.repo = localRepo(localRoot);
    return runInit({ mode, root: localRoot, repo: state.repo, instance: null, prefix: a.prefix, yes: a.yes, interactive: a.interactive, io, state, ...(a.answers ? { answers: a.answers } : {}) }, file);
  }
  // server
  const repo = a.target ?? '';
  if (!/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    io.say(`init: server mode sets up a GitHub repo: \`${BRAND.cli} init --mode server <owner/repo> [--instance <name>]\``);
    return 2;
  }
  const instance = a.instance ?? repo.split('/')[1]!.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 21);
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(instance)) {
    io.say(`init: instance name "${instance}": lowercase letters, digits and dashes, starting with a letter (give --instance <name>)`);
    return 2;
  }
  if (!root()) {
    io.say(`init: server mode runs the setup scripts as root: sudo ${BRAND.cli} init --mode server ${repo} --instance ${instance}`);
    return 2;
  }
  const file = serverInitFile(instance);
  // A record an earlier engine kept in root's own state is carried over (and written where the coordinator reads it).
  let state = readInitState(file) ?? readInitState(legacyServerInitFile(instance));
  if (!state || a.reset) state = newState('server', repo, repo, instance);
  return runInit({ mode, root: null, repo, instance, prefix: a.prefix, yes: a.yes, interactive: a.interactive, io, state, ...(a.timeout ? { timeout: a.timeout } : {}) }, file);
}

/** The dashboard's first-run page (GET /api/first-run): the checklist as init recorded it, and what the mode can't do. */
export interface FirstRunView {
  /** Whether init has run for this checkout or instance. */
  recorded: boolean;
  mode: Mode | null;
  steps: ChecklistItem[];
  done: number;
  total: number;
  unavailable: Unavailable[];
  updatedAt: string | null;
  finishedAt: string | null;
  /** The command that walks (or resumes) the checklist. */
  command: string;
  /** Auto-config (local mode): the questions still open, each command's result on the default branch, the setup PR. */
  autoConfig: { questions: Question[]; verified: Verification[]; pr: { number: number | null; url: string } | null; answer: string } | null;
  /** Every setup step that applies to the mode, checked live from the real state (src/setup-steps.ts); doctor shows the same. */
  setup: SetupView | null;
}

/** How the page checks the steps live: the probe (none: the real one, off the main thread), where the state is, and the poll's cache. */
export interface FirstRunLive {
  probe?: SetupProbe;
  stateDir: string;
  policyFile: string | null;
  cache?: DetectCache;
  fresh?: boolean;
  localMs?: number;
  netMs?: number;
  context?: Partial<Pick<SetupContext, 'machine' | 'instanceFacts' | 'skipped'>>;
}

/** The setup context for a checkout or an instance, with what init recorded (auto-config's questions and PR). */
export function setupContext(state: InitState | null, o: { mode: Mode; root: string; repo: string | null; instance: string | null; stateDir: string; policyFile: string | null }): SetupContext {
  // Server mode: the setup PR add-project waits on, as it said (the service step's detail).
  const serverPr = /https:\/\/\S+\/pull\/\d+/.exec(state?.handoffDetail?.service ?? '')?.[0] ?? null;
  return {
    mode: o.mode,
    root: o.root,
    repo: o.repo,
    instance: o.instance,
    stateDir: o.stateDir,
    policyFile: o.policyFile,
    openQuestions: state?.autoConfig?.questions.length ?? 0,
    setupPr: state?.autoConfig?.pr?.url ?? serverPr,
    ...(state?.mode === 'server' ? { handoff: state.handoff, handoffDetail: state.handoffDetail ?? {} } : {}),
  };
}

/**
 * The first-run view with every step checked live (the dashboard's): a checkout without a recorded mode is local, an
 * instance's is server. With no probe given, the real one runs in a worker so the dashboard keeps answering.
 */
export async function firstRunLiveView(file: string, o: { root: string; repo: string; instance: string | null; has?: (cmd: string) => boolean; live: FirstRunLive }): Promise<FirstRunView> {
  const state = readInitState(file);
  const mode: Mode = state?.mode ?? (o.instance ? 'server' : 'local');
  const ctx = setupContext(state, { mode, root: o.root, repo: o.repo, instance: o.instance, stateDir: o.live.stateDir, policyFile: o.live.policyFile });
  const opts = { cache: o.live.cache ?? new Map(), fresh: !!o.live.fresh, localMs: o.live.localMs ?? 0, netMs: o.live.netMs ?? 0 };
  const setup = o.live.probe ? checkSetup({ ...ctx, ...o.live.context }, o.live.probe, opts) : await checkSetupOffThread({ ...ctx, ...(o.live.context?.machine ? { machine: o.live.context.machine } : {}), ...(o.live.context?.skipped ? { skipped: o.live.context.skipped } : {}) }, opts);
  return firstRunView(file, { root: o.root, repo: o.repo, instance: o.instance, ...(o.has ? { has: o.has } : {}), setup });
}

export function firstRunView(file: string, o: { root: string; repo: string; instance: string | null; has?: (cmd: string) => boolean; setup?: SetupView | null }): FirstRunView {
  const state = readInitState(file);
  const mode = state?.mode ?? o.setup?.mode ?? (o.instance ? 'server' : null);
  const steps = recordedChecklist(state, mode ?? 'local');
  const command = mode === 'server' ? `sudo ${BRAND.cli} init --mode server ${o.repo} --instance ${o.instance ?? '<name>'}` : `${BRAND.cli} init ${mode ? '' : '--mode local '}${o.root}`;
  return {
    recorded: state !== null,
    mode,
    steps,
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
    unavailable: mode ? unavailableIn(mode, o.has) : [],
    updatedAt: state?.updatedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    command,
    autoConfig: state?.autoConfig
      ? {
          questions: state.autoConfig.questions,
          verified: state.autoConfig.verified.filter((v) => v.base === state.autoConfig!.base),
          pr: state.autoConfig.pr ? { number: state.autoConfig.pr.number, url: state.autoConfig.pr.url } : null,
          answer: `${BRAND.cli} init ${o.root} --answer <id>=<choice>`,
        }
      : null,
    setup: o.setup ?? null,
  };
}
