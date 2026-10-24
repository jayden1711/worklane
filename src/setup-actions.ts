// WHY: the first-run page fixes some steps itself (Fix kind 'action'). Each action shows its plan before anything
// happens and runs the CLI's own code for the step; the dashboard runs it for owners only, confirmed and audited.
import { join } from 'node:path';
import { execFileSync, spawnSync } from './os/child-process.js';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { refreshFingerprints, type RefreshResult } from './guardrails/context.js';
import { install, installGitHooks } from './install.js';
import { detectTools, type Mode, type RunResult } from './setup-steps.js';
import { describeInstall, httpDownload, INSTALLABLE, installPlan, installTool, type Download, type InstallableTool, type ToolInstall } from './tool-install.js';
import { findTool, toolPrefix, withToolPath } from './tool-path.js';
import { classicChecks } from './branch-protection.js';

export const ACTION_IDS = ['install-tools', 'local-hooks', 'git-hooks', 'fingerprints', 'protection', 'default-branch'] as const;
export type ActionId = (typeof ACTION_IDS)[number];
export const isActionId = (s: unknown): s is ActionId => typeof s === 'string' && (ACTION_IDS as readonly string[]).includes(s);

export interface ActionPlan {
  id: ActionId;
  step: string;
  label: string;
  available: boolean;
  why?: string;
  changes: string[];
  commands: string[];
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  /**
   * A failure's text for the page, in the engine's own words: never a tool's output, GitHub's text or a path (#882).
   * The detail goes to the dashboard's log. Unset: the page says the fix wasn't done.
   */
  shown?: string;
}

const LOGGED = "the detail is in the dashboard's log on the machine";

export interface ActionContext {
  mode: Mode;
  root: string;
  cfg: Config;
}

// WHY: tests stand in for the downloads, the fingerprint commands and the tool lookup.
export interface ActionDeps {
  which: (cmd: string) => string | null;
  prefix: string;
  plan: (tool: InstallableTool, prefix: string) => ToolInstall | null;
  download: Download;
  refresh: (root: string, cfg: Config['guardrails']) => RefreshResult[];
  gh: (args: string[], input?: string) => RunResult;
}

export function systemActionDeps(): ActionDeps {
  return { which: (c) => findTool(c), prefix: toolPrefix(), plan: (t, p) => installPlan(t, p), download: httpDownload, refresh: refreshFingerprints, gh: (args, input) => {
      const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, env: withToolPath(), ...(input !== undefined ? { input } : {}) });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
    } };
}

const gitCommonHooks = (root: string) => {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  return join(common.startsWith('/') ? common : join(root, common), 'hooks');
};

interface ActionDef {
  step: string;
  label: string;
  plan: (c: ActionContext, d: ActionDeps) => Omit<ActionPlan, 'id' | 'step' | 'label'>;
  run: (c: ActionContext, d: ActionDeps) => Promise<ActionResult>;
}

const toolPlans = (c: ActionContext, d: ActionDeps) => {
  const missing = detectTools(c.mode, d).missing;
  return missing.map((t) => ({ t, p: (INSTALLABLE as string[]).includes(t) ? d.plan(t as InstallableTool, d.prefix) : null }));
};

export const ACTIONS: Record<ActionId, ActionDef> = {
  'install-tools': {
    step: 'tools',
    label: 'Install the missing tools',
    plan: (c, d) => {
      if (c.mode === 'server') return { available: false, why: "on a server, installing tools is the owner's root step (scripts/setup/tools.sh, through bootstrap --hardened); the dashboard never runs as root", changes: [], commands: [] };
      const plans = toolPlans(c, d);
      if (!plans.length) return { available: false, why: 'nothing is missing', changes: [], commands: [] };
      const manual = plans.filter((x) => !x.p).map((x) => x.t);
      if (manual.length) {
        const how = manual.includes('git') ? ' (git: on macOS `xcode-select --install`; on Linux your package manager)' : '';
        return { available: false, why: `not something ${BRAND.cli} installs here: ${manual.join(', ')}${how}`, changes: [], commands: [] };
      }
      // INVARIANT: the same pinned plan and checksum check as `init --yes` (src/tool-install.ts); nothing else is fetched.
      return { available: true, changes: plans.map(({ p }) => `${describeInstall(p!)}; checked against the pinned checksum before it is unpacked`), commands: [] };
    },
    run: async (c, d) => {
      const plan = ACTIONS['install-tools'].plan(c, d);
      if (!plan.available) return { ok: false, detail: plan.why ?? 'not available', shown: plan.why ?? 'not available' };
      const done: string[] = [];
      for (const { p } of toolPlans(c, d)) {
        const r = await installTool(p!, { download: d.download });
        const before = done.length ? `installed ${done.join(', ')}; then ` : '';
        if (!r.ok) return { ok: false, detail: `${before}${r.error}`, shown: `${before}installing ${p!.tool} ${p!.version} failed; ${LOGGED}` };
        done.push(`${p!.tool} ${p!.version}`);
      }
      return { ok: true, detail: `installed ${done.join(', ')} in ${join(d.prefix, 'bin')}` };
    },
  },
  'local-hooks': {
    step: 'hooks',
    label: 'Install the hooks',
    plan: (c) => {
      if (c.mode === 'server') return { available: false, why: "an instance's agents get their hooks in its home, from add-project", changes: [], commands: [] };
      return {
        available: true,
        changes: [`${join(c.root, '.claude', 'settings.json')}: the guardrail hooks and rules for agent runs in this checkout merged in (anything else in it is kept)`, `the same as \`${BRAND.cli} install\``],
        commands: [],
      };
    },
    run: async (c) => {
      const r = install({ root: c.root });
      return { ok: true, detail: `hooks merged into ${r.settingsPath}` };
    },
  },
  'git-hooks': {
    step: 'pre-commit',
    label: 'Install the git hooks',
    plan: (c) => {
      if (c.mode === 'server') return { available: false, why: "an instance's checkout gets its hooks from checkout.sh, as root", changes: [], commands: [] };
      const hooks = gitCommonHooks(c.root);
      const direct = c.cfg.project.land_mode === 'direct';
      return {
        available: true,
        changes: [
          `${join(hooks, 'pre-commit')}: a gitleaks secret scan on every commit, in every worktree of the repo (an existing hook is kept as pre-commit.before-${BRAND.cli} and still runs)`,
          direct ? 'no pre-push hook: land_mode direct lands by pushing the default branch' : `${join(hooks, 'pre-push')}: refuses a push to ${c.cfg.project.project.default_branch}`,
          `the same hooks as \`${BRAND.cli} install --git-hooks\``,
        ],
        commands: [],
      };
    },
    run: async (c) => {
      const r = installGitHooks(c.root, c.cfg);
      return { ok: true, detail: `pre-commit secret scan at ${r.gitHook}${r.prePushHook ? `; pre-push guard at ${r.prePushHook}` : ''}` };
    },
  },
  'default-branch': {
    step: 'default-branch',
    label: 'Fetch the default branch',
    plan: (c) => ({
      available: c.mode === 'local',
      ...(c.mode === 'local' ? {} : { why: "an instance's checkout is set up by checkout.sh" }),
      changes: [`this checkout's origin/${c.cfg.project.project.default_branch} and origin/HEAD, from origin (no local branch moves, no files change)`],
      commands: defaultBranchCommands(c).map((x) => x.join(' ')),
    }),
    run: async (c) => {
      for (const cmd of defaultBranchCommands(c)) {
        const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: c.root, encoding: 'utf8', timeout: 120_000, env: withToolPath() });
        if (r.status !== 0) return { ok: false, detail: `${cmd.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`, shown: `${cmd.join(' ')} failed; ${LOGGED}` };
      }
      return { ok: true, detail: `fetched origin/${c.cfg.project.project.default_branch}; origin/HEAD set` };
    },
  },
  protection: {
    step: 'protection',
    label: 'Protect the default branch',
    plan: (c) => {
      const { path: _p, body: _b, ...plan } = protectionPlan(c);
      return plan;
    },
    run: async (c, d) => {
      const p = protectionPlan(c);
      if (!p.available || !p.path || !p.body) return { ok: false, detail: p.why ?? 'not available', shown: p.why ?? 'not available' };
      // INVARIANT: never replaces protection that exists (PUT would overwrite it whole).
      const now = d.gh(['api', p.path, '--silent']);
      const already = `${c.cfg.project.project.default_branch} is protected already; not replaced`;
      if (now.status === 0) return { ok: false, detail: already, shown: already };
      const r = d.gh(['api', '--method', 'PUT', p.path, '--input', '-'], p.body);
      if (r.status !== 0) return { ok: false, detail: `GitHub refused: ${(r.stderr.trim() || r.stdout.trim()).split('\n')[0]}`, shown: `GitHub refused to protect ${c.cfg.project.project.default_branch} (only a repo admin may); ${LOGGED}` };
      return { ok: true, detail: `GitHub now requires ${c.cfg.project.required_checks.join(', ')} on ${c.cfg.project.project.default_branch}` };
    },
  },
  fingerprints: {
    step: 'fingerprints',
    label: 'Fetch the fingerprints',
    plan: (c) => {
      const sets = Object.entries(c.cfg.guardrails.fingerprints);
      if (!sets.length) return { available: false, why: 'guardrails.yaml has no fingerprint sets', changes: [], commands: [] };
      return {
        available: true,
        changes: [`hashes of each connection string found, never the value, in this checkout's ${BRAND.cli} state (0600)`],
        commands: sets.map(([name, s]) => `${s.command}    (${name}: reads ${s.key})`),
      };
    },
    run: async (c, d) => {
      const r = d.refresh(c.root, c.cfg.guardrails);
      const bad = r.filter((x) => !x.ok);
      const line = r.map((x) => (x.ok ? `${x.name}: ${x.count} stored` : `${x.name}: ${x.error}`)).join('; ');
      const shown = r.map((x) => (x.ok ? `${x.name}: ${x.count} stored` : `${x.name}: not fetched`)).join('; ');
      return { ok: !bad.length, detail: line || 'no fingerprint sets', ...(bad.length ? { shown: `${shown}; ${LOGGED}` } : {}) };
    },
  },
};

const defaultBranchCommands = (c: ActionContext) => [
  ['git', 'fetch', '-q', 'origin', c.cfg.project.project.default_branch],
  ['git', 'remote', 'set-head', 'origin', '--auto'],
];

/** WHY: classic protection, not a ruleset: the main watch and direct landing read the branch protection API. */
export function protectionBody(cfg: Config) {
  return { required_status_checks: classicChecks(cfg.project), enforce_admins: false, required_pull_request_reviews: null, restrictions: null };
}

function protectionPlan(c: ActionContext): Omit<ActionPlan, 'id' | 'step' | 'label'> & { path?: string; body?: string } {
  const repo = c.cfg.project.project.repo;
  const branch = c.cfg.project.project.default_branch;
  const settings = `https://github.com/${repo}/settings/branches`;
  if (c.mode === 'server') return { available: false, why: `the agents' App may not change branch protection (it has no administration permission); a repo admin sets it at ${settings}`, changes: [], commands: [] };
  if (!/^[^/]+\/[^/]+$/.test(repo) || repo === 'owner/repo') return { available: false, why: 'no GitHub repo in config.yaml yet', changes: [], commands: [] };
  const checks = c.cfg.project.required_checks;
  if (!checks.length) return { available: false, why: 'name the required checks first (config.yaml required_checks): protection requiring none would mark nothing', changes: [], commands: [] };
  const body = JSON.stringify(protectionBody(c.cfg));
  const path = `repos/${repo}/branches/${branch}/protection`;
  return {
    available: true,
    changes: [
      `GitHub branch protection on ${repo}'s ${branch}: a PR's checks ${checks.join(', ')} must pass before it merges, ${c.cfg.project.protection.strict ? 'and it must be up to date first (protection.strict)' : 'not strict (it need not be up to date first)'}`,
      'nothing else: no required reviews, no push restrictions, admins not bound; only when the branch has no protection yet (an existing one is never replaced)',
      `with your gh login, which must be an admin of ${repo}; otherwise GitHub refuses and an admin sets it at ${settings}`,
    ],
    commands: [`gh api --method PUT ${path} --input - <<'JSON'\n${body}\nJSON`],
    path,
    body,
  };
}

export function actionPlan(id: ActionId, c: ActionContext, d: ActionDeps): ActionPlan {
  const a = ACTIONS[id];
  try {
    return { id, step: a.step, label: a.label, ...a.plan(c, d) };
  } catch (e) {
    return { id, step: a.step, label: a.label, available: false, why: `can't plan it: ${(e as Error).message.split('\n')[0]}`, changes: [], commands: [] };
  }
}
