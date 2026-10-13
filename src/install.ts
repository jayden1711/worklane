// `install`: scaffold the config folder, write the guardrail hooks and
// permission rules, and optionally add a gitleaks pre-commit hook.
// With --instance, the hooks and rules go to the instance's agent settings
// (see agent-settings.ts): they apply to its agent runs only, and the repo
// needs no .claude/settings.json. Without, they're merged into the
// checkout's .claude/settings.json (keeping the project's own entries), for
// local runs without an instance. Re-running is safe: our entries are
// recognized by a marker and replaced, never duplicated.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSettingsPath, HOOK_MARKER, type HookEntry, type Settings } from './agent-settings.js';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { instancesDir, policiesForRepo } from './instance.js';
import { writeOwnerOnly } from './os/index.js';
import { installPrePushHook } from './push-guard.js';

export { HOOK_MARKER };
export const GIT_HOOK_MARKER = `# managed by ${BRAND.cli}`;

/** The engine's packaged templates directory. */
export function templatesDir(): string {
  return fileURLToPath(new URL('../../templates/project/', import.meta.url));
}

/** What a human session is told when the engine the hooks point at is missing. */
export function missingEngineWarning(enginePath: string): string {
  const fix = enginePath.startsWith('$CLAUDE_PROJECT_DIR/node_modules/') ? 'run npm install to enable them' : `install the ${BRAND.cli} engine on this machine to enable them`;
  return `${BRAND.name} guardrails are off in this checkout: ${fix}.`;
}

/**
 * Hook command (POSIX sh; Claude Code runs hooks through bash on every OS).
 * A crashing engine always blocks (`|| exit 2`). A missing engine blocks
 * agent sessions; a human session gets a one-line warning at session start
 * and is otherwise unaffected.
 */
export function hookCommand(enginePath: string, event: string): string {
  // The post-edit check only gives feedback: a missing engine or a crash must stay silent, never exit 2.
  if (event === 'post-tool-use') return `E="${enginePath}"; if [ -f "$E" ]; then ${HOOK_MARKER} node "$E" hook post-tool-use || true; else :; fi`;
  const agentVar = `$${BRAND.envPrefix}_AGENT`;
  const run = `${HOOK_MARKER} node "$E" hook ${event} || exit 2`;
  const human =
    event === 'session-start'
      ? `echo '{"systemMessage": "${missingEngineWarning(enginePath)}", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "${missingEngineWarning(enginePath)} Mention this to the user once."}}'`
      : ':';
  return `E="${enginePath}"; if [ -f "$E" ]; then ${run}; elif [ "${agentVar}" = 1 ]; then echo "${BRAND.cli}: engine missing at $E, agent sessions are blocked" >&2; exit 2; else ${human}; fi`;
}

/** Engine entry as Claude Code should call it: relative to $CLAUDE_PROJECT_DIR when inside the project. */
export function engineRef(root: string, engineCli: string): string {
  const rel = relative(root, engineCli);
  return !rel.startsWith('..') && !isAbsolute(rel) ? `$CLAUDE_PROJECT_DIR/${rel.split('\\').join('/')}` : engineCli;
}

export function mergeSettings(existing: Settings, enginePath: string, preApproved: string[], domains: string[], secretPaths: string[] = []): Settings {
  const s: Settings = structuredClone(existing);
  const hooks = { ...(s.hooks ?? {}) };
  const ours: Record<string, HookEntry> = {
    PreToolUse: { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCommand(enginePath, 'pre-tool-use'), timeout: 30 }] },
    SessionStart: { hooks: [{ type: 'command', command: hookCommand(enginePath, 'session-start'), timeout: 30 }] },
    SessionEnd: { hooks: [{ type: 'command', command: hookCommand(enginePath, 'session-end'), timeout: 300 }] },
    // The post-edit check: feedback only, so it never fails the edit (see hookCommand).
    PostToolUse: { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCommand(enginePath, 'post-tool-use'), timeout: 30 }] },
  };
  for (const [event, entry] of Object.entries(ours)) {
    const kept = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => h.command.includes(HOOK_MARKER)));
    hooks[event] = [...kept, entry];
  }
  s.hooks = hooks;
  const allow = new Set(s.permissions?.allow ?? []);
  for (const p of preApproved) allow.add(p);
  for (const d of domains) allow.add(`WebFetch(domain:${d})`);
  const deny = new Set(s.permissions?.deny ?? []);
  for (const p of secretPaths) deny.add(`Read(${p})`);
  s.permissions = { ...(s.permissions ?? {}), allow: [...allow], ...(deny.size ? { deny: [...deny] } : {}) };
  return s;
}

function readJson(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Settings;
}

function gitRemoteRepo(root: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    return url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The engine as installed in the project's node_modules, if present. Preferred
 * over the running engine's own path, which Node resolves through symlinks
 * (npm link, workspaces) to a machine-specific location.
 */
export function projectLocalEngine(root: string): string | null {
  const p = join(root, 'node_modules', ...BRAND.pkg.split('/'), 'dist', 'src', 'cli.js');
  return existsSync(p) ? p : null;
}

/**
 * When an instance on this machine runs the repo, start its scaffolded config
 * within that instance's policy (budget, worker counts), not at the template's
 * defaults, which the coordinator would refuse.
 */
function scaffoldWithinPolicies(cfgDir: string, repo: string): string[] {
  const policies = policiesForRepo(repo).flatMap((p) => (p.policy ? [p.policy] : []));
  if (!policies.length) return [];
  const budget = Math.min(...policies.map((p) => p.budget.daily_usd));
  const workers = Math.min(...policies.map((p) => p.agents.max_workers));
  const file = join(cfgDir, 'agents.yaml');
  const text = readFileSync(file, 'utf8')
    .replace(/^(daily_budget_usd:\s*)(\d+(?:\.\d+)?)/m, (_m, k: string, v: string) => `${k}${Math.min(Number(v), budget)}`)
    .replace(/^(\s*workers:.*?\bcount:\s*)(\d+)/m, (_m, k: string, v: string) => `${k}${Math.min(Number(v), workers)}`)
    .replace(/^(\s*workers:.*?\bmax:\s*)(\d+)/m, (_m, k: string, v: string) => `${k}${Math.min(Number(v), workers)}`);
  writeFileSync(file, text);
  return [`agents.yaml starts within this machine's instance policy for ${repo} (budget $${budget}/day, at most ${workers} workers)`];
}

export interface InstallOptions {
  root: string;
  /** Path to the engine's cli.js (defaults to this running engine). */
  engineCli?: string;
  gitHooks?: boolean;
  /**
   * The instance whose agents run this checkout: the hooks and rules go to its agent settings (in its home, which
   * only the coordinator user can read), never into the checkout.
   */
  instance?: string;
}

export interface InstallReport {
  scaffolded: boolean;
  settingsPath: string;
  gitHook?: string;
  /** The pre-push hook that refuses a push to the default branch. */
  prePushHook?: string;
  notes: string[];
}

/**
 * The engine as it was invoked, following one link only: a machine-wide command (/usr/local/bin/<cli> -> a stable
 * /opt/<cli>/current/... path) stays on the stable path, not the versioned release Node resolves it to, which an
 * engine update removes.
 */
export function invokedEngine(argv1 = process.argv[1]): string | undefined {
  if (!argv1) return undefined;
  try {
    return resolve(dirname(argv1), readlinkSync(argv1));
  } catch {
    return resolve(argv1);
  }
}

/** The hooks and rules for an instance's agent runs: our entries only, with every hook kept on. */
export function agentSettings(enginePath: string, preApproved: string[], domains: string[], secretPaths: string[]): Settings {
  return { disableAllHooks: false, ...mergeSettings({}, enginePath, preApproved, domains, secretPaths) };
}

export function install(opts: InstallOptions): InstallReport {
  const root = resolve(opts.root);
  const notes: string[] = [];
  const cfgDir = join(root, BRAND.configDir);
  // An instance's home must exist before anything is written for it.
  const instanceHome = opts.instance ? join(instancesDir(), opts.instance) : null;
  if (instanceHome && !existsSync(instanceHome)) throw new Error(`no instance "${opts.instance}" at ${instanceHome}; run \`${BRAND.cli} instance init\` first`);
  let scaffolded = false;
  if (!existsSync(cfgDir)) {
    cpSync(templatesDir(), cfgDir, { recursive: true });
    const config = join(cfgDir, 'config.yaml');
    const repo = gitRemoteRepo(root) ?? 'owner/repo';
    writeFileSync(config, readFileSync(config, 'utf8').replaceAll('{{name}}', basename(root)).replaceAll('{{repo}}', repo));
    notes.push(...scaffoldWithinPolicies(cfgDir, repo));
    scaffolded = true;
    notes.push(`created ${BRAND.configDir}/ from templates; edit owners, guardrails and tests, then run \`${BRAND.cli} doctor\``);
  }
  // Settings are generated from valid config only; a broken config fails here, loudly.
  const cfg = loadConfig(root);
  const running = fileURLToPath(new URL('./cli.js', import.meta.url));
  let settingsPath: string;
  if (instanceHome) {
    // Agent runs only. Never the checkout's node_modules engine: agents can write the checkout. An absolute path,
    // owner-only file in the coordinator's instance home: the agent user can neither read nor change it.
    const engineCli = resolve(opts.engineCli ?? running);
    settingsPath = agentSettingsPath(instanceHome);
    writeOwnerOnly(settingsPath, JSON.stringify(agentSettings(engineCli, cfg.guardrails.pre_approved, cfg.guardrails.network.allow, cfg.guardrails.credential_stores), null, 2) + '\n');
    if (existsSync(join(root, '.claude', 'settings.json'))) notes.push(`agents no longer get their hooks from this checkout's .claude/settings.json but from ${settingsPath}; the repo can drop that file`);
  } else {
    const engineCli = resolve(opts.engineCli ?? projectLocalEngine(root) ?? running);
    settingsPath = join(root, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    const merged = mergeSettings(readJson(settingsPath), engineRef(root, engineCli), cfg.guardrails.pre_approved, cfg.guardrails.network.allow, cfg.guardrails.credential_stores);
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  }
  const report: InstallReport = { scaffolded, settingsPath, notes };
  if (opts.gitHooks) {
    report.gitHook = installGitHook(root);
    // land_mode direct lands by pushing the default branch: there the hook would refuse the landing itself.
    if (cfg.project.land_mode === 'direct') notes.push('no pre-push hook: land_mode direct lands by pushing the default branch');
    else report.prePushHook = installCheckoutPrePush(root, [cfg.project.project.default_branch], resolve(opts.engineCli ?? running));
  } else notes.push('git pre-commit secret scan not installed (pass --git-hooks); it applies to every worktree of the repo');
  return report;
}

/**
 * The pre-push hook in the repo's common hooks dir (every worktree's), refusing any push to the default branch:
 * `branches` (the config's, when there is one) and whatever origin/HEAD names at push time.
 */
export function installCheckoutPrePush(root: string, branches: string[], engineCli?: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  return installPrePushHook(join(resolve(root, common), 'hooks'), { branches, node: process.execPath, ...(engineCli ? { engine: engineCli } : {}) });
}

/** gitleaks pre-commit hook in the repo's common hooks dir, chaining any existing hook. */
export function installGitHook(root: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const hooksDir = join(resolve(root, common), 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-commit');
  const chained = join(hooksDir, `pre-commit.before-${BRAND.cli}`);
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(GIT_HOOK_MARKER)) renameSync(hook, chained);
  writeFileSync(
    hook,
    `#!/bin/sh
${GIT_HOOK_MARKER}: secret scan on every commit. Missing gitleaks fails the commit.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "${BRAND.cli}: gitleaks not found; install it to commit (secret scanning is required)" >&2
  exit 1
fi
gitleaks git --pre-commit --staged --redact --no-banner || exit 1
if [ -x "${chained}" ]; then exec "${chained}" "$@"; fi
`,
  );
  chmodSync(hook, 0o755);
  return hook;
}
