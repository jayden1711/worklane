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
import { GIT_HOOK_MARKER, HOOK_MARKER } from './install.js';
import { canRunAgents, detectOs, shimsNeedShell, which, wslAvailable } from './os/index.js';

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

export function doctor(rootArg: string, opts: { agentshield?: boolean } = {}): DoctorCheck[] {
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

  const os = detectOs(cfg?.project.os ?? 'auto');
  if (canRunAgents(os)) add('os', 'ok', os);
  else add('os', 'warn', wslAvailable() ? 'native Windows: run agents inside WSL2' : 'native Windows without WSL2: dashboard and Issues only; agents run on another machine');

  // Settings and hook wiring
  const settingsPath = join(root, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) add('hooks', 'fail', `.claude/settings.json missing; run \`${BRAND.cli} install\``);
  else {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, { hooks?: { command: string }[] }[]> };
      for (const event of ['PreToolUse', 'SessionStart', 'SessionEnd']) {
        const cmds = (s.hooks?.[event] ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command).filter((c) => c.includes(HOOK_MARKER));
        if (cmds.length !== 1) {
          add(`hook ${event}`, 'fail', cmds.length ? `${cmds.length} ${BRAND.cli} entries (expected 1)` : 'not installed');
          continue;
        }
        const cmd = cmds[0]!;
        const path = cmd.match(/E="([^"]+)"/)?.[1]?.replace('$CLAUDE_PROJECT_DIR', root);
        if (!cmd.includes('|| exit 2') || !/_AGENT" = 1 \]; then [^;]*>&2; exit 2/.test(cmd)) add(`hook ${event}`, 'fail', 'does not fail closed for agents');
        else if (!path || !existsSync(path)) add(`hook ${event}`, 'fail', `engine not found at ${path ?? '(unparsed)'}`);
        else add(`hook ${event}`, 'ok', 'installed, fails closed');
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
