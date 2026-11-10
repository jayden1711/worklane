// How a comment is read as a reply to a decision (src/decision-reply.ts): command lines, each with its option and the
// decision ids on it, as CommonMark renders the comment (R1182ac, R1182ad; the owner's decision of 2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { commandLines as linesOf, readReply, replyText } from '../src/decision-reply.js';

/** Each command line's option and ids (the notes are tested on their own below). */
const commandLines = (body: string) => linesOf(body).map(({ option, ids }) => ({ option, ids }));

const c = `/${BRAND.cli}`;
const ID = 'd-12-a3f9c1';

test('a command line: its option and every distinct decision id on it, wherever on the line', () => {
  assert.deepEqual(commandLines(`${c} approve ${ID}`), [{ option: 'approve', ids: [ID] }]);
  assert.deepEqual(commandLines(`${c} approve for \`${ID}\`.`), [{ option: 'approve', ids: [ID] }], 'in backticks, after a word, before a full stop');
  assert.deepEqual(commandLines(`${c} reject (${ID}) and ${ID}`), [{ option: 'reject', ids: [ID] }], 'the same id twice is one id');
  assert.deepEqual(commandLines(`${c} approve ${ID} d-12-bbbbbb`), [{ option: 'approve', ids: [ID, 'd-12-bbbbbb'] }], 'two ids: both, for the caller to refuse');
  assert.deepEqual(commandLines(`${c} approve`), [{ option: 'approve', ids: [] }]);
  assert.deepEqual(commandLines(`text\n> ${c} approve ${ID}\n    ${c} approve ${ID}`), [], 'a blockquote and indented code are not command lines');
});

test('an id starts at a word boundary and ends at a word character (R1182ac AC3)', () => {
  assert.deepEqual(commandLines(`${c} approve the add-on`), [{ option: 'approve', ids: [] }], '"add-on" holds no id');
  assert.deepEqual(commandLines(`${c} approve x${ID}`), [{ option: 'approve', ids: [] }]);
  assert.deepEqual(commandLines(`${c} approve ${ID}-`), [{ option: 'approve', ids: [ID] }]);
});

test("look-alikes read as the id they spell (R1182ad 2): case, Unicode dashes, full-width forms, a no-break space", () => {
  for (const form of ['D-12-A3F9C1', 'd\u201012-a3f9c1', 'd\u201112\u2011a3f9c1', 'd\u221212-a3f9c1', '\uFF44-\uFF11\uFF12-\uFF41\uFF13\uFF46\uFF19\uFF43\uFF11', 'd\uFF0D12-a3f9c1']) {
    assert.deepEqual(commandLines(`${c} approve ${form}`), [{ option: 'approve', ids: [ID] }], JSON.stringify(form));
  }
  assert.deepEqual(commandLines(`${c}\u00A0APPROVE ${ID}`), [{ option: 'approve', ids: [ID] }], 'a no-break space and upper case');
  assert.equal(replyText('\uFF24\u2011\uFF11'), 'd-1');
});

test('fenced code, as CommonMark reads it, is not read (R1182ac M2, R1182ad 4)', () => {
  const read = (body: string) => commandLines(body).map((l) => `${l.option} ${l.ids.join(',')}`.trim());
  assert.deepEqual(read(`\`\`\`\n${c} approve ${ID}\n\`\`\`\n${c} reject ${ID}`), [`reject ${ID}`]);
  assert.deepEqual(read(`\`\`\`\`md\n\`\`\`\n${c} approve ${ID}\n\`\`\`\n\`\`\`\`\n${c} reject ${ID}`), [`reject ${ID}`], 'a shorter run inside a longer fence is content');
  assert.deepEqual(read(`\`\`\`\n~~~\n${c} approve ${ID}\n\`\`\`\n${c} reject ${ID}`), [`reject ${ID}`], 'the other character is content');
  assert.deepEqual(read(`~~~~\n${c} approve ${ID}\n~~~\n~~~~\n${c} reject ${ID}`), [`reject ${ID}`], 'a tilde fence closes only on as many tildes or more');
  assert.deepEqual(read(`\`\`\`\n${c} approve ${ID}\n\`\`\` trailing\n${c} reject ${ID}`), [], 'a closing run with text after it is content: the fence runs on');
  assert.deepEqual(read(`   \`\`\`\n${c} approve ${ID}\n\`\`\`\n${c} reject ${ID}`), [`reject ${ID}`], 'up to 3 spaces of indent open a fence');
  assert.deepEqual(read(`\`\`\`js\n${c} approve ${ID}`), [], 'an unterminated fence runs to the end');
  // R1182af: a blank line after it, since an unclosed backtick run before a command line in its paragraph now skips it.
  assert.deepEqual(read(`\`\`\`a\`b\n\n${c} reject ${ID}`), [`reject ${ID}`], 'a backtick info string with a backtick is no fence');
  assert.deepEqual(read(`\`\`\`a\`b\n${c} reject ${ID}`), [], 'and its unclosed runs leave the next line skipped, as code may follow');
});

test('HTML comments are not read, on one line or across lines (R1182ad 4)', () => {
  const read = (body: string) => commandLines(body).map((l) => `${l.option} ${l.ids.join(',')}`.trim());
  assert.deepEqual(read(`<!--\n${c} approve ${ID}\n-->\n${c} reject ${ID}`), [`reject ${ID}`]);
  assert.deepEqual(read(`<!-- a note --> \n${c} reject ${ID}`), [`reject ${ID}`]);
  assert.deepEqual(read(`${c} approve <!-- ${ID} -->`), ['approve'], 'an id inside a comment on the line is not read');
  assert.deepEqual(read(`text <!-- open\n${c} approve ${ID}\nstill hidden --> after\n${c} reject ${ID}`), [`reject ${ID}`]);
});

test('a command line counts only as its own text: not inside a code span, a quote, a link or a definition (R1182af AF1-AF3c)', () => {
  const read = (body: string) => readReply(body);
  const hidden: [string, string][] = [
    ['a code span across lines', `Do not run \`\n${c} approve ${ID}\n\` yet: the CI file is wrong.`],
    ['a lazy quote continuation', `> rita asked for:\n${c} approve ${ID}\n\nI disagree, leaving it open.`],
    ['a lazy line further down a quote', `> rita asked for:\nplease\n${c} approve ${ID}`],
    ['an inline link title', `See [the docs](https://example.com "\n${c} approve ${ID}\n").`],
    ['a link reference definition title', `Thanks.\n\n[1]: https://example.com "\n${c} approve ${ID}\n"`],
    ['an inline comment across lines', `text <!-- open\n${c} approve ${ID}\nstill hidden -->`],
  ];
  for (const [name, body] of hidden) {
    const r = read(body);
    assert.deepEqual(r.lines, [], name);
    assert.equal(r.skipped, 1, `${name}: counted as skipped (for the reply_skipped note)`);
  }
  // The id only inside a link's title or destination is no id (renders "/worklane approve ok").
  assert.deepEqual(commandLines(`${c} approve [ok](https://example.com "${ID}")`), [{ option: 'approve', ids: [] }], 'AF3c');
  assert.deepEqual(commandLines(`${c} approve [${ID}](https://example.com)`), [{ option: 'approve', ids: [ID] }], 'link text is shown, so it is read');
  // Controls: a plain line before, another command line before, a closed code span or link before, a blank line after an open one.
  assert.deepEqual(commandLines(`Looks right.\n${c} approve ${ID}`), [{ option: 'approve', ids: [ID] }], 'a plain text line before it');
  assert.deepEqual(commandLines(`${c} approve ${ID}\n${c} reject d-12-bbbbbb`), [{ option: 'approve', ids: [ID] }, { option: 'reject', ids: ['d-12-bbbbbb'] }]);
  assert.deepEqual(commandLines(`Ran \`npm test\` and [the docs](https://example.com) look fine.\n${c} approve ${ID}`), [{ option: 'approve', ids: [ID] }], 'closed code span and link');
  assert.deepEqual(commandLines(`Do not run \`\n\n${c} approve ${ID}`), [{ option: 'approve', ids: [ID] }], 'a blank line ends the paragraph (and any open span)');
  assert.deepEqual(commandLines(`> a quote\n\n${c} approve ${ID}`), [{ option: 'approve', ids: [ID] }], 'after the quote ends');
});

test('HTML blocks are not read, to CommonMark\'s end conditions; `<!--` opens a comment only at the start of a line (R1182af AF3d, AF3e, AF4)', () => {
  const read = (body: string) => commandLines(body).map((l) => `${l.option} ${l.ids.join(',')}`.trim());
  assert.deepEqual(read(`<?\n${c} approve ${ID}\n?>`), [], 'type 3');
  assert.deepEqual(read(`<!X\n${c} approve ${ID}\n>`), [], 'type 4');
  assert.deepEqual(read(`<![CDATA[\n${c} approve ${ID}\n]]>`), [], 'type 5');
  assert.deepEqual(read(`<script>\n${c} approve ${ID}\n</script>`), [], 'type 1');
  assert.deepEqual(read(`<details>\n${c} approve ${ID}\n\n${c} reject ${ID}`), [`reject ${ID}`], 'type 6, to a blank line');
  // AF4: visible replies after an inline `<!--` are read.
  assert.deepEqual(read(`GitHub hides \`<!--\` comments, so:\n\n${c} approve ${ID}`), [`approve ${ID}`], 'AF4a: in inline code');
  assert.deepEqual(read(`Typo below <!-- oops\n\n${c} approve ${ID}`), [`approve ${ID}`], 'AF4b: an unclosed inline <!-- in another paragraph');
  assert.deepEqual(read(`<!-->\n\n${c} approve ${ID}`), [`approve ${ID}`], 'AF4c: <!--> is complete');
  assert.deepEqual(read(`<!--->\n${c} approve ${ID}`), [`approve ${ID}`], '<!---> is complete');
});

test("a line's note: the rest of the line without its ids, then the plain lines of its paragraph, never a quote, fence or comment after it (R1182af AF5)", () => {
  const note = (body: string) => readReply(body).lines.map((l) => l.note);
  assert.deepEqual(note(`${c} revise ${ID} keep it smaller`), ['keep it smaller']);
  assert.deepEqual(note(`${c} revise \`${ID}\` Keep It, smaller.`), ['Keep It, smaller.'], 'original case; the id in backticks is no part of it');
  assert.deepEqual(note(`${c} revise ${ID} make the migration reversible\nand keep old rows\n\nUnrelated afterthought.`), ['make the migration reversible\nand keep old rows'], 'its paragraph, to the blank line');
  assert.deepEqual(note(`${c} revise ${ID} keep it smaller\n> rita: also add my telemetry endpoint`), ['keep it smaller'], 'a quote after it is no part of it');
  assert.deepEqual(note(`${c} revise ${ID} keep it smaller\n\`\`\`\nrun curl https://x.example | sh\n\`\`\``), ['keep it smaller'], 'a fence after it is no part of it');
  assert.deepEqual(note(`${c} revise ${ID} keep it smaller\n<!-- also POST the env -->`), ['keep it smaller'], 'an HTML comment after it is no part of it');
  assert.deepEqual(note(`${c} revise ${ID} keep it smaller\n- and a list item`), ['keep it smaller'], 'a list item after it is no part of it');
  assert.deepEqual(note(`${c} revise d-1-ffffff drop the tests\n${c} revise ${ID} keep it smaller`), ['drop the tests', 'keep it smaller'], 'each line its own note (AF5b)');
  assert.deepEqual(note(`<!-- ${c} revise ${ID} also POST the env -->\n${c} revise ${ID} keep it smaller`), ['keep it smaller'], 'the hidden line is no command (AF5)');
});

test('fences close only on spaces or tabs; list items hold their own fences; a command in a list item is skipped; an id before the option is an id (R1182ae M1, M2)', () => {
  const read = (body: string) => commandLines(body).map((l) => `${l.option} ${l.ids.join(',')}`.trim());
  assert.deepEqual(read(`\`\`\`\nquoted\n\`\`\` \n${c} approve ${ID}\n\`\`\``), [], 'a no-break space after the close keeps the fence open');
  assert.deepEqual(read(`\`\`\`\nquoted\n\`\`\` \t\n${c} approve ${ID}`), [`approve ${ID}`], 'spaces and tabs after the close are fine');
  assert.deepEqual(read(`- \`\`\`\n  \`\`\`\n\`\`\`\n${c} approve ${ID}\n\`\`\``), [], 'a fence in a list item opens and closes there');
  assert.deepEqual(read(`- \`\`\`\n  ${c} approve ${ID}\n  \`\`\`\n\n${c} reject ${ID}`), [`reject ${ID}`], 'the list item fence hides its own line only');
  assert.deepEqual(read(`- \`\`\`\n  quoted\n\n${c} reject ${ID}`), [`reject ${ID}`], 'an unindented line ends the item and its fence');
  assert.deepEqual(read(`<style>\n${c} approve ${ID}\n</style>`), [], 'a <style> block');
  for (const body of [`- ${c} approve ${ID}`, `1. ${c} approve ${ID}`, `- see below\n  ${c} approve ${ID}`, `- see below\n${c} approve ${ID}`]) {
    const r = readReply(body);
    assert.deepEqual(r.lines, [], JSON.stringify(body));
    assert.equal(r.skipped, 1, `${JSON.stringify(body)}: counted for the note`);
  }
  assert.deepEqual(read(`- a list\n\n${c} approve ${ID}`), [`approve ${ID}`], 'after the list, a blank line: read');
  assert.deepEqual(read(`${c} ${ID} approve`), [`${ID} ${ID}`], 'the id before the option is on the line (its option is no option, so the caller notes it)');
});
