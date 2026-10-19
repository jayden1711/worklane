// WHY: the first-run page's Policy form (audit row 16) edits a server instance's policy.yaml keys that Settings
// doesn't: each change is checked against the schema, the machine's limits and the repo's config before it is
// shown, then written only after an owner confirms that exact change. Isolation keys (sandbox, allow_same_user,
// lanes, allowlists) are never editable here: loosening them is a root-shell decision.
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { EventLog } from './events/log.js';
import { policyViolations, PolicyFile } from './instance.js';
import { replaceFileAtomically } from './os/index.js';
import { loadLimits, settingsProblems } from './settings.js';
import { policyInstance, readPolicyChecked } from './policy-gate.js';
import { autoMergeKilled } from './policy-kill.js';

export const POLICY_KEYS = ['budget.daily_usd', 'agents.max_workers', 'land_mode', 'auto_merge', 'main_watch', 'automations.enabled'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

export interface PolicyField {
  key: PolicyKey;
  value: number | boolean | string;
  kind: 'number' | 'boolean' | 'choice';
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
  why: string;
}

export interface PolicyFormView {
  fields: PolicyField[];
  /** INVARIANT: shown read-only; this form never writes them. */
  fixed: { key: string; value: unknown }[];
  error: string | null;
}

export class PolicyEditError extends Error {}

const get = (p: PolicyFile, k: PolicyKey): number | boolean | string => (k === 'budget.daily_usd' ? p.budget.daily_usd : k === 'agents.max_workers' ? p.agents.max_workers : k === 'automations.enabled' ? p.automations.enabled : p[k]);

function read(path: string): { doc: ReturnType<typeof parseDocument>; policy: PolicyFile; root: boolean } {
  const checked = readPolicyChecked(path);
  if (checked && 'refused' in checked) throw new PolicyEditError(checked.refused);
  const doc = parseDocument(checked ? checked.text : readFileSync(path, 'utf8'));
  const r = PolicyFile.safeParse(doc.toJS());
  if (!r.success) throw new PolicyEditError(`${path} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  // Root's kill switch (src/policy-kill.ts): auto_merge reads off while it is there, as the engine reads it.
  return { doc, policy: autoMergeKilled(policyInstance(path)) ? { ...r.data, auto_merge: false } : r.data, root: !!checked };
}

export function policyForm(path: string, limitsPath?: string): PolicyFormView {
  let policy: PolicyFile;
  let limits;
  try {
    policy = read(path).policy;
    limits = loadLimits(limitsPath);
  } catch (e) {
    return { fields: [], fixed: [], error: (e as Error).message.split('\n')[0] ?? 'unreadable' };
  }
  return {
    fields: [
      { key: 'budget.daily_usd', value: policy.budget.daily_usd, kind: 'number', min: 1, max: limits.daily_budget_usd.max, step: 1, why: "the instance's daily spend ceiling (estimated); the repo's agents.yaml may only be lower" },
      { key: 'agents.max_workers', value: policy.agents.max_workers, kind: 'number', min: limits.workers.min, max: limits.workers.max, step: 1, why: 'the most workers at once; the repo may only ask for fewer' },
      { key: 'land_mode', value: policy.land_mode, kind: 'choice', choices: ['pr', 'direct'], why: 'pr: every change lands through a PR; direct: the harness may push the default branch (needs branch protection)' },
      { key: 'auto_merge', value: policy.auto_merge, kind: 'boolean', why: "on: the harness merges its own PRs that review.yaml's merge rules allow; off: every PR waits for a person" },
      { key: 'main_watch', value: policy.main_watch, kind: 'choice', choices: ['auto', 'off'], why: "auto: the main watch guards the default branch whenever GitHub doesn't protect it" },
      { key: 'automations.enabled', value: policy.automations.enabled, kind: 'boolean', why: `on: the automations on Extend may run, within ${policy.automations.max_runs_per_day} runs a day, ${policy.automations.max_concurrent} at once and ${Math.round(policy.automations.budget_share * 100)}% of the daily budget; off: none runs` },
    ],
    fixed: [
      { key: 'sandbox', value: policy.sandbox },
      { key: 'allow_same_user', value: policy.allow_same_user },
      { key: 'lanes', value: Object.keys(policy.lanes) },
      { key: 'network_allow', value: policy.network_allow ?? null },
      { key: 'pre_approved', value: policy.pre_approved ?? null },
    ],
    error: null,
  };
}

export interface PolicyChange {
  key: PolicyKey;
  from: unknown;
  to: unknown;
}

/** The change these values make, or why it is refused; nothing is written. */
export function planPolicy(o: { path: string; cfg: Config; values: Record<string, unknown>; limitsPath?: string }): { changes: PolicyChange[]; text: string; root: boolean } {
  const unknown = Object.keys(o.values).filter((k) => !(POLICY_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new PolicyEditError(`not editable here: ${unknown.join(', ')}; the form changes ${POLICY_KEYS.join(', ')}`);
  const { doc, policy, root } = read(o.path);
  const changes: PolicyChange[] = [];
  for (const k of POLICY_KEYS) {
    if (!(k in o.values) || o.values[k] === get(policy, k)) continue;
    changes.push({ key: k, from: get(policy, k), to: o.values[k] });
    doc.setIn(k.split('.'), o.values[k]);
  }
  if (!changes.length) throw new PolicyEditError('nothing to change');
  const parsed = PolicyFile.safeParse(doc.toJS());
  if (!parsed.success) throw new PolicyEditError(`refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const limits = loadLimits(o.limitsPath);
  const problems = [...settingsProblems(parsed.data.settings, limits, parsed.data)];
  if (parsed.data.budget.daily_usd > limits.daily_budget_usd.max) problems.push(`budget.daily_usd ${parsed.data.budget.daily_usd} is over ${limits.daily_budget_usd.max} (machine limits)`);
  if (parsed.data.agents.max_workers > limits.workers.max) problems.push(`agents.max_workers ${parsed.data.agents.max_workers} is over ${limits.workers.max} (machine limits)`);
  // INVARIANT: a policy the repo's config already loosens would stop the instance from loading at its next start.
  problems.push(...policyViolations(o.cfg, parsed.data).map((v) => `${v.file} ${v.path}: ${v.message}`));
  if (problems.length) throw new PolicyEditError(`refused: ${problems.join('; ')}`);
  return { changes, text: doc.toString(), root };
}

/**
 * Write a confirmed change: the plan again (the file may have changed since), atomically, 0600, and logged. A root
 * policy.yaml (src/policy-gate.ts) is never written here: refused, naming the root command.
 */
export function applyPolicy(o: { path: string; cfg: Config; values: Record<string, unknown>; eventsDb: string; by: string; limitsPath?: string }): PolicyChange[] {
  const plan = planPolicy(o);
  if (plan.root) throw new PolicyEditError(`${o.path} is root's: an admin changes it at a root shell (sudo ${BRAND.cli} policy set <instance> <key> <value>)`);
  replaceFileAtomically(o.path, plan.text, 0o600);
  const log = new EventLog(o.eventsDb);
  try {
    const at = new Date().toISOString();
    for (const c of plan.changes) log.append('settings.changed', { key: `policy.${c.key}`, from: c.from as never, to: c.to as never, by: o.by, at }, o.by, 'human');
  } finally {
    log.close();
  }
  return plan.changes;
}
