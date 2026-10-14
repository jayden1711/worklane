// The changelog for a release, from the PRs merged since the previous one. Pure: the release script gathers
// the commit subjects (git) and the PRs (one GitHub listing), this groups and writes them.

/** Files whose change is a guardrail change: the rules, the hooks that apply them, the sandbox and the scanners. */
export const GUARDRAIL_PATHS = [/^src\/guardrails\//, /^src\/hook\.ts$/, /^src\/sandbox\.ts$/, /^src\/scan\//, /^src\/push-check\.ts$/, /^templates\/project\/guardrails/];

/**
 * The PR numbers in first-parent commit subjects, oldest first: a squash merge ends "(#N)"; a merge commit names
 * its PR ("Merge #N: title", GitHub's "Merge pull request #N from ..."), or the range of a reviewed stack it brings
 * in ("Merge stages 1-5 (reviewed PRs #8-#22) into main"); a batch merge ("Batch 4: #170 #156 (#184)") names each
 * PR it merged, and those are listed rather than the batch itself. Any other merge (main into a branch) names none.
 */
export function prNumbers(subjects) {
  const out = [];
  for (const s of subjects) {
    const merged = /^Merge (?:#(\d+):|pull request #(\d+) from )/.exec(s);
    const range = /^Merge .*\bPRs #(\d+)\s*[-–]\s*#(\d+)\b/.exec(s);
    const batch = /^Batch \d+(?: \([^)]*\))?:((?:\s*#\d+)+)\s*\(#\d+\)\s*$/.exec(s);
    const squash = /\(#(\d+)\)\s*$/.exec(s);
    let nums;
    if (merged) nums = [Number(merged[1] ?? merged[2])];
    else if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      nums = b >= a && b - a < 200 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [];
    } else if (batch) nums = [...batch[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    // A squash merge whose title starts with the word ("Merge train: ... (#296)") is still a PR.
    else if (squash) nums = [Number(squash[1])];
    else continue;
    for (const n of nums) if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * A PR title without the words the repo's denylist refuses (`denied(word)`, e.g. an internal ticket key), so a
 * regenerated changelog passes the denylist check without a hand edit that the next run would undo.
 */
export function scrubTitle(title, denied) {
  return title
    .split(/(\s+)/)
    .filter((w) => !w.trim() || !denied(w))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The PR a PR reverts, from its title ("Revert #N: ..." or GitHub's 'Revert "title" (#N)'), or null. */
export function revertOf(pr) {
  const m = /^Revert\b.*?#(\d+)/i.exec(pr.title ?? '');
  return m ? Number(m[1]) : null;
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
 * A PR reverted within the same release is in no group: it and its revert are listed together under "Reverted in
 * this release" (a reland is a PR of its own and listed as usual).
 */
export function changelogSection(version, date, prs) {
  const line = (pr) => `- ${pr.title.replace(/\s*\(#\d+\)\s*$/, '')} (#${pr.number})`;
  const numbers = new Set(prs.map((pr) => pr.number));
  const revertedBy = new Map(prs.filter((pr) => numbers.has(revertOf(pr))).map((pr) => [revertOf(pr), pr]));
  const listed = prs.filter((pr) => !revertedBy.has(pr.number) && !numbers.has(revertOf(pr)));
  const out = [`## v${version} (${date})`, ''];
  const groups = [['features', 'Features'], ['fixes', 'Fixes'], ['security', 'Security and guardrails']];
  for (const [key, heading] of groups) {
    const these = listed.filter((pr) => groupOf(pr) === key);
    if (these.length) out.push(`### ${heading}`, '', ...these.map(line), '');
  }
  const reverted = prs.filter((pr) => revertedBy.has(pr.number));
  if (reverted.length) out.push('### Reverted in this release', '', ...reverted.map((pr) => `${line(pr)}: reverted by #${revertedBy.get(pr.number).number}`), '');
  const guard = listed.filter(isGuardrail);
  out.push('### Guardrail changes', '');
  if (!guard.length) out.push('- none in this release', '');
  for (const pr of guard) out.push(`${line(pr)}: ${(pr.files ?? []).filter((f) => GUARDRAIL_PATHS.some((re) => re.test(f))).join(', ')}`);
  if (guard.length) out.push('');
  if (!prs.length) out.splice(2, 0, '- no merged PRs since the previous release', '');
  return out.join('\n');
}

/** The headings this tool writes. Anything in a section above the first of them is written by hand. */
const GENERATED = /^### (?:Features|Fixes|Security and guardrails|Reverted in this release|Guardrail changes)[ \t]*$/m;

/** A section's hand-written top (highlights, upgrade notes): what sits between its title and the generated lists. */
export function handWritten(section) {
  const body = (section ?? '').replace(/^## v[^\n]*\n?/, '').replace(/^- no merged PRs since the previous release$/m, '');
  const at = body.search(GENERATED);
  return at < 0 ? '' : body.slice(0, at).trim();
}

/**
 * CHANGELOG.md with the section for this version first. An existing section for the same version is replaced,
 * keeping its hand-written top, so regenerating the lists never drops the highlights or the upgrade notes.
 */
export function withSection(existing, version, section) {
  const head = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n';
  const body = (existing ?? '').replace(/^# Changelog\n[\s\S]*?(?=^## v|(?![\s\S]))/m, '');
  const parts = body.split(/(?=^## v)/m);
  const kept = parts.filter((s) => s.trim() && !s.startsWith(`## v${version} `));
  const lead = handWritten(parts.find((s) => s.startsWith(`## v${version} `)));
  const full = lead && !handWritten(section) ? section.replace(/^(## v[^\n]*\n)\n?/, (_, title) => `${title}\n${lead}\n\n`) : section;
  return `${head}\n${full.trimEnd()}\n${kept.length ? `\n${kept.map((s) => s.trimEnd()).join('\n\n')}\n` : ''}`;
}

/** The section for a version in a CHANGELOG.md, or null: the GitHub release notes. */
export function sectionFor(changelog, version) {
  const m = new RegExp(`^## v${version.replace(/\./g, '\\.')} [\\s\\S]*?(?=^## v|(?![\\s\\S]))`, 'm').exec(changelog ?? '');
  return m ? m[0].trimEnd() : null;
}
