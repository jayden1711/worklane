// CHANGELOG.md from the PRs merged between releases: grouped as features, fixes, security and guardrails, with a
// separate "Guardrail changes" section listing every PR that changed a guardrail file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Pr = { number: number; title: string; labels?: string[]; files?: string[] };
const c = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'changelog.mjs')).href)) as {
  prNumbers(subjects: string[]): number[];
  groupOf(pr: Pr): string;
  changelogSection(version: string, date: string, prs: Pr[]): string;
  withSection(existing: string, version: string, section: string): string;
  sectionFor(changelog: string, version: string): string | null;
  handWritten(section: string | undefined): string;
  scrubTitle(title: string, denied: (word: string) => boolean): string;
};
const s = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'signing.mjs')).href)) as {
  signingProblem(cfg: Record<string, string>, exists?: (f: string) => boolean): string | null;
};

test('the PRs between two releases, from first-parent subjects: squash merges and each PR a batch merged, never a merge of main', () => {
  assert.deepEqual(
    c.prNumbers([
      'Denylist: allow the owner handle (#177)',
      'Batch 4: #170 #156 #158 (#184)',
      "Merge branch 'main' into feat/x",
      'A commit with no PR',
      'Guardrail hooks for an instance (#175)',
      'Denylist: allow the owner handle again (#177)',
    ]),
    [177, 170, 156, 158, 175],
  );
});

test('regression: merge commits name their PR ("Merge #N:", "Merge pull request #N", a reviewed range); a title starting "Merge" is still a PR', () => {
  assert.deepEqual(
    c.prNumbers([
      'Merge stages 1-5 (reviewed PRs #8-#11) into main',
      'Merge pull request #274 from someone/feat/usage-limit-pause',
      'Merge train: up to land.parallel_merges green PRs merge in one pass (#296)',
      'Batch 7 (final): #220 #223 (#229)',
      "Merge #381: GitHub's hosts are constants (#377)",
      "Merge branch 'main' into feat/x",
      'Merge remote-tracking branch origin/main',
      'Merge #427: docs: a short, current README',
    ]),
    [8, 9, 10, 11, 274, 296, 220, 223, 381, 427],
  );
});

test('a PR reverted in the same release is listed once, with its revert, and in no group; its reland is listed as usual', () => {
  const sec = c.changelogSection('0.5.0', '2026-10-14', [
    { number: 416, title: 'CI: build the dashboard UI before the tests', files: ['.github/workflows/ci.yml'] },
    { number: 421, title: 'Revert #416 (web UI built before the tests): main red' },
    { number: 422, title: 'Reland #416 with Chrome started through the engine' },
    { number: 430, title: 'Revert #12: an older change' },
  ]);
  assert.match(sec, /### Reverted in this release\n\n- CI: build the dashboard UI before the tests \(#416\): reverted by #421\n/);
  assert.equal((sec.match(/#416\)/g) ?? []).length, 1, '#416 is listed once');
  assert.doesNotMatch(sec, /\(#421\)/, 'the revert is named beside what it reverted, not listed on its own');
  assert.match(sec, /### Features\n\n- Reland #416 with Chrome started through the engine \(#422\)\n- Revert #12: an older change \(#430\)/, 'the reland, and a revert of an earlier release, are ordinary entries');
});

test('regenerating a section keeps what is written by hand above the generated lists; the lists are replaced', () => {
  const lead = '### Highlights\n\nOne command, one URL.\n\n### Upgrade notes (from v0.4.1)\n\n- Remove `every_minutes`.';
  const first = c.withSection('', '0.5.0', c.changelogSection('0.5.0', '2026-10-13', [{ number: 10, title: 'Dashboard: a chat panel' }]));
  const edited = first.replace('## v0.5.0 (2026-10-13)\n\n', `## v0.5.0 (2026-10-13)\n\n${lead}\n\n`);
  assert.equal(c.handWritten(c.sectionFor(edited, '0.5.0')!), lead);
  const again = c.withSection(edited, '0.5.0', c.changelogSection('0.5.0', '2026-10-14', [{ number: 10, title: 'Dashboard: a chat panel' }, { number: 11, title: 'Fix the queue' }]));
  assert.ok(again.includes(`## v0.5.0 (2026-10-14)\n\n${lead}\n\n### Features\n\n- Dashboard: a chat panel (#10)`), again);
  assert.match(again, /### Fixes\n\n- Fix the queue \(#11\)/);
  assert.equal(c.withSection(again, '0.5.0', c.sectionFor(again, '0.5.0')!), again, 'a rerun with nothing new changes nothing');
  assert.equal(c.handWritten(c.changelogSection('0.5.1', '2026-10-20', [])), '', 'a generated section, even an empty one, has no hand-written top');
  const other = c.withSection(again, '0.6.0', c.changelogSection('0.6.0', '2026-10-20', [{ number: 20, title: 'Releases' }]));
  assert.equal(c.handWritten(c.sectionFor(other, '0.6.0')!), '', "another version's highlights are never carried over");
  assert.equal(c.handWritten(c.sectionFor(other, '0.5.0')!), lead);
});

test('a PR title loses the words the denylist refuses, so a regenerated changelog passes it with no hand edit', () => {
  const denied = (w: string) => /\binternal-key-[0-9]+\b/.test(w);
  assert.equal(c.scrubTitle('Dashboard: the chat panel (internal-key-11) — merge after #82', denied), 'Dashboard: the chat panel — merge after #82');
  assert.equal(c.scrubTitle('Dashboard: a chat panel', denied), 'Dashboard: a chat panel');
});

test('groups: guardrail files or words go to security, fixes by label or title, the rest are features', () => {
  assert.equal(c.groupOf({ number: 1, title: 'Dashboard: a chat panel', files: ['web/src/pages/Chat.tsx'] }), 'features');
  assert.equal(c.groupOf({ number: 2, title: 'Fix the queue deadline under load', files: ['src/queue.ts'] }), 'fixes');
  assert.equal(c.groupOf({ number: 3, title: 'Queue: wait for the job', labels: ['bug'] }), 'fixes');
  assert.equal(c.groupOf({ number: 4, title: 'Prod reads: one role', files: ['src/guardrails/rules.ts'] }), 'security', 'a guardrail file');
  assert.equal(c.groupOf({ number: 5, title: 'Sandbox: deny reads of the task files', files: ['src/instance.ts'] }), 'security');
});

test('a release section: each group, then guardrail changes with their files; written first in CHANGELOG.md, replacing a section of the same version', () => {
  const prs: Pr[] = [
    { number: 10, title: 'Dashboard: a chat panel (#10)', files: ['web/src/x.tsx'] },
    { number: 11, title: 'Fix the queue deadline', files: ['src/queue.ts'] },
    { number: 12, title: 'Hooks: refuse writes to frozen tests', files: ['src/hook.ts', 'test/hook.test.ts'] },
  ];
  const sec = c.changelogSection('0.5.0', '2026-10-12', prs);
  assert.equal(
    sec,
    [
      '## v0.5.0 (2026-10-12)',
      '',
      '### Features',
      '',
      '- Dashboard: a chat panel (#10)',
      '',
      '### Fixes',
      '',
      '- Fix the queue deadline (#11)',
      '',
      '### Security and guardrails',
      '',
      '- Hooks: refuse writes to frozen tests (#12)',
      '',
      '### Guardrail changes',
      '',
      '- Hooks: refuse writes to frozen tests (#12): src/hook.ts',
      '',
    ].join('\n'),
  );
  assert.match(c.changelogSection('0.5.1', '2026-10-13', [{ number: 13, title: 'Docs', files: ['docs/a.md'] }]), /### Guardrail changes\n\n- none in this release/);
  const one = c.withSection('', '0.5.0', sec);
  assert.match(one, /^# Changelog\n\nEvery release, newest first/);
  const two = c.withSection(one, '0.6.0', c.changelogSection('0.6.0', '2026-10-20', [{ number: 20, title: 'Releases: signed tags' }]));
  assert.ok(two.indexOf('## v0.6.0') < two.indexOf('## v0.5.0'), 'newest first');
  const again = c.withSection(two, '0.6.0', c.changelogSection('0.6.0', '2026-10-21', [{ number: 21, title: 'Releases: the changelog' }]));
  assert.equal((again.match(/## v0\.6\.0/g) ?? []).length, 1, 'the same version is replaced, not repeated');
  assert.match(again, /Releases: the changelog \(#21\)/);
  assert.match(c.sectionFor(again, '0.5.0')!, /^## v0\.5\.0[\s\S]*src\/hook\.ts$/);
  assert.equal(c.sectionFor(again, '0.4.0'), null);
});

test('signing: refused without a key, or with an SSH key file that is missing; an existing SSH key, an inline key or a GPG key id is fine', () => {
  assert.match(s.signingProblem({})!, /no signing key configured[\s\S]*git config --global gpg\.format ssh/);
  assert.match(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': '/nope/key.pub' }, () => false)!, /\/nope\/key\.pub, which doesn't exist/);
  assert.equal(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': '/k.pub' }, () => true), null);
  assert.equal(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': 'key::ssh-ed25519 AAAA' }, () => false), null);
  assert.equal(s.signingProblem({ 'user.signingkey': 'owner@example.com' }), null);
  assert.match(s.signingProblem({ 'gpg.format': 'x509', 'user.signingkey': 'k' })!, /isn't supported/);
});
