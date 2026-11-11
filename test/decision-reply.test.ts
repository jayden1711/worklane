// How a comment is read as a reply to a decision (src/decision-reply.ts). The owner's decisions: a reply names the
// decision's id (2026-11-09); only a comment's first line is read, with no other command in the comment (2026-11-10,
// option (b) with (b')); and the whole comment is plain ASCII, curly quotes and en or em dashes read as ' " - (2026-11-10,
// after R1182ak/al). No markdown and no Unicode is interpreted: these cases are the whole reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { idsElsewhere, NOT_ASCII, pageText, readReply, replyText, TYPED, UNSAFE } from '../src/decision-reply.js';

const c = `/${BRAND.cli}`;
const ID = 'd-12-a3f9c1';
/** The first line's option and ids, or null. */
const first = (body: string) => {
  const f = readReply(body).first;
  return f && { option: f.option, ids: f.ids };
};
/** Whether the comment can answer at all: plain ASCII, a first-line command, no refused character, no other command. */
const answers = (body: string) => {
  const r = readReply(body);
  return r.notAscii === null && r.first !== null && !r.unsafe && r.others.length === 0;
};
const u = (hex: string) => String.fromCodePoint(parseInt(hex, 16));

test('the first non-blank line is the command: its option and ids; nothing after it is one', () => {
  assert.deepEqual(first(`${c} approve ${ID}`), { option: 'approve', ids: [ID] });
  assert.deepEqual(first(`\n  \n\t\n${c} approve ${ID}`), { option: 'approve', ids: [ID] }, 'blank lines (spaces, a tab) before it');
  assert.deepEqual(first(`   ${c} approve ${ID}`), { option: 'approve', ids: [ID] }, 'up to 3 spaces before it');
  assert.equal(first(`    ${c} approve ${ID}`), null, '4 spaces: indented code');
  assert.equal(first(`\t${c} approve ${ID}`), null, 'a tab: indented code');
  assert.equal(first(`Looks right.\n${c} approve ${ID}`), null, 'a command after the first line is not read');
  assert.deepEqual(first(`${c} approve`), { option: 'approve', ids: [] });
  assert.deepEqual(first(`${c} approve ${ID} d-12-bbbbbb`), { option: 'approve', ids: [ID, 'd-12-bbbbbb'] }, 'two ids: both, for the caller to refuse');
  assert.deepEqual(first(`${c} reject ${ID} and ${ID}`), { option: 'reject', ids: [ID] }, 'the same id twice is one id');
  assert.deepEqual(first(`${c} ${ID} approve`), { option: ID, ids: [ID] }, 'the id before the option: an id, and no option (R1182ae AE3)');
  assert.deepEqual(first(`${c.toUpperCase()} APPROVE ${ID.toUpperCase()}`), { option: 'approve', ids: [ID] }, 'upper case');
});

test('ids: a word boundary, lower case', () => {
  assert.deepEqual(first(`${c} approve the add-on`)!.ids, [], '"add-on" holds no id');
  assert.deepEqual(first(`${c} approve x${ID}`)!.ids, []);
  assert.deepEqual(first(`${c} approve ${ID}-`)!.ids, [ID]);
  assert.equal(replyText('AbC'), 'abc');
});

test('the whole comment must be plain ASCII; anything else, anywhere, voids it and is named with its line', () => {
  assert.equal(answers(`${c} approve ${ID}\nthanks, looks good`), true, 'control');
  for (const hex of ['00A0', '2003', 'FEFF', '200B', '2060', '00AD', '202E', '2800', '3164', '0336', '0332', '2215', '2044', '29F8', 'FF0F', '0430', '00E9', '1F44D', 'FE0F', '06DD', '2028']) {
    const ch = u(hex);
    for (const body of [`${c} approve ${ID} ${ch}`, `${c} approve ${ID}\nok ${ch}`, `${ch}${c} approve ${ID}`]) {
      const r = readReply(body);
      assert.equal(answers(body), false, `U+${hex}: ${JSON.stringify(body)}`);
      assert.equal(r.notAscii?.code, `U+${hex}`, `U+${hex} named`);
    }
  }
  assert.deepEqual(readReply(`${c} approve ${ID}\nok\nfine ${u('00E9')}`).notAscii, { code: 'U+00E9', line: 3 });
  assert.equal(readReply(`${c} approve ${ID}\nnaming ${u('1F44D')}`).notAscii?.code, 'U+1F44D', 'an emoji outside the BMP, by its code point');
  assert.ok(NOT_ASCII.test(u('7F')) && !NOT_ASCII.test('\t') && !NOT_ASCII.test('~'), 'DEL is not printable; tab and ~ are ASCII');
  assert.equal(readReply(`d${u('00E9')}j${u('00E0')} vu ${c} approve ${ID}`).ascii.includes(c), true, 'the ASCII text is kept for the note decision');
});

test("the owner's phone characters: curly quotes and en or em dashes read as ' \" -, and nothing else is mapped", () => {
  assert.deepEqual([...new Set(Object.values(TYPED))].sort(), ['"', "'", '-'], 'the only values');
  assert.deepEqual(Object.keys(TYPED).map((ch) => ch.codePointAt(0)!.toString(16).toUpperCase()).sort(), ['2013', '2014', '2018', '2019', '201C', '201D']);
  // (1) A phone-typed reply: a plain first line, smart quotes and dashes below it.
  const phone = `${c} approve ${ID}\nLooks good ${u('2014')} I ${u('2019')}ve checked the ${u('201C')}migration${u('201D')} part ${u('2013')} thanks`;
  assert.equal(answers(phone), true);
  // (2) The mapped characters can't make a command or a slash.
  const all = Object.keys(TYPED).join('');
  for (const body of [`${c} approve ${ID}\n${all}${all}`, `${c} approve ${ID}\n${u('2018')}worklane reject ${ID}`, `${c} approve ${ID}\n${u('2014')}worklane reject ${ID}`]) {
    const r = readReply(body);
    assert.equal(r.notAscii, null);
    assert.deepEqual(r.others, [], JSON.stringify(body));
    assert.equal(r.ascii.split('\n')[1]!.includes('/'), false, 'no slash');
  }
  // (3) Each unmapped near-relative still voids.
  for (const hex of ['201A', '201E', '2032', '2212', '2010', '2011', 'FF0D', '02BC']) {
    assert.equal(readReply(`${c} approve ${ID}\nok ${u(hex)}`).notAscii?.code, `U+${hex}`, `U+${hex} still voids`);
  }
  // The interaction the owner asked about: a mapped apostrophe on line 1 is a ' there, which line 1 refuses.
  assert.equal(readReply(`${c} revise ${ID} don${u('2019')}t split it`).unsafe, true);
});

test('the first line is refused if it holds a character that opens code, HTML, a link, an image, a quote, an escape, an entity, strikethrough or math', () => {
  for (const ch of ['`', '<', '>', '[', ']', '(', ')', '"', "'", '\\', '&', '!', '~', '$', '%']) {
    const r = readReply(`${c} approve ${ID} ok ${ch} x`);
    assert.ok(r.first && r.unsafe, JSON.stringify(ch));
  }
  assert.ok(!readReply(`${c} revise ${ID} keep it smaller, and fix the 2 tests: ok? yes - 50 of them.`).unsafe, 'plain punctuation is fine');
  assert.ok(UNSAFE.test('$x%') && !UNSAFE.test('keep it smaller'));
});

test("(b'): any other `/<cli> <word>`, or any other slash command naming an id, means the comment answers nothing", () => {
  assert.equal(answers(`${c} approve ${ID}`), true, 'control');
  assert.equal(answers(`${c} approve ${ID}\n${c} reject ${ID}`), false, 'a second command line');
  assert.equal(answers(`${c} approve ${ID}\n> Reply ${c} approve ${ID}`), false, 'a quoted question');
  assert.equal(answers(`${c} approve ${ID} then ${c} reject ${ID}`), false, 'twice on the first line');
  assert.equal(answers(`${c} approve ${ID}\n/workIane reject ${ID}`), false, 'an ASCII look-alike name naming an id (R1182ak K1d)');
  assert.equal(answers(`${c} approve ${ID}\nsee /usr/bin and the and/or case`), true, 'a path or and/or naming no id is no command');
  assert.equal(answers(`${c} approve ${ID}\nthe ${ID} plan, and d-12-bbbbbb too`), true, 'ids in text without a slash command');
  assert.deepEqual(readReply(`${c} approve ${ID}\n${c} reject d-12-bbbbbb`).others.map((o) => [o.option, o.ids]), [['reject', ['d-12-bbbbbb']]]);
  assert.equal(answers(`${c}-tools approve`), false, 'another command name with no id: no command at all');
});

test('the note is the rest of the first line without its ids, in its own case; nothing after the first line', () => {
  const note = (body: string) => readReply(body).first?.note;
  assert.equal(note(`${c} revise ${ID} keep it smaller`), 'keep it smaller');
  assert.equal(note(`${c} revise ${ID} Keep It, smaller.`), 'Keep It, smaller.');
  assert.equal(note(`${c} revise ${ID}`), '');
  assert.equal(note(`${c} revise keep ${ID} it smaller`), 'keep it smaller', 'the id anywhere on the line is not part of it');
  assert.equal(note(`${c} revise ${ID} keep it smaller\nand drop the cache`), 'keep it smaller', 'the next line is not part of it');
  assert.equal(note(`${c} revise ${ID.toUpperCase()}, keep it smaller`), 'keep it smaller');
});

test('R1182an AN3: the id must come right after the option (idNext); a comma, colon, semicolon or full stop may follow it', () => {
  const next = (body: string) => readReply(body).first?.idNext;
  assert.equal(next(`${c} approve ${ID}`), true);
  assert.equal(next(`${c} approve ${ID}, thanks`), true);
  assert.equal(next(`${c} revise ${ID}: keep it smaller`), true);
  assert.equal(next(`${c} approve ${ID.toUpperCase()}`), true);
  assert.equal(next(`${c} approve not yet: ${ID} needs tests`), false);
  assert.equal(next(`${c} revise keep v1 ${ID} tables`), false);
  assert.equal(next(`${c} approve x${ID}`), false, "a letter glued before the id: no id there");
  assert.equal(next(`${c} approve`), false);
});

test('rule (c): an open id anywhere outside line 1 slot, as typed or as the page shows it, is found (idsElsewhere, pageText)', () => {
  const live = [ID];
  const elsewhere = (body: string) => idsElsewhere(readReply(body), live);
  assert.deepEqual(elsewhere(`${c} approve ${ID}`), [], 'the slot only');
  assert.deepEqual(elsewhere(`${c} approve ${ID}, thanks`), [], 'the slot with a comma');
  assert.deepEqual(elsewhere(`${c} approve ${ID}\nsee the d-12-bbbbbb plan`), [], 'another id is not this one');
  for (const body of [
    `${c} approve ${ID}, as in ${ID} plan`,
    `${c} approve ${ID}\n${ID}`,
    `${c} approve ${ID}\n&#100;${ID.slice(1)}`,
    `${c} approve ${ID}\n&#x64;&#45;${ID.slice(2)}`,
    `${c} approve ${ID}\n<b>d</b>${ID.slice(1)}`,
    `${c} approve ${ID}\n*d*${ID.slice(1)}`,
    `${c} approve ${ID}\nd&ndash;${ID.slice(2)}`,
    `${c} approve ${ID}\nd&shy;${ID.slice(1)}`,
    `${c} approve ${ID}\nd<!-- x -->${ID.slice(1)}`,
    `${c} approve ${ID}\nx${ID}0`,
    `${c} approve not yet ${ID}`,
  ]) assert.deepEqual(elsewhere(body), [ID], JSON.stringify(body));
  assert.equal(pageText('/wor&#108;&lowbar;lane&sol; A&nbsp;b'), '/worllane/ a b');
  assert.equal(pageText('&bogus; &#0; &#xFFFFFFF;'), '&bogus; &#0; &#xfffffff;', 'unknown or out-of-range entities stay as typed');
});
