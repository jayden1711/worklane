// `instance set-budget <name> <usd>`: the instance policy's daily budget (the cap the repo's agents.yaml may
// only lower), set by its coordinator user (the helper's set-budget runs it as that user, never as root).
// Bounded by the machine's limits file; written atomically, 0600.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { CredentialsFile, InstanceFile, instancesDir, PolicyFile } from '../instance.js';
import { replaceFileAtomically } from '../os/index.js';
import { loadLimits, SettingsError } from '../settings.js';

/**
 * `instance set-agent-api-key <name>`: point credentials.yaml's agent_api_key at the key `credentials.sh <name> api-key`
 * installed (<agent home>/.config/<name>-claude-key/api_key), so doctor and the runner use it. Run as the coordinator
 * user (the helper's install-api-key does, after the script); the key itself is never read here.
 */
export function setAgentApiKey(name: string, o: { dir?: string } = {}): string {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new SettingsError(`instance name ${name}: lowercase letters, digits and dashes`);
  const home = join(o.dir ?? instancesDir(), name);
  const inst = InstanceFile.parse(parseDocument(readFileSync(join(home, 'instance.yaml'), 'utf8')).toJS());
  if (!inst.run_as) throw new SettingsError(`${name} has no agent user (instance.yaml run_as)`);
  const key = `${inst.run_as.agent_home.replace(/\/+$/, '')}/.config/${name}-claude-key/api_key`;
  const file = join(home, 'credentials.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  doc.set('agent_api_key', key);
  const r = CredentialsFile.safeParse(doc.toJS());
  if (!r.success) throw new SettingsError(`refused: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  replaceFileAtomically(file, doc.toString(), 0o600);
  return key;
}

export function setInstanceBudget(name: string, usd: number, o: { dir?: string; limitsPath?: string } = {}): { from: number; to: number } {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new SettingsError(`instance name ${name}: lowercase letters, digits and dashes`);
  const max = loadLimits(o.limitsPath).daily_budget_usd.max;
  if (!Number.isFinite(usd) || usd <= 0 || usd > max) throw new SettingsError(`the daily budget must be more than 0 and at most $${max} (the machine's limit), not ${usd}`);
  const file = join(o.dir ?? instancesDir(), name, 'policy.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const before = PolicyFile.parse(doc.toJS());
  doc.setIn(['budget', 'daily_usd'], usd);
  const after = PolicyFile.safeParse(doc.toJS());
  if (!after.success) throw new SettingsError(`refused: ${after.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  replaceFileAtomically(file, doc.toString(), 0o600);
  return { from: before.budget.daily_usd, to: usd };
}
