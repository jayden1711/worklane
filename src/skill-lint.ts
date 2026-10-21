// Skill lint: every SKILL.md has the six sections a skill needs to be used and checked, each with something in it.
// Validate (how to check the result) matters most: a skill whose result can't be checked is a guess.
import { execFileSync } from './os/child-process.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The sections every SKILL.md must have, as headings (any level from ##), each non-empty. */
export const SKILL_SECTIONS = ['When to use', 'Inputs and access', 'Steps', 'Validate', 'Return', 'Approval'] as const;

const norm = (s: string) => s.trim().replace(/:$/, '').trim().toLowerCase();

/** What is wrong with one SKILL.md's text ([] when it passes). */
export function lintSkill(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Headings outside code fences, with the text up to the next heading at the same level or above.
  const heads: { level: number; name: string; line: number }[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
    else if (fence === null) {
      const h = /^(#{2,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (h) heads.push({ level: h[1]!.length, name: norm(h[2]!), line: i });
    }
  });
  const body = (k: number) => {
    const end = heads.slice(k + 1).find((h) => h.level <= heads[k]!.level)?.line ?? lines.length;
    return lines.slice(heads[k]!.line + 1, end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  };
  const problems: string[] = [];
  for (const s of SKILL_SECTIONS) {
    const k = heads.findIndex((h) => h.name === norm(s));
    if (k < 0) problems.push(`missing the "${s}" section`);
    else if (!body(k)) problems.push(`the "${s}" section is empty`);
  }
  return problems;
}

/** Every tracked SKILL.md in a git checkout (forward-slash paths, relative to `root`). */
export function trackedSkills(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*SKILL.md'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md'));
}

/** Lint every tracked SKILL.md under `root`: the files that fail, each with its problems. */
export function lintSkills(root: string): { file: string; problems: string[] }[] {
  return trackedSkills(root)
    .map((file) => ({ file, problems: lintSkill(readFileSync(join(root, file), 'utf8')) }))
    .filter((r) => r.problems.length);
}

/** One line per failing file, for a refusal or a report. */
export function skillLintReport(results: { file: string; problems: string[] }[]): string {
  return results.map((r) => `${r.file}: ${r.problems.join('; ')}`).join('\n');
}
