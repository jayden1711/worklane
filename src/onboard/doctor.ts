// The last step of `add`: the instance's own doctor (run as its coordinator, through the helper) and
// onboarding's checks, each failure with the fix for it.
import { BRAND } from '../brand.js';
import type { DoctorCheck } from '../doctor.js';
import { stagedSecrets } from './answer.js';

export type FixedCheck = DoctorCheck & { fix: string };

interface OnboardingView {
  name: string;
  repo: string;
  dir: string;
  steps(): { step: string; status: string; detail: string }[];
}

/** The fix for a doctor check, by its name; the check's own detail when it already says what to do. */
export function fixFor(c: DoctorCheck, name: string, repo: string): string {
  const again = `run \`${BRAND.cli} add ${repo}\` again`;
  const n = c.name;
  if (n === 'config' || n.startsWith('policy')) return `fix ${BRAND.configDir}/ in a PR to the default branch (the setup PR's config, adjusted), then ${again}`;
  if (n.startsWith('agent hook') || n === 'project settings') return `the checkout step writes them: ${again} (it re-runs checkout)`;
  if (n === 'gitleaks') return `install the pinned tools: sudo bash /usr/local/libexec/${BRAND.cli}-setup/tools.sh <claude-code version>`;
  if (n === 'claude') return `install Claude Code for every user: sudo bash /usr/local/libexec/${BRAND.cli}-setup/tools.sh <claude-code version>`;
  if (n === 'node') return `install Node 24: sudo bash /usr/local/libexec/${BRAND.cli}-setup/node.sh`;
  if (n === 'guardrails') return `fix the rules or examples in ${BRAND.configDir}/guardrails.yaml (\`${BRAND.cli} guardrails check\` lists them)`;
  if (n.startsWith('fingerprints')) return `as wl-${name}: \`${BRAND.cli} guardrails refresh\` once guardrails.yaml has the command`;
  if (n === 'owners') return `set owners in ${BRAND.configDir}/config.yaml`;
  if (n === 'pre-commit') return `the checkout step installs it: ${again}`;
  if (n === 'skills') return 'fix the SKILL.md files the detail lists';
  if (n === 'hooks') return 'none needed for an instance';
  return c.detail.split('\n')[0] ?? again;
}

/** The instance doctor's JSON (what the helper's instance-doctor printed), or a failing check saying why there's none. */
export function parseDoctor(output: string): DoctorCheck[] | null {
  const i = output.indexOf('[');
  if (i < 0) return null;
  try {
    const j = JSON.parse(output.slice(i)) as unknown;
    return Array.isArray(j) && j.every((c) => c && typeof c === 'object' && typeof (c as DoctorCheck).name === 'string' && ['ok', 'warn', 'fail'].includes((c as DoctorCheck).level)) ? (j as DoctorCheck[]) : null;
  } catch {
    return null;
  }
}

export function onboardDoctor(o: { instanceDoctor: string; onboarding: OnboardingView }): FixedCheck[] {
  const { name, repo, dir } = o.onboarding;
  const out: FixedCheck[] = [];
  const parsed = parseDoctor(o.instanceDoctor);
  if (!parsed) out.push({ name: 'instance doctor', level: 'fail', detail: `no report from \`${BRAND.cli} doctor --instance ${name}\`: ${o.instanceDoctor.slice(0, 300) || 'it printed nothing'}`, fix: `the helper's instance-doctor ran nothing usable: check that the engine is installed (/usr/local/bin/${BRAND.cli}) and wl-${name} exists, then run \`${BRAND.cli} add ${repo}\` again` });
  else for (const c of parsed) out.push({ ...c, fix: c.level === 'ok' ? '' : fixFor(c, name, repo) });
  const latest = new Map<string, { status: string; detail: string }>();
  for (const s of o.onboarding.steps()) latest.set(s.step, s);
  for (const [step, s] of latest) {
    if (step === 'doctor' || s.status !== 'failed') continue;
    out.push({ name: `setup ${step}`, level: 'fail', detail: s.detail, fix: `run \`${BRAND.cli} add ${repo}\` again; it continues at this step` });
  }
  const left = stagedSecrets(dir);
  out.push(left.length ? { name: 'staged secrets', level: 'fail', detail: `still staged for setup: ${left.join(', ')}`, fix: `they're installed by their root steps, which delete them; delete ${dir}/secrets yourself if you stopped there` } : { name: 'staged secrets', level: 'ok', detail: 'none left: every key and token went to its owner user', fix: '' });
  return out;
}
