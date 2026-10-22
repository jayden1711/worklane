// The owner's decision diff and the fix-forward culprit diff show a binary file as main does (#927; the owner's
// decision, 2026-10-21: "Cut --text, land the runner."). Both went through git with `--text` in this PR, which showed
// a binary file's bytes (on the owner's dashboard, and in a fix task's tracker issue). They run through the git runner
// as before, with main's arguments: a binary file is "Binary files ... differ", a text file shows its lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionDiff } from '../src/decision-detail.js';
import { agents, commitAll, coordinator, fixture, git } from './repro-state-graph/harness.js';

/** A binary file (a NUL in it) holding a printable run that must not show, and a control byte. */
const SECRET_RUN = 'NotShownRun7Qx2';
const BLOB = Buffer.concat([Buffer.from(`header line\n${SECRET_RUN}`), Buffer.from([0, 1, 2, 0x0a]), Buffer.from('tail\n')]);

/** In the fixture's clone: a commit adding a binary file and changing a text file. Its id and its parent's. */
function culprit(repo: string): { base: string; head: string } {
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'blob.bin'), BLOB);
  writeFileSync(join(repo, 'notes.md'), 'a text line the diff shows\n');
  commitAll(repo, 'add a blob and notes');
  return { base, head: git(repo, 'rev-parse', 'HEAD') };
}

function asMain(diff: string) {
  assert.match(diff, /Binary files \/dev\/null and b\/blob\.bin differ/, 'the binary file shows as main shows it');
  assert.match(diff, /^\+a text line the diff shows$/m, "the text file's lines show");
  assert.equal(diff.includes(SECRET_RUN), false, "none of the binary file's bytes show");
  assert.equal(diff.includes('\0'), false);
}

test("the owner's decision diff shows a binary file as \"Binary files differ\", and a text file's lines", async () => {
  const f = fixture();
  const { base, head } = culprit(f.repo);
  const d = await decisionDiff(f.repo, base, head);
  assert.ok(d.diff !== null, JSON.stringify(d));
  asMain(d.diff);
});

test('the fix-forward culprit diff (what a fix task\'s issue body holds) shows a binary file as "Binary files differ"', () => {
  const f = fixture();
  const { head } = culprit(f.repo);
  const c = coordinator(f, agents());
  const ff = (c as unknown as { fixForward: { d: { git: { diff: (sha: string) => string } } } }).fixForward;
  asMain(ff.d.git.diff(head));
});
