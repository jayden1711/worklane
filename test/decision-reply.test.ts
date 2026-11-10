// How a comment is read as a reply to a decision (src/decision-reply.ts): command lines, each with its option and the
// decision ids on it, as CommonMark renders the comment (R1182ac, R1182ad; the owner's decision of 2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { commandLines, replyText } from '../src/decision-reply.js';

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
  assert.deepEqual(read(`\`\`\`a\`b\n${c} reject ${ID}`), [`reject ${ID}`], 'a backtick info string with a backtick is no fence');
});

test('HTML comments are not read, on one line or across lines (R1182ad 4)', () => {
  const read = (body: string) => commandLines(body).map((l) => `${l.option} ${l.ids.join(',')}`.trim());
  assert.deepEqual(read(`<!--\n${c} approve ${ID}\n-->\n${c} reject ${ID}`), [`reject ${ID}`]);
  assert.deepEqual(read(`<!-- a note --> \n${c} reject ${ID}`), [`reject ${ID}`]);
  assert.deepEqual(read(`${c} approve <!-- ${ID} -->`), ['approve'], 'an id inside a comment on the line is not read');
  assert.deepEqual(read(`text <!-- open\n${c} approve ${ID}\nstill hidden --> after\n${c} reject ${ID}`), [`reject ${ID}`]);
});
