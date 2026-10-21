// `install`: scaffold the config folder, write the guardrail hooks and
// permission rules, and optionally add a gitleaks pre-commit hook.
// With --instance, the hooks and rules go to the instance's agent settings
// (see agent-settings.ts): they apply to its agent runs only, and the repo
// needs no .claude/settings.json. Without, they're merged into the
// checkout's .claude/settings.json (keeping the project's own entries), for
// local runs without an instance. Re-running is safe: our entries are
// recognized by a marker and replaced, never duplicated.
import { execFileSync } from './os/child-process.js';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSettingsPath, GUARD_ON_FAILURE, HOOK_MARKER, installCommand, type HookEntry, type Settings } from './agent-settings.js';
import { BRAND } from './brand.js';
import { loadConfig, type Config } from './config/load.js';
import { instancesDir, policiesForRepo } from './instance.js';
import { githubRepoOf } from './managed-apps.js';
import { stableNodePath, writeOwnerOnly } from './os/index.js';
import { toolBin } from './tool-path.js';
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

/** The hook commands' entry: the guard's own (src/hook-main.ts), beside the engine's cli.js, the path install is given. */
export const HOOK_ENTRY = 'hook-main.js';

/** The guard's own entry beside an engine's cli.js (either separator, or $CLAUDE_PROJECT_DIR/...); anything else throws. */
export function hookEntry(engineCli: string): string {
  if (!/(^|[/\\])cli\.js$/.test(engineCli)) throw new Error(`the engine path for the hooks must be the engine's dist/src/cli.js, not ${engineCli}`);
  return engineCli.slice(0, -'cli.js'.length) + HOOK_ENTRY;
}

/**
 * Hook command (POSIX sh; Claude Code runs hooks through bash on every OS).
 * A crashing engine always blocks (`|| exit 2`). A missing engine blocks
 * agent sessions; a human session gets a one-line warning at session start
 * and is otherwise unaffected.
 */
export function hookCommand(engineCli: string, event: string): string {
  // WHY (#665): the guard's own entry, not the CLI: the process that decides a tool call loads only the guard's
  // locked import tree. `E` is that file, so a check that the engine is present checks the file that runs.
  const enginePath = hookEntry(engineCli);
  // The post-edit check only gives feedback: a missing engine or a crash must stay silent, never exit 2.
  if (event === 'post-tool-use') return `E="${enginePath}"; if [ -f "$E" ]; then ${HOOK_MARKER} node "$E" post-tool-use || true; else :; fi`;
  const agentVar = `$${BRAND.envPrefix}_AGENT`;
  const run = `${HOOK_MARKER} node "$E" ${event} || exit 2`;
  const human =
    event === 'session-start'
      ? `echo '{"systemMessage": "${missingEngineWarning(enginePath)}", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "${missingEngineWarning(enginePath)} Mention this to the user once."}}'`
      : ':';
  return `E="${enginePath}"; if [ -f "$E" ]; then ${run}; elif [ "${agentVar}" = 1 ]; then echo "${BRAND.cli}: engine missing at $E, agent sessions are blocked" >&2; exit 2; else ${human}; fi`;
}

/**
 * A hook command install wrote before #665 (the CLI's `hook <event>`), as the guard's own entry would run it: the
 * engine file and the event, and the command with only those two parts changed. Null when it isn't in that form.
 */
function forwardOfCliHook(command: string, engine: string): { event: string; moved: string } | null {
  // The old run step, read here and never written: node on $E, the CLI's `hook` command, the event; exactly once.
  const run = /( node "\$E") hook (pre-tool-use|session-start|session-end|post-tool-use) \|\|/g;
  const runs = [...command.matchAll(run)];
  if (runs.length !== 1 || !command.startsWith(`E="${engine}"; `)) return null;
  const moved = `E="${hookEntry(engine)}"; ${command.slice(`E="${engine}"; `.length)}`.replace(run, '$1 $2 ||');
  return { event: runs[0]![2]!, moved };
}

/** Our hook commands in settings, each with the engine file it runs (its `E="..."`). */
const ourHooks = (s: Settings) =>
  Object.values(s.hooks ?? {})
    .flat()
    .flatMap((e) => e?.hooks ?? [])
    .filter((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER))
    .map((h) => ({ h, engine: h.command.match(/E="([^"]+)"/)?.[1] ?? '' }));

/**
 * The hook events in these settings whose guard still runs through the CLI (`cli.js hook <event>`, an install before
 * #665) rather than its own entry (src/hook-main.ts): the CLI isn't locked as the guard is, and loads far more.
 */
export function legacyHookEvents(s: Settings): string[] {
  return ourHooks(s)
    .filter(({ engine }) => /(^|[/\\])cli\.js$/.test(engine))
    .map(({ h, engine }) => forwardOfCliHook(h.command, engine)?.event ?? 'a hook not in the form install wrote');
}

/** Doctor's line for an instance's agent settings still on the CLI's `hook` (none when there are none). */
export function legacyHookChecks(s: Settings, instance: string, checkout: string): { name: string; level: 'warn'; detail: string }[] {
  const events = legacyHookEvents(s);
  if (!events.length) return [];
  return [
    {
      name: `agent hooks ${instance}`,
      level: 'warn',
      detail: `${events.join(', ')}: the guard runs through the CLI (\`cli.js hook\`, an install from before the guard had its own entry), which isn't locked as the guard is. As its coordinator user, run \`${BRAND.cli} migrate --instance ${instance}\` (the engine updater does this at each install) or \`${installCommand(instance, checkout)}\``,
    },
  ];
}

/**
 * An instance's agent settings, moved from the CLI's `hook <event>` to the guard's own entry (#747): each hook command
 * that install wrote before #665 becomes what install writes now (hookCommand) for the same engine, and nothing else in
 * the file changes. "Wrote before #665" is exact: moving its engine file and its run step to the guard's own entry
 * (forwardOfCliHook) must give hookCommand's text, character for character, so a command changed by hand stays. A
 * command is moved only when the guard's own entry is there beside its cli.js, so a hook never comes to name a file
 * that isn't there. The file is backed up first, beside it (0600, as install writes it).
 * WHY never throws: the engine updater runs this through `migrate`, and a settings file it can't move must not hold an
 * engine update (it never did before); `left` says why, and doctor keeps saying so.
 * INVARIANT: only an exact match moves, to the same checks with the same fail-closed exits; the guard is the same
 * function (hookProcess) either way. No hook is added, dropped or loosened.
 */
export function migrateLegacyHooks(file: string, now = new Date()): { events: string[]; backup: string | null; left: string[] } {
  const none = (left: string[] = []) => ({ events: [], backup: null, left });
  if (!existsSync(file)) return none();
  let text: string;
  let s: Settings;
  try {
    text = readFileSync(file, 'utf8');
    s = JSON.parse(text) as Settings;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return none([`${file}: not a JSON object`]);
  } catch (e) {
    return none([`${file}: ${(e as Error).message}`]);
  }
  const events: string[] = [];
  const left: string[] = [];
  try {
    for (const { h, engine } of ourHooks(s)) {
      if (!/(^|[/\\])cli\.js$/.test(engine)) continue;
      const f = forwardOfCliHook(h.command, engine);
      const target = f ? hookCommand(engine, f.event) : null;
      if (!f || !target || f.moved !== target) {
        left.push(`${file}: a hook command that runs ${engine} isn't one install wrote; re-run install`);
        continue;
      }
      if (!isAbsolute(engine) || !existsSync(hookEntry(engine))) {
        left.push(`${file}: ${f.event}: no ${HOOK_ENTRY} beside ${engine} yet`);
        continue;
      }
      h.command = target;
      events.push(f.event);
    }
  } catch (e) {
    return none([...left, `${file}: ${(e as Error).message}; unchanged`]);
  }
  if (!events.length) return none(left);
  const backup = `${file}.bak-hooks-${now.toISOString().replace(/[:.]/g, '-')}`;
  try {
    writeOwnerOnly(backup, text);
    writeOwnerOnly(file, JSON.stringify(s, null, 2) + '\n');
  } catch (e) {
    return none([...left, `${file}: couldn't be rewritten (${(e as Error).message}); unchanged`]);
  }
  return { events, backup, left };
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
    // onFailure "block": a guard that times out, can't start or crashes blocks the call (src/agent-settings.ts GUARD_ON_FAILURE).
    PreToolUse: { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCommand(enginePath, 'pre-tool-use'), timeout: 30, onFailure: GUARD_ON_FAILURE }] },
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

export function gitRemoteRepo(root: string): string | null {
  try {
    // WHY trim: git ends its answer with a newline; the shared parser (src/managed-apps.ts) takes a URL as given.
    return githubRepoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim());
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

/**
 * The config folder from the templates, at `cfgDir`: the project's name and repo filled in, and, when given, its
 * owner (else the template's placeholder stays, for the person to set) and default branch.
 */
export function scaffoldConfig(cfgDir: string, o: { name: string; repo: string; owner?: string; defaultBranch?: string }): void {
  cpSync(templatesDir(), cfgDir, { recursive: true });
  const config = join(cfgDir, 'config.yaml');
  let text = readFileSync(config, 'utf8').replaceAll('{{name}}', o.name).replaceAll('{{repo}}', o.repo);
  if (o.owner) text = text.replaceAll('your-github-handle', o.owner);
  if (o.defaultBranch) text = text.replace(/^( {2}default_branch: )\S+/m, `$1${o.defaultBranch}`);
  writeFileSync(config, text);
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
    const repo = gitRemoteRepo(root) ?? 'owner/repo';
    scaffoldConfig(cfgDir, { name: basename(root), repo });
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
    const h = installGitHooks(root, cfg, resolve(opts.engineCli ?? running));
    report.gitHook = h.gitHook;
    if (h.prePushHook) report.prePushHook = h.prePushHook;
    notes.push(...h.notes);
  } else notes.push('git pre-commit secret scan not installed (pass --git-hooks); it applies to every worktree of the repo');
  return report;
}

/** WHY: `install --git-hooks` and the first-run page's Fix install the same hooks, from one place. */
export function installGitHooks(root: string, cfg: Config, engineCli = fileURLToPath(new URL('./cli.js', import.meta.url))): { gitHook: string; prePushHook?: string; notes: string[] } {
  const gitHook = installGitHook(root);
  // land_mode direct lands by pushing the default branch: there the hook would refuse the landing itself.
  if (cfg.project.land_mode === 'direct') return { gitHook, notes: ['no pre-push hook: land_mode direct lands by pushing the default branch'] };
  return { gitHook, prePushHook: installCheckoutPrePush(root, [cfg.project.project.default_branch], engineCli), notes: [] };
}

/**
 * The pre-push hook in the repo's common hooks dir (every worktree's), refusing any push to the default branch:
 * `branches` (the config's, when there is one) and whatever origin/HEAD names at push time.
 */
export function installCheckoutPrePush(root: string, branches: string[], engineCli?: string, node: string = stableNodePath().path): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  // WHY (#468): the checkout's hook runs node by Homebrew's stable bin/node (or this node's own path), as the service does.
  return installPrePushHook(join(resolve(root, common), 'hooks'), { branches, node, ...(engineCli ? { engine: engineCli } : {}) });
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
# Where ${BRAND.cli} init installs tools, for a commit made without it on PATH.
PATH="$PATH":'${toolBin().replaceAll("'", "'\\''")}'
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
