// `doctor`: verify an install. Each check is ok, warn or fail; any fail
// makes the command exit non-zero. Nothing here is skipped silently: a check
// that can't run reports why.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config } from './config/load.js';
import { checkGuardrails } from './guardrails/check.js';
import { loadFingerprintSets } from './guardrails/context.js';
import { agentSettingsPath, hookChecks, installCommand, legacyProjectHooks, projectSettingsRefusal, type Settings } from './agent-settings.js';
import { GIT_HOOK_MARKER } from './install.js';
import { instancesDir, loadInstance, policiesForRepo, policyViolations, readPolicy } from './instance.js';
import { canRunAgents, detectOs, fileAccess, shimsNeedShell, userUid, which, wslAvailable } from './os/index.js';
import { lintSkills, skillLintReport, trackedSkills } from './skill-lint.js';

export type Level = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  name: string;
  level: Level;
  detail: string;
}

const CLAUDE_MD_TOKEN_BUDGET = 2500;

function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0]);
}

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

export function doctor(rootArg: string, opts: { agentshield?: boolean; /** A policy.yaml to check the config against, besides any local instance's. */ policy?: string; /** An instance whose agent settings to check, besides those of any local instance running this repo. */ instance?: string } = {}): DoctorCheck[] {
  const root = resolve(rootArg);
  const out: DoctorCheck[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });

  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  if (maj < 22 || (maj === 22 && min < 13)) add('node', 'fail', `Node ${process.versions.node}; hooks need >= 22.13`);
  else if (nodeMajor() < 24) add('node', 'warn', `Node ${process.versions.node}: hooks OK; the coordinator (step 2) needs >= 24`);
  else add('node', 'ok', `Node ${process.versions.node}`);

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(root);
    add('config', 'ok', `${BRAND.configDir}/ valid`);
  } catch (e) {
    add('config', 'fail', e instanceof ConfigInvalid ? e.message : (e as Error).message);
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

  const os = detectOs(cfg?.project.os ?? 'auto');
  if (canRunAgents(os)) add('os', 'ok', os);
  else add('os', 'warn', wslAvailable() ? 'native Windows: run agents inside WSL2' : 'native Windows without WSL2: dashboard and Issues only; agents run on another machine');

  // Hook wiring. An instance's agents get their hooks and rules from its agent settings, for agent runs only
  // (agent-settings.ts). The checkout's .claude/settings.json is for local runs without an instance, and is where
  // instances installed before agent settings still find them.
  const instances = [...new Set([...(opts.instance ? [opts.instance] : []), ...(cfg ? policiesForRepo(cfg.project.project.repo).map((p) => p.name) : [])])];
  for (const name of instances) {
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
  const gl = which('gitleaks');
  if (!gl) add('gitleaks', 'fail', 'not on PATH: commit and transcript scans cannot run');
  else add('gitleaks', 'ok', execFileSync(gl, ['version'], { encoding: 'utf8' }).trim());
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const hook = join(resolve(root, common), 'hooks', 'pre-commit');
    if (existsSync(hook) && readFileSync(hook, 'utf8').includes(GIT_HOOK_MARKER)) add('pre-commit', 'ok', 'gitleaks pre-commit installed');
    else add('pre-commit', 'warn', `not installed (\`${BRAND.cli} install --git-hooks\`); the land queue still re-scans`);
  } catch {
    add('pre-commit', 'warn', 'not a git repository');
  }

  // Agent runtime
  const claude = which('claude');
  if (!claude) add('claude', cfg?.project.agent_runtime.kind === 'cli' ? 'fail' : 'warn', 'Claude Code CLI not on PATH');
  else {
    const v = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    add('claude', v.status === 0 ? 'ok' : 'warn', (v.stdout || v.stderr || '').trim().split('\n')[0] ?? '');
  }

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

  if (opts.agentshield) out.push(agentShield(root));
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
