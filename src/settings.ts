// Instance settings: the few knobs where the operator's policy.yaml wins over
// the repo's config (whose values are the defaults): worker count, daily
// budget, CI fix runs, run windows. The coordinator re-reads them every tick;
// the instance's dashboard changes them through changeSetting, which only the
// owner may call. Bounds come from a machine-wide, root-owned limits file the
// dashboard can't write; a value outside them is refused, never clamped.
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { EventLog } from './events/log.js';
import { InstanceSettings, PolicyFile } from './instance.js';
import { replaceFileAtomically } from './os/index.js';
import { INTAKE_DEFAULT_CAPS, type IntakeCaps } from './intake/report.js';
import { RESEARCH_DEFAULT_CAPS, type ResearchCaps } from './research.js';
import { ROUTING_ALIASES } from './routing.js';
import type { StuckMode } from './stuck.js';

/** The machine's bounds on instance settings: root-owned, outside every instance's home. */
export const LIMITS_PATH = `/etc/${BRAND.cli}/limits.json`;

export const Limits = z.strictObject({
  workers: z.strictObject({ min: z.number().int().min(0), max: z.number().int().min(0) }).default({ min: 1, max: 8 }),
  daily_budget_usd: z.strictObject({ max: z.number().positive() }).default({ max: 100 }),
  max_fixes_per_pr: z.strictObject({ max: z.number().int().min(0) }).default({ max: 5 }),
  research: z
    .strictObject({
      max_searches_per_day: z.number().int().min(0).default(200),
      max_fetches_per_day: z.number().int().min(0).default(500),
      max_usd_per_day: z.number().min(0).default(20),
    })
    .prefault({}),
  intake: z
    .strictObject({
      reports_per_sender_per_day: z.number().int().min(1).default(100),
      drafts_per_day: z.number().int().min(1).default(200),
      max_usd_per_day: z.number().min(0).default(20),
    })
    .prefault({}),
});
export type Limits = z.infer<typeof Limits>;

export class SettingsError extends Error {}

/** The machine's limits: the engine's defaults when there's no limits file; an unreadable or invalid one is an error. */
export function loadLimits(path = LIMITS_PATH): Limits {
  if (!existsSync(path)) return Limits.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SettingsError(`limits file ${path} is unreadable: ${(e as Error).message}`);
  }
  const r = Limits.safeParse(raw);
  if (!r.success) throw new SettingsError(`limits file ${path} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Every way these settings break the machine's limits or the policy's own ceilings. */
export function settingsProblems(s: InstanceSettings, limits: Limits, policy?: Pick<PolicyFile, 'budget' | 'agents'>): string[] {
  const out: string[] = [];
  if (s.workers !== undefined) {
    if (s.workers < limits.workers.min || s.workers > limits.workers.max) out.push(`workers ${s.workers} is outside ${limits.workers.min}-${limits.workers.max} (machine limits)`);
    if (policy && s.workers > policy.agents.max_workers) out.push(`workers ${s.workers} is over the policy's max_workers ${policy.agents.max_workers}`);
  }
  if (s.daily_budget_usd !== undefined) {
    if (s.daily_budget_usd > limits.daily_budget_usd.max) out.push(`daily_budget_usd ${s.daily_budget_usd} is over ${limits.daily_budget_usd.max} (machine limits)`);
    if (policy && s.daily_budget_usd > policy.budget.daily_usd) out.push(`daily_budget_usd ${s.daily_budget_usd} is over the policy's budget ${policy.budget.daily_usd}`);
  }
  const fixes = s.ci_repair?.max_fixes_per_pr;
  if (fixes !== undefined && fixes > limits.max_fixes_per_pr.max) out.push(`ci_repair.max_fixes_per_pr ${fixes} is over ${limits.max_fixes_per_pr.max} (machine limits)`);
  for (const w of s.run_windows ?? []) if (w.from === w.to) out.push(`run window ${w.from}-${w.to} is empty`);
  for (const k of ['max_searches_per_day', 'max_fetches_per_day', 'max_usd_per_day'] as const) {
    const v = s.research?.[k];
    if (v !== undefined && v > limits.research[k]) out.push(`research.${k} ${v} is over ${limits.research[k]} (machine limits)`);
  }
  for (const k of ['reports_per_sender_per_day', 'drafts_per_day', 'max_usd_per_day'] as const) {
    const v = s.intake?.[k];
    if (v !== undefined && v > limits.intake[k]) out.push(`intake.${k} ${v} is over ${limits.intake[k]} (machine limits)`);
  }
  return out;
}

function instanceEvalRouting(a: Config['agents'], e: NonNullable<InstanceSettings['eval_routing']>): Pick<Config['agents'], 'routing' | 'routing_from'> {
  const routing = { ...a.routing };
  const from = { ...a.routing_from };
  for (const [k, v] of Object.entries(e)) {
    const key = ROUTING_ALIASES.eval_routing[k];
    if (v === undefined || !key) continue;
    Object.assign(routing, { [key]: v });
    from[key] = `policy.yaml settings.eval_routing.${k}`;
  }
  return { routing, routing_from: from };
}

/** The repo's config with the instance's settings applied over it (the repo's values are the defaults). */
export function applySettings(cfg: Config, s: InstanceSettings): Config {
  const workers = cfg.agents.roles.workers;
  const ci = cfg.agents.roles.ci_repair;
  return {
    ...cfg,
    project: { ...cfg.project, agent_runtime: { ...cfg.project.agent_runtime, ...(s.run_windows ? { run_windows: s.run_windows } : {}) } },
    agents: {
      ...cfg.agents,
      ...(s.daily_budget_usd !== undefined ? { daily_budget_usd: s.daily_budget_usd } : {}),
      ...(s.eval_routing ? instanceEvalRouting(cfg.agents, s.eval_routing) : {}),
      roles: {
        ...cfg.agents.roles,
        ...(workers && s.workers !== undefined ? { workers: { ...workers, count: s.workers } } : {}),
        ...(s.ci_repair && (ci || workers)
          ? { ci_repair: { ...(ci ?? { enabled: false, model: workers!.model }), ...(s.ci_repair.enabled !== undefined ? { enabled: s.ci_repair.enabled } : {}), ...(s.ci_repair.max_fixes_per_pr !== undefined ? { max_fixes_per_pr: s.ci_repair.max_fixes_per_pr } : {}) } }
          : {}),
      },
    },
  };
}

/** Is `now` (local time) inside one of the run windows? No windows: always. A window may cross midnight. */
export function inRunWindow(windows: { from: string; to: string }[], now = new Date()): boolean {
  if (!windows.length) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return windows.some(({ from, to }) => (mins(from) <= mins(to) ? m >= mins(from) && m < mins(to) : m >= mins(from) || m < mins(to)));
}

/**
 * A reader of an instance's settings for the coordinator's every tick: it parses policy.yaml again only when the
 * text of it (or of the limits file) changed. Compared by content, not mtime and size: an edit of the same length
 * within one timestamp tick (workers 2 -> 3) would otherwise go unseen. Both files are a few hundred bytes. An unreadable or invalid file, or settings out of bounds: the error, and no
 * settings (the repo's values apply) until it's fixed.
 */
export function settingsReader(policyPath: string, limitsPath = LIMITS_PATH): () => { settings: InstanceSettings; error: string | null } {
  let key = '';
  let last: { settings: InstanceSettings; error: string | null } = { settings: {}, error: null };
  return () => {
    let stamp = '';
    try {
      stamp = `${readFileSync(policyPath, 'utf8')}\0${existsSync(limitsPath) ? readFileSync(limitsPath, 'utf8') : ''}`;
    } catch (e) {
      return { settings: {}, error: `policy unreadable: ${(e as Error).message}` };
    }
    if (stamp === key) return last;
    key = stamp;
    try {
      const policy = PolicyFile.parse(parseDocument(readFileSync(policyPath, 'utf8')).toJS());
      const problems = settingsProblems(policy.settings, loadLimits(limitsPath), policy);
      last = problems.length ? { settings: {}, error: `settings refused: ${problems.join('; ')}` } : { settings: policy.settings, error: null };
    } catch (e) {
      last = { settings: {}, error: `policy settings unusable: ${(e as Error).message.split('\n')[0]}` };
    }
    return last;
  };
}

export const SETTING_KEYS = ['workers', 'daily_budget_usd', 'ci_repair.enabled', 'ci_repair.max_fixes_per_pr', 'run_windows', 'research.max_searches_per_day', 'research.max_fetches_per_day', 'research.max_usd_per_day', 'research.repo_access', 'intake.reports_per_sender_per_day', 'intake.drafts_per_day', 'intake.max_usd_per_day', 'stuck_guard'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** A setting's value in effect: the instance's if set, else the repo's. */
export function currentValue(cfg: Config, s: InstanceSettings, key: SettingKey): unknown {
  const eff = applySettings(cfg, s);
  switch (key) {
    case 'workers':
      return eff.agents.roles.workers?.count ?? 1;
    case 'daily_budget_usd':
      return eff.agents.daily_budget_usd;
    case 'ci_repair.enabled':
      return eff.agents.roles.ci_repair?.enabled ?? false;
    case 'ci_repair.max_fixes_per_pr':
      return eff.agents.roles.ci_repair?.max_fixes_per_pr ?? 2;
    case 'run_windows':
      return eff.project.agent_runtime.run_windows;
    case 'research.max_searches_per_day':
    case 'research.max_fetches_per_day':
    case 'research.max_usd_per_day':
      return researchCaps(s)[key.slice('research.'.length) as keyof ResearchCaps];
    case 'research.repo_access':
      return researchRepoAccess(s);
    case 'intake.reports_per_sender_per_day':
    case 'intake.drafts_per_day':
    case 'intake.max_usd_per_day':
      return intakeCaps(s)[key.slice('intake.'.length) as keyof IntakeCaps];
    case 'stuck_guard':
      return stuckMode(s);
  }
}

/** The stuck-run guard's mode: the instance's, else dry-run (logs what it would stop, stops nothing). */
export function stuckMode(s: InstanceSettings): StuckMode {
  return s.stuck_guard ?? 'dry-run';
}

/** Intake's daily caps in force: the instance's settings, else the intake config's values, else the engine's defaults. */
export function intakeCaps(s: InstanceSettings, defaults: IntakeCaps = INTAKE_DEFAULT_CAPS): IntakeCaps {
  const v = s.intake ?? {};
  return {
    reports_per_sender_per_day: v.reports_per_sender_per_day ?? defaults.reports_per_sender_per_day,
    drafts_per_day: v.drafts_per_day ?? defaults.drafts_per_day,
    max_usd_per_day: v.max_usd_per_day ?? defaults.max_usd_per_day,
  };
}

/** Whether research runs may read the repo: only when the owner turned it on. */
export function researchRepoAccess(s: InstanceSettings): boolean {
  return s.research?.repo_access === true;
}

/** The research caps in force: the instance's, else the engine's conservative defaults (there's no repo value). */
export function researchCaps(s: InstanceSettings): ResearchCaps {
  const r = s.research ?? {};
  return {
    max_searches_per_day: r.max_searches_per_day ?? RESEARCH_DEFAULT_CAPS.max_searches_per_day,
    max_fetches_per_day: r.max_fetches_per_day ?? RESEARCH_DEFAULT_CAPS.max_fetches_per_day,
    max_usd_per_day: r.max_usd_per_day ?? RESEARCH_DEFAULT_CAPS.max_usd_per_day,
  };
}

/**
 * Change one instance setting, for the instance's own dashboard. Only the owner may: `owner` says whether the
 * dashboard read `by` as one of the instance's owners (admin on its repo); without it, owners.default only.
 * The new value is checked against the schema, the machine's limits and the policy's ceilings; refused,
 * nothing changes. Written atomically (a temp file beside policy.yaml, same owner, mode 0600, then a
 * rename), and recorded as settings.changed in the instance's event log.
 */
export function changeSetting(o: { policyPath: string; cfg: Config; eventsDb: string; key: string; value: unknown; by: string; owner?: boolean; actor?: string; limitsPath?: string; now?: () => Date }): { from: unknown; to: unknown } {
  const owner = o.cfg.project.owners.default;
  const isOwner = o.owner ?? (!!o.by && o.by.toLowerCase() === owner.toLowerCase());
  if (!o.by || !isOwner) throw new SettingsError(`only the owner (@${owner}) may change settings; @${o.by || 'unknown'} may not`);
  if (!(SETTING_KEYS as readonly string[]).includes(o.key)) throw new SettingsError(`unknown setting ${o.key}; settings are ${SETTING_KEYS.join(', ')}`);
  const key = o.key as SettingKey;
  const text = readFileSync(o.policyPath, 'utf8');
  const doc = parseDocument(text);
  const before = PolicyFile.parse(doc.toJS());
  const from = currentValue(o.cfg, before.settings, key);
  doc.setIn(['settings', ...key.split('.')], o.value);
  const parsed = PolicyFile.safeParse(doc.toJS());
  if (!parsed.success) throw new SettingsError(`refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const problems = settingsProblems(parsed.data.settings, loadLimits(o.limitsPath), parsed.data);
  if (problems.length) throw new SettingsError(`refused: ${problems.join('; ')}`);
  const to = currentValue(o.cfg, parsed.data.settings, key);
  // Atomic: a temp file in the same directory, the original's owner, 0600; then rename over it.
  replaceFileAtomically(o.policyPath, doc.toString(), 0o600);
  const log = new EventLog(o.eventsDb);
  try {
    log.append('settings.changed', { key, from: from as never, to: to as never, by: o.by, at: (o.now ?? (() => new Date()))().toISOString() }, o.actor ?? o.by, 'human');
  } finally {
    log.close();
  }
  return { from, to };
}
