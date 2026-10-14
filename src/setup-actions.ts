// WHY: the first-run page fixes some steps itself (Fix kind 'action'). Each action shows its plan before anything
// happens and runs the CLI's own code for the step; the dashboard runs it for owners only, confirmed and audited.
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { refreshFingerprints, type RefreshResult } from './guardrails/context.js';
import { install, installGitHooks } from './install.js';
import { detectTools, type Mode } from './setup-steps.js';
import { describeInstall, httpDownload, INSTALLABLE, installPlan, installTool, type Download, type InstallableTool, type ToolInstall } from './tool-install.js';
import { findTool, toolPrefix } from './tool-path.js';

export const ACTION_IDS = ['install-tools', 'local-hooks', 'git-hooks', 'fingerprints'] as const;
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
}

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
}

export function systemActionDeps(): ActionDeps {
  return { which: (c) => findTool(c), prefix: toolPrefix(), plan: (t, p) => installPlan(t, p), download: httpDownload, refresh: refreshFingerprints };
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
      if (!plan.available) return { ok: false, detail: plan.why ?? 'not available' };
      const done: string[] = [];
      for (const { p } of toolPlans(c, d)) {
        const r = await installTool(p!, { download: d.download });
        if (!r.ok) return { ok: false, detail: `${done.length ? `installed ${done.join(', ')}; then ` : ''}${r.error}` };
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
      return { ok: !bad.length, detail: line || 'no fingerprint sets' };
    },
  },
};

export function actionPlan(id: ActionId, c: ActionContext, d: ActionDeps): ActionPlan {
  const a = ACTIONS[id];
  try {
    return { id, step: a.step, label: a.label, ...a.plan(c, d) };
  } catch (e) {
    return { id, step: a.step, label: a.label, available: false, why: `can't plan it: ${(e as Error).message.split('\n')[0]}`, changes: [], commands: [] };
  }
}
