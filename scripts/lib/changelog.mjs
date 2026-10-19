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
  return revertsOf(pr, repo)[0] ?? null;
}

/**
 * Every PR a revert PR reverts, in order, each once: all its body's "Reverts" lines for this repo, else the title's
 * first #N (see revertOf). Empty for a PR whose title doesn't start "Revert". A PR never reverts itself: its own
 * number is left out, so it stays listed in its group.
 */
export function revertsOf(pr, repo) {
  if (!/^Revert\b/i.test(pr.title ?? '')) return [];
  const named = [];
  for (const m of String(pr.body ?? '').matchAll(/^[ \t]*Reverts[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gim)) {
    if (!m[1] || !repo || m[1].toLowerCase() === repo.toLowerCase()) named.push(Number(m[2]));
  }
  if (!named.length) {
    const t = /^Revert\b.*?#(\d+)/i.exec(pr.title);
    if (t) named.push(Number(t[1]));
  }
  return [...new Set(named)].filter((n) => n !== pr.number);
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
  // Each PR reverted in this release, by the first revert that names it. A revert is left out of the groups only
  // when every PR it reverts is in this release; one that also reverts an earlier release's PR stays listed.
  const targets = new Map(prs.map((pr) => [pr.number, revertsOf(pr, repo)]));
  const revertedBy = new Map();
  for (const pr of prs) for (const n of targets.get(pr.number)) if (numbers.has(n) && !revertedBy.has(n)) revertedBy.set(n, pr);
  const hidden = (pr) => targets.get(pr.number).length > 0 && targets.get(pr.number).every((n) => numbers.has(n));
  const listed = prs.filter((pr) => !revertedBy.has(pr.number) && !hidden(pr));
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
/** The version a released heading names, right after the `##` ("v0.5.3", "[0.5.3]"), or null. */
const versionIn = (h) => /^\[?v?(\d+\.\d+\.\d+)(?=[\s\])]|$)/i.exec(h)?.[1] ?? null;
const EXACT_VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+)(?![\w.])/gi;
/**
 * An unreleased heading's version, never guessed: the one X.Y.Z it names; '' when it names none (no digit at all:
 * `## Unreleased`); null when it is unclear (`## v0.6 (unreleased)`, `## Unreleased (0.6.x)`, two versions).
 */
const unreleasedVersion = (h) => {
  // Any numeric character, not only ASCII 0-9: `v０.６`, `v٠.٦`, `v²` and `Ⅵ` name a version too (#829 round 2).
  if (/\p{N}/u.test(h.replace(EXACT_VERSION, ''))) return null;
  const named = [...new Set([...h.matchAll(EXACT_VERSION)].map((m) => m[1]))];
  return named.length === 0 ? '' : named.length === 1 ? named[0] : null;
};
/** Whether a part is a section that could hold this version's notes: its own, or an unreleased one naming no version. */
const isFor = (part, version) => {
  const h = headingOf(part);
  if (h === null) return false;
  if (!isUnreleased(h)) return versionIn(h) === version;
  const v = unreleasedVersion(h);
  return v === '' || v === version;
};
/** A released section's heading: the version, then its date, as changelogSection writes it ("v0.5.2 (2026-10-17)"). */
const isDated = (h) => !isUnreleased(h) && /^\[?v?\d+\.\d+\.\d+\]?[ \t]+\(\d{4}-\d{2}-\d{2}\)/i.test(h);
/** A line this tool writes in a section's lists: a generated heading, a PR line, a "none" line, or NOTES_END. */
const isListLine = (l) =>
  GENERATED.test(l) || /^- .*\(#\d+\)(?::[^\n]*)?$/.test(l) || l === '- none in this release' || l === '- no merged PRs since the previous release' || l === NOTES_END;

/**
 * The lines of the input (trimmed, non-blank, counted) that `after` lacks. `segments`: [text, ignore(line)] in input
 * order, so a line is left out only where it may be (the fixed intro; the replaced section's heading and lists).
 */
function lost(segments, after) {
  const have = new Map();
  for (const l of after.split('\n')) if (l.trim()) have.set(l.trim(), (have.get(l.trim()) ?? 0) + 1);
  const out = [];
  for (const [text, ignore] of segments) {
    for (const l of text.split('\n')) {
      const t = l.trim();
      if (!t || ignore(t)) continue;
      if (have.get(t)) have.set(t, have.get(t) - 1);
      else out.push(t);
    }
  }
  return out;
}

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
 * More than one section that could be this version's (two unreleased, one beside a dated one, two dated) is
 * refused: it can't tell which notes are meant. A heading naming another version, even partly (`## v0.6
 * (unreleased)`), is never taken as this one's; it stays where it is.
 * Every line of the input that isn't the fixed intro or the replaced section's heading and generated lists must
 * be in the result (counted): otherwise (text it can't place in a section, say) it throws, and nothing is written.
 * The boundary: in a dated section the tool wrote lists for, every line after the notes shaped like a generated
 * line (isListLine: a generated heading, `- text (#N)` with or without `: files`, the "none" lines) is taken as
 * the tool's and replaced, as main always did, even one written there by hand. Any other line there is refused.
 */
export function withSection(existing, version, section) {
  const head = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n';
  const input = existing ?? '';
  const stripped = new RegExp(`^# Changelog\\n[\\s\\S]*?(?:${SECTION_START.source}|(?![\\s\\S]))`, 'im').exec(input);
  const body = stripped ? input.slice(0, stripped.index) + input.slice(stripped.index + stripped[0].length) : input;
  const parts = body.split(SECTION_START);
  const dated = parts.filter((s) => isFor(s, version) && isDated(headingOf(s)));
  const unreleased = parts.filter((s) => isFor(s, version) && !isDated(headingOf(s)));
  if (unreleased.length + dated.length > 1) {
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
  const out = `${head}\n${full.trimEnd()}\n${kept.length ? `\n${kept.map((s) => s.trimEnd()).join('\n\n')}\n` : ''}`;
  // INVARIANT: no hand-written line is dropped. Checked on the result, whatever the parsing above got wrong.
  const intro = new Set(head.split('\n').map((l) => l.trim()));
  const replaced = dated[0] ?? unreleased[0];
  const firstLine = replaced?.split('\n')[0].trim();
  const segments = parts.map((s) => [s, () => false]);
  if (stripped) segments.unshift([stripped[0], (l) => intro.has(l)]);
  if (replaced !== undefined) {
    const lists = whole === undefined;
    segments[segments.findIndex(([s]) => s === replaced)] = [replaced, (l) => l === firstLine || (lists && isListLine(l))];
  }
  const missing = lost(segments, out);
  if (missing.length) {
    throw new Error(
      `CHANGELOG.md: the changelog step would drop ${missing.length} line(s) it can't place, so nothing is written:\n  ${missing.slice(0, 5).join('\n  ')}\n` +
        `Put them in a section (\`## v${version} (unreleased)\` for this release), or remove them by hand.`,
    );
  }
  return out;
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
