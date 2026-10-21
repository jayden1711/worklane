// Risk-based review levels, computed by code from what a change touches.
// The highest matching level wins; a failed or low-confidence evaluator
// verdict bumps it up one; an agent can raise its own level, never lower it.
import { spawnSync } from './os/child-process.js';
import { posix } from 'node:path';
import type { ReviewConfig } from './config/schema.js';
import { globToRegExp } from './guardrails/glob.js';
import { BRAND } from './brand.js';
import { HOOK_IMPORTS } from './hook-imports.js';
import { hasControlCharacter, hasInvisibleCharacter, hasNonAsciiTopLevel, isNonUtf8Path, shownPath, shownPaths } from './path-text.js';

// The odd-name tests and how a reason shows a path live in src/path-text.ts (one module the merge policy, the conflict
// fix and the coordinator share); re-exported here for the callers that read them with the review levels.
export { escapedPath, hasControlCharacter, hasInvisibleCharacter, hasNonAsciiTopLevel, isNonUtf8Path, shownPath, shownPaths } from './path-text.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
const ORDER: Level[] = ['L0', 'L1', 'L2', 'L3'];
const up = (l: Level): Level => ORDER[Math.min(3, ORDER.indexOf(l) + 1)]!;

/**
 * The agents' own instructions: the config folder's roles and skills (the one part of it agents may edit), the root
 * AGENTS.md and every CLAUDE.md. Always high-risk, so their PRs never auto-merge (merge-policy.ts
 * waitCategoriesOf), whatever review.yaml says; review.yaml can't redefine, drop or loosen it.
 */
export const AGENT_INSTRUCTIONS = 'agent-instructions';

/**
 * A changed path with a control character in it (a newline, a tab, an escape, ...). Nothing should have to read
 * around one (a glob, a log line, the owner), so such a change is always L3 ("path with a control character") and
 * never auto-merges (merge-policy.ts waitCategoriesOf), whatever review.yaml says (#683).
 */
export const CONTROL_CHARACTER_PATH = 'control-character-path';

/**
 * A changed path whose name isn't valid UTF-8 (a byte like 0xff). It can't be read as itself: every reader decodes
 * its bad bytes as U+FFFD, and that string names no file git knows, so its lines and blobs can't be asked for. Like
 * a control character, such a change is always L3 ("path that isn't valid UTF-8") and never auto-merges
 * (merge-policy.ts waitCategoriesOf), whatever review.yaml says (#683).
 */
export const NON_UTF8_PATH = 'non-utf8-path';

/**
 * A changed path with an invisible or format character in it: a bidi override or isolate (`docs/<U+202E>dm.exe.md`
 * reads as `docs/md.exe.md`), a zero-width character, a soft hyphen, or any other character that shows as nothing or
 * reorders what is around it. Such a name can read as another in a file list or a hold reason, so the change is
 * always L3 ("path with an invisible or format character") and never auto-merges (merge-policy.ts waitCategoriesOf),
 * whatever review.yaml says (#683, the owner's call).
 */
export const INVISIBLE_CHARACTER_PATH = 'invisible-character-path';

/**
 * A changed path whose first segment (its top-level directory, or a file at the root) has a character outside ASCII:
 * a look-alike of a real one, like Cyrillic `ѕrc/` beside `src/`. Further down, a name like `docs/naïve.md` is an
 * ordinary name; at the top it can pass for a module the reader trusts. Always L3 ("top-level name that isn't ASCII")
 * and never auto-merges (merge-policy.ts waitCategoriesOf), whatever review.yaml says (#683, the owner's call).
 */
export const NON_ASCII_TOP_LEVEL_PATH = 'non-ascii-top-level-path';

/** The categories of a path nothing should have to read around: always L3, always waits, never loosened. */
// check-table: never-shrink
export const ODD_PATH_CATEGORIES: readonly string[] = [CONTROL_CHARACTER_PATH, NON_UTF8_PATH, INVISIBLE_CHARACTER_PATH, NON_ASCII_TOP_LEVEL_PATH];

/**
 * A change to a .gitattributes (any directory's) that can hide or change what a review of a file sees: `-diff` or
 * `binary` ("Binary files differ", no lines), `linguist-generated` (GitHub folds the file away in a PR), a `filter`
 * (git-lfs: the review sees a pointer, a checkout gets other content), a `working-tree-encoding` (the blob a review
 * reads is the file re-encoded: `IBM037` turns ASCII code into one line of noise, and a checkout turns it back), a
 * diff driver git doesn't ship (its textconv or binary setting lives in a config the review can't see), any name not
 * known to be harmless, a macro definition (`[attr]quiet -diff`, or quoted as git reads it: `"[attr] quiet" -diff`;
 * any line whose unquoted pattern starts with `[`, or that git can't unquote, counts as one), or a name some
 * .gitattributes in the base or head tree defines as a macro (`[attr]eol -diff` on main makes `*.job eol` hide the
 * file). Taking away a line that turned one of those off (`*.sql -filter`), or a macro definition, counts too. A
 * changed .gitmodules whose base or head sets any `ignore` to anything but `none`, as git's own config parser reads it
 * (or that git can't parse), counts the same: it hides submodule links, including one an existing `ignore = all` is
 * moved onto by editing `path`. Any case and NTFS's other spellings of either name (a trailing dot, an 8.3 or fall-back
 * short name) count; an HFS-ignorable spelling (`.gitattributes<U+200C>`) is L3 through INVISIBLE_CHARACTER_PATH
 * instead. Above those line checks, git judges the outcome itself (ChangeFile attributeOutcome): any path whose
 * attributes change between the trees in a way that can show less (attributeTransitionHides), by git's own reading of
 * every .gitattributes, flags the change, whatever its lines look like. The harness's own readers ignore attributes and submodule
 * settings (coordinator/change-files.ts), but the owner reviewing on GitHub and a checkout don't, so such a change is
 * always L3 and never auto-merges (merge-policy.ts waitCategoriesOf), whatever review.yaml says (#693). Fails
 * closed: only the names below pass.
 */
export const DIFF_HIDING_ATTRIBUTES = 'diff-hiding-attributes';

/** From `i` on, only spaces and periods, then the end or an NTFS stream (`:...`). */
const trailingOnly = (s: string, i: number): boolean => /^[ .]*(?::|$)/.test(s.slice(i));

/**
 * Whether a path's last segment is `.<name>` as a file system may open it. Fails closed: such a name is judged as the
 * real file. The forms, as git documents its own check (is_ntfs_dotgitattributes / is_ntfs_dotgitmodules) and as `git
 * fsck --strict` classifies names (measured in test/change-files-renames.test.ts against git itself):
 * - `.<name>` in any case, then only spaces or periods, then the end or an NTFS stream (`.gitattributes::$DATA`);
 * - the 8.3 short name: the first 6 letters of the name, `~`, a digit 1-4 (`GITATT~1`), then the same tail;
 * - the fall-back short name NTFS makes from a hash, 8 characters long: k (0 to 6) ASCII characters that are the first k
 *   of `hash` in any case, then `~`, a digit 1-9 and digits to the 8th character (`GI7D29~1`, `gi7eb~10`, `g~123456`),
 *   then the same tail.
 * Written here from that description, not from git's source.
 */
function isDotFile(path: string, name: string, hash: string): boolean {
  const base = path.split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (lower.startsWith(`.${name}`) && trailingOnly(lower, name.length + 1)) return true;
  if (new RegExp(`^${name.slice(0, 6)}~[1-4]`).test(lower) && trailingOnly(lower, 8)) return true;
  const k = base.indexOf('~');
  if (k < 0 || k > 6 || base.length < 8) return false;
  const prefix = base.slice(0, k);
  return /^[\x00-\x7f]*$/.test(prefix) && prefix.toLowerCase() === hash.slice(0, k) && /^[1-9][0-9]*$/.test(base.slice(k + 1, 8)) && trailingOnly(base, 8);
}
/** A .gitattributes in any directory, in any case or other spelling a file system opens as one. */
export const isGitattributesPath = (path: string): boolean => isDotFile(path, 'gitattributes', 'gi7d29');
/** A .gitmodules in any directory, in any case or other spelling a file system opens as one. */
export const isGitmodulesPath = (path: string): boolean => isDotFile(path, 'gitmodules', 'gi7eba');
/** Attributes that change line endings, whitespace checks, archives, merges or GitHub's language stats: nothing a review reads. */
const HARMLESS_ATTRIBUTES = new Set([
  'text', 'eol', 'crlf', 'whitespace', 'export-ignore', 'ident', 'delta', 'encoding', 'merge', 'conflict-marker-size',
  'linguist-language', 'linguist-detectable', 'linguist-vendored', 'linguist-documentation',
]);
/** The diff drivers git ships (hunk headers and word splitting only): `diff=python` changes no line a review sees. */
const BUILTIN_DIFF_DRIVERS = new Set([
  'ada', 'bash', 'bibtex', 'cpp', 'csharp', 'css', 'dts', 'elixir', 'fortran', 'fountain', 'golang', 'html', 'java', 'kotlin', 'markdown', 'matlab',
  'objc', 'pascal', 'perl', 'php', 'python', 'ruby', 'rust', 'scheme', 'tex',
]);

/** git's escapes in a C-quoted string (quote.c unquote_c_style), besides `\ooo` octal. */
const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };

/**
 * A C-quoted string at the start of `s` (which starts with `"`), unquoted as git does: its value and what follows the
 * closing quote, or null when git can't unquote it (an unknown escape, no closing quote).
 */
function cUnquote(s: string): { value: string; rest: string } | null {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), rest: s.slice(i + 1) };
    if (ch !== '\\') {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = s[++i];
    if (next === undefined) return null;
    if (next in C_ESCAPES) bytes.push(C_ESCAPES[next]!.charCodeAt(0));
    else if (/[0-3]/.test(next) && /^[0-7]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else return null;
  }
  return null;
}

/** git's blanks in a .gitattributes line (attr.c): only these are skipped before a comment or a quoted pattern. */
const GIT_BLANK = /^[ \t\r\n]*/;

/**
 * How a .gitattributes line is read. 'git': as git's attr.c parse_attr_line does, skipping only git's blanks (space,
 * tab, CR, LF) before the pattern, which then runs to the next git blank: `<NBSP>#* -diff` is a pattern with `-diff`
 * to git, not a comment. 'any-space': skipping and splitting on any JavaScript whitespace, as other readers may (GitHub's
 * linguist goes through libgit2, whose blanks include `\v` and `\f`), so `*.sql<VT>linguist-generated` has an
 * attribute. Every check reads a line every way and flags it if any reading does (readings): reading more than git
 * never reads less.
 */
type Way = 'git' | 'any-space';

/**
 * A .gitattributes line read one `way`: its pattern (C-unquoted when it starts with `"`) and what follows it; null
 * for a blank line or a comment; 'unreadable' when a quoted pattern can't be unquoted.
 */
function attrLine(line: string, way: Way): { pattern: string; rest: string } | 'unreadable' | null {
  const t = way === 'git' ? line.replace(GIT_BLANK, '') : line.replace(/^\s*/, '');
  if (!t || t.startsWith('#')) return null;
  if (t.startsWith('"')) {
    const u = cUnquote(t);
    return u ? { pattern: u.value, rest: u.rest } : 'unreadable';
  }
  const m = (way === 'git' ? /^([^ \t\r\n]+)([\s\S]*)$/ : /^(\S+)([\s\S]*)$/).exec(t)!;
  return { pattern: m[1]!, rest: m[2]! };
}

/**
 * Every reading of a line: git's way and the any-whitespace way, each of the line and (when it starts with a BOM, which
 * git drops on a file's first line only) of the line without it.
 */
const readings = (line: string): ({ pattern: string; rest: string } | 'unreadable' | null)[] =>
  (line.startsWith('﻿') ? [line, line.slice(1)] : [line]).flatMap((l) => [attrLine(l, 'git'), attrLine(l, 'any-space')]);

/** The attributes in one reading of a line: what follows its pattern (or `[attr]name`). */
function attributesIn(p: { pattern: string; rest: string } | 'unreadable' | null): { sign: string; name: string; value: string | undefined }[] {
  if (!p || p === 'unreadable') return [];
  return p.rest.split(/\s+/).filter(Boolean).map((a) => {
    const m = /^([-!]?)([^=]*)(?:=(.*))?$/.exec(a)!;
    return { sign: m[1]!, name: m[2]!, value: m[3] };
  });
}

/** Every attribute any reading of a line finds. */
const attributesOf = (line: string) => readings(line).flatMap(attributesIn);

/**
 * A macro definition, or a line that may be one, in any reading: its pattern, unquoted as git does (`"[attr] eol" -diff`
 * is a macro to git), starts with `[`, or it is quoted and can't be unquoted. Fails closed.
 */
const isMacroDefinition = (line: string): boolean => readings(line).some((p) => p === 'unreadable' || (p !== null && p.pattern.startsWith('[')));

/**
 * The macros a .gitattributes line defines, in any reading: `[attr]` then optional blanks then the name, from the
 * unquoted pattern; '*' (every name) when the line may define one whose name can't be read (fails closed).
 */
export function macrosDefined(line: string): string[] {
  return [
    ...new Set(
      readings(line).flatMap((p) => {
        if (p === null) return [];
        if (p === 'unreadable') return ['*'];
        if (!p.pattern.startsWith('[')) return [];
        const m = /^\[attr\][ \t\r\n]*([^ \t\r\n]+)/.exec(p.pattern);
        return [m ? m[1]! : '*'];
      }),
    ),
  ];
}

/** Whether a line uses a name the base or head tree defines as a macro (`*`: a definition whose name can't be read). */
const usesMacro = (line: string, macros: readonly string[]): boolean => attributesOf(line).some(({ name }) => macros.includes(name) || macros.includes('*'));

/**
 * Whether a line a change adds to a .gitattributes can hide or change what a review sees (fails closed). `macros`: the
 * names any .gitattributes in the base or head tree defines with `[attr]` (ChangeFile.attributeMacros); `*` among them
 * means a definition whose name couldn't be read, so every attribute counts as one.
 */
export function hidesDiff(line: string, macros: readonly string[] = []): boolean {
  if (isMacroDefinition(line) || usesMacro(line, macros)) return true;
  return attributesOf(line).some(({ sign, name, value }) => {
    if (HARMLESS_ATTRIBUTES.has(name)) return false;
    // `diff` set (always text), or a driver git ships; `-diff` and any other driver hide or change lines, and `!diff`
    // can take away an earlier forced `diff` (a file with a NUL byte goes back to "Binary files differ").
    if (name === 'diff') return sign === '-' || sign === '!' || (value !== undefined && !BUILTIN_DIFF_DRIVERS.has(value));
    // Turning GitHub's fold off, or a filter off, shows more.
    if ((name === 'linguist-generated' && (sign !== '' || value === 'false')) || (name === 'filter' && sign !== '')) return false;
    return true;
  });
}

/**
 * Whether a line a change takes out of a .gitattributes had turned off something that hides (`*.sql -filter`, `*.sql
 * diff`), defined a macro (the lines that use it now mean something else), or used one (`*.ts showme`, where a macro on
 * main turns the diff back on: taking it away lets an earlier `-diff` hide the file). `macros` as for hidesDiff.
 */
export function unhidLine(line: string, macros: readonly string[] = []): boolean {
  if (isMacroDefinition(line) || usesMacro(line, macros)) return true;
  return attributesOf(line).some(({ sign, name, value }) => {
    if (HARMLESS_ATTRIBUTES.has(name)) return false;
    if (name === 'diff') return sign === '!' || (sign === '' && value === undefined);
    return sign !== '' || value === 'false';
  });
}

/** A state `git check-attr` reports that sets the attribute (to true or a value). */
const isSet = (state: string): boolean => state !== 'unspecified' && state !== 'unset';

/**
 * Whether a path's attribute going from state `was` (base tree) to `now` (head tree), as `git check-attr` reports them,
 * can make a review see less of the file (#693, the outcome check). It judges the change, not the end state:
 * - `diff`: never when `now` is `set` (forced text). Otherwise yes when either side is a driver git doesn't ship (its
 *   binary or textconv setting lives in a config the review can't see: fails closed, even from `unset`, since a
 *   textconv can show an empty diff where the base showed "Binary files differ"); no when `was` was `unset` (binary
 *   already); yes when `was` was `set` (leaving a forced `diff`, even for a driver git ships, hands a file with a NUL
 *   byte back to "Binary files differ") or `now` is `unset`. Between `unspecified` and git's own drivers, no.
 * - `binary`: yes when it becomes set.
 * - `text`: yes when it becomes unset (a plain `git diff` shows the same; kept fail-closed for other readers).
 * - `filter`, `working-tree-encoding`: yes when `now` sets one (a checkout gets other bytes than the blob).
 * - `linguist-generated`: yes when `now` sets it to anything but `false` (GitHub folds the file).
 * - `merge`: never (no diff reads it).
 * The table of every transition and what plain git shows is in #802's round-5 adversarial pass.
 */
export function attributeTransitionHides(attr: string, was: string, now: string): boolean {
  if (was === now) return false;
  switch (attr) {
    case 'diff': {
      if (now === 'set') return false;
      // A driver git doesn't ship, on either side, before the `unset` return: from binary to such a driver can show
      // nothing at all (its textconv lives in a config the review can't see), so it fails closed (R21).
      const custom = (s: string) => isSet(s) && s !== 'set' && !BUILTIN_DIFF_DRIVERS.has(s);
      if (custom(now) || custom(was)) return true;
      if (was === 'unset') return false;
      return was === 'set' || now === 'unset';
    }
    case 'binary':
      return isSet(now);
    case 'text':
      return now === 'unset';
    case 'filter':
    case 'working-tree-encoding':
      return isSet(now);
    case 'linguist-generated':
      return isSet(now) && now !== 'false';
    default:
      return false;
  }
}

/** The attributes the outcome check asks git about (coordinator/change-files.ts attributeOutcome). */
export const OUTCOME_ATTRIBUTES = ['diff', 'binary', 'text', 'merge', 'filter', 'working-tree-encoding', 'linguist-generated'] as const;

/**
 * Whether a changed .gitmodules can hide a submodule's changes from `git diff` and `git status`, from what git's own
 * config parser read in it (ChangeFile.submoduleIgnores, coordinator/change-files.ts): any `ignore` key, on the base or
 * the head side, set to anything but exactly `none`. Fails closed: a side git couldn't parse (null), or a file read by
 * anything but that reader (undefined), counts as hiding.
 */
export function hidesSubmodules(f: Pick<ChangeFile, 'submoduleIgnores'>): boolean {
  return f.submoduleIgnores == null || f.submoduleIgnores.some((v) => v !== 'none');
}

/**
 * The harness's config in a repo: the config folder (tests.yaml says what a project command runs and with what
 * environment, review.yaml these levels), Claude Code's project settings and CLAUDE.md. Locked (#798, in
 * LOCKED_CATEGORIES below): before, it was L3 only because the default review.yaml listed it, so a repo's review.yaml
 * could drop it from L3 or redefine its globs to nothing. Now always L3 and never auto-merged; its globs always hold,
 * and a repo may only add to them.
 */
export const HARNESS_CONFIG = 'harness-config';
// check-table: never-shrink
const HARNESS_CONFIG_GLOBS =[`${BRAND.configDir}/**`, '.claude/**', 'CLAUDE.md'];

/**
 * The harness changing its own controls: the merge policy, the main watch and the push guard, the updater, the review
 * levels and guardrails, the machine's setup scripts, the engine's container image, deployment files and CI workflows, sign-in and
 * credentials, who may approve, the evaluator and the agent runner, the sandbox, the push gate, denylist and secret scan,
 * the tests that hold those controls, the release and design rules, and the public security claims.
 * Always L3 and never auto-merged (merge-policy.ts waitCategoriesOf), whatever review.yaml says; review.yaml can't
 * redefine, drop or loosen it. Each part says, in the words "Waiting on you" shows, what such a change changes; the
 * first part a file matches names it. Every glob matches a real file in the engine's repo (a test checks).
 */
export const SELF_MODIFICATION = 'self-modification';
// check-table: never-shrink
export const SELF_MODIFICATION_PARTS: { what: string; globs: string[] }[] = [
  // src/vacuity.ts: what the merge gate counts as an assertion and as app code run (#784, src/merge-policy-vacuity.ts).
  { what: 'the merge policy', globs: ['src/merge-policy*', 'src/coordinator/merge-flow*', 'src/pr-rules*', 'src/vacuity.ts', 'src/vacuity-read.ts'] },
  { what: 'the main watch', globs: ['src/main-watch*', 'src/github/main-watch-api*'] },
  { what: 'the push guard', globs: ['src/push-guard*', 'src/push-check*'] },
  { what: 'the updater', globs: ['src/updates*', `scripts/machine/${BRAND.cli}-update*`] },
  // src/path-text.ts holds the odd-name tests computeLevel raises on (moved out of src/review.ts, #683), so it stays locked with it.
  { what: 'the review levels', globs: [`${BRAND.configDir}/review.yaml`, 'src/review.ts', 'src/path-text.ts'] },
  { what: 'the guardrails', globs: [`${BRAND.configDir}/guardrails.yaml`, 'src/guardrails/**'] },
  // deploy/**: the engine's deployment manifests (a compose file and the like) set its isolation and exposure, as the
  // setup scripts do: the user it runs as, what it mounts, which ports it publishes. Locked before the first one exists.
  { what: 'the machine setup', globs: ['scripts/setup/**', 'scripts/machine/**', 'deploy/**'] },
  // The engine's container image (Dockerfile, and any Dockerfile.<name> beside it, in any case the tools read, and the
  // Containerfile podman reads): the base image, the user it runs as, what it installs and from where. Before this, only
  // review.yaml's deploy-config held the Dockerfile (#858, a gap #853's review named). dockerfile* and Containerfile*
  // match no file yet (NOT_YET_FILES in test/merge-policy.test.ts).
  { what: "the engine's container image", globs: ['Dockerfile*', 'dockerfile*', 'Containerfile*'] },
  // The engine's deployment files at the top of its repo, beside deploy/**: a bare deploy path (a file, or a symlink to
  // anywhere) and the compose files set how it runs, as the setup scripts do: the user, the mounts, the ports. Locked
  // before the first one exists (NOT_YET_FILES in test/merge-policy.test.ts; #885).
  { what: "the engine's deployment files", globs: ['deploy', 'compose.*', 'docker-compose.*'] },
  { what: 'the CI workflows', globs: ['.github/workflows/**'] },
  // Whose signed tag the release workflow stages on npm, and the check that enforces it (release.yml).
  { what: 'who may sign a release', globs: ['.github/release-signers', 'scripts/verify-release-tag*'] },
  // src/events/redact.ts: the secret redaction of everything stored and of every chat reply (locked with the guard's
  // tree before #785, which no longer reaches it).
  { what: 'sign-in, credentials or secrets', globs: ['src/dashboard-auth*', 'src/github-app*', 'src/github-scope*', 'src/**/*secret*', 'src/console/terminal*', 'src/setup/app-manifest*', 'src/events/redact.ts'] },
  // src/intake/report.ts: isTrusted and isAllowed, the intake's trust and admission inputs to src/intake/decide.ts;
  // src/intake/dedupe.ts: candidates(), the bound on which issue the intake agent may name, which decide.ts relies on
  // (both locked with the guard's tree before #785, which no longer reaches them).
  { what: 'who may approve', globs: ['src/decide.ts', 'src/intake/decide.ts', 'src/intake/people.ts', 'src/machine-owners.ts', 'src/intake/report.ts', 'src/intake/dedupe.ts'] },
  // WHY: before this, these were the owner's call only where a repo's own review.yaml listed them (the engine's does, as
  // `engine`); a repo whose review.yaml didn't would have merged a change to the evaluator or the denylist on its own.
  { what: 'the evaluator and the agent runner', globs: ['src/roles.ts', 'src/coordinator.ts', 'src/runner.ts'] },
  { what: 'the sandbox and test runs', globs: ['src/sandbox.ts', 'src/testrun/**'] },
  // The PreToolUse guard (which tool calls an agent may make, the config folder's guard among them) and the post-edit hook,
  // with every module it reaches, directly or through other imports (#655, #665): the deny lists, the read-only agents'
  // tools and refusals, the task file's frozen paths, the guardrail rules' loader, the secret check, and the rest.
  // src/hook-imports.ts holds that tree as the test reads it from the real imports (test/review.test.ts).
  // Its process entry is src/hook-main.ts (under src/hook*), so the tree is read from there too (#665).
  // src/guard/** holds the lanes' rules the guard decides with (#785): every file there is locked, a new one too.
  { what: "the agents' tool guard", globs: ['src/hook*', 'src/guard/**', ...HOOK_IMPORTS] },
  // What writes the hook commands that run it (src/install.ts hookCommand, src/instance.ts's research lanes): a change
  // there could point an agent's hooks at another entry, or at none (#665).
  { what: "the agents' tool guard's hook commands", globs: ['src/install.ts', 'src/instance.ts'] },
  // WHY (#785): these were locked only as modules the guard's import tree reached. The tree no longer reaches them, but
  // each still decides what an agent run gets: the settings that keep its hooks on, the bundles it may read, the
  // plugins and MCP servers it loads, the hosts it may ask for, the stuck-run stop, the role, lane and tools of the
  // runs that read untrusted text (the research, intake, chat, replier, explainer and stage-judge run builders; #841
  // would let those six go), and the intake run's output schema and draft checks (src/intake/triage.ts). So they stay
  // locked here, exactly as before; only the part that names them changed.
  {
    what: 'what an agent run is given',
    globs: [
      'src/agent-settings.ts', 'src/bundle.ts', 'src/domain-requests.ts', 'src/stuck.ts',
      'src/research.ts', 'src/intake/run.ts', 'src/intake/chat.ts', 'src/intake/replier.ts', 'src/intake/explain.ts',
      'src/stage-label.ts', 'src/intake/triage.ts',
      'src/mcp/client.ts', 'src/mcp/connector.ts', 'src/mcp/snapshot.ts', 'src/plugins/approval.ts', 'src/plugins/run.ts', 'src/plugins/tree.ts',
    ],
  },
  // Which repos root says are managed apps, where the engine's own source paths below aren't locked (#665).
  { what: 'where the self-modification locks apply', globs: ['src/managed-apps.ts'] },
  { what: 'the push gate, denylist and secret scan', globs: ['scripts/push-gate*', 'scripts/check-denylist.mjs', 'scripts/lib/denylist.mjs', 'scripts/check-dco.mjs', '.denylist*', '.gitleaks*', '.githooks/**'] },
  // A tests-only change is L0 and merges itself: so the tests that hold the controls above are named here, one by one.
  {
    what: 'the tests of the harness controls',
    globs: [
      'test/review.test.ts', 'test/merge-policy.test.ts', 'test/guardrails.test.ts',
      'test/push-check.test.ts', 'test/push-guard.test.ts', 'test/push-hook-guard.test.ts', 'test/push-gate.test.ts', 'test/push-gate-hook.test.ts',
      // The rename, odd-byte and control-character guarantees, and the scan that keeps every changed-name reader in
      // one helper (#688, locked by #724).
      'test/change-files-renames.test.ts',
      // The push limits' SKILL.md lint: read by its bytes, and a link, a submodule or a huge blob refused (#724).
      'test/push-skill-names.test.ts', 'test/push-skill-links.test.ts',
      // The push limits' names from plumbing, whatever the repo's log config says; crafted names refused (#724).
      'test/push-names-plumbing.test.ts',
      'test/main-watch.test.ts', 'test/main-watch-coordinator.test.ts', 'test/denylist.test.ts', 'test/dco.test.ts', 'test/package-files.test.ts',
      // Root's managed-apps reader's fail-closed cases and the script's refusals (#665).
      'test/managed-apps.test.ts',
      // The merge reconciliation's cases: only the engine's own App's merge is reconciled, never another's (#733).
      'test/merge-idempotent.test.ts',
      // The merge gate's vacuity check: tests that run none of the changed code never auto-merge (#784).
      'test/vacuity.test.ts', 'test/merge-policy-vacuity.test.ts', 'test/merge-vacuity-coordinator.test.ts',
      'test/merge-vacuity-hostile.test.ts', 'test/merge-vacuity-decisions.test.ts', 'test/merge-vacuity-doctor.test.ts',
      'test/merge-vacuity-bounds.test.ts', 'test/merge-vacuity-precision.test.ts', 'test/merge-vacuity-r5.test.ts', 'test/merge-vacuity-r6.test.ts',
      'test/merge-vacuity-r7.test.ts', 'test/merge-vacuity-r8.test.ts', 'test/merge-vacuity-r9-tip.test.ts', 'test/merge-vacuity-r9-precision.test.ts', 'test/merge-vacuity-r9-limits.test.ts', 'test/vacuity-tip.ts',
      // The test that keeps the security pages' citations true, the adversarial suite of hostile PRs (its runner, its
      // cases, controls and todo list), and the test that holds these locks (#858).
      'test/docs-guardrails.test.ts',
      'test/adversarial/**',
      'test/engine-guard-locks.test.ts',
      // The test that keeps each lock glob that matches no file yet paired with its lock (#885).
      'test/not-yet-files-locks.test.ts',
    ],
  },
  { what: 'the release procedure and the design rules', globs: ['docs/releasing.md', 'docs/design.md'] },
  // What the engine publicly claims its guards do and which gaps are open (#705), and how to report one: a docs-only
  // change was L0 and merged itself, so a PR could rewrite a claim with nothing holding it (#858).
  { what: 'the public security claims', globs: ['docs/guardrails.md', 'docs/security*.md', 'SECURITY.md'] },
  // After the merge policy's own part above (the first part a file matches names it): the rest of the coordinator.
  { what: 'the coordinator', globs: ['src/coordinator/**'] },
  // A study's definition (docs: the experiments design): its eval, editable paths and budget are what a job may touch.
  { what: 'the experiment studies', globs: [`${BRAND.configDir}/experiments.yaml`] },
];

// check-table: never-shrink
export const LOCKED_CATEGORIES: Record<string, string[]> = {
  [AGENT_INSTRUCTIONS]: [`${BRAND.configDir}/roles/**`, `${BRAND.configDir}/skills/**`, 'AGENTS.md', '**/CLAUDE.md'],
  [SELF_MODIFICATION]: SELF_MODIFICATION_PARTS.flatMap((p) => p.globs),
  [HARNESS_CONFIG]: HARNESS_CONFIG_GLOBS,
};

/**
 * Whose repo a change is in, for the locks above (#665). 'engine': the engine's own, where every lock applies. The
 * other value, a managed app's, comes only from root's word on this machine (src/managed-apps.ts readLockScope), never
 * from anything in a repo; there the globs that name the engine's own source tree (ENGINE_TREE) stand aside, the push
 * gate's and release-tag check's scripts under scripts/ among them, and the rest (the config folder's review.yaml,
 * guardrails.yaml and experiments.yaml, CI workflows and release signers, the git hooks and secret-scan files:
 * .githooks/**, .denylist* and .gitleaks*, and the agents' instructions) still hold: each changes the harness's rules
 * for that repo.
 * INVARIANT: absent, unknown or unreadable is 'engine' (fails closed).
 */
export type LockScope = 'engine' | 'managed-app';

/**
 * The engine's own source tree: a self-modification glob under it names an engine file, not a managed app's. deploy/ is
 * the engine's deployment manifests; a managed app's own deploy/ stays its deploy-config, as before.
 */
// check-table: never-grow
const ENGINE_TREE = ['src/', 'scripts/', 'test/', 'docs/', 'deploy/'];
/**
 * The engine's own files at the top of its repo, glob for glob (#858): its security policy, its container image and its
 * deployment files. Like ENGINE_TREE, their locks hold only in the engine's repo; a managed app's own SECURITY.md,
 * Dockerfile, Containerfile, compose file or deploy path keeps the categories its review.yaml gives it, as before.
 * Matched exactly, so no other glob stands aside through it.
 */
// check-table: never-grow
const ENGINE_ROOT_FILES = ['SECURITY.md', 'Dockerfile*', 'dockerfile*', 'Containerfile*', 'deploy', 'compose.*', 'docker-compose.*'];
/** Whether a locked glob names the engine's own source (so it holds only in the engine's repo). */
export const engineSourceGlob = (glob: string): boolean => ENGINE_TREE.some((d) => glob.startsWith(d)) || ENGINE_ROOT_FILES.includes(glob);

/** The locked categories in this scope: all of them in the engine's repo; in a managed app's, those that hold in every repo. */
export function lockedCategories(scope: LockScope | undefined): Record<string, string[]> {
  if (scope !== 'managed-app') return LOCKED_CATEGORIES;
  return Object.fromEntries(Object.entries(LOCKED_CATEGORIES).map(([c, globs]) => [c, globs.filter((g) => !engineSourceGlob(g))]));
}

/** Locked categories that are always L3, whatever review.yaml's levels list. */
// check-table: never-shrink
const ALWAYS_L3 = [SELF_MODIFICATION, HARNESS_CONFIG];

/** What a change to this path changes, in plain words (the self-modification part it falls in, in this scope), or null. */
export function selfModificationPart(path: string, scope?: LockScope): string | null {
  const holds = (g: string) => scope !== 'managed-app' || !engineSourceGlob(g);
  return SELF_MODIFICATION_PARTS.find((p) => p.globs.some((g) => holds(g) && globToRegExp(g).test(path)))?.what ?? null;
}

/** Built-in categories; review.yaml `categories` adds to them or replaces one by name. */

export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  docs: ['**/*.md', 'docs/**', '**/*.txt', 'art/**', 'assets/**'],
  tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  dependency: [
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '**/package.json', '**/package-lock.json',
    '**/pyproject.toml', '**/requirements*.txt', '**/setup.py', '**/setup.cfg', '**/poetry.lock', '**/uv.lock', '**/Pipfile', '**/Pipfile.lock',
    '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/Gemfile', '**/Gemfile.lock',
  ],
  'ci-config': ['.github/**', '.gitlab-ci.yml', '.circleci/**'],
  [HARNESS_CONFIG]: HARNESS_CONFIG_GLOBS,
  'guardrail-config': [`${BRAND.configDir}/guardrails.yaml`],
  migration: ['**/migrations/**', '**/*.sql', 'prisma/schema.prisma'],
  'deploy-config': ['.github/workflows/**', 'railway.json', 'railway.toml', 'deploy/**', 'Dockerfile', 'fly.toml', 'render.yaml'],
  'release-config': ['scripts/release*', '.github/workflows/release*', '.github/release-signers', 'scripts/verify-release-tag*'],
  secrets: ['.env*', '**/*.pem', '**/*secret*', '**/*credential*'],
  auth: ['**/auth/**', '**/*auth*.*', '**/session*.*', '**/totp*.*'],
  'test-machinery': ['scripts/**', 'test/harness*', 'test/run-*'],
};

export interface ChangeFile {
  path: string;
  added: number;
  removed: number;
  /** Added lines, for content checks (data deletion). */
  addedLines?: string[];
  /** Removed lines, for telling a comment-only change from a code change. */
  removedLines?: string[];
  /**
   * On a .gitattributes only: every macro name (`[attr]name`) any .gitattributes in the base or the head tree
   * defines, so a line using one is judged as the macro, not as the harmless name it may shadow (#693).
   */
  attributeMacros?: string[];
  /**
   * On a .gitmodules only: the value of every `ignore` key git's config parser reads in it, on the base side and the
   * head side (null for a key with no value); null when git can't parse a side (#693).
   */
  submoduleIgnores?: (string | null)[] | null;
  /**
   * On a .gitattributes only: what git itself says the change does to attributes (coordinator/change-files.ts
   * attributeOutcome): each path whose state of an OUTCOME_ATTRIBUTES attribute differs between the base and head trees
   * and now hides it (`path: diff unspecified -> unset`); null when git can't judge (too old for `check-attr --source`,
   * a `$GIT_DIR/info/attributes` that would mask the trees, or a failure), which counts as hiding (#693).
   */
  attributeOutcome?: string[] | null;
}

export interface LevelInput {
  files: ChangeFile[];
  labels: string[];
  /** Money-path regexes or globs (from money_path_source). */
  moneyPaths: RegExp[];
  verdict?: { patch_correct: boolean; test_correct: boolean; confidence: 'high' | 'medium' | 'low' };
  /** An agent may ask for more review, never less. */
  requested?: Level;
  /**
   * Whose repo this is, for the locked categories (LockScope); undefined: the engine's, every lock applies. A required
   * key (#665): every caller says which scope it means, so a call site can't leave it out by accident.
   */
  scope: LockScope | undefined;
}

export interface LevelResult {
  level: Level;
  reasons: string[];
  categories: Record<string, string[]>;
}

/**
 * Money paths from the project's source of truth, as `rev` has it: the default branch's ref (`<remote>/<branch>`),
 * read with git from `repo`, as review.yaml itself is (src/config/live.ts). Never a working tree: the coordinator's
 * is never checked out again after its clone, so a list read there misses every path main added since (#715).
 * The list file itself is a money path too: a change to it waits for the owner like the paths it names, in every
 * repo, wherever its name would otherwise put it (docs, for a .txt). A pattern containing regex literals (/.../)
 * yields those; otherwise each line is a glob.
 */
export function loadMoneyPaths(repo: string, src: ReviewConfig['money_path_source'], rev: string): RegExp[] {
  if (!src) return [];
  const file = posix.normalize(src.file).replace(/^\.\//, '');
  const shown = spawnSync('git', ['show', `${rev}:${file}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (shown.status !== 0) throw new Error(`money_path_source: ${file} isn't readable at ${rev}: ${(shown.stderr || shown.error?.message || '').trim().split('\n')[0]}`);
  let text = shown.stdout;
  if (src.pattern) {
    const m = text.match(new RegExp(src.pattern));
    if (!m) throw new Error(`money_path_source: pattern not found in ${src.file}`);
    text = m[1] ?? m[0];
  }
  const self = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const literals = [...text.matchAll(/\/((?:\\\/|[^/\n])+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1]!, m[2]!.replace('g', '')));
  if (literals.length) return [self, ...literals];
  return [self, ...text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((g) => globToRegExp(g))];
}

export function computeLevel(input: LevelInput, cfg: ReviewConfig, extraCategories: Record<string, string[]> = {}): LevelResult {
  const own = { ...DEFAULT_CATEGORIES, ...cfg.categories, ...extraCategories };
  const locked = lockedCategories(input.scope);
  // harness-config's built-in globs always hold, beside whatever a repo adds to it (#798): never fewer.
  const defs = { ...own, ...locked, [HARNESS_CONFIG]: [...new Set([...(locked[HARNESS_CONFIG] ?? HARNESS_CONFIG_GLOBS), ...(own[HARNESS_CONFIG] ?? [])])] };
  const res = Object.fromEntries(Object.entries(defs).map(([k, globs]) => [k, globs.map((g) => globToRegExp(g))]));
  const categories: Record<string, string[]> = {};
  const add = (cat: string, path: string) => (categories[cat] ??= []).push(path);

  for (const f of input.files) {
    for (const [cat, list] of Object.entries(res)) if (list.some((re) => re.test(f.path))) add(cat, f.path);
    if (input.moneyPaths.some((re) => re.test(f.path))) add('money-path', f.path);
    if ((f.addedLines ?? []).some((l) => /\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i.test(l))) add('deletes-data', f.path);
    if (hasControlCharacter(f.path)) add(CONTROL_CHARACTER_PATH, f.path);
    if (isNonUtf8Path(f.path)) add(NON_UTF8_PATH, f.path);
    if (hasInvisibleCharacter(f.path)) add(INVISIBLE_CHARACTER_PATH, f.path);
    if (hasNonAsciiTopLevel(f.path)) add(NON_ASCII_TOP_LEVEL_PATH, f.path);
    // Two layers. The outcome: git itself (check-attr on the base and head trees) found a path whose attributes now
    // hide it, or couldn't judge (null). The lines: what the change adds or takes away. A .gitattributes read by
    // anything but changeFiles has no macro list, so every name may be a macro (fails closed).
    if (isGitattributesPath(f.path)) {
      const macros = f.attributeMacros ?? ['*'];
      // No outcome (undefined: read by anything but changeFiles) counts as git not judging (null): fails closed.
      const outcome = f.attributeOutcome == null || f.attributeOutcome.length > 0;
      if (outcome || (f.addedLines ?? []).some((l) => hidesDiff(l, macros)) || (f.removedLines ?? []).some((l) => unhidLine(l, macros))) add(DIFF_HIDING_ATTRIBUTES, f.path);
    }
    if (isGitmodulesPath(f.path) && hidesSubmodules(f)) add(DIFF_HIDING_ATTRIBUTES, f.path);
  }
  const lines = input.files.reduce((n, f) => n + f.added + f.removed, 0);
  const isDocOrTest = (p: string) => (categories.docs ?? []).includes(p) || (categories.tests ?? []).includes(p);
  const app = input.files.filter((f) => !isDocOrTest(f.path) && !(categories['harness-config'] ?? []).includes(f.path));
  for (const f of app) if (!(categories['money-path'] ?? []).includes(f.path)) add('app-non-money', f.path);
  if (input.labels.includes('ui')) for (const f of app) add('ui', f.path);
  if (input.labels.includes('money-path')) for (const f of input.files) if (!(categories['money-path'] ?? []).includes(f.path)) add('money-path', f.path);

  const L = cfg.levels;
  const reasons: string[] = [];
  let level: Level = 'L0';
  const raise = (to: Level, why: string) => {
    if (ORDER.indexOf(to) > ORDER.indexOf(level)) level = to;
    reasons.push(why);
  };
  const allLow = input.files.length > 0 && input.files.every((f) => isDocOrTest(f.path));
  if (allLow && lines <= (L.L0_auto.max_lines ?? Infinity)) reasons.push(`only docs/tests, ${lines} lines`);
  else raise('L1', allLow ? `docs/tests but ${lines} lines (> ${L.L0_auto.max_lines})` : 'touches app code');
  // A category listed for L1 (e.g. docs, for a site whose docs are its product) always gets the evaluator.
  // Every path in a reason as shownPath shows it (#683): reasons reach the PR body, events, the owner's question and
  // hold comments, so no control, format or invisible character in a name reaches them raw.
  const named = (c: string) => `${c}: ${shownPaths((categories[c] ?? []).slice(0, 3))}`;
  if (level === 'L0') for (const c of L.L1_evaluator.when) if (categories[c]?.length) raise('L1', named(c));

  const l1Limits = (L.L1_evaluator.max_lines !== undefined && lines > L.L1_evaluator.max_lines) || (L.L1_evaluator.max_files !== undefined && input.files.length > L.L1_evaluator.max_files);
  if (l1Limits && (categories['app-non-money'] ?? []).length) {
    add('app-non-money-large', '*');
    raise('L2', `large app change: ${lines} lines, ${input.files.length} files`);
  }
  for (const c of L.L2_notify.when) if (c !== 'app-non-money-large' && categories[c]?.length) raise('L2', named(c));
  for (const c of L.L3_human.when) if (categories[c]?.length) raise('L3', named(c));
  for (const c of ALWAYS_L3) if (!L.L3_human.when.includes(c) && categories[c]?.length) raise('L3', named(c));
  if (L.L3_human.over_lines !== undefined && lines > L.L3_human.over_lines) raise('L3', `${lines} lines (> ${L.L3_human.over_lines})`);
  // The odd names, each as shownPath shows it: a control, invisible or format character, or a top-level name outside
  // ASCII, escaped (\uXXXX), so the character shows as what it is and never reaches a comment or a log line raw; a
  // name that isn't valid UTF-8, quoted.
  const odd = categories[CONTROL_CHARACTER_PATH] ?? [];
  if (odd.length) raise('L3', `path with a control character: ${odd.slice(0, 3).map(shownPath).join(', ')}`);
  const notUtf8 = categories[NON_UTF8_PATH] ?? [];
  if (notUtf8.length) raise('L3', `path that isn't valid UTF-8: ${notUtf8.slice(0, 3).map(shownPath).join(', ')}`);
  const invisible = categories[INVISIBLE_CHARACTER_PATH] ?? [];
  if (invisible.length) raise('L3', `path with an invisible or format character: ${invisible.slice(0, 3).map(shownPath).join(', ')}`);
  const lookalike = categories[NON_ASCII_TOP_LEVEL_PATH] ?? [];
  if (lookalike.length) raise('L3', `top-level name that isn't ASCII: ${lookalike.slice(0, 3).map(shownPath).join(', ')}`);
  const hiding = categories[DIFF_HIDING_ATTRIBUTES] ?? [];
  if (hiding.length) raise('L3', `.gitattributes or .gitmodules can hide what a review sees (-diff, binary, linguist-generated, a filter, an encoding, a diff driver, a macro, a submodule ignore): ${shownPaths(hiding.slice(0, 3))}`);

  if (input.verdict && (!input.verdict.patch_correct || !input.verdict.test_correct || input.verdict.confidence === 'low')) {
    const from = level;
    level = up(level);
    reasons.push(`evaluator ${input.verdict.patch_correct ? '' : 'rejected the patch, '}${input.verdict.test_correct ? '' : 'doubts the test, '}confidence ${input.verdict.confidence}: ${from} -> ${level}`);
  }
  if (input.requested && ORDER.indexOf(input.requested) > ORDER.indexOf(level)) {
    reasons.push(`agent asked for ${input.requested}`);
    level = input.requested;
  }
  return { level, reasons, categories };
}
