// The look-alike check's Unicode data and skeleton (#763): the generated table is the pinned Unicode file's, written
// as characters (never code point numbers), the generator reads a file back exactly, and skeleton() is UTS #39's. The
// review-level cases are in test/confusable-paths.test.ts.
//
// WHY each look-alike character below is written as itself, with a name: no committed file holds a code point
// number; the first test checks each one is the character its name says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFUSABLES, CONFUSABLES_SOURCE } from '../src/confusables-data.js';
import { BRAILLE_BLANK, lookalikeOf, MAX_CHECKED_PATH, skeleton } from '../src/confusables.js';
import { escapedPath, hasInvisibleCharacter, hasNonAccentCharacter, shownPath } from '../src/path-text.js';
import { repoRoot } from './helpers.js';

/** The pinned upstream file: Unicode 17.0.0's security/confusables.txt, as published (sha256 of its bytes). */
const PINNED = {
  version: '17.0.0',
  url: 'https://www.unicode.org/Public/17.0.0/security/confusables.txt',
  sha256: '091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a',
  mappings: 6565,
};
/** The sha256 of the generated table (CONFUSABLES), so a hand edit to it fails here even with the header left alone. */
const TABLE_SHA256 = '53e69803f9fdc7f71301068fb326ede57fd8c05ab6125a9f81cdf6afe7ace064';

/**
 * The no-break space, found by its properties (an editor may save it as a plain space): the first White_Space
 * character after ASCII that isn't a control character.
 */
function firstBlankOutsideAscii(): string {
  for (let cp = 128; ; cp++) {
    const c = String.fromCodePoint(cp);
    if (/^\p{White_Space}$/u.test(c) && !/^\p{Cc}$/u.test(c)) return c;
  }
}

/** The look-alike characters these tests use, each written as itself. */
const C = {
  cyrillicE: 'е',
  cyrillicA: 'а',
  cyrillicEr: 'р',
  cyrillicU: 'у',
  cyrillicDze: 'ѕ',
  greekOmicron: 'ο',
  divisionSlash: '∕',
  longS: 'ſ',
  iDiaeresis: 'ï',
  combiningDiaeresis: '̈',
  eAcute: 'é',
  fullwidthR: 'ｒ',
  fullwidthP: 'ｐ',
  zeroWidthJoiner: '‍',
  noBreakSpace: firstBlankOutsideAscii(),
  lowAsterisk: '⁎',
  arabicLigature: 'ﷺ',
  han: '日本',
};

test('#763: each look-alike character these tests use is the character its name says', () => {
  const is = (re: RegExp, s: string) => re.test(s);
  assert.ok([C.cyrillicE, C.cyrillicA, C.cyrillicEr, C.cyrillicU, C.cyrillicDze].every((c) => is(/^\p{Script=Cyrillic}$/u, c)));
  assert.ok(is(/^\p{Script=Greek}$/u, C.greekOmicron));
  assert.ok(is(/^\p{Sm}$/u, C.divisionSlash) && C.divisionSlash !== '/');
  assert.ok(is(/^\p{Script=Latin}$/u, C.longS) && C.longS.toUpperCase() === 'S');
  assert.deepEqual([...C.iDiaeresis.normalize('NFD')], ['i', C.combiningDiaeresis]);
  assert.ok(is(/^\p{Mn}$/u, C.combiningDiaeresis));
  assert.deepEqual([...C.eAcute.normalize('NFD')][0], 'e');
  assert.deepEqual([C.fullwidthR, C.fullwidthP].map((c) => c.normalize('NFKC')), ['r', 'p']);
  assert.ok(is(/^\p{Join_Control}$/u, C.zeroWidthJoiner) && is(/^\p{Default_Ignorable_Code_Point}$/u, C.zeroWidthJoiner));
  assert.ok(is(/^\p{White_Space}$/u, C.noBreakSpace) && C.noBreakSpace !== ' ');
  assert.ok(is(/^\p{Po}$/u, C.lowAsterisk) && C.lowAsterisk !== '*');
  assert.ok(is(/^\p{Script=Arabic}$/u, C.arabicLigature) && C.arabicLigature.normalize('NFKC').length >= 18);
  assert.ok(is(/^\p{Script=Han}+$/u, C.han));
});

test('#763: the table is the pinned Unicode file\'s, and the notices name its version, address, hash and licence', () => {
  assert.deepEqual({ ...CONFUSABLES_SOURCE }, PINNED);
  assert.equal(createHash('sha256').update(CONFUSABLES).digest('hex'), TABLE_SHA256);
  const notices = readFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const s of ['Unicode 17.0.0', PINNED.url, PINNED.sha256, 'Unicode License v3', 'UNICODE LICENSE V3', 'src/confusables-data.ts', 'scripts/dev/confusables-data.mjs']) assert.ok(notices.includes(s), s);
});

test('#763: the table holds one mapping a line, characters as themselves: sorted, each character once, never a code point number', () => {
  const lines = CONFUSABLES.split('\n').filter(Boolean);
  assert.equal(lines.length, PINNED.mappings);
  let last = -1;
  for (const line of lines) {
    const from = line.codePointAt(0)!;
    assert.ok(from > last, `not sorted, or twice: line ${lines.indexOf(line) + 1}`);
    last = from;
    assert.ok(line.length > String.fromCodePoint(from).length, `no prototype: line ${lines.indexOf(line) + 1}`);
  }
  // The generated module's own text: no escape or notation that writes a character as a number.
  const text = readFileSync(join(repoRoot, 'src', 'confusables-data.ts'), 'utf8');
  assert.doesNotMatch(text, /\\u|\\x|U\+[0-9A-F]|0x[0-9a-f]/i);
});

test('#763: skeleton is UTS #39\'s: NFD, default-ignorables dropped, each character mapped to its prototype, NFD again', () => {
  // Cyrillic and Greek letters that read as Latin ones; r n for m; 1 and capital I for l; a division slash for /.
  assert.equal(skeleton(`docs/r${C.cyrillicE}leasing.md`), skeleton('docs/releasing.md'));
  assert.equal(skeleton(`${C.cyrillicEr}${C.cyrillicA}${C.cyrillicU}${C.cyrillicEr}${C.cyrillicA}l`), skeleton('paypal'));
  assert.equal(skeleton(C.greekOmicron), skeleton('o'));
  assert.equal(skeleton('rn'), skeleton('m'));
  assert.equal(skeleton('1'), skeleton('l'));
  assert.equal(skeleton('I'), skeleton('l'));
  assert.equal(skeleton(`a${C.divisionSlash}b`), 'a/b');
  // A zero-width joiner (default-ignorable) is dropped; a long s is f to UTS #39.
  assert.equal(skeleton(`re${C.zeroWidthJoiner}view`), skeleton('review'));
  assert.equal(skeleton(C.longS), 'f');
  // An accent stays: naive with a diaeresis is not naive, precomposed or not.
  assert.notEqual(skeleton(`na${C.iDiaeresis}ve`), skeleton('naive'));
  assert.equal(skeleton(`na${C.iDiaeresis}ve`), skeleton(`nai${C.combiningDiaeresis}ve`));
});

test('#763: the braille blank is the Braille script\'s first character, and no other check sees it', () => {
  const cp = BRAILLE_BLANK.codePointAt(0)!;
  assert.equal([...BRAILLE_BLANK].length, 1);
  assert.ok(/^\p{Script=Braille}$/u.test(BRAILLE_BLANK) && !/^\p{Script=Braille}$/u.test(String.fromCodePoint(cp - 1)));
  assert.ok(!/\p{White_Space}/u.test(BRAILLE_BLANK) && !hasInvisibleCharacter(`a${BRAILLE_BLANK}b`));
  assert.equal(skeleton(BRAILLE_BLANK), BRAILLE_BLANK);
});

test('#763: hasNonAccentCharacter (how text shows a path): any character outside ASCII but an accent on an ASCII letter, without the look-alike table', () => {
  const yes = [`docs/r${C.cyrillicE}leasing.md`, `a${C.divisionSlash}b`, `x${C.cyrillicDze}y`, `docs/${C.fullwidthR}x.md`, `docs/a${C.noBreakSpace}b.md`, `docs/a${BRAILLE_BLANK}b.md`, `docs/relea${C.longS}ing.md`, `docs/${C.han}.md`];
  assert.deepEqual(yes.map(hasNonAccentCharacter), yes.map(() => true));
  // Accents, precomposed or combining; ASCII; and the replacement character, which isNonUtf8Path shows as JSON.
  const no = [`docs/na${C.iDiaeresis}ve.md`, `docs/nai${C.combiningDiaeresis}ve.md`, `docs/caf${C.eAcute}.md`, 'src/x.ts', 'web/say"hi".ts', 'docs/a b.md', 'docs/a�b.md'];
  assert.deepEqual(no.map(hasNonAccentCharacter), no.map(() => false));
  // So shownPath escapes each of the first and shows each accented name as itself.
  assert.deepEqual(yes.map(shownPath), yes.map(escapedPath));
  assert.deepEqual([`docs/na${C.iDiaeresis}ve.md`, `docs/caf${C.eAcute}.md`].map(shownPath), [`docs/na${C.iDiaeresis}ve.md`, `docs/caf${C.eAcute}.md`]);
  assert.equal(shownPath('docs/a�b.md'), JSON.stringify('docs/a�b.md'));
});

test('#763: lookalikeOf: a path a pattern matches as itself is its own, never a look-alike; blanks are read both ways; over the bound it is held unread', () => {
  const pats = [{ glob: 'docs/releasing.md', what: 'r' }, { glob: 'src/**/*secret*', what: 's' }, { re: /^lib\/pay\.ts$/, what: 'm' }];
  assert.equal(lookalikeOf('docs/releasing.md', pats), null);
  assert.deepEqual(lookalikeOf(`docs/r${C.cyrillicE}leasing.md`, pats), { like: 'r' });
  assert.equal(lookalikeOf('src/a/secret.ts', pats), null);
  assert.deepEqual(lookalikeOf(`src/a/s${C.cyrillicE}cret.ts`, pats), { like: 's' });
  assert.deepEqual(lookalikeOf(`lib/p${C.cyrillicA}y.ts`, pats), { like: 'm' });
  // Fullwidth letters, through the compatibility form: a glob's and a regex's look-alike.
  assert.deepEqual(lookalikeOf(`docs/${C.fullwidthR}eleasing.md`, pats), { like: 'r' });
  assert.deepEqual(lookalikeOf(`lib/${C.fullwidthP}ay.ts`, pats), { like: 'm' });
  // Case only counts for a name outside ASCII: SecretStore.ts is no look-alike of *secret*, a Cyrillic one is.
  assert.equal(lookalikeOf('src/SecretStore.ts', pats), null);
  assert.deepEqual(lookalikeOf(`src/S${C.cyrillicE}cretStore.ts`, pats), { like: 's' });
  // A blank-looking character (a space, a no-break space, the braille blank) is read as nothing too.
  for (const p of ['docs/releasing.md ', `docs/releasing.md${C.noBreakSpace}`, `docs/releasing${BRAILLE_BLANK}.md`]) assert.deepEqual(lookalikeOf(p, pats), { like: 'r' }, p);
  for (const p of ['lib/pay.ts ', `lib/pay.ts${BRAILLE_BLANK}`]) assert.deepEqual(lookalikeOf(p, pats), { like: 'm' }, p);
  assert.equal(lookalikeOf('docs/release notes.md', pats), null);
  // Over the length bound, or a skeleton over its bound (an Arabic ligature maps to 18 characters): held, not compared.
  assert.ok('unchecked' in lookalikeOf(`docs/${'a'.repeat(MAX_CHECKED_PATH)}`, pats)!);
  assert.ok('unchecked' in lookalikeOf(`docs/${C.arabicLigature.repeat(300)}`, pats)!);
  // A failure inside the check (here a money path whose test throws) holds the path, not passes it.
  const throws = { test: () => { throw new Error('boom'); } } as unknown as RegExp;
  assert.deepEqual(lookalikeOf('lib/x.ts', [{ re: throws, what: 'm' }]), { unchecked: 'the check failed: boom' });
  // A glob whose literal reads as a wildcard (a low asterisk) only widens what it holds.
  assert.deepEqual(lookalikeOf('x/anything', [{ glob: `x/${C.lowAsterisk}`, what: 'w' }]), { like: 'w' });
});

// ---- The generator (scripts/dev/confusables-data.mjs), on a small file made here

/** A code point as confusables.txt writes it: upper-case hex, at least four digits (built here, never written out). */
const num = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
const mapping = (from: string, to: string) => `${num(from)} ;\t${[...to].map(num).join(' ')} ;\tMA\t# a test mapping`;

/** Run the generator in a scratch folder on `text` as confusables.txt: its exit status, and what it wrote. */
function generate(text: string | Buffer): { status: number | null; stderr: string; out: string | undefined } {
  const dir = mkdtempSync(join(tmpdir(), 'confusables-gen-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'confusables.txt'), text);
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'dev', 'confusables-data.mjs'), join(dir, 'confusables.txt')], { cwd: dir, encoding: 'utf8' });
  let out: string | undefined;
  try {
    out = readFileSync(join(dir, 'src', 'confusables-data.ts'), 'utf8');
  } catch {
    out = undefined;
  }
  return { status: r.status, stderr: r.stderr, out };
}

/** The table a generated module holds, read back as its lines (the template literal's escapes undone). */
const tableOf = (out: string): string[] => {
  const body = out.slice(out.indexOf('CONFUSABLES = `\n') + 'CONFUSABLES = `\n'.length, out.lastIndexOf('\n`;'));
  return body.replace(/\\([\\`$])/g, '$1').split('\n');
};

test('#763: the generator writes each mapping as its characters, sorted, with a template literal\'s escapes only, and records the file\'s version and hash', () => {
  // Out of order, a byte order mark before the first comment, and prototypes holding a backslash, a backquote and a ${.
  const pairs: [string, string][] = [
    [C.fullwidthR, 'r'],
    [C.cyrillicA, 'a'],
    [C.divisionSlash, '\\'],
    [C.lowAsterisk, '`'],
    [C.longS, '${f}'],
    ['m', 'rn'],
  ];
  const text = ['# confusables.txt', '# Version: 99.1.0', '', ...pairs.map(([f, t]) => mapping(f, t)), '# end', ''].join('\n');
  // The UTF-8 byte order mark, as its three bytes in decimal.
  const bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text, 'utf8')]);
  const r = generate(bytes);
  assert.equal(r.status, 0, r.stderr);
  const sorted = [...pairs].sort((a, b) => a[0].codePointAt(0)! - b[0].codePointAt(0)!).map(([f, t]) => f + t);
  assert.deepEqual(tableOf(r.out!), sorted);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.ok(r.out!.includes(`{ version: '99.1.0', url: 'https://www.unicode.org/Public/99.1.0/security/confusables.txt', sha256: '${sha256}', mappings: 6 }`), r.out);
  assert.doesNotMatch(r.out!, /\\u|\\x|U\+[0-9A-F]|0x[0-9a-f]/i);
  // Byte-identical for the same file.
  assert.equal(generate(bytes).out, r.out);
});

test('#763: the generator fails, writing nothing, on a line that is neither a comment nor a mapping, a character mapped twice, or no version', () => {
  const head = '# Version: 99.1.0\n';
  for (const [why, text] of [
    ['a stray line', `${head}${mapping(C.cyrillicA, 'a')}\nnot a mapping\n`],
    ['a character mapped twice', `${head}${mapping(C.cyrillicA, 'a')}\n${mapping(C.cyrillicA, 'o')}\n`],
    ['no version', `${mapping(C.cyrillicA, 'a')}\n`],
  ] as const) {
    const r = generate(text);
    assert.notEqual(r.status, 0, why);
    assert.equal(r.out, undefined, why);
  }
});
