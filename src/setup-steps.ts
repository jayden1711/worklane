// The setup step registry: every step a new install goes through (the first-run audit's table), each with how it
// is detected live from the real state, what a person does about it today, and how the first-run page fixes it.
// One list, read by three things that must never disagree: `init` (its walked steps are this registry's groups,
// and it checks them with these detectors), `doctor` (one line per step) and the dashboard's first-run page
// (GET /api/first-run). A detector only looks: it runs read-only commands (`claude auth status`, `gh auth status`,
// `git rev-parse`, the service manager's status) and reads files; it never changes anything.
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { AUTH_CHECK, authFailedDetail, isAuthFailure } from './claude-auth-failure.js';
import { redactString } from './events/redact.js';
import { loadConfig, type Config } from './config/load.js';
import { hookChecks, type Settings } from './agent-settings.js';
import { loadFingerprintSets } from './guardrails/context.js';
import { GIT_HOOK_MARKER, githubRepoOf } from './install.js';
import { instancesDir, loadInstance, readPolicy } from './instance.js';
import { INTAKE_FILE } from './intake/config.js';
import { MACHINE_HELPER } from './machine.js';
import { MACHINE_OWNERS_FILE, readMachineOwners } from './machine-owners.js';
import { CLAUDE_ACCOUNT_DIR, readAccountStatus } from './claude-account.js';
import { readWatchState } from './main-watch.js';
import { OFFSITE_FILE } from './offsite-backup.js';
import { lingerEnabled, serviceRunning, systemUnitActive } from './os/index.js';
import { findTool, withToolPath } from './tool-path.js';
import { FULL_RUN_LOCK } from './testrun/run.js';
import { ENGINE_CURRENT, UPDATES_CONFIG } from './updates.js';
import { instanceUnit, serviceLabel } from './service.js';
import { asRoot, etcPath, unitPath } from './os/system-paths.js';

export type Mode = 'local' | 'server';
export const MODES: readonly Mode[] = ['local', 'server'];

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What the detectors may ask of the machine: read-only commands and the service manager. Tests stand in for it. */
export interface SetupProbe {
  which(cmd: string): string | null;
  run(cmd: string, args: string[], o?: { cwd?: string }): RunResult;
  /** This user's service (local mode's coordinator) running now; null where there is no service manager to ask. */
  serviceRunning(label: string): boolean | null;
  /** A system unit (a server instance's coordinator, the dashboard hub) active now; null off Linux. */
  systemUnitActive(unit: string): boolean | null;
  /** Linux: whether this user's services outlive a login session; null elsewhere. */
  linger(): boolean | null;
}

export function systemProbe(): SetupProbe {
  return {
    which: (cmd) => findTool(cmd),
    run: (cmd, args, o = {}) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, env: withToolPath(), ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
    },
    serviceRunning,
    systemUnitActive,
    linger: () => lingerEnabled(),
  };
}

/** The machine-wide files a server's steps are read from (tests point them elsewhere). */
export interface MachinePaths {
  /** The engine this process runs: its package.json. */
  enginePackage: string;
  engine: string;
  helper: string;
  machineOwners: string;
  updatesConfig: string;
  allowedSigners: string;
  hubUnitFile: string;
  fullRunLock: string;
  /** claude-account.sh's status.json: each agent user's stored login and `claude auth status`, never the token. */
  claudeAccountDir: string;
}
export const MACHINE_PATHS: MachinePaths = {
  enginePackage: fileURLToPath(new URL('../../package.json', import.meta.url)),
  engine: ENGINE_CURRENT,
  helper: MACHINE_HELPER,
  machineOwners: MACHINE_OWNERS_FILE,
  updatesConfig: UPDATES_CONFIG,
  allowedSigners: etcPath('allowed_signers'),
  hubUnitFile: unitPath(`${BRAND.cli}-dashboard-hub.service`),
  fullRunLock: FULL_RUN_LOCK,
  claudeAccountDir: CLAUDE_ACCOUNT_DIR,
};
export const HUB_UNIT = `${BRAND.cli}-dashboard-hub.service`;
/** The hub in setup mode (src/hub-setup.ts; dashboards.sh --setup): before the sign-in App exists. */
export const HUB_SETUP_UNIT = `${BRAND.cli}-dashboard-hub-setup.service`;

/** What a server instance's steps read from it: its credentials and its home. */
export interface InstanceFacts {
  home: string;
  credentials: {
    github: { kind: 'app'; key_path: string } | { kind: 'gh-config-dir'; path: string };
    claude?: { config_dir: string } | undefined;
    agent_api_key?: string | undefined;
    intake?: { discord_token?: string | undefined } | undefined;
  };
}

export interface SetupContext {
  mode: Mode;
  /** The checkout: local mode's repo, or a server instance's clone. */
  root: string;
  /** owner/name on GitHub, when known. */
  repo: string | null;
  instance: string | null;
  /** Where the checkout's (or instance's) machine-local state is: the main watch's file. */
  stateDir: string;
  /** A server instance's policy.yaml. */
  policyFile: string | null;
  /** Auto-config's open questions and its setup PR, as init recorded them (local mode). */
  openQuestions: number;
  setupPr: string | null;
  /**
   * Server mode: add-project's last state and detail per step, as init recorded them (src/init.ts). What the
   * coordinator's user can't see for itself (the agent user's Claude login, a step left waiting) is read from here.
   */
  handoff?: Record<string, string>;
  handoffDetail?: Record<string, string>;
  machine?: Partial<MachinePaths>;
  /** A server instance's credentials and home; loadInstance when unset. */
  instanceFacts?: () => InstanceFacts | { error: string };
  /** Steps skipped on the first-run page (src/dashboard.ts). */
  skipped?: readonly string[];
}

export interface Detected {
  done: boolean;
  detail: string;
}

/** How the first-run page fixes a step that isn't done. */
export type Fix =
  /** A dashboard screen does it: the button opens it. */
  | { kind: 'screen'; path: string; label: string }
  /** No screen yet: the page shows what a person does today, and says one is coming. */
  | { kind: 'coming' }
  /** Only on the provider's own page (a login, a consent): a direct link, and the page detects when it's done. */
  | { kind: 'outside'; url: string | null; label: string; why: string; command?: string }
  /** Only in a terminal (root consent, sudo, a shell profile): the command, and why it can't be a button. */
  | { kind: 'terminal'; command: string; why: string }
  /** The Start button: the coordinator's service. */
  | { kind: 'start' }
  /** WHY: a step the dashboard does itself (src/setup-actions.ts): its plan shown first, then confirmed by an owner. */
  | { kind: 'action'; action: string; label: string }
  /** WHY: the Claude sign-in (src/claude-signin.ts): local mode relays `claude auth login`; a server pastes a setup token. */
  | { kind: 'signin'; label: string }
  /** WHY: a fix that needs values (the policy's): a form on the page, its change shown before it is written. */
  | { kind: 'form'; form: 'policy' | 'repo-config' | 'setup-origin' | 'setup-config'; label: string }
  /** WHY: Connect GitHub (src/gh-login.ts): gh's device login run for the person, its one-time code relayed to the page. */
  | { kind: 'gh-login'; label: string; command: string }
  /** WHY: the Discord step (src/intake/discord-setup.ts): token, invite, channel picks, intake.yaml after a shown diff. */
  | { kind: 'discord'; label: string };

export type GroupId = 'install' | 'tools' | 'claude' | 'github' | 'repo-config' | 'coordinator' | 'protection' | 'policy' | 'discord' | 'tailscale' | 'updates' | 'extras' | 'service';

export interface GroupDef {
  id: GroupId;
  title: string;
  optional: boolean;
  modes: readonly Mode[];
  /** One of init's walked steps (init does this group's work, in this order). */
  walked: boolean;
}

/** The groups, in order. init's checklist is the walked ones, in this order (src/init.ts STEPS). */
export const GROUPS: readonly GroupDef[] = [
  { id: 'install', title: 'Install', optional: false, modes: MODES, walked: false },
  { id: 'tools', title: 'Tools present', optional: false, modes: MODES, walked: true },
  { id: 'claude', title: 'Claude login', optional: false, modes: MODES, walked: true },
  { id: 'github', title: 'GitHub', optional: false, modes: MODES, walked: true },
  { id: 'repo-config', title: 'Repo config', optional: false, modes: MODES, walked: true },
  { id: 'coordinator', title: 'Coordinator running', optional: false, modes: ['server'], walked: true },
  { id: 'protection', title: 'Protection', optional: false, modes: MODES, walked: true },
  { id: 'policy', title: 'Instance policy', optional: false, modes: ['server'], walked: false },
  { id: 'discord', title: 'Discord', optional: true, modes: MODES, walked: true },
  { id: 'tailscale', title: 'Tailscale', optional: true, modes: ['server'], walked: true },
  { id: 'updates', title: 'Engine updates', optional: false, modes: ['server'], walked: false },
  { id: 'extras', title: 'Extras', optional: true, modes: MODES, walked: false },
  { id: 'service', title: 'Start', optional: false, modes: ['local'], walked: false },
];

/** How many installs reach a step (the audit's estimate from where it sits on the path, not usage data). */
export type Reach = 'all' | 'most' | 'some' | 'few';

export interface SetupStep {
  id: string;
  group: GroupId;
  /** The rows of the first-run audit's table this step covers. */
  rows: number[];
  title: string;
  modes: readonly Mode[];
  /** Recommended, not required: shown, never blocks. */
  optional: boolean;
  /**
   * The modes in which init's walk needs this step for its group to be done (init stops there until it is). Doctor's
   * line for the group (`setup <group>`) fails until every such step is done; any step not done is a warning on its
   * own line (`setup step <id>`).
   */
  walk?: readonly Mode[];
  reach: Reach;
  /** What a person does about it today, without a screen. */
  today: string;
  fix: Fix;
  /** WHY: every screen has a way to do the same without the page (a command or a config key), shown on it and in docs/dashboard.md. */
  automation?: string;
  /** It asks GitHub (or another service) over the network: checked less often, to spare the API's rate limit. */
  network?: boolean;
  detect: (c: Checking) => Detected | null;
}

/** A detector's view of the context: the context, the probe, and the config loaded once per check. */
export interface Checking {
  c: SetupContext;
  p: SetupProbe;
  m: MachinePaths;
  /** A call that costs (the Claude login's proof): its answer kept per identity in the dashboard's cache (proveClaudeLogin). */
  memo?: (identity: string, call: () => Detected) => Detected;
  cfg: () => Config | { error: string };
  inst: () => InstanceFacts | { error: string };
}

const ok = (detail: string): Detected => ({ done: true, detail });
/** Server mode: the instance's agent user's login, as claude-account.sh status (or add-project, credentials.sh) last found it; null when it has no record. */
function agentLogin(k: Checking): Detected | null {
  if (!k.c.instance) return null;
  const s = readAccountStatus(k.m.claudeAccountDir);
  const u = s?.users.find((x) => x.instance === k.c.instance && x.kind === 'agent');
  if (!s || !u) return null;
  const when = s.at ? ` at ${s.at}` : '';
  // WHY (#463): signed in per claude auth status is not proof the API takes the login; the real call is, when made.
  if (u.loggedIn && u.apiOk === false) return no(`${u.user} is signed in per claude auth status, but the API refused the login on a minimal real call${when}: ${u.apiError ?? 'no answer'}`);
  if (u.loggedIn) return ok(`${u.user} is signed in${u.authMethod ? ` (${u.authMethod})` : ''}, per claude auth status as that user${when}${u.tokenId ? `; token ${u.tokenId}` : ''}`);
  return no(`${u.user}: ${u.error ?? 'not signed in'}, per claude auth status as that user${when}`);
}
/** Server mode: a step this user can't check for itself, done as init recorded add-project's step; null when not recorded done. */
const recorded = (k: Checking, step: string, what: string): Detected | null => (k.c.handoff?.[step] === 'done' ? ok(`${what}: done, as init recorded it (add-project: ${step}); not visible to this user to check again`) : null);
const no = (detail: string): Detected => ({ done: false, detail });
const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
const isErr = <T extends object>(v: T | { error: string }): v is { error: string } => 'error' in v;

const nodeOk = (v = process.versions.node) => {
  const [maj, min] = v.split('.').map(Number) as [number, number];
  return maj > 22 || (maj === 22 && min >= 13);
};

export const REQUIRED_TOOLS: Record<Mode, string[]> = { local: ['git', 'gitleaks', 'claude', 'gh'], server: ['git', 'gitleaks', 'claude'] };

/** The tools step: Node new enough, and each required tool on PATH. */
export function detectTools(mode: Mode, p: Pick<SetupProbe, 'which'>, node = process.versions.node): Detected & { missing: string[] } {
  const missing = REQUIRED_TOOLS[mode].filter((t) => !p.which(t));
  if (!nodeOk(node)) return { done: false, detail: `Node ${node}: the engine needs 22.13 or newer`, missing };
  const docker = p.which('docker') ? 'docker' : 'no docker (optional: the test sandbox)';
  if (missing.length) return { done: false, detail: `missing: ${missing.join(', ')}`, missing };
  return { done: true, detail: `node ${node}, ${REQUIRED_TOOLS[mode].join(', ')}; ${docker}`, missing };
}

/** The minimal real call that proves a login: the cheapest model, a one-word answer, one turn, a hard budget cap. */
export const LOGIN_PROOF_ARGS = ['-p', AUTH_CHECK.prompt, '--model', AUTH_CHECK.model, '--max-turns', String(AUTH_CHECK.maxTurns), '--max-budget-usd', String(AUTH_CHECK.maxBudgetUsd), '--output-format', 'json'];

/**
 * Whether the API takes the login (issue #463: `claude auth status` says a credential is configured, not that it
 * works): one minimal real call. Done when Claude answered (a reply, or the budget cap reached); else Claude's
 * message, redacted, never a token.
 */
export function proveClaudeLogin(p: Pick<SetupProbe, 'run'>): Detected {
  const r = p.run('claude', LOGIN_PROOF_ARGS);
  type Result = { subtype?: string; is_error?: boolean; result?: string; api_error_status?: number | null };
  let j: Result | null = null;
  try {
    const parsed = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '') as unknown;
    j = parsed && typeof parsed === 'object' ? (parsed as Result) : null;
  } catch {
    // no JSON result: the exit status and stderr say what happened
  }
  if (j && ((j.subtype === 'success' && !j.is_error) || j.subtype === 'error_max_budget_usd')) return ok('a minimal real call was answered');
  const text = `${j?.result ?? ''}\n${r.stderr}`.trim() || r.stdout.trim() || `claude exited ${r.status ?? 'without a status'}`;
  if (isAuthFailure({ apiErrorStatus: j?.api_error_status ?? null, text })) return no(authFailedDetail({ apiErrorStatus: j?.api_error_status ?? null, text }));
  return no(redactString(`a minimal real call failed: ${text.replace(/\s+/g, ' ')}`).slice(0, 1000));
}

/**
 * Claude Code signed in (local mode: the person's own login, which the agents use): `claude auth status` says so,
 * and a minimal real call proves the API takes it. `memo` (the dashboard's) keeps the call's answer for the same
 * login: a success for LOGIN_PROOF_OK_MS, a failure for LOGIN_PROOF_FAILED_MS; Re-check calls again.
 */
export function detectClaudeLogin(p: Pick<SetupProbe, 'which' | 'run'>, memo?: (identity: string, call: () => Detected) => Detected): Detected {
  if (!p.which('claude')) return no('claude is not installed (the tools step)');
  const r = p.run('claude', ['auth', 'status']);
  let parsed: { loggedIn?: boolean; authMethod?: string; email?: unknown; orgId?: unknown } = {};
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    // older output: the exit status says it
  }
  if (!(r.status === 0 && parsed.loggedIn !== false)) return no('not signed in, per `claude auth status`');
  const how = `signed in${parsed.authMethod ? ` (${parsed.authMethod})` : ''}, per \`claude auth status\``;
  const identity = JSON.stringify([parsed.authMethod ?? null, parsed.email ?? null, parsed.orgId ?? null]);
  const proof = memo ? memo(identity, () => proveClaudeLogin(p)) : proveClaudeLogin(p);
  return proof.done ? ok(`${how}; ${proof.detail}`) : no(`${how}, but the API refused it: ${proof.detail}`);
}

/** How long the dashboard keeps a login's proof: an answered call, and a refused one (Re-check always calls again). */
export const LOGIN_PROOF_OK_MS = 6 * 3600_000;
export const LOGIN_PROOF_FAILED_MS = 10 * 60_000;

/** gh signed in, per `gh auth status`, and able to push to the repo. */
export function detectGithubLogin(p: Pick<SetupProbe, 'which' | 'run'>, repo: string | null): Detected {
  if (!p.which('gh')) return no('gh is not installed (the tools step)');
  if (p.run('gh', ['auth', 'status']).status !== 0) return no('gh is not signed in, per `gh auth status`');
  if (!repo) return no(`gh is signed in, but the repo has no GitHub origin: add one (git remote add origin https://github.com/<owner>/<name>.git), then run \`${BRAND.cli} init\` again`);
  const r = p.run('gh', ['api', `repos/${repo}`, '--jq', '.permissions.push']);
  if (r.status !== 0) return no(`gh is signed in, but can't read ${repo}: ${firstLine(r.stderr)}`);
  if (r.stdout.trim() !== 'true') return no(`gh is signed in, but your login can't push to ${repo}`);
  return ok(`gh signed in; you can push to ${repo}`);
}

/** The checkout's config folder: there, valid, and its hooks for local runs installed (init's repo-config step). */
export function detectRepoConfig(root: string, openQuestions: number, setupPr: string | null): Detected {
  if (!existsSync(join(root, BRAND.configDir, 'config.yaml'))) {
    return no(`no ${BRAND.configDir}/config.yaml${setupPr ? `: proposed in ${setupPr}, to merge` : openQuestions ? `: ${openQuestions} question${openQuestions === 1 ? '' : 's'} to answer (\`${BRAND.cli} init\`)` : ''}`);
  }
  if (!existsSync(join(root, '.claude', 'settings.json'))) return no('the hooks for local runs are not installed (.claude/settings.json)');
  try {
    const cfg = loadConfig(root);
    const placeholders = /your-github-handle|owner\/repo/.test(JSON.stringify(cfg.project)) ? `; still has template placeholders: set the owners in ${BRAND.configDir}/config.yaml` : '';
    return ok(`${BRAND.configDir}/ valid (${cfg.project.project.repo}), hooks installed${placeholders}`);
  } catch (e) {
    return no(firstLine((e as Error).message) || 'invalid config');
  }
}

/** The tailnet, per `tailscale status --json`; null when not on one. */
export function detectTailscale(p: Pick<SetupProbe, 'which' | 'run'>): (Detected & { dnsName: string | null; json: Record<string, unknown> | null }) | null {
  if (!p.which('tailscale')) return null;
  try {
    const s = JSON.parse(p.run('tailscale', ['status', '--json']).stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    if (s.BackendState !== 'Running') return null;
    const dnsName = (s.Self?.DNSName ?? '').replace(/\.$/, '') || null;
    return { done: true, detail: `on the tailnet as ${dnsName ?? 'this machine'}`, dnsName, json: s as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** WHY: what the Repo config form does, by hand (the owners, required checks and budget steps). */
const REPO_CONFIG_BY_HAND = `a reviewed commit (PR) to ${BRAND.configDir}/config.yaml (owners.writers, required_checks) and ${BRAND.configDir}/agents.yaml (daily_budget_usd, roles.workers count and model)`;

const placeholderOwners = (cfg: Config) => /your-github-handle|owner\/repo/.test(JSON.stringify(cfg.project.owners)) || /^owner\/repo$/.test(cfg.project.project.repo);

/** Whether a branch exists at origin (the last fetch's view; no network). */
const originHas = (k: Checking, ref: string) => k.p.run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`], { cwd: k.c.root }).status === 0;

function defaultBranch(k: Checking): string | null {
  const cfg = k.cfg();
  if (!isErr(cfg)) return cfg.project.project.default_branch;
  const head = k.p.run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: k.c.root });
  return head.status === 0 ? head.stdout.trim().replace(/^origin\//, '') || null : null;
}

/** The registry: every step of the audit's table (rows 1-33), in the order the page shows them. */
export const SETUP_STEPS: readonly SetupStep[] = [
  // Install
  {
    id: 'engine',
    group: 'install',
    rows: [1],
    title: `The ${BRAND.name} engine`,
    modes: MODES,
    optional: false,
    reach: 'all',
    today: 'Local: clone the repo, then `bash scripts/bootstrap.sh --mode local <repo>`. Server: `sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>`.',
    fix: { kind: 'terminal', command: 'bash scripts/bootstrap.sh --mode local <repo>', why: 'the one install command: nothing runs before it' },
    detect: (k) => {
      try {
        const pkg = JSON.parse(readFileSync(k.m.enginePackage, 'utf8')) as { version?: string };
        return pkg.version ? ok(`engine ${pkg.version} installed (this dashboard runs it)`) : no('the engine has no version in its package.json');
      } catch {
        return no("the engine's package.json can't be read");
      }
    },
  },
  {
    id: 'root-scripts',
    group: 'install',
    rows: [2],
    title: 'Root setup scripts reviewed and run',
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: 'bootstrap.sh pages each root script and asks "Run scripts/setup/<script> as root now? [y/N]" (skipped with --yes).',
    fix: { kind: 'terminal', command: 'sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>', why: 'consent to run root scripts is given at a root shell, before any web page exists' },
    detect: (k) => (existsSync(k.m.engine) ? ok(`the engine is installed at ${k.m.engine}`) : no(`no engine at ${k.m.engine}: bootstrap --hardened hasn't run here`)),
  },
  {
    id: 'machine-owner',
    group: 'install',
    rows: [3],
    title: 'First machine owner',
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: 'bootstrap.sh asks "Your GitHub login (you become this machine\'s first owner...)", or takes --machine-owner <login>.',
    fix: { kind: 'coming' },
    detect: (k) => {
      const r = readMachineOwners(k.m.machineOwners);
      if (r.error) return no(r.error);
      return r.owners.length ? ok(`machine owners: ${r.owners.map((o) => `@${o}`).join(', ')}`) : no(`no machine owner in ${k.m.machineOwners}`);
    },
  },
  {
    id: 'path',
    group: 'install',
    rows: [5],
    title: `${BRAND.cli} on your PATH`,
    modes: ['local'],
    optional: true,
    reach: 'some',
    today: 'bootstrap.sh prints: "$PREFIX/bin isn\'t on your PATH: add it in your shell profile (export PATH=...)".',
    fix: { kind: 'terminal', command: 'export PATH="$HOME/.local/bin:$PATH"', why: "it goes in your shell profile, and your shell profile is yours: it isn't written behind your back" },
    detect: (k) => {
      const at = k.p.which(BRAND.cli);
      return at ? ok(`${BRAND.cli} at ${at}`) : no(`${BRAND.cli} isn't on PATH for terminal use (the dashboard doesn't need it)`);
    },
  },
  // Tools
  {
    id: 'tools',
    walk: MODES,
    group: 'tools',
    rows: [4],
    title: 'Tools: git, gitleaks, claude (and gh, locally)',
    modes: MODES,
    optional: false,
    reach: 'most',
    today: `\`${BRAND.cli} init --yes\` installs a missing gitleaks, gh or claude from pinned, checksummed downloads; or install them yourself. On a server, tools.sh (bootstrap) does it.`,
    fix: { kind: 'action', action: 'install-tools', label: 'Install' },
    automation: `${BRAND.cli} init --yes (local: the same pinned tools); on a server, scripts/setup/tools.sh through bootstrap.sh --hardened`,
    detect: (k) => detectTools(k.c.mode, k.p),
  },
  {
    id: 'docker',
    group: 'tools',
    rows: [21],
    title: 'Test sandbox',
    modes: MODES,
    optional: true,
    reach: 'some',
    today: 'Local: install Docker. Server: set tests.yaml test_run by hand; test-user.sh needs a root-made full-run lock.',
    fix: { kind: 'outside', url: 'https://docs.docker.com/get-started/get-docker/', label: "Docker's installer", why: "Docker Desktop is the vendor's own installer" },
    detect: (k) => {
      if (k.c.mode === 'local') return k.p.which('docker') ? ok('docker is on PATH: test runs can use the sandbox') : no('docker is not on PATH: test runs have no sandbox');
      return existsSync(k.m.fullRunLock) ? ok(`the full-run lock ${k.m.fullRunLock} is set up`) : no(`no ${k.m.fullRunLock}: the machine's test locks aren't set up`);
    },
  },
  // Claude
  {
    id: 'claude-login',
    walk: ['local'],
    group: 'claude',
    rows: [6],
    title: 'Signed in to Claude',
    modes: ['local'],
    optional: false,
    reach: 'all',
    today: `Run \`claude auth login\` in a terminal, then \`${BRAND.cli} init\` again (it picks up here).`,
    fix: { kind: 'signin', label: 'Sign in' },
    automation: 'claude auth login (in a terminal, as this user)',
    detect: (k) => detectClaudeLogin(k.p, k.memo),
  },
  {
    id: 'claude-token',
    walk: ['server'],
    group: 'claude',
    rows: [7],
    title: "The agents' Claude login",
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: "Run `claude setup-token` on a machine signed in to the agents' Claude account, then paste the token it prints: in Add project's paste box, or at credentials.sh <name> claude's hidden prompt (as root).",
    fix: { kind: 'signin', label: 'Paste the token' },
    automation: 'scripts/setup/credentials.sh <name> claude (paste the token claude setup-token prints at its hidden prompt), or scripts/setup/add-project.sh <name> <owner/repo> (its claude-token step)',
    detect: (k) => {
      const i = k.inst();
      // WHY: add-project and credentials.sh keep the login in the agent user's own home, out of this user's sight;
      // what claude auth status said there, as root found it (claude-account status.json), is the real state. A switch
      // rewrites it. Signed in or not only: never the cached account email (#341), never the token.
      const login = agentLogin(k);
      if (login) return login;
      if (isErr(i)) return recorded(k, 'claude-token', "the agents' Claude login") ?? no(i.error);
      if (i.credentials.claude) return existsSync(i.credentials.claude.config_dir) ? ok(`the agents' Claude login is stored (${i.credentials.claude.config_dir})`) : (recorded(k, 'claude-token', "the agents' Claude login") ?? no(`Claude config dir ${i.credentials.claude.config_dir} not found`));
      if (i.credentials.agent_api_key) return ok('the agents bill to an API key (credentials.yaml agent_api_key)');
      // No entry in credentials.yaml: add-project keeps the agents' login in the agent user's own home, out of this user's sight.
      return recorded(k, 'claude-token', "the agents' Claude login") ?? no('credentials.yaml names no Claude login for the agents');
    },
  },
  // GitHub
  {
    id: 'gh-login',
    walk: ['local'],
    group: 'github',
    rows: [8],
    title: 'Signed in to GitHub (gh), able to push',
    modes: ['local'],
    optional: false,
    reach: 'most',
    today: `Run \`gh auth login\` in a terminal, then \`${BRAND.cli} init\` again.`,
    fix: { kind: 'gh-login', label: 'Connect GitHub', command: 'gh auth login --web' },
    automation: 'gh auth login --web (in a terminal, as this user)',
    network: true,
    detect: (k) => detectGithubLogin(k.p, k.c.repo),
  },
  {
    id: 'origin',
    group: 'github',
    rows: [9],
    title: 'The repo has a GitHub origin',
    modes: ['local'],
    optional: false,
    reach: 'few',
    today: 'git remote add origin https://github.com/<owner>/<name>.git',
    fix: { kind: 'form', form: 'setup-origin', label: 'Pick' },
    automation: 'git remote add origin https://github.com/<owner>/<name>.git, then git fetch origin',
    detect: (k) => {
      const url = k.p.run('git', ['remote', 'get-url', 'origin'], { cwd: k.c.root });
      const r = url.status === 0 ? githubRepoOf(url.stdout) : null;
      return r ? ok(`origin is github.com/${r}`) : no(url.status === 0 ? `origin isn't on GitHub (${url.stdout.trim()})` : 'no GitHub origin on this checkout');
    },
  },
  {
    id: 'signin-app',
    group: 'github',
    rows: [22, 24],
    title: 'Dashboard sign-in (GitHub App)',
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: '`dashboards.sh --setup --public-url <url>` starts the hub in setup mode: open the URL, paste the one-time setup token from the file it names, and make the sign-in App through GitHub\'s manifest flow; setup mode then turns itself off, and `dashboards.sh <name>...` starts the hub with it. With no https origin yet, `dashboards.sh --setup --loopback` serves the same page on 127.0.0.1 only (an ssh tunnel reaches it), and its App step shows Tailscale and HTTPS (screen 7) first. By hand instead: make the App on GitHub, `credentials.sh dashboard-signin`, then `dashboards.sh --client-id <id> --public-url <url> <name>`.',
    fix: { kind: 'terminal', command: 'sudo bash scripts/setup/dashboards.sh --setup --public-url https://<machine>.<tailnet>.ts.net', why: "root makes the hub's user and its setup-mode service; the page it serves, behind a one-time setup token from a root-only file, makes the sign-in App on GitHub" },
    detect: (k) => {
      const up = k.p.systemUnitActive(HUB_UNIT);
      if (up === null) return no('no systemd here to ask about the dashboard hub');
      if (up) return ok(`the dashboard hub (${HUB_UNIT}) is running with its sign-in App`);
      if (k.p.systemUnitActive(HUB_SETUP_UNIT)) return no(`the hub is in setup mode (${HUB_SETUP_UNIT}): open it and make the sign-in App`);
      return no(`the dashboard hub (${HUB_UNIT}) isn't running`);
    },
  },
  {
    id: 'agent-app',
    walk: ['server'],
    group: 'github',
    rows: [25],
    title: "The agents' GitHub App",
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: "The Setup console's Add project, or at a root shell `sudo bash scripts/setup/add-project.sh <name> <owner/repo>`: the App is made through GitHub's manifest flow (two clicks on GitHub, nothing copied by hand) and installed on the one repo picked.",
    fix: { kind: 'screen', path: '/setup', label: "the Setup console's Add project (pick the repo; the App through GitHub's manifest flow)" },
    automation: 'sudo bash scripts/setup/add-project.sh <name> <owner/repo> (its app step: the App through the manifest flow, installed on that one repo)',
    detect: (k) => {
      const i = k.inst();
      if (isErr(i)) return recorded(k, 'app', "the agents' GitHub App") ?? no(i.error);
      const g = i.credentials.github;
      if (g.kind !== 'app') return no(`the instance uses a gh login (${g.path}), not a GitHub App`);
      return existsSync(g.key_path) ? ok(`the App's private key is installed (${g.key_path})`) : no(`the App's private key ${g.key_path} is missing`);
    },
  },
  // Repo config
  {
    id: 'default-branch',
    group: 'repo-config',
    rows: [10],
    title: 'Default branch known',
    modes: ['local'],
    optional: false,
    reach: 'few',
    today: `\`git remote set-head origin --auto\`, then \`${BRAND.cli} init\` again.`,
    fix: { kind: 'action', action: 'default-branch', label: 'Set' },
    automation: 'git fetch origin <branch>, then git remote set-head origin --auto',
    detect: (k) => {
      const b = defaultBranch(k);
      if (!b) return no("can't tell the default branch: origin/HEAD isn't set and there's no config yet");
      return originHas(k, b) ? ok(`default branch ${b} (origin/${b})`) : no(`origin/${b} isn't fetched here`);
    },
  },
  {
    id: 'questions',
    group: 'repo-config',
    rows: [11],
    title: 'Auto-config questions answered',
    modes: ['local'],
    optional: false,
    reach: 'some',
    today: `Answer them in the terminal (\`${BRAND.cli} init\` asks), or \`${BRAND.cli} init --answer <id>=<choice>\`.`,
    fix: { kind: 'form', form: 'setup-config', label: 'Answer' },
    automation: `${BRAND.cli} init --answer <id>=<choice> (or answer init's questions in a terminal)`,
    detect: (k) => {
      if (existsSync(join(k.c.root, BRAND.configDir, 'config.yaml'))) return ok(`${BRAND.configDir}/ is here: nothing to ask`);
      return k.c.openQuestions ? no(`${k.c.openQuestions} question${k.c.openQuestions === 1 ? '' : 's'} open (shown below)`) : ok('none open');
    },
  },
  {
    id: 'config-on-main',
    walk: ['server'],
    group: 'repo-config',
    rows: [12, 26],
    title: `${BRAND.configDir}/ valid and on the default branch`,
    modes: MODES,
    optional: false,
    reach: 'most',
    today: `Review and merge the setup PR init proposed (local), or edit and merge the ${BRAND.cli}/setup branch's PR by hand (server); then \`${BRAND.cli} init\` again.`,
    fix: { kind: 'form', form: 'setup-config', label: 'Open' },
    automation: `${BRAND.cli} init (drafts the config and proposes it as a PR), then gh pr merge <number>, then ${BRAND.cli} init again (it fast-forwards)`,
    detect: (k) => {
      // Server mode: add-project leaves the service waiting until its setup PR merges; that wait is this step's.
      if (k.c.handoff?.service === 'waiting') return no(`${k.c.handoffDetail?.service || 'waiting for the setup PR to merge'} (add-project: service)`);
      const cfg = k.cfg();
      if (isErr(cfg)) return no(`${cfg.error}${k.c.setupPr ? `; proposed in ${k.c.setupPr}` : ''}`);
      const b = cfg.project.project.default_branch;
      const onMain = k.p.run('git', ['cat-file', '-e', `refs/remotes/origin/${b}:${BRAND.configDir}/config.yaml`], { cwd: k.c.root });
      if (onMain.status === 0) return ok(`${BRAND.configDir}/ valid here and on origin/${b}`);
      // Server mode: add-project's service step starts only from a config on the default branch; done, it was there.
      if (k.c.handoff?.service === 'done') return ok(`${BRAND.configDir}/ valid here; on ${b} as add-project's service step found it (init's record)`);
      return no(`${BRAND.configDir}/ is valid here but not on origin/${b} yet${k.c.setupPr ? `: merge ${k.c.setupPr}` : ''}`);
    },
  },
  {
    id: 'hooks',
    walk: ['local'],
    group: 'repo-config',
    rows: [12],
    title: 'Hooks for local runs installed',
    modes: ['local'],
    optional: false,
    reach: 'most',
    today: `\`${BRAND.cli} install\` (init runs it once the config is on the default branch).`,
    fix: { kind: 'action', action: 'local-hooks', label: 'Install' },
    automation: `${BRAND.cli} install`,
    detect: (k) => {
      const file = join(k.c.root, '.claude', 'settings.json');
      if (!existsSync(file)) return no('the hooks for local runs are not installed (.claude/settings.json)');
      try {
        const bad = hookChecks(JSON.parse(readFileSync(file, 'utf8')) as Settings, (p) => p.replace('$CLAUDE_PROJECT_DIR', k.c.root)).filter((h) => !h.ok);
        return bad.length ? no(bad.map((h) => `${h.event}: ${h.detail}`).join('; ')) : ok('every guarded hook installed (.claude/settings.json)');
      } catch (e) {
        return no(`.claude/settings.json unreadable: ${(e as Error).message}`);
      }
    },
  },
  {
    id: 'owners',
    group: 'repo-config',
    rows: [13],
    title: 'Owners and writers set',
    modes: MODES,
    optional: false,
    reach: 'most',
    today: `Edit owners in ${BRAND.configDir}/config.yaml (the template's your-github-handle) and merge it through a PR.`,
    fix: { kind: 'form', form: 'repo-config', label: 'Change' },
    automation: REPO_CONFIG_BY_HAND,
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet');
      return placeholderOwners(cfg) ? no(`config.yaml still has template placeholders`) : ok(`owners: ${cfg.project.owners.default}`);
    },
  },
  {
    id: 'required-checks',
    group: 'repo-config',
    rows: [14],
    title: 'Required checks named',
    modes: MODES,
    optional: false,
    reach: 'most',
    today: `List your CI checks in ${BRAND.configDir}/config.yaml required_checks (empty: nothing is ever marked ready).`,
    fix: { kind: 'form', form: 'repo-config', label: 'Change' },
    automation: REPO_CONFIG_BY_HAND,
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet');
      const r = cfg.project.required_checks;
      return r.length ? ok(`required: ${r.join(', ')}`) : no('required_checks is empty: nothing is ever marked ready');
    },
  },
  {
    id: 'agents-config',
    walk: ['local'],
    group: 'repo-config',
    rows: [15],
    title: 'Budget, models, guardrails, review levels',
    modes: MODES,
    optional: false,
    reach: 'most',
    today: `Review agents.yaml (budget, models), guardrails.yaml and review.yaml in ${BRAND.configDir}/: they start from the templates.`,
    fix: { kind: 'form', form: 'repo-config', label: 'Change' },
    automation: REPO_CONFIG_BY_HAND,
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet');
      return ok(`daily budget $${cfg.agents.daily_budget_usd}, ${cfg.guardrails.rules.length} guardrail rules${cfg.review ? ', review levels set' : ''}`);
    },
  },
  {
    id: 'pre-commit',
    group: 'repo-config',
    rows: [18],
    title: 'Pre-commit secret scan',
    modes: ['local'],
    optional: true,
    reach: 'most',
    today: `\`${BRAND.cli} install --git-hooks\``,
    fix: { kind: 'action', action: 'git-hooks', label: 'Install' },
    automation: `${BRAND.cli} install --git-hooks`,
    detect: (k) => {
      const common = k.p.run('git', ['rev-parse', '--git-common-dir'], { cwd: k.c.root });
      if (common.status !== 0) return no('not a git repository');
      const dir = common.stdout.trim();
      const hook = join(dir.startsWith('/') ? dir : join(k.c.root, dir), 'hooks', 'pre-commit');
      return existsSync(hook) && readFileSync(hook, 'utf8').includes(GIT_HOOK_MARKER) ? ok('gitleaks pre-commit installed') : no('not installed; the land queue still re-scans');
    },
  },
  {
    id: 'fingerprints',
    group: 'repo-config',
    rows: [19],
    title: 'Guardrail fingerprints fetched',
    modes: MODES,
    optional: true,
    reach: 'some',
    today: `\`${BRAND.cli} guardrails refresh\``,
    fix: { kind: 'action', action: 'fingerprints', label: 'Fetch' },
    automation: `${BRAND.cli} guardrails refresh`,
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet');
      const names = Object.keys(cfg.guardrails.fingerprints);
      if (!names.length) return ok('no fingerprint rules: nothing to fetch');
      const sets = loadFingerprintSets(k.c.root);
      const missing = names.filter((n) => !sets[n]?.size);
      return missing.length ? no(`not fetched: ${missing.join(', ')}; until then agents are denied any command with a DB connection string`) : ok(`fetched: ${names.join(', ')}`);
    },
  },
  // Protection
  {
    id: 'protection',
    group: 'protection',
    rows: [17],
    title: 'Default branch protected',
    modes: MODES,
    optional: true,
    reach: 'most',
    today: "On github.com, the repo's Settings, Rules (or Branches): protect the default branch and require your checks. Needed for land_mode direct.",
    fix: { kind: 'action', action: 'protection', label: 'Protect' },
    automation: 'gh api --method PUT repos/<owner/repo>/branches/<branch>/protection --input <body.json>, the body from config.yaml required_checks and protection.strict (src/branch-protection.ts classicChecks)',
    network: true,
    detect: (k) => {
      const b = defaultBranch(k) ?? 'main';
      const watch = readWatchState(join(k.c.stateDir, 'main-watch.json'));
      if (watch.mode === 'github') return ok(`GitHub enforces protection on ${b}`);
      if (watch.mode === 'main_watch') return ok(`GitHub doesn't protect ${b}: the main watch guards it`);
      if (!k.c.repo) return no('no GitHub origin: nothing to protect yet');
      if (!k.p.which('gh')) return no(`can't ask GitHub: gh isn't installed`);
      const r = k.p.run('gh', ['api', `repos/${k.c.repo}/branches/${b}/protection`, '--silent']);
      if (r.status === 0) return ok(`GitHub enforces protection on ${b}`);
      const code = r.stderr.match(/HTTP (\d{3})/)?.[1];
      return no(`GitHub doesn't protect ${b}${code ? ` (HTTP ${code})` : ''}: every change still lands through a PR you merge`);
    },
  },
  // Policy (server)
  {
    id: 'policy',
    group: 'policy',
    rows: [16],
    title: "The instance's policy",
    modes: ['server'],
    optional: false,
    reach: 'most',
    today: "Edit the instance's policy.yaml (auto_merge, land_mode, budget, workers); the Settings page changes workers and budget.",
    fix: { kind: 'form', form: 'policy', label: 'Review' },
    automation: "the instance's policy.yaml: budget.daily_usd, agents.max_workers, land_mode, auto_merge, main_watch",
    detect: (k) => {
      if (!k.c.policyFile) return no('no policy file for this instance');
      const r = readPolicy(k.c.policyFile);
      if (!r.policy) return no(r.errors.map((e) => `${e.file}${e.path ? ` at ${e.path}` : ''}: ${e.message}`).join('; '));
      return ok(`auto_merge ${r.policy.auto_merge ? 'on' : 'off'}, $${r.policy.budget.daily_usd}/day, ${r.policy.agents.max_workers} workers at most`);
    },
  },
  // Discord
  {
    id: 'discord',
    group: 'discord',
    rows: [27],
    title: 'Discord intake and chat',
    modes: ['server'],
    optional: true,
    reach: 'some',
    today: `Create the app and bot in Discord's developer portal and turn on the message-content intent (only there). Then here, or in a terminal: the token (\`credentials.sh <name> intake-discord\`, as root), the invite link, the bot's channels (\`${BRAND.cli} discord channels\`, as the instance's user), and intake.yaml's discord and superfan channel keys; who may send, people and owners stay in intake.yaml by hand. Restart the instance.`,
    fix: { kind: 'discord', label: 'Set up' },
    automation: 'sudo bash scripts/setup/credentials.sh <name> intake-discord (the bot token), then intake.yaml in the instance home (guild, channels, owners, people; docs/intake.md) and a restart of the instance',
    detect: (k) => {
      const i = k.inst();
      if (isErr(i)) return no(i.error);
      if (!i.credentials.intake?.discord_token) return no('no bot token in credentials.yaml');
      return existsSync(join(i.home, INTAKE_FILE)) ? ok(`bot token stored and ${INTAKE_FILE} written`) : no(`bot token stored, but no ${INTAKE_FILE} in the instance home`);
    },
  },
  // Tailscale
  {
    id: 'tailscale',
    group: 'tailscale',
    rows: [23],
    title: 'Reachable over Tailscale (HTTPS)',
    modes: ['server'],
    optional: true,
    reach: 'most',
    today: "The Machine page's Tailscale and HTTPS panel walks it (a machine owner's): install, log in, serve, the hub's URL. Without the dashboard, as root: `scripts/setup/tailscale.sh install`, `up`, `serve`, then `public-url` (dashboards.sh --public-url). MagicDNS and HTTPS certificates are turned on in Tailscale's admin console. Skipping it changes nothing: the hub keeps its URL.",
    fix: { kind: 'screen', path: '/machine#tailscale', label: "the Machine page's Tailscale and HTTPS panel" },
    automation: 'sudo bash scripts/setup/tailscale.sh install, then up, serve and public-url (one step each; status reads only)',
    detect: (k) => detectTailscale(k.p) ?? no('not on a tailnet: the dashboard stays on this machine'),
  },
  {
    id: 'console-devices',
    group: 'tailscale',
    rows: [32],
    title: 'Owner terminal devices',
    modes: ['server'],
    optional: true,
    reach: 'few',
    today: '`console-shell.sh <admin user>`, then dashboards.sh again with --console-user and --console-devices tag:...; tag the devices in your tailnet policy.',
    fix: { kind: 'outside', url: 'https://login.tailscale.com/admin/acls', label: "Tailscale's access controls", why: "devices are tagged in the tailnet's own policy" },
    detect: (k) => {
      let unit = '';
      try {
        unit = readFileSync(k.m.hubUnitFile, 'utf8');
      } catch {
        return no(`no dashboard hub unit (${k.m.hubUnitFile})`);
      }
      const m = unit.match(/--console-devices (\S+)/);
      return m ? ok(`terminal devices: ${m[1]}`) : no('no terminal devices listed for the owner terminal');
    },
  },
  // Updates
  {
    id: 'updater',
    group: 'updates',
    rows: [28],
    title: 'Engine updater set up',
    modes: ['server'],
    optional: false,
    reach: 'most',
    today: '`sudo bash scripts/setup/updates.sh` installs it (off); `--signer <principal> ssh-ed25519 <public key>` adds a release signer to /etc/<cli>/allowed_signers (or `--confirm-signer <fingerprint>` for one staged on the Machine page), and `--channel release|main` picks what it follows; then turn updates on from the Machine page.',
    fix: { kind: 'screen', path: '/machine', label: "the Machine page's Updater setup" },
    automation: `sudo bash scripts/setup/updates.sh [--channel release] [--signer <principal> ssh-ed25519 <public key>] (or --confirm-signer SHA256:<fingerprint> for a signer staged on the Machine page), then sudo ${asRoot.libexec('machine')} set-updates on`,
    detect: (k) => {
      if (!existsSync(k.m.updatesConfig)) return no(`the updater isn't set up (no ${k.m.updatesConfig})`);
      return existsSync(k.m.allowedSigners) ? ok(`set up (${k.m.updatesConfig}); release signers listed`) : no(`set up, but no ${k.m.allowedSigners}: the release channel installs nothing until it lists the signing key`);
    },
  },
  // Extras
  {
    id: 'other-keys',
    group: 'extras',
    rows: [29],
    title: 'API and provider keys',
    modes: ['server'],
    optional: true,
    reach: 'few',
    today: 'credentials.sh <name> api-key (or provider-key, eval-key) prompts for the key, then set it in credentials.yaml by hand and restart the instance.',
    fix: { kind: 'outside', url: 'https://console.anthropic.com/settings/keys', label: "Anthropic's console", why: "the key is made in the provider's console" },
    detect: (k) => {
      const i = k.inst();
      if (isErr(i)) return no(i.error);
      const key = i.credentials.agent_api_key;
      if (!key) return no('none set (only for API-key billing)');
      return existsSync(key) ? ok(`agent API key installed (${key})`) : no(`credentials.yaml names ${key}, which isn't there`);
    },
  },
  {
    id: 'backup',
    group: 'extras',
    rows: [30],
    title: 'Off-site backup',
    modes: ['server'],
    optional: true,
    reach: 'few',
    today: `Make a bucket and key in Backblaze, put ${OFFSITE_FILE} in the instance home (docs/backups.md), then offsite-backup.sh asks for the key.`,
    fix: { kind: 'outside', url: 'https://secure.backblaze.com/b2_buckets.htm', label: "Backblaze's buckets", why: "the bucket and key are made in Backblaze's console" },
    detect: (k) => {
      const i = k.inst();
      if (isErr(i)) return no(i.error);
      return existsSync(join(i.home, OFFSITE_FILE)) ? ok(`${OFFSITE_FILE} is set up`) : no(`no ${OFFSITE_FILE} in the instance home`);
    },
  },
  {
    id: 'more-owners',
    group: 'extras',
    rows: [31],
    title: 'More machine owners',
    modes: ['server'],
    optional: true,
    reach: 'few',
    today: '`dashboards.sh --machine-owner <login>[,...]` as root.',
    fix: { kind: 'coming' },
    detect: (k) => {
      const r = readMachineOwners(k.m.machineOwners);
      return r.owners.length > 1 ? ok(`${r.owners.length} machine owners`) : no(r.error ?? 'one machine owner (or none): no one else can approve machine changes');
    },
  },
  {
    id: 'deploy-gate',
    group: 'extras',
    rows: [33],
    title: 'Deploy environments',
    modes: MODES,
    optional: true,
    reach: 'some',
    today: `Write ${BRAND.configDir}/deploy.yaml environments by hand; point production at the deploy branch in your host's settings.`,
    fix: { kind: 'coming' },
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet');
      const envs = cfg.deploy?.environments ?? [];
      return envs.length ? ok(`environments: ${envs.map((e) => e.name).join(', ')}`) : no('no environments in deploy.yaml');
    },
  },
  // Coordinator running (server): add-project's last steps, the service among them
  {
    id: 'coordinator',
    walk: ['server'],
    group: 'coordinator',
    rows: [20, 26],
    title: "The instance's coordinator running",
    modes: ['server'],
    optional: false,
    reach: 'all',
    today: `\`sudo ${BRAND.cli} init --mode server <owner/repo> --instance <name> [--timeout <minutes>]\` hands off to add-project.sh, whose last steps (service, test-user, machine-helper, dashboards) install and start ${BRAND.cli}-<name>.service; --timeout is how long it waits for a GitHub click or the setup PR's merge (default 15).`,
    fix: { kind: 'start' },
    automation: 'sudo bash scripts/setup/service.sh <name> (add-project.sh runs it)',
    detect: (k) => {
      const unit = instanceUnit(k.c.instance ?? '<name>');
      const up = k.p.systemUnitActive(unit);
      if (up) return ok(`${unit} is active`);
      // Why not, as add-project left it: a step waiting or failed, with its detail.
      const left = ['service', 'test-user', 'machine-helper', 'dashboards'].find((s) => k.c.handoff?.[s] === 'waiting' || k.c.handoff?.[s] === 'failed');
      const why = left ? `; add-project ${left} ${k.c.handoff![left]}${k.c.handoffDetail?.[left] ? `: ${k.c.handoffDetail[left]}` : ''}` : '';
      return no(`${up === null ? 'no systemd here to ask' : `${unit} isn't active`}${why}`);
    },
  },
  // Start (local)
  {
    id: 'service',
    group: 'service',
    rows: [20],
    title: 'The coordinator running',
    modes: ['local'],
    optional: false,
    reach: 'all',
    today: `\`${BRAND.cli} up\` installs and starts it as your own service.`,
    fix: { kind: 'start' },
    automation: `${BRAND.cli} up`,
    detect: (k) => {
      const cfg = k.cfg();
      if (isErr(cfg)) return no('no valid config yet: the coordinator needs one');
      const label = serviceLabel(cfg);
      const up = k.p.serviceRunning(label);
      if (up === null) return no('no service manager here (agents need macOS, Linux or WSL2)');
      return up ? ok(`${label} is running`) : no(`${label} isn't running`);
    },
  },
  {
    id: 'linger',
    group: 'service',
    rows: [20],
    title: 'Runs without a login session (Linux)',
    modes: ['local'],
    optional: true,
    reach: 'some',
    today: 'Run `sudo loginctl enable-linger $USER` so the coordinator runs without a login session.',
    fix: { kind: 'terminal', command: 'sudo loginctl enable-linger "$USER"', why: 'it needs sudo, which the dashboard never runs' },
    detect: (k) => {
      const l = k.p.linger();
      if (l === null) return null;
      return l ? ok('linger is on: the service outlives your login') : no('linger is off: the coordinator stops when you log out');
    },
  },
];

export interface StepView {
  id: string;
  group: GroupId;
  rows: number[];
  title: string;
  optional: boolean;
  /** init's walk needs it for its group, in this mode. */
  walk: boolean;
  reach: Reach;
  done: boolean;
  detail: string;
  today: string;
  fix: Fix;
  automation: string | null;
  /** The person skipped it on the first-run page: shown as skipped, not counted as left; doctor and init still check it. */
  skipped: boolean;
  network: boolean;
  checkedAt: string;
}

export interface GroupView {
  id: GroupId;
  title: string;
  optional: boolean;
  /** Every required step in it done (an optional group: every step). */
  done: boolean;
  /** Every step init's walk needs here done: what doctor's line for the group says (ok, or not). */
  ready: boolean;
  steps: StepView[];
}

export interface SetupView {
  mode: Mode;
  groups: GroupView[];
  /** Steps done, of all that apply. */
  done: number;
  total: number;
  /** Required steps not done yet. */
  requiredLeft: number;
}

/** A detector's answer, kept between checks (the dashboard's poll). */
export type DetectCache = Map<string, { at: number; key: string; r: Detected | null }>;

function defaultFacts(name: string | null): () => InstanceFacts | { error: string } {
  return () => {
    if (!name) return { error: 'no instance: these steps are a server instance\'s' };
    try {
      const i = loadInstance(name, instancesDir());
      return { home: i.home, credentials: i.credentials as InstanceFacts['credentials'] };
    } catch (e) {
      return { error: `instance ${name} can't be read here: ${firstLine((e as Error).message)}` };
    }
  };
}

/**
 * Check every step that applies to this mode, now. With a cache (the dashboard), a step checked within its time to
 * live is reused: network steps for `netMs`, the rest for `localMs`; `fresh` (Re-check) checks them all again.
 */
export function checkSetup(c: SetupContext, p: SetupProbe, o: { cache?: DetectCache; fresh?: boolean; localMs?: number; netMs?: number; now?: () => number } = {}): SetupView {
  const now = o.now ?? Date.now;
  let cfg: Config | { error: string } | undefined;
  let inst: InstanceFacts | { error: string } | undefined;
  const facts = c.instanceFacts ?? defaultFacts(c.instance);
  const k: Checking = {
    c,
    p,
    m: { ...MACHINE_PATHS, ...c.machine },
    cfg: () =>
      (cfg ??= (() => {
        if (!existsSync(join(c.root, BRAND.configDir))) return { error: `no ${BRAND.configDir}/ in ${c.root}` };
        try {
          return loadConfig(c.root);
        } catch (e) {
          return { error: firstLine((e as Error).message) || 'invalid config' };
        }
      })()),
    inst: () => (inst ??= facts()),
    // WHY: the login's proof is a real (cheap) call: never once per poll. Kept for the same login; Re-check calls again.
    memo: (identity, call) => {
      const hit = o.cache?.get('claude-login:proof');
      const t = now();
      if (hit && !o.fresh && hit.key === identity && hit.r && t - hit.at < (hit.r.done ? LOGIN_PROOF_OK_MS : LOGIN_PROOF_FAILED_MS)) return hit.r;
      const r = call();
      o.cache?.set('claude-login:proof', { at: t, key: identity, r });
      return r;
    },
  };
  const key = JSON.stringify([c.mode, c.root, c.repo, c.instance, c.openQuestions, c.setupPr]);
  const steps: StepView[] = [];
  for (const s of SETUP_STEPS) {
    if (!s.modes.includes(c.mode)) continue;
    const ttl = s.network ? (o.netMs ?? 0) : (o.localMs ?? 0);
    const hit = o.cache?.get(s.id);
    const t = now();
    let r: Detected | null;
    let at = t;
    if (hit && !o.fresh && hit.key === key && t - hit.at < ttl) {
      r = hit.r;
      at = hit.at;
    } else {
      try {
        r = s.detect(k);
      } catch (e) {
        r = no(`couldn't check: ${firstLine((e as Error).message)}`);
      }
      o.cache?.set(s.id, { at: t, key, r });
    }
    if (!r) continue;
    steps.push({ id: s.id, group: s.group, rows: s.rows, title: s.title, optional: s.optional, walk: !!s.walk?.includes(c.mode), reach: s.reach, done: r.done, detail: r.detail, today: s.today, fix: s.fix, automation: s.automation ?? null, skipped: !!c.skipped?.includes(s.id), network: !!s.network, checkedAt: new Date(at).toISOString() });
  }
  const groups: GroupView[] = GROUPS.filter((g) => g.modes.includes(c.mode))
    .map((g) => {
      const mine = steps.filter((s) => s.group === g.id);
      const required = mine.filter((s) => !s.optional);
      return { id: g.id, title: g.title, optional: g.optional || !required.length, done: (required.length ? required : mine).every((s) => s.done || s.skipped), ready: mine.filter((s) => s.walk).every((s) => s.done), steps: mine };
    })
    .filter((g) => g.steps.length);
  return { mode: c.mode, groups, done: steps.filter((s) => s.done).length, total: steps.length, requiredLeft: steps.filter((s) => !s.optional && !s.done && !s.skipped).length };
}

/** The level doctor shows a step's own line at: ok when done, as the page shows it; a warning when not. */
export const stepLevel = (s: Pick<StepView, 'done'>): 'ok' | 'warn' => (s.done ? 'ok' : 'warn');

/** The level of doctor's line for one of init's walked groups: ok when ready, as the page's group says; else fail (an optional group: warn). */
export const groupLevel = (g: Pick<GroupView, 'ready' | 'optional'>): 'ok' | 'warn' | 'fail' => (g.ready ? 'ok' : g.optional ? 'warn' : 'fail');

/**
 * checkSetup in a worker thread (src/setup-worker.ts), with the real probe: the dashboard's way, so its server keeps
 * answering while the commands run. The context must be plain data (no instanceFacts function: the worker loads
 * the instance itself). The cache comes back updated.
 */
export function checkSetupOffThread(c: Omit<SetupContext, 'instanceFacts'>, o: { cache: DetectCache; fresh?: boolean; localMs?: number; netMs?: number }): Promise<SetupView> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./setup-worker.js', import.meta.url), { workerData: { ctx: c, cache: o.cache, fresh: !!o.fresh, localMs: o.localMs ?? 0, netMs: o.netMs ?? 0 } });
    w.once('message', (m: { view: SetupView; cache: DetectCache }) => {
      o.cache.clear();
      for (const [k, v] of m.cache) o.cache.set(k, v);
      resolve(m.view);
    });
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(`the setup check stopped (exit ${code})`)));
  });
}
