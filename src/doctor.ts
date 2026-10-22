// `doctor`: verify an install. Each check is ok, warn or fail; any fail
// makes the command exit non-zero. Nothing here is skipped silently: a check
// that can't run reports why, and a feature the setup's mode can't have is
// listed as off, with why.
import { execFileSync, spawnSync } from './os/child-process.js';
import { gitExecFileSync } from './os/git.js';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentRecordWarning } from './setup-steps.js';
import { BRAND } from './brand.js';
import { checkSourceDoctor, workflowsAt, type Tip } from './check-pin-block.js';
import { ConfigInvalid, loadConfig, type Config } from './config/load.js';
import { checkGuardrails } from './guardrails/check.js';
import { loadFingerprintSets } from './guardrails/context.js';
import { agentSettingsPath, hookChecks, installCommand, legacyProjectHooks, projectSettingsRefusal, type Settings } from './agent-settings.js';
import { GIT_HOOK_MARKER, legacyHookChecks } from './install.js';
import { instancesDir, loadInstance, policiesForRepo, policyViolations, readPolicy } from './instance.js';
import { instanceTargets, planMigrations, projectConfigFiles, type Targets } from './migrations.js';
import { projectStateDir } from './guardrails/context.js';
import { canRunAgents, detectOs, diskFree, fileAccess, homeOf, nvidiaNodes, shimsNeedShell, stateDir, userUid, wslAvailable } from './os/index.js';
import { VIEWER_USER } from './setup/app-manifest.js';
import { diskFloorCheck } from './governor-holds.js';
import { policyRootChecks } from './doctor-policy-root.js';
import { findTool, toolBin } from './tool-path.js';
import { checkIntakeFile } from './intake/check.js';
import { claudeAccountLeftoverCheck } from './claude-accounts-retired.js';
import { INTAKE_FILE } from './intake/config.js';
import { lintSkills, skillLintReport, trackedSkills } from './skill-lint.js';
import { initStateUnreadable, localInitFile, localRepo, readInitState, serverInitFile, setupContext, unavailableIn, type InitIo, type Mode } from './init.js';
import { gpuCommands, gpuFilePath, gpuIndices, readGpuFile } from './testrun/gpu.js';
import { networkCommands, networkFilePath, NETWORK_FILE_NAME, parseNetworkFile } from './testrun/network.js';
import { usernsUnsupportedProblem } from './testrun/status.js';
import { openReadOnly } from './events/read-only.js';
import { checkSetup, groupLevel, GROUPS, stepLevel, systemProbe, type SetupContext, type SetupProbe } from './setup-steps.js';
import { modelWarnings } from './model-routing.js';
import { vacuityDoctor } from './merge-policy-vacuity.js';
import { HUB_UNIT_AS_ROOT, OWNER_TERMINAL_RERUN, ownerTerminalNotice, ownerTerminalRerun, type TerminalPaths } from './console/owner-terminal-removed.js';
import { voiceSiriLeftoverCheck } from './doctor-voice-removed.js';
import { moneyListCheck } from './review.js';
import { DASHBOARD_KEY_PREFIX, isDashboardKey } from './events/redact.js';

/** off: not available in this setup's mode (said why; never a failure). */
export type Level = 'ok' | 'warn' | 'fail' | 'off';
export interface DoctorCheck {
  name: string;
  level: Level;
  detail: string;
}

const CLAUDE_MD_TOKEN_BUDGET = 2500;

/**
 * An instance's agent API key file (credentials.yaml agent_api_key): present, owned by the agent user, and open to
 * nobody else (no group or other bits). The file is never read. The coordinator user normally can't even see it
 * (it lives in the agent user's home), which is right: then this says to run doctor as root to check the mode.
 */
export function apiKeyCheck(file: string, agentUser: string | null, access = fileAccess, uidOf = userUid): { level: Level; detail: string } {
  if (!agentUser) return { level: 'fail', detail: `${file}: an API key needs agents to run as their own user (instance.yaml run_as)` };
  const a = access(file);
  if (a.kind === 'unsupported') return { level: 'warn', detail: 'API-key instances run agents as their own POSIX user; not checkable on native Windows' };
  if (a.kind === 'missing') return { level: 'fail', detail: `${file} not found: install it with \`scripts/setup/credentials.sh <name> api-key\`` };
  if (a.kind === 'hidden') return { level: 'warn', detail: `${file} can't be seen from this user, as intended (it is ${agentUser}'s); to check its owner and mode, run doctor as root` };
  const uid = uidOf(agentUser);
  if (uid === null) return { level: 'fail', detail: `the agent user ${agentUser} does not exist on this machine` };
  if (a.uid !== uid) return { level: 'fail', detail: `${file} is not owned by ${agentUser}: reinstall it with credentials.sh` };
  if (a.openToOthers) return { level: 'fail', detail: `${file} is mode ${a.mode}: only ${agentUser} may read it (0400). Run: chmod 0400 ${file}` };
  return { level: 'ok', detail: `${file}: ${agentUser}'s only (${a.mode})` };
}

export function doctor(rootArg: string, opts: { agentshield?: boolean; /** A policy.yaml to check the config against, besides any local instance's. */ policy?: string; /** An instance whose agent settings to check, besides those of any local instance running this repo. */ instance?: string; /** The setup's mode, when init's state doesn't say (or to see another's). */ mode?: Mode; /** For tests: init's world. */ initIo?: InitIo; /** For tests: the disk's free and total GB at a path. */ disk?: (path: string) => { freeGb: number; totalGb: number }; /** #727: the default branch tip's check runs (the CLI reads them with gh); absent: not read. */ tipRuns?: (repo: string, branch: string) => Tip | null } = {}): DoctorCheck[] {
  const root = resolve(rootArg);
  const out: DoctorCheck[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });

  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  // The engine's requirement (package.json engines): every part, hooks and coordinator alike, runs on it.
  if (maj < 22 || (maj === 22 && min < 13)) add('node', 'fail', `Node ${process.versions.node}; the engine needs >= 22.13`);
  else add('node', 'ok', `Node ${process.versions.node}`);

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(root);
    add('config', 'ok', `${BRAND.configDir}/ valid`);
    // WHY (#468): a model the engine doesn't list is a warning, never a refusal (the config still loads).
    const models = modelWarnings(cfg.agents);
    add('config models', models.length ? 'warn' : 'ok', models.length ? models.join('\n') : 'every model named is one the engine lists');
    // #727: a required check with no recorded source is judged by name, unless GitHub's rules name its App; the block
    // that pins it maps from the workflow files committed on main's tip (never the checkout's working tree).
    const p = cfg.project;
    const pinsNeeded = p.land_mode === 'pr' && p.ci !== 'none' && p.required_checks.some((n) => !Object.hasOwn(p.required_check_sources, n));
    const tip = pinsNeeded ? (opts.tipRuns?.(p.project.repo, p.project.default_branch) ?? null) : null;
    const origin = `origin/${p.project.default_branch}`;
    const workflows = pinsNeeded ? ((tip ? workflowsAt(root, tip.sha) : null) ?? workflowsAt(root, origin)) : null;
    const pins = checkSourceDoctor(p, workflows, tip);
    add('required check sources', pins.level, pins.detail);
    // #784: whether app-code PRs can auto-merge (their tests run under coverage), with the lines to add when not.
    const vac = vacuityDoctor(cfg.tests);
    add('vacuity gate', vac.level, vac.detail);
  } catch (e) {
    add('config', 'fail', e instanceof ConfigInvalid ? e.message : (e as Error).message);
  }

  // Migrations: anything newer than this engine, or pending steps the coordinator won't start with.
  const targets: [string, Targets][] = [['migrations', { configFiles: projectConfigFiles(root), eventsDb: join(projectStateDir(root), 'events.db') }], ...(opts.instance ? [[`migrations ${opts.instance}`, instanceTargets(join(instancesDir(), opts.instance))] as [string, Targets]] : [])];
  for (const [name, t] of targets) {
    const plan = planMigrations(t);
    const manual = plan.pending.filter((p) => !p.auto);
    const lines = [...plan.newer, ...plan.pending.map((p) => `${p.path}: ${p.kind} version ${p.from} -> ${p.to}${p.auto ? ' (applied at the next start)' : ''}: ${p.steps.join('; ')}`)];
    if (plan.newer.length) add(name, 'fail', `${lines.join('\n')}\nnewer than this engine: update the engine, or restore the backup made before the migration`);
    else if (manual.length) add(name, 'fail', `${lines.join('\n')}\nthe coordinator won't start until you run \`${BRAND.cli} migrate${name === 'migrations' ? '' : ` --instance ${opts.instance}`}\` (it backs each file up first)`);
    else add(name, 'ok', lines.length ? lines.join('\n') : 'config and state at the current versions');
  }

  // A repo config may only tighten the policy of the instance that runs it; the coordinator refuses to start otherwise.
  if (cfg) {
    const repo = cfg.project.project.repo;
    const policies = [...(opts.policy ? [{ name: opts.policy, ...readPolicy(resolve(opts.policy)) }] : []), ...policiesForRepo(repo)];
    if (!policies.length) add('policy', 'ok', `no instance on this machine runs ${repo}; to check against one, pass --policy <its policy.yaml>`);
    for (const p of policies) {
      const errs = p.policy ? policyViolations(cfg, p.policy) : p.errors;
      const what = p.policy ? 'within the policy' : 'policy unreadable';
      if (!errs.length) add(`policy ${p.name}`, 'ok', what);
      else add(`policy ${p.name}`, 'fail', errs.map((e) => `${e.file}${e.path ? ` at ${e.path}` : ''}: ${e.message}`).join('\n'));
    }
  }

  // The disk floor (src/governor-holds.ts): under it, or under it after one more worktree, the coordinator starts
  // nothing, so doctor says so with the same numbers and fix the Board's banner gives.
  if (cfg) {
    try {
      const c = diskFloorCheck((opts.disk ?? diskFree)(root), cfg.project.governor, cfg.tests.worktree.est_size_gb);
      add('disk floor', c.level, c.detail);
    } catch (e) {
      add('disk floor', 'warn', `can't measure the free disk at ${root}: ${(e as Error).message}`);
    }
  }

  // #763: money paths are globs only; a money-list line with no glob form holds every PR until it is rewritten.
  if (cfg?.review?.money_path_source) {
    const money = moneyListCheck(root, cfg.review.money_path_source, `origin/${cfg.project.project.default_branch}`);
    add('money paths', money.level, money.detail);
  }

  const os = detectOs(cfg?.project.os ?? 'auto');
  if (canRunAgents(os)) add('os', 'ok', os);
  else add('os', 'warn', wslAvailable() ? 'native Windows: run agents inside WSL2' : 'native Windows without WSL2: dashboard and Issues only; agents run on another machine');

  // Hook wiring. An instance's agents get their hooks and rules from its agent settings, for agent runs only
  // (agent-settings.ts). The checkout's .claude/settings.json is for local runs without an instance, and is where
  // instances installed before agent settings still find them.
  const instances = [...new Set([...(opts.instance ? [opts.instance] : []), ...(cfg ? policiesForRepo(cfg.project.project.repo).map((p) => p.name) : [])])];
  for (const name of instances) {
    // WHY: the coordinator turns intake off on a broken intake.yaml with one log line; here it is a failing check.
    const intake = checkIntakeFile(join(instancesDir(), name, INTAKE_FILE));
    if (intake.state === 'off') add(`intake ${name}`, 'ok', `no ${INTAKE_FILE} in the instance home: intake is off`);
    else if (intake.state === 'invalid') add(`intake ${name}`, 'fail', `${intake.file} is invalid, so intake is off until it is fixed (\`${BRAND.cli} intake check --instance ${name}\` checks an edit):\n${intake.errors.join('\n')}`);
    else add(`intake ${name}`, intake.warnings.length ? 'warn' : 'ok', [`${INTAKE_FILE} valid: ${intake.summary.join('; ')}`, ...intake.warnings].join('\n'));
    const userns = usernsCheck(name);
    if (userns) out.push(userns);
    // An API-key instance: its key file is the agent user's alone.
    try {
      const inst = loadInstance(name);
      if (inst.credentials.agent_api_key) {
        const k = apiKeyCheck(inst.credentials.agent_api_key, inst.runAs?.user ?? null);
        add(`api key ${name}`, k.level, k.detail);
      }
    } catch {
      // an instance this user can't load is reported by its own checks
    }
    const file = agentSettingsPath(join(instancesDir(), name));
    if (!existsSync(file)) {
      // Hooks in the checkout's own .claude/settings.json (an install from before agent settings) don't count: the
      // runner never falls back to them.
      const old = legacyProjectHooks(root) ? ` The hooks in this checkout's .claude/settings.json are no longer used for agent runs.` : '';
      add(`agent hooks ${name}`, 'fail', `${file} missing: ${name}'s agent runs and its coordinator won't start.${old} As its coordinator user, run \`${installCommand(name, root)}\``);
      continue;
    }
    let s: Settings;
    try {
      s = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    } catch (e) {
      add(`agent hooks ${name}`, 'fail', `${file} unreadable: ${(e as Error).message}`);
      continue;
    }
    for (const c of hookChecks(s)) add(`agent hook ${name} ${c.event}`, c.ok ? 'ok' : 'fail', c.ok ? `${c.detail}, for agent runs only (${file})` : c.detail);
    for (const c of legacyHookChecks(s, name, root)) add(c.name, c.level, c.detail);
    if (s.disableAllHooks !== false) add(`agent hooks ${name}`, 'fail', 'disableAllHooks is not pinned to false: a project file could turn the hooks off');
    const refusal = projectSettingsRefusal(root, s);
    if (refusal) add(`project settings`, 'fail', `${name}'s agent runs won't start: ${refusal}`);
  }
  const settingsPath = join(root, '.claude', 'settings.json');
  const where = instances.length ? ` (for people's sessions and local runs; ${instances.join(', ')}'s agents get theirs from their agent settings)` : '';
  if (!existsSync(settingsPath)) {
    if (instances.length) add('hooks', 'ok', `no .claude/settings.json in the repo, and none needed: ${instances.join(', ')}'s agents get their hooks from their agent settings`);
    else add('hooks', 'warn', `no .claude/settings.json: an instance's agents get their hooks from \`${BRAND.cli} install --instance <name>\` (run by its coordinator); for local runs without an instance, run \`${BRAND.cli} install\``);
  } else {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
      for (const c of hookChecks(s, (p) => p.replace('$CLAUDE_PROJECT_DIR', root))) {
        // Without an instance, these are the hooks local runs rely on; with one, they're only for people's sessions.
        if (!c.ok && c.detail === 'not installed' && instances.length) continue;
        add(`hook ${c.event}`, c.ok ? 'ok' : 'fail', `${c.detail}${where}`);
      }
    } catch (e) {
      add('hooks', 'fail', `.claude/settings.json unreadable: ${(e as Error).message}`);
    }
  }

  if (cfg) {
    const problems = checkGuardrails(cfg.guardrails, root);
    if (problems.length) add('guardrails', 'fail', problems.map((p) => `${p.kind}: ${p.example ?? p.rule}: ${p.message}`).join('\n'));
    else add('guardrails', 'ok', `${cfg.guardrails.rules.length} rules, ${cfg.guardrails.examples.must_block.length + cfg.guardrails.examples.must_ask.length + cfg.guardrails.examples.must_allow.length} examples, no conflicts`);

    const sets = loadFingerprintSets(root);
    for (const name of Object.keys(cfg.guardrails.fingerprints)) {
      if (!sets[name]?.size) add(`fingerprints ${name}`, 'warn', `not fetched; until it is, agents are denied any command containing a DB connection string. Run \`${BRAND.cli} guardrails refresh\``);
      else add(`fingerprints ${name}`, 'ok', `${sets[name].size} stored (hashes only)`);
    }
    if (/your-github-handle|owner\/repo/.test(JSON.stringify(cfg.project))) add('owners', 'warn', 'config.yaml still has template placeholders');
  }

  // Secret scanning
  const gl = findTool('gitleaks');
  if (!gl) add('gitleaks', 'fail', `not on PATH or in ${toolBin()}: commit and transcript scans cannot run`);
  else add('gitleaks', 'ok', execFileSync(gl, ['version'], { encoding: 'utf8' }).trim());
  try {
    const common = gitExecFileSync(['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const hook = join(resolve(root, common), 'hooks', 'pre-commit');
    if (existsSync(hook) && readFileSync(hook, 'utf8').includes(GIT_HOOK_MARKER)) add('pre-commit', 'ok', 'gitleaks pre-commit installed');
    else add('pre-commit', 'warn', `not installed (\`${BRAND.cli} install --git-hooks\`); the land queue still re-scans`);
  } catch {
    add('pre-commit', 'warn', 'not a git repository');
  }

  // Agent runtime
  const claude = findTool('claude');
  if (!claude) add('claude', cfg?.project.agent_runtime.kind === 'cli' ? 'fail' : 'warn', `Claude Code CLI not on PATH or in ${toolBin()}`);
  else {
    const v = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    add('claude', v.status === 0 ? 'ok' : 'warn', (v.stdout || v.stderr || '').trim().split('\n')[0] ?? '');
  }
  // What the removed account profiles, failover and switch left (#736): ignored, named with the step that removes it.
  const accountLeftovers = claudeAccountLeftoverCheck();
  if (accountLeftovers) out.push(accountLeftovers);

  // Lean CLAUDE.md
  const claudeMd = join(root, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const approxTokens = Math.round(readFileSync(claudeMd, 'utf8').length / 4);
    add('CLAUDE.md', approxTokens > CLAUDE_MD_TOKEN_BUDGET ? 'warn' : 'ok', `~${approxTokens} tokens (target <= ${CLAUDE_MD_TOKEN_BUDGET}; move detail into skills and module docs)`);
  }

  // Skills: every SKILL.md has the six sections, none empty.
  try {
    const bad = lintSkills(root);
    const n = trackedSkills(root).length;
    if (bad.length) add('skills', 'fail', skillLintReport(bad));
    else if (n) add('skills', 'ok', `${n} SKILL.md file(s) pass the skill lint`);
  } catch {
    // not a git repository: reported under pre-commit
  }

  out.push(...setupChecks(root, opts));
  const terminal = ownerTerminalCheck();
  if (terminal) out.push(terminal);
  const voiceSiri = voiceSiriLeftoverCheck({ instances });
  if (voiceSiri) out.push(voiceSiri);
  const gpu = gpuCheck();
  if (gpu) out.push(gpu);
  // Only where the project runs its tests on the machine: elsewhere no run has a sandbox to grant from.
  if (cfg?.tests.test_run) out.push(networkCheck());
  if (opts.agentshield) out.push(agentShield(root));
  out.push(...policyRootChecks());
  // #889: each dashboard key this user can read: the local one, each instance's and the hub's (its own user's state dir,
  // or the viewer user's when doctor runs as root): an older key asks for rotation.
  const viewerHome = homeOf(VIEWER_USER);
  const keyDirs: [string, string][] = [['local', projectStateDir(root)], ...instances.map((n): [string, string] => [n, join(instancesDir(), n, 'state')]), ['hub', join(stateDir(), 'dashboard-hub')], ...(viewerHome ? [['hub', join(viewerHome, '.local', 'state', BRAND.cli, 'dashboard-hub')] as [string, string]] : [])];
  const seen = new Set<string>();
  for (const [where, dir] of keyDirs) {
    const file = join(dir, 'dashboard-token');
    if (seen.has(file)) continue;
    seen.add(file);
    const k = dashboardKeyCheck(file, where);
    if (k) out.push(k);
  }
  return out;
}

/**
 * A dashboard key file (#889): a key from before keys had DASHBOARD_KEY_PREFIX still opens the dashboard, but a shape
 * the redactor can't tell from a commit hash or an id, so it may show in a log or a post in clear: rotate it. Null
 * when there is no file or this user can't read it. The key is read and never shown.
 */
export function dashboardKeyCheck(file: string, where: string, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): DoctorCheck | null {
  let key: string;
  try {
    key = read(file).trim();
  } catch {
    return null;
  }
  if (!key) return null;
  const name = `dashboard key ${where}`;
  if (isDashboardKey(key)) return { name, level: 'ok', detail: `${file}: the current key format (${DASHBOARD_KEY_PREFIX}...), redacted wherever it appears` };
  return {
    name,
    level: 'warn',
    detail: `${file} holds a dashboard key in the older format (no ${DASHBOARD_KEY_PREFIX} prefix). It still works, but the redactor can't tell it from a commit hash or an id, so it could show in a log or a post. Rotate it: remove the file and restart what serves that dashboard (the instance's service, or \`${BRAND.cli} dashboard\`); a new key is written, and the page asks for it once. On a server with the hub, then run scripts/setup/dashboards.sh as root so the hub can read the new key.`,
  };
}

/**
 * A failure when the instance's newest sandbox check (its coordinator's `testrun.sandbox` event) said this machine
 * can't give a test run a user namespace of its own (util-linux older than 2.38, or no setpriv), with the fix; else
 * nothing. Read-only: the event log is opened read-only, and one this user can't read (another user's state) or that
 * has no such event says nothing. INVARIANT: shown only. No test run, install or update waits on doctor (its exit code
 * is read by bootstrap.sh alone, after everything is installed, to print what's next), and this reads the same field
 * the Machine page shows (src/testrun/status.ts), which the run gate and the updater never read.
 */
export function usernsCheck(instance: string, eventsDb = join(instancesDir(), instance, 'state', 'events.db')): DoctorCheck | null {
  let payload: string | undefined;
  try {
    if (!existsSync(eventsDb)) return null;
    const db = openReadOnly(eventsDb);
    try {
      payload = (db.prepare("SELECT payload FROM events WHERE type = 'testrun.sandbox' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined)?.payload;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  let why: unknown;
  try {
    why = payload ? (JSON.parse(payload) as { unsupported?: unknown }).unsupported : undefined;
  } catch {
    return null;
  }
  return typeof why === 'string' && why ? { name: `test runs ${instance}`, level: 'fail', detail: usernsUnsupportedProblem(why) } : null;
}

/**
 * The removed owner terminal (#742): nothing while the machine has nothing of it left; a failure (doctor exits 1)
 * while its console shell or a hub unit naming a console user is still there, since its sudoers rule (which only root
 * can see) is then still there too and the hub may run without its sandbox. The rerun that removes them comes first:
 * built exactly from the hub unit's ExecStart, so it keeps the hub's devices, gateways and instances; when the unit
 * can't be read or parsed, the placeholder version, with why and where to fill it in from (never part of a command).
 */
export function ownerTerminalCheck(paths: TerminalPaths = {}): DoctorCheck | null {
  const r = ownerTerminalRerun(paths);
  // With the exact command, the notice points at it: one command to run, never a second, placeholder one.
  const notice = ownerTerminalNotice(paths, 'command' in r);
  if (!notice) return null;
  const first = 'command' in r ? `run as root, once (built from the hub unit's ExecStart): ${r.command}` : `run as root, once, with each <...> and [...] filled in from the ExecStart of ${HUB_UNIT_AS_ROOT} (the exact command can't be built here: ${r.error}): ${OWNER_TERMINAL_RERUN}`;
  return { name: 'owner terminal', level: 'fail', detail: `${first}\n${notice}` };
}

/**
 * GPU test runs (docs/test-runs.md "GPU"): nothing while root's file is absent (off). On for some instance but a node
 * its runs need is missing (the driver not loaded, a GPU index that isn't there): a warning, since each of those runs
 * then runs without the GPU. A file the helper would refuse: a warning too, saying so.
 */
export function gpuCheck(file = gpuFilePath(), present: (path: string) => boolean = (p) => existsSync(p), rootUid = 0, nodes: (indices: number[]) => string[] = (i) => nvidiaNodes(i)): DoctorCheck | null {
  const f = readGpuFile(file, rootUid);
  if ('state' in f) {
    if (f.state === 'off' && f.why.startsWith('GPU test runs are off')) return null;
    return { name: 'gpu test runs', level: 'warn', detail: `${f.why}; fix it with ${gpuCommands('<name>').status} (and enable/disable)` };
  }
  const names = Object.keys(f.instances);
  if (!names.length) return null;
  const need = nodes(gpuIndices(f));
  const missing = need.filter((n) => !present(n));
  const on = `on for ${names.join(', ')} (GPU ${gpuIndices(f).join(', ')}; at most ${f.maxMinutes} min a GPU command)`;
  if (missing.length) return { name: 'gpu test runs', level: 'warn', detail: `${on}, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing: those runs run without the GPU until ${missing.length === 1 ? 'it exists' : 'they exist'} (the NVIDIA driver loaded, the GPU present)` };
  return { name: 'gpu test runs', level: 'ok', detail: on };
}

/**
 * Network for test runs (docs/test-runs.md "Network"), read-only: no tier has it unless root's file lists it. Which
 * instances' tiers do, with the root command that changes it; a file the helper would refuse is a warning.
 */
export function networkCheck(file = networkFilePath(), rootUid = 0): DoctorCheck {
  const how = `root changes it: ${networkCommands('<name>').enable} (or disable; status shows it)`;
  let text: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o777) !== 0o644) return { name: 'test-run network', level: 'warn', detail: `${file} is not root's regular 0644 file, so the helper grants no network; ${how}` };
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { name: 'test-run network', level: 'ok', detail: `none for any tier (no ${NETWORK_FILE_NAME}); ${how}` };
    return { name: 'test-run network', level: 'warn', detail: `${file} can't be read: ${(e as Error).message}` };
  }
  const f = parseNetworkFile(text);
  if ('error' in f) return { name: 'test-run network', level: 'warn', detail: `${file} is ${f.error}, so the helper grants no network; ${how}` };
  const on = Object.entries(f.instances).map(([n, t]) => `${n}: ${t.join(', ')}`);
  return { name: 'test-run network', level: 'ok', detail: `${on.length ? `granted to ${on.join('; ')}` : 'none for any tier'} (every other tier has none); ${how}` };
}

/**
 * The setup steps (src/setup-steps.ts), as doctor shows them: every step that applies to the mode, checked live, the
 * same checks and the same done or not done as the dashboard's first-run page. Then what the mode can't do, each
 * with why. When init was never run and no mode is given, one line saying how to get the checklist.
 */
export function setupChecks(root: string, opts: { instance?: string; mode?: Mode; initIo?: InitIo; probe?: SetupProbe; context?: Partial<Pick<SetupContext, 'machine' | 'instanceFacts'>> }): DoctorCheck[] {
  const file = opts.instance && opts.mode === 'server' ? serverInitFile(opts.instance) : localInitFile(root);
  // A record this user can't read is said plainly, never shown as every step "not reached yet".
  const unreadable = initStateUnreadable(file);
  if (unreadable) return [{ name: 'setup', level: 'fail', detail: `${unreadable}: init writes it readable by the instance's coordinator group; run \`sudo ${BRAND.cli} init --mode server <owner/repo> --instance ${opts.instance ?? '<name>'}\` again with this engine to fix its access` }];
  const state = readInitState(file);
  const mode = opts.mode ?? state?.mode;
  if (!mode) return [{ name: 'setup', level: 'warn', detail: `no guided setup recorded for this checkout: \`${BRAND.cli} init --mode local|server\` walks the checklist (tools, Claude login, GitHub, repo config, protection)` }];
  // #738: the manager's reading comes from initIo too, never from the real probe behind a stand-in io.
  const probe: SetupProbe = opts.probe ?? { ...systemProbe(), ...(opts.initIo ? { which: opts.initIo.which, run: opts.initIo.run, serviceManagerEnv: opts.initIo.serviceManagerEnv } : {}) };
  const s = state?.mode === mode ? state : null;
  // A server instance's own clone, state and policy; a checkout's own state.
  let site = { root, stateDir: projectStateDir(root), policyFile: null as string | null };
  const instance = opts.instance ?? s?.instance ?? null;
  if (mode === 'server' && instance) {
    try {
      const i = loadInstance(instance);
      site = { root: i.repo.path, stateDir: i.stateDir, policyFile: join(i.home, 'policy.yaml') };
    } catch {
      // its steps say it can't be read
    }
  }
  const ctx = { ...setupContext(s, { mode, ...site, repo: s?.repo ?? (mode === 'local' ? localRepo(root) : null), instance }), ...opts.context };
  const view = checkSetup(ctx, probe);
  // init's walked groups first, one line each (what init stops at, with what it found), then every step's own line.
  // A walked group with no step in this mode (Discord in local mode) still has its line, as init walks it.
  const out: DoctorCheck[] = GROUPS.filter((d) => d.walked && d.modes.includes(mode)).map((d) => {
    const g = view.groups.find((x) => x.id === d.id) ?? { id: d.id, title: d.title, optional: d.optional, done: true, ready: true, steps: [] };
    const need = g.steps.filter((x) => x.walk);
    const missing = need.find((x) => !x.done);
    const said = missing ? missing.detail : need.length ? need.map((x) => x.detail).join('; ') : g.steps.length ? `${g.steps.filter((x) => x.done).length} of ${g.steps.length} steps done, none needed to run` : `nothing to set up in ${mode} mode`;
    return { name: `setup ${g.id}`, level: groupLevel(g), detail: `${g.title} (${mode} mode): ${said}${missing && !g.optional ? `; \`${BRAND.cli} init\` picks up here` : ''}` };
  });
  for (const g of view.groups)
    for (const i of g.steps) out.push({ name: `setup step ${i.id}`, level: stepLevel(i), detail: `${i.title} (${mode} mode): ${i.detail}${i.done ? '' : `; today: ${i.today}`}` });
  const noRecord = agentRecordWarning(ctx);
  if (noRecord) out.push({ name: 'setup claude-account record', level: 'warn', detail: noRecord });
  for (const u of unavailableIn(mode, (c) => probe.which(c) !== null)) out.push({ name: `not in ${mode} mode: ${u.feature}`, level: 'off', detail: u.why });
  return out;
}

/** AgentShield scan of hooks, MCP config and permissions (MIT, run via npx). */
export function agentShield(root: string): DoctorCheck {
  const r = spawnSync('npx', ['-y', 'ecc-agentshield@1.6.0', 'scan', '--path', join(root, '.claude'), '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    shell: shimsNeedShell,
  });
  if (r.error || (r.status !== 0 && !r.stdout)) return { name: 'agentshield', level: 'fail', detail: `could not run: ${r.error?.message ?? r.stderr.trim().split('\n').pop()}` };
  try {
    const report = JSON.parse(r.stdout) as { findings?: { severity?: string; title?: string; rule?: string }[]; score?: { grade?: string } };
    const findings = report.findings ?? [];
    const serious = findings.filter((f) => ['critical', 'high'].includes((f.severity ?? '').toLowerCase()));
    const grade = report.score?.grade ? ` grade ${report.score.grade}` : '';
    if (serious.length) return { name: 'agentshield', level: 'fail', detail: `${serious.length} critical/high finding(s)${grade}:\n` + serious.map((f) => `  ${f.severity}: ${f.title ?? f.rule}`).join('\n') };
    return { name: 'agentshield', level: findings.length ? 'warn' : 'ok', detail: `${findings.length} finding(s), none critical/high${grade}` };
  } catch {
    return { name: 'agentshield', level: 'fail', detail: 'unexpected output (not JSON)' };
  }
}
