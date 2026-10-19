// How a changed path reads in text a person or a log sees (a reason, an event, a question, a comment), and the tests
// for the names that can't be shown as they are (#683). One module, so the review levels (src/review.ts), the merge
// policy (src/merge-policy.ts), the conflict fix and the coordinator show a path the same way. Locked with the review
// levels (src/review.ts SELF_MODIFICATION_PARTS).

/** Whether a path holds a control character (Unicode Cc: U+0000 to U+001F and U+007F to U+009F). */
export const hasControlCharacter = (path: string): boolean => /\p{Cc}/u.test(path);

/**
 * Whether a path, as read, came from a name that isn't valid UTF-8: it holds U+FFFD, which is what any UTF-8 decode
 * (the helper's, or a plain `encoding: 'utf8'`) makes of a bad byte. A name with a real U+FFFD in it counts too; the
 * owner looks at it.
 */
export const isNonUtf8Path = (path: string): boolean => path.includes('�');

/**
 * Whether a path holds a Unicode format character (General Category Cf: bidi controls, zero-width characters, the
 * soft hyphen, ...) or a default-ignorable code point (Default_Ignorable_Code_Point: Cf's invisible kin outside it,
 * like U+034F or the Hangul fillers, and the variation selectors). Both are Unicode properties, not a hand list.
 */
export const hasInvisibleCharacter = (path: string): boolean => /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(path);

/** Whether a path's first segment (its top-level directory, or a file at the root) has a character outside ASCII. */
export const hasNonAsciiTopLevel = (path: string): boolean => /[^\x00-\x7f]/.test(path.split('/')[0]!);

/**
 * A path JSON-quoted with every character outside printable ASCII written as \uXXXX, so an invisible, look-alike or
 * control character shows as what it is (`"ѕrc/x.ts"`, `"src/a\nb.ts"`).
 */
export const escapedPath = (path: string): string => JSON.stringify(path).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * A changed path as every reason, event, question and comment shows it. An ordinary name (`docs/naïve.md`) as itself.
 * Escaped (escapedPath) when it holds a control character, an invisible or format character, or its top-level name
 * isn't ASCII: so no Cc, Cf or default-ignorable character reaches the text, a newline can't start a line of its own,
 * and a bidi override can't reorder the line around it. Quoted (JSON) when it holds a U+FFFD (a name that isn't valid
 * UTF-8), so it reads as the odd name it is.
 */
export const shownPath = (path: string): string =>
  hasControlCharacter(path) || hasInvisibleCharacter(path) || hasNonAsciiTopLevel(path) ? escapedPath(path) : isNonUtf8Path(path) ? JSON.stringify(path) : path;

/** Several changed paths as text: each one shownPath, joined. */
export const shownPaths = (paths: readonly string[], sep = ', '): string => paths.map(shownPath).join(sep);
