// The changelog for a release, from the PRs merged since the previous one. Pure: the release script gathers
// the commit subjects (git) and the PRs (one GitHub listing), this groups and writes them.

/** Files whose change is a guardrail change: the rules, the hooks that apply them, the sandbox and the scanners. */
export const GUARDRAIL_PATHS = [/^src\/guardrails\//, /^src\/hook\.ts$/, /^src\/sandbox\.ts$/, /^src\/scan\//, /^src\/push-check\.ts$/, /^templates\/project\/guardrails/];

/**
 * The PR numbers in first-parent commit subjects, oldest first: a squash merge ends "(#N)"; a batch merge
 * ("Batch 4: #170 #156 (#184)") names each PR it merged, and those are listed rather than the batch itself.
 */
export function prNumbers(subjects) {
  const out = [];
  for (const s of subjects) {
    if (/^Merge /.test(s)) continue;
    const batch = /^Batch \d+:((?:\s*#\d+)+)\s*\(#\d+\)\s*$/.exec(s);
    const nums = batch ? [...batch[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [Number(/\(#(\d+)\)\s*$/.exec(s)?.[1] ?? NaN)];
    for (const n of nums) if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

const isGuardrail = (pr) => (pr.files ?? []).some((f) => GUARDRAIL_PATHS.some((re) => re.test(f)));
const labelled = (pr, ...names) => (pr.labels ?? []).some((l) => names.includes(String(l).toLowerCase()));

/** Which group a PR goes in: security and guardrails, fixes, or features. */
export function groupOf(pr) {
  if (isGuardrail(pr) || labelled(pr, 'security', 'guardrails') || /\b(security|guardrails?|secrets?|sandbox|permissions?|credentials?|denylist)\b/i.test(pr.title)) return 'security';
  if (labelled(pr, 'bug', 'fix') || /\b(fix|fixes|fixed|regression|bug|crash)\b/i.test(pr.title) || /^fix\b/i.test(pr.title)) return 'fixes';
  return 'features';
}

/**
 * One release's changelog section. prs: { number, title, labels?, files? } in merge order. Every PR is listed
 * in its group; a PR that changed a guardrail file is also listed under "Guardrail changes" with those files.
 */
export function changelogSection(version, date, prs) {
  const line = (pr) => `- ${pr.title.replace(/\s*\(#\d+\)\s*$/, '')} (#${pr.number})`;
  const out = [`## v${version} (${date})`, ''];
  const groups = [['features', 'Features'], ['fixes', 'Fixes'], ['security', 'Security and guardrails']];
  for (const [key, heading] of groups) {
    const these = prs.filter((pr) => groupOf(pr) === key);
    if (these.length) out.push(`### ${heading}`, '', ...these.map(line), '');
  }
  const guard = prs.filter(isGuardrail);
  out.push('### Guardrail changes', '');
  if (!guard.length) out.push('- none in this release', '');
  for (const pr of guard) out.push(`${line(pr)}: ${(pr.files ?? []).filter((f) => GUARDRAIL_PATHS.some((re) => re.test(f))).join(', ')}`);
  if (guard.length) out.push('');
  if (!prs.length) out.splice(2, 0, '- no merged PRs since the previous release', '');
  return out.join('\n');
}

/** CHANGELOG.md with the section for this version first; an existing section for the same version is replaced. */
export function withSection(existing, version, section) {
  const head = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n';
  const body = (existing ?? '').replace(/^# Changelog\n[\s\S]*?(?=^## v|(?![\s\S]))/m, '');
  const kept = body.split(/(?=^## v)/m).filter((s) => s.trim() && !s.startsWith(`## v${version} `));
  return `${head}\n${section.trimEnd()}\n${kept.length ? `\n${kept.map((s) => s.trimEnd()).join('\n\n')}\n` : ''}`;
}

/** The section for a version in a CHANGELOG.md, or null: the GitHub release notes. */
export function sectionFor(changelog, version) {
  const m = new RegExp(`^## v${version.replace(/\./g, '\\.')} [\\s\\S]*?(?=^## v|(?![\\s\\S]))`, 'm').exec(changelog ?? '');
  return m ? m[0].trimEnd() : null;
}
