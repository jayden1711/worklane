// `install`: scaffold the config folder, merge hooks and permissions into
// .claude/settings.json (keeping the project's own entries), and optionally
// add a gitleaks pre-commit hook. Re-running is safe: our entries are
// recognized by a marker and replaced, never duplicated.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';

/** Leading env assignment that marks our hook commands (the shell ignores it otherwise). */
export const HOOK_MARKER = `${BRAND.envPrefix}_HOOK=1`;
export const GIT_HOOK_MARKER = `# managed by ${BRAND.cli}`;

/** The engine's packaged templates directory. */
export function templatesDir(): string {
  return fileURLToPath(new URL('../../templates/project/', import.meta.url));
}

export const MISSING_ENGINE_WARNING = `${BRAND.name} guardrails are off in this checkout: run npm install to enable them.`;

/**
 * Hook command (POSIX sh; Claude Code runs hooks through bash on every OS).
 * A crashing engine always blocks (`|| exit 2`). A missing engine blocks
 * agent sessions; a human session gets a one-line warning at session start
 * and is otherwise unaffected.
 */
export function hookCommand(enginePath: string, event: string): string {
  const agentVar = `$${BRAND.envPrefix}_AGENT`;
  const run = `${HOOK_MARKER} node "$E" hook ${event} || exit 2`;
  const human =
    event === 'session-start'
      ? `echo '{"systemMessage": "${MISSING_ENGINE_WARNING}", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "${MISSING_ENGINE_WARNING} Mention this to the user once."}}'`
      : ':';
  return `E="${enginePath}"; if [ -f "$E" ]; then ${run}; elif [ "${agentVar}" = 1 ]; then echo "${BRAND.cli}: engine missing at $E, agent sessions are blocked" >&2; exit 2; else ${human}; fi`;
}

/** Engine entry as Claude Code should call it: relative to $CLAUDE_PROJECT_DIR when inside the project. */
export function engineRef(root: string, engineCli: string): string {
  const rel = relative(root, engineCli);
  return !rel.startsWith('..') && !isAbsolute(rel) ? `$CLAUDE_PROJECT_DIR/${rel.split('\\').join('/')}` : engineCli;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number }[];
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookEntry[]>;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] } & Record<string, unknown>;
};

export function mergeSettings(existing: Settings, enginePath: string, preApproved: string[], domains: string[], secretPaths: string[] = []): Settings {
  const s: Settings = structuredClone(existing);
  const hooks = { ...(s.hooks ?? {}) };
  const ours: Record<string, HookEntry> = {
    PreToolUse: { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCommand(enginePath, 'pre-tool-use'), timeout: 30 }] },
    SessionStart: { hooks: [{ type: 'command', command: hookCommand(enginePath, 'session-start'), timeout: 30 }] },
    SessionEnd: { hooks: [{ type: 'command', command: hookCommand(enginePath, 'session-end'), timeout: 300 }] },
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

export interface InstallOptions {
  root: string;
  /** Path to the engine's cli.js (defaults to this running engine). */
  engineCli?: string;
  gitHooks?: boolean;
}

export interface InstallReport {
  scaffolded: boolean;
  settingsPath: string;
  gitHook?: string;
  notes: string[];
}

export function install(opts: InstallOptions): InstallReport {
  const root = resolve(opts.root);
  const notes: string[] = [];
  const cfgDir = join(root, BRAND.configDir);
  let scaffolded = false;
  if (!existsSync(cfgDir)) {
    cpSync(templatesDir(), cfgDir, { recursive: true });
    const config = join(cfgDir, 'config.yaml');
    const repo = gitRemoteRepo(root) ?? 'owner/repo';
    writeFileSync(config, readFileSync(config, 'utf8').replaceAll('{{name}}', basename(root)).replaceAll('{{repo}}', repo));
    scaffolded = true;
    notes.push(`created ${BRAND.configDir}/ from templates; edit owners, guardrails and tests, then run \`${BRAND.cli} doctor\``);
  }
  // Settings are generated from valid config only; a broken config fails here, loudly.
  const cfg = loadConfig(root);
  const engineCli = resolve(opts.engineCli ?? projectLocalEngine(root) ?? fileURLToPath(new URL('./cli.js', import.meta.url)));
  const settingsPath = join(root, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const merged = mergeSettings(readJson(settingsPath), engineRef(root, engineCli), cfg.guardrails.pre_approved, cfg.guardrails.network.allow, cfg.guardrails.credential_stores);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  const report: InstallReport = { scaffolded, settingsPath, notes };
  if (opts.gitHooks) report.gitHook = installGitHook(root);
  else notes.push('git pre-commit secret scan not installed (pass --git-hooks); it applies to every worktree of the repo');
  return report;
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
