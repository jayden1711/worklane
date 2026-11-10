// How a comment is read as a reply to a decision (src/decision-reply.ts). The owner's decisions: a reply names the
// decision's id (2026-11-09), and only a comment's first line is read, in plain text, with no other command in the
// comment (2026-11-10, option (b) with (b')). No markdown is parsed: these cases are the whole reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { readReply, replyText, UNSAFE } from '../src/decision-reply.js';

const c = `/${BRAND.cli}`;
const ID = 'd-12-a3f9c1';
/** The first line's option and ids, or null. */
const first = (body: string) => {
  const f = readReply(body).first;
  return f && { option: f.option, ids: f.ids };
};
/** Whether the comment can answer at all: a first-line command, no refused character, no other command. */
const answers = (body: string) => {
  const r = readReply(body);
  return r.first !== null && !r.unsafe && r.others.length === 0;
};

test("the first non-blank line is the command: its option and ids; nothing after it is one", () => {
  assert.deepEqual(first(`${c} approve ${ID}`), { option: 'approve', ids: [ID] });
  assert.deepEqual(first(`\n  \n${c} approve ${ID}`), { option: 'approve', ids: [ID] }, 'blank lines before it');
  assert.deepEqual(first(`   ${c} approve ${ID}`), { option: 'approve', ids: [ID] }, 'up to 3 spaces before it (R1182ah AH4a)');
  assert.deepEqual(first(`\u00A0${c} approve ${ID}`), { option: 'approve', ids: [ID] }, 'a no-break space before it (AH4e)');
  assert.equal(first(`    ${c} approve ${ID}`), null, '4 spaces: indented code');
  assert.equal(first(`\t${c} approve ${ID}`), null, 'a tab: indented code');
  assert.equal(first(`Looks right.\n${c} approve ${ID}`), null, 'a command after the first line is not read');
  assert.deepEqual(first(`${c} approve`), { option: 'approve', ids: [] });
  assert.deepEqual(first(`${c} approve ${ID} d-12-bbbbbb`), { option: 'approve', ids: [ID, 'd-12-bbbbbb'] }, 'two ids: both, for the caller to refuse');
  assert.deepEqual(first(`${c} reject ${ID} and ${ID}`), { option: 'reject', ids: [ID] }, 'the same id twice is one id');
  assert.deepEqual(first(`${c} ${ID} approve`), { option: ID, ids: [ID] }, 'the id before the option: an id, and no option (R1182ae AE3)');
});

test('ids: a word boundary, after NFKC, folded dashes and lower case', () => {
  assert.deepEqual(first(`${c} approve the add-on`)!.ids, [], '"add-on" holds no id');
  assert.deepEqual(first(`${c} approve x${ID}`)!.ids, []);
  assert.deepEqual(first(`${c} approve ${ID}-`)!.ids, [ID]);
  for (const form of [ID.toUpperCase(), ID.replace(/-/g, '\u2011'), ID.replace(/-/g, '\u2212'), [...ID].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('')]) {
    assert.deepEqual(first(`${c} approve ${form}`)!.ids, [ID], JSON.stringify(form));
  }
  assert.deepEqual(first(`${c}\u00A0APPROVE ${ID}`), { option: 'approve', ids: [ID] }, 'a no-break space and upper case');
  assert.equal(replyText('\uFF21\u2013B'), 'a-b');
});

test('the first line is refused if it holds a character that opens code, HTML, a link, an image, a quote, an escape or an entity', () => {
  for (const ch of ['`', '<', '>', '[', ']', '(', ')', '"', "'", '\\', '&', '!']) {
    const r = readReply(`${c} approve ${ID} ok ${ch} x`);
    assert.ok(r.first && r.unsafe, JSON.stringify(ch));
  }
  assert.ok(readReply(`${c} approve ${ID} \uFF1Cb\uFF1E x`).unsafe, "full-width < and > are < and > after NFKC (no ASCII one on the line)");
  assert.ok(!readReply(`${c} revise ${ID} keep it smaller, and fix the 2 tests: ok? yes - 50%.`).unsafe, 'plain punctuation is fine');
  assert.ok(UNSAFE.test('<!--') && !UNSAFE.test('keep it smaller'));
});

test("(b'): any other `/<cli> <word>` in the comment, on any line, means the comment answers nothing", () => {
  assert.equal(answers(`${c} approve ${ID}`), true, 'control');
  assert.equal(answers(`${c} approve ${ID}\nthanks, looks good`), true, 'plain text after it is fine');
  assert.equal(answers(`${c} approve ${ID}\n${c} reject ${ID}`), false, 'a second command line');
  assert.equal(answers(`${c} approve ${ID}\n> Reply \`${c} approve ${ID}\``), false, 'a quoted question');
  assert.equal(answers(`${c} approve ${ID}\n\`\`\`\n${c} approve d-12-bbbbbb\n\`\`\``), false, 'in a fence');
  assert.equal(answers(`${c} approve ${ID} then ${c} reject ${ID}`), false, 'twice on the first line');
  assert.deepEqual(readReply(`${c} approve ${ID}\n${c} reject d-12-bbbbbb`).others.map((o) => [o.option, o.ids]), [['reject', ['d-12-bbbbbb']]]);
  assert.deepEqual(readReply(`Looks right.\n${c} approve ${ID}`).others.map((o) => [o.option, o.ids]), [['approve', [ID]]], 'not first: reported for the note');
  assert.equal(answers(`${c}-tools approve ${ID}`), false, 'another command name is no command');
});

test("the note is the rest of the first line without its ids, in its own case; nothing after the first line", () => {
  const note = (body: string) => readReply(body).first?.note;
  assert.equal(note(`${c} revise ${ID} keep it smaller`), 'keep it smaller');
  assert.equal(note(`${c} revise ${ID} Keep It, smaller.`), 'Keep It, smaller.');
  assert.equal(note(`${c} revise ${ID}`), '');
  assert.equal(note(`${c} revise keep ${ID} it smaller`), 'keep it smaller', 'the id anywhere on the line is not part of it');
  assert.equal(note(`${c} revise ${ID} keep it smaller\nand drop the cache`), 'keep it smaller', 'the next line is not part of it');
  assert.equal(note(`${c} revise ${ID.toUpperCase()}, keep it smaller`), 'keep it smaller');
});
