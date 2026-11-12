// How a comment is read as a reply to a decision (src/decision-reply.ts): the allowlist (#1182). A reply is the comment's
// one line, `/<cli> <option> <id> [note]`, the note in letters, digits, spaces and `. , : ; -`, and nothing else; GitHub's
// rendering (body_text), when given, must be that same line. These cases are the whole reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { ALLOWED, idsIn, readReply, secondLook, TYPED } from '../src/decision-reply.js';

const c = `/${BRAND.cli}`;
const ID = 'd-12-a3f9c1';
const u = (hex: string) => String.fromCodePoint(parseInt(hex, 16));
const cmd = (body: string, rendered?: string | null) => readReply(body, rendered).command;
const why = (body: string, rendered?: string | null) => readReply(body, rendered).refused;

test('the one line: the option, the id right after it, and a note in its own case', () => {
  assert.deepEqual(cmd(`${c} approve ${ID}`), { option: 'approve', id: ID, note: '' });
  assert.deepEqual(cmd(`${c} revise ${ID} Keep it smaller, and drop the v1 tables: 2 of them.`), { option: 'revise', id: ID, note: 'Keep it smaller, and drop the v1 tables: 2 of them.' });
  assert.deepEqual(cmd(`${c.toUpperCase()} APPROVE ${ID.toUpperCase()}`), { option: 'approve', id: ID, note: '' }, 'upper case');
  assert.deepEqual(cmd(`${c}  approve   ${ID}  \n\n`), { option: 'approve', id: ID, note: '' }, 'extra spaces, trailing blank lines');
  assert.deepEqual(cmd(`${c} revise ${ID} keep v1 ${u('2014')} the old one`), { option: 'revise', id: ID, note: 'keep v1 - the old one' }, 'a phone dash is a hyphen');
});

test('anything but that one line answers nothing, and says why', () => {
  for (const [body, kind] of [
    [`${c} approve`, 'reply_shape'],
    [`${c} ${ID} approve`, 'reply_shape'],
    [`${c} approve not yet ${ID}`, 'reply_shape'],
    [`   ${c} approve ${ID}`, 'reply_not_plain'],
    [`Looks right.\n${c} approve ${ID}`, 'reply_not_one_line'],
    [`${c} approve ${ID}\nthanks`, 'reply_not_one_line'],
  ] as [string, string][]) assert.equal(why(body)?.kind, kind, JSON.stringify(body));
  // Every character outside the allowlist is refused, and named.
  for (const ch of ['`', '<', '>', '[', ']', '(', ')', '"', "'", '\\', '&', '!', '~', '$', '%', '#', '*', '_', '|', '@', '/', '+', '=', '?', '{', '\t', u('2019'), u('00A0'), u('200B'), u('00E9'), u('1F44D'), u('FF0F')]) {
    const r = why(`${c} approve ${ID} ok ${ch} x`);
    const want = TYPED[ch] ?? ch;
    assert.equal(r?.kind, 'reply_not_plain', JSON.stringify(ch));
    assert.equal(r?.code, `U+${want.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, JSON.stringify(ch));
  }
  assert.ok(ALLOWED.test('a') && ALLOWED.test('-') && !ALLOWED.test("'"), 'the allowlist holds no apostrophe (the owner, 2026-11-10)');
});

test('secondLook: only an open id in the note counts ("1182 dword: b"); the rendering is read for an open id or a second command only ("1182 fv: b")', () => {
  const live = new Set([ID, 'd-12-bbbbbb']);
  const look = (body: string, rendered?: string | null) => secondLook(readReply(body, rendered), live);
  assert.equal(look(`${c} approve ${ID}`), null);
  assert.equal(look(`${c} approve ${ID} as in ${ID}`), 'reply_several_ids', 'the same open id again');
  assert.equal(look(`${c} approve ${ID} and d-12-bbbbbb`), 'reply_several_ids', 'another open id');
  assert.equal(look(`${c} revise ${ID} wait until after d-day, then drop d-bus`), null, 'a note word shaped like an id is fine');
  assert.equal(look(`${c} approve ${ID} unlike d-9-ffffff`), null, 'an id that is not open is fine');
  // The rendering: an emoji GitHub draws from a shortcode is fine; an open id or a second command it adds voids.
  assert.equal(look(`${c} approve ${ID} thanks :tada:`, `${c} approve ${ID} thanks ${u('1F389')}`), null, 'a :tada: in the note');
  assert.equal(look(`${c} approve ${ID} ok`, `${c} approve ${ID} ok\n${c} reject ${ID}`), 'reply_rendering_shows_more', 'a second command');
  assert.equal(look(`${c} approve ${ID} ok`, `${c} approve ${ID} ok ${ID}`), 'reply_rendering_shows_more', 'the open id twice');
  assert.equal(look(`${c} approve ${ID} ok`, `${c} approve ${ID} ok d-12-bbbbbb`), 'reply_rendering_shows_more', 'another open id');
  assert.equal(look(`${c} approve ${ID}`, ''), null, 'an empty rendering adds nothing');
  for (const missing of [null, undefined]) assert.equal(look(`${c} approve ${ID}`, missing), null);
  assert.deepEqual(cmd(`${c} approve ${ID} ok`, `${c} approve ${ID} ok ${u('1F389')}`), { option: 'approve', id: ID, note: 'ok' }, 'the allowlist is on the typed text only');
});

test('what decides a note: the comment names the command or an id', () => {
  assert.deepEqual(readReply(`see ${c} docs`).mentions, { command: true, ids: [] });
  assert.deepEqual(readReply(`about ${ID.toUpperCase()} later`).mentions, { command: false, ids: [ID] });
  assert.deepEqual(readReply('nothing here').mentions, { command: false, ids: [] });
  assert.deepEqual(idsIn(`${ID} and x${ID} and ${ID}-`), [ID]);
});
