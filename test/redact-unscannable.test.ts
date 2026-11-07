// #889 round 6 (the round-5 delta check): a text with a run of millions of characters.
// - secretKinds fails closed: it names the text as too large to scan, so an attachment is refused (409) until the
//   person attaches it anyway, instead of throwing V8's RangeError.
// - A plain base64url run (no prefix, no dot) is left as it was, as on main: the JWT rule passes over it in one step.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as redactModule from '../src/events/redact.js';
import { redactString, secretKinds } from '../src/events/redact.js';
import { AttachmentError, ATTACHMENT_DEFAULT_CAPS, storeUpload } from '../src/chat-attachments.js';

const SIX_MB = 6 * 1024 * 1024;
const huge = `${'ghp'}_${'a'.repeat(SIX_MB)}`;

test('secretKinds names a text it cannot scan instead of throwing', () => {
  let kinds: string[] = [];
  assert.doesNotThrow(() => {
    kinds = secretKinds(huge);
  });
  assert.equal(typeof redactModule.UNSCANNABLE_KIND, 'string');
  assert.deepEqual(kinds, [redactModule.UNSCANNABLE_KIND]);
  // An ordinary text still gets its kinds.
  assert.deepEqual(secretKinds(`x ${'ghp'}_${'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa'} y`), ['GitHub token']);
});

test('an attachment too large to scan is refused (409) until attached anyway', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'attach-huge-'));
  async function* once() {
    yield Buffer.from(huge);
  }
  const put = (anyway: boolean) => storeUpload({ stateDir, name: 'big.txt', body: once(), caps: { ...ATTACHMENT_DEFAULT_CAPS }, by: 'example-collaborator', gitleaks: null, anyway });
  await assert.rejects(put(false), (e: unknown) => e instanceof AttachmentError && e.status === 409 && e.secretKinds.join() === redactModule.UNSCANNABLE_KIND);
  const m = await put(true);
  assert.deepEqual(m.secretKinds, [redactModule.UNSCANNABLE_KIND]);
});

test('a plain base64url run of 6 MB is left as it was (default, broad) and names no kind', () => {
  const plain = 'aB3-_x'.repeat(SIX_MB / 6);
  assert.equal(redactString(plain), plain);
  assert.equal(redactString(plain, { broad: true }), plain);
  assert.deepEqual(secretKinds(plain), []);
});
