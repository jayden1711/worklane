import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lintSkill, lintSkills, SKILL_SECTIONS } from '../src/skill-lint.js';
import { doctor } from '../src/doctor.js';
import { repoRoot } from './helpers.js';

const skill = (sections: Record<string, string>) => `---\nname: x\ndescription: y\n---\n\n# X\n\n${Object.entries(sections).map(([h, b]) => `## ${h}\n\n${b}\n`).join('\n')}`;
const full = () => Object.fromEntries(SKILL_SECTIONS.map((s) => [s, `${s} text.`]));

test('a SKILL.md with all six sections, each with text, passes', () => {
  assert.deepEqual(lintSkill(skill(full())), []);
});

test('a missing or empty Validate fails', () => {
  const { Validate: _, ...rest } = full();
  assert.deepEqual(lintSkill(skill(rest)), ['missing the "Validate" section']);
  assert.deepEqual(lintSkill(skill({ ...full(), Validate: '<!-- how to check -->' })), ['the "Validate" section is empty']);
});

test('every missing section is named; case, a trailing colon, deeper headings and CRLF are fine', () => {
  assert.equal(lintSkill('# Only a title\n\nSome text.\n').length, 6);
  const loose = skill(full()).replace('## When to use', '### WHEN TO USE:').replace(/\n/g, '\r\n');
  assert.deepEqual(lintSkill(loose), []);
});

test('a subsection counts as its section’s text; a heading inside a code fence is not a section', () => {
  assert.deepEqual(lintSkill(skill({ ...full(), Steps: '### First\n\nDo it.' })), []);
  const fenced = skill({ ...full(), Steps: '```md\n## Validate\nin a fence\n```' }).replace(/## Validate\n\nValidate text\.\n/, '');
  assert.deepEqual(lintSkill(fenced), ['missing the "Validate" section']);
});

function repoWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-lint-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('lintSkills: every tracked SKILL.md, wherever it is; doctor fails on a bad one', () => {
  const dir = repoWith({ '.claude/skills/good/SKILL.md': skill(full()), '.claude/skills/bad/SKILL.md': skill({ 'When to use': 'x' }), 'docs/nested/a/SKILL.md': skill(full()) });
  const bad = lintSkills(dir);
  assert.deepEqual(bad.map((b) => b.file), ['.claude/skills/bad/SKILL.md']);
  assert.equal(bad[0]!.problems.length, 5);
  const check = doctor(dir).find((c) => c.name === 'skills');
  assert.equal(check?.level, 'fail');
  assert.match(check!.detail, /bad\/SKILL\.md: missing the "Inputs and access" section/);
});

test("this repo's own skills pass the skill lint", () => {
  assert.deepEqual(lintSkills(repoRoot), []);
});
