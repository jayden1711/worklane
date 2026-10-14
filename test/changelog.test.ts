// CHANGELOG.md from the PRs merged between releases: grouped as features, fixes, security and guardrails, with a
// separate "Guardrail changes" section listing every PR that changed a guardrail file.
import './isolate.js';
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
