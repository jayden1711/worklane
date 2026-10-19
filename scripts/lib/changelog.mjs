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

/**
 * The PR a revert PR reverts, or null when its title doesn't start "Revert". GitHub's revert button titles it
 * 'Revert "<original title>"', whose first #N can be any number the original title names, and writes the reverted
 * PR in the body: "Reverts owner/repo#N". So the body's line is read first (only for this repo when `repo` is
 * given; "Reverts #N" too), and the title's first #N ("Revert #N: ...") only when the body names none.
 */
export function revertOf(pr, repo) {
  if (!/^Revert\b/i.test(pr.title ?? '')) return null;
  // A PR never reverts itself: a number that is its own is read as none, so it stays listed in its group.
  const other = (n) => (n === pr.number ? null : n);
  for (const m of String(pr.body ?? '').matchAll(/^[ \t]*Reverts[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gim)) {
    if (!m[1] || !repo || m[1].toLowerCase() === repo.toLowerCase()) return other(Number(m[2]));
  }
  const t = /^Revert\b.*?#(\d+)/i.exec(pr.title);
  return t ? other(Number(t[1])) : null;
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
 * One release's changelog section. prs: { number, title, body?, labels?, files? } in merge order. Every PR is
 * listed in its group; a PR that changed a guardrail file is also listed under "Guardrail changes" with those files.
 * A PR reverted within the same release is in no group: it and its revert are listed together under "Reverted in
 * this release" (a reland is a PR of its own and listed as usual). `repo` (owner/repo): whose "Reverts" lines count.
 */
export function changelogSection(version, date, prs, repo) {
  const line = (pr) => `- ${pr.title.replace(/\s*\(#\d+\)\s*$/, '')} (#${pr.number})`;
  const numbers = new Set(prs.map((pr) => pr.number));
  const of = (pr) => revertOf(pr, repo);
  const revertedBy = new Map(prs.filter((pr) => numbers.has(of(pr))).map((pr) => [of(pr), pr]));
  const listed = prs.filter((pr) => !revertedBy.has(pr.number) && !numbers.has(of(pr)));
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
 * The line that ends a section's hand-written notes, written only when the generated headings alone can't show
 * where they end (the notes use one of those headings, say). Everything above it is kept on every rerun.
 */
export const NOTES_END = '<!-- The lists below are written by the release script. Everything above this line is kept. -->';
const NOTES_END_LINE = new RegExp(`^${NOTES_END.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')}[ \\t]*$`, 'gm');

/** Where a section starts: a `## v...` heading, or any `##` heading that says "unreleased" (any case). */
const SECTION_START = /(?=^##[ \t]+(?:v|[^\n]*\bunreleased\b))/im;

/** A section's heading text (after the `##`), or null when the part doesn't start with one. */
const headingOf = (part) => /^##[ \t]+([^\n]*)/.exec(part)?.[1] ?? null;
const isUnreleased = (h) => /\bunreleased\b/i.test(h);
/** The version a heading names: first after the `##` ("v0.5.3", "[0.5.3]"), or for an unreleased one, anywhere. */
const versionIn = (h) => /^\[?v?(\d+\.\d+\.\d+)(?=[\s\])]|$)/i.exec(h)?.[1] ?? (isUnreleased(h) ? /(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])/.exec(h)?.[1] : undefined) ?? null;
/** A released section's heading: the version, then its date, as changelogSection writes it ("v0.5.2 (2026-10-17)"). */
const isDated = (h) => !isUnreleased(h) && /^\[?v?\d+\.\d+\.\d+\]?[ \t]+\(\d{4}-\d{2}-\d{2}\)/i.test(h);
/** Whether a part is a section that could hold this version's notes: its own, or an unreleased one with no version. */
const isFor = (part, version) => {
  const h = headingOf(part);
  return h !== null && (isUnreleased(h) ? (versionIn(h) ?? version) === version : versionIn(h) === version);
};

/**
 * A section's hand-written notes: everything above the last NOTES_END line when it has one, else (a section
 * written before NOTES_END existed, or one whose notes need no marker) what sits above the first generated heading.
 */
export function notesOf(section) {
  const text = section ?? '';
  const ends = [...text.matchAll(NOTES_END_LINE)];
  if (!ends.length) return handWritten(text);
  return text.slice(0, ends.at(-1).index).replace(/^##[ \t][^\n]*\n?/, '').trim();
}

/**
 * CHANGELOG.md with the section for this version first. An existing section for the same version is replaced,
 * and none of its hand-written lines is ever dropped:
 * - an unreleased one (`## vX.Y.Z (unreleased)`, any case or spacing, or `## Unreleased` with no version), or any
 *   heading for this version that isn't the dated one (`## vX.Y.Z (draft)`, `## vX.Y.Z`), is all hand-written:
 *   every line of it is kept, whatever its headings are called (the generated ones included), under the new dated
 *   heading, and the generated lists come after it;
 * - a dated one (`## vX.Y.Z (YYYY-MM-DD)`, what this tool writes) keeps its notes (notesOf), so a rerun never
 *   drops what the first run kept; one with no generated heading (never regenerated) is kept whole, as above.
 * When the notes would read back differently without it, a NOTES_END line is written after them, and the result is
 * checked to read back exactly those notes: it throws rather than write a section that would lose one on a rerun.
 * Two unreleased sections that could both be this version's, or one beside a dated one, are refused: it can't
 * tell which notes are meant.
 */
export function withSection(existing, version, section) {
  const head = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n';
  const body = (existing ?? '').replace(new RegExp(`^# Changelog\\n[\\s\\S]*?(?:${SECTION_START.source}|(?![\\s\\S]))`, 'im'), '');
  const parts = body.split(SECTION_START);
  const dated = parts.filter((s) => isFor(s, version) && isDated(headingOf(s)));
  const unreleased = parts.filter((s) => isFor(s, version) && !isDated(headingOf(s)));
  if (unreleased.length > 1 || (unreleased.length && dated.length)) {
    const names = [...unreleased, ...dated].map((s) => `"## ${headingOf(s)}"`).join(', ');
    throw new Error(`CHANGELOG.md has more than one section for v${version} (${names}): merge them into one by hand first`);
  }
  const kept = parts.filter((s) => s.trim() && !unreleased.includes(s) && !dated.includes(s));
  // A section this tool never wrote lists for (no generated heading, no NOTES_END) is all notes, dated or not.
  const whole = unreleased[0] ?? (dated[0] && !GENERATED.test(dated[0]) && !dated[0].match(NOTES_END_LINE) ? dated[0] : undefined);
  const notes = whole !== undefined ? whole.replace(/^##[ \t][^\n]*\n?/, '').trim() : notesOf(dated[0]);
  const own = notesOf(section);
  if (own && notes && own !== notes && whole !== undefined) throw new Error(`the new v${version} section has notes of its own, and the unreleased one has others: merge them by hand first`);
  let full = section;
  if (notes && !own) {
    const [title, ...rest] = section.split('\n');
    const lists = rest.join('\n').replace(/^\n/, '');
    full = `${title}\n\n${notes}\n\n${lists}`;
    if (notesOf(full) !== notes) full = `${title}\n\n${notes}\n\n${NOTES_END}\n\n${lists}`;
    if (notesOf(full) !== notes) throw new Error(`v${version}: the section's notes wouldn't read back whole on a rerun; nothing written`);
  }
  return `${head}\n${full.trimEnd()}\n${kept.length ? `\n${kept.map((s) => s.trimEnd()).join('\n\n')}\n` : ''}`;
}

/**
 * What the tag step tags with: { notes } (the version's section, without any NOTES_END line), or { problem }.
 * Fails closed: the version must have exactly one section, with the dated heading changelogSection writes
 * (`## vX.Y.Z (YYYY-MM-DD)`, a real date) and its generated lists, and nothing that could also be its notes (an
 * `(unreleased)` heading for it, or `## Unreleased` with no version) anywhere in the file.
 */
export function tagNotes(changelog, version) {
  const run = `run \`node scripts/release.mjs changelog ${version}\` and merge it first`;
  const ours = String(changelog ?? '').split(SECTION_START).filter((s) => isFor(s, version));
  if (!ours.length) return { problem: `CHANGELOG.md at HEAD has no v${version} section: ${run}` };
  if (ours.length > 1) return { problem: `CHANGELOG.md at HEAD has more than one section for v${version} (${ours.map((s) => `"## ${headingOf(s)}"`).join(', ')}): merge them, then ${run}` };
  const [section] = ours;
  // The raw heading line, byte for byte as changelogSection writes it (one space, lowercase v, nothing after).
  const first = section.split('\n')[0];
  const date = new RegExp(`^## v${version.replace(/\./g, '\\.')} \\((\\d{4}-\\d{2}-\\d{2})\\)$`).exec(first)?.[1];
  const when = date ? new Date(`${date}T00:00:00Z`) : null;
  const real = when !== null && !Number.isNaN(when.getTime()) && when.toISOString().slice(0, 10) === date;
  if (!real) return { problem: `CHANGELOG.md at HEAD has ${JSON.stringify(first)}, not the dated heading "## v${version} (YYYY-MM-DD)" the changelog step writes: ${run}` };
  if (!/^### Guardrail changes[ \t]*$/m.test(section)) return { problem: `CHANGELOG.md at HEAD's v${version} section has no generated lists (no "### Guardrail changes"): ${run}` };
  // The NOTES_END line withSection writes (blank line, the line, blank line) goes; nothing else in the notes changes.
  const notes = section.replace(new RegExp(`\\n\\n${NOTES_END_LINE.source.replace(/^\^/, '')}(?=\\n)`, 'gm'), '').trimEnd();
  return { notes };
}

/** The section for a version in a CHANGELOG.md, or null: the GitHub release notes. */
export function sectionFor(changelog, version) {
  const m = new RegExp(`^## v${version.replace(/\./g, '\\.')} [\\s\\S]*?(?=^## v|(?![\\s\\S]))`, 'm').exec(changelog ?? '');
  return m ? m[0].trimEnd() : null;
}
