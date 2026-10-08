// Risk-based review levels, computed by code from what a change touches.
// The highest matching level wins; a failed or low-confidence evaluator
// verdict bumps it up one; an agent can raise its own level, never lower it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewConfig } from './config/schema.js';
import { globToRegExp } from './guardrails/glob.js';
import { BRAND } from './brand.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
const ORDER: Level[] = ['L0', 'L1', 'L2', 'L3'];
const up = (l: Level): Level => ORDER[Math.min(3, ORDER.indexOf(l) + 1)]!;
const max = (a: Level, b: Level): Level => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** Built-in categories; review.yaml `categories` adds to or overrides them. */
export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  docs: ['**/*.md', 'docs/**', '**/*.txt', 'art/**', 'assets/**'],
  tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  dependency: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '**/package.json', '**/package-lock.json'],
  'harness-config': [`${BRAND.configDir}/**`, '.claude/**', 'CLAUDE.md'],
  'guardrail-config': [`${BRAND.configDir}/guardrails.yaml`],
  migration: ['**/migrations/**', '**/*.sql', 'prisma/schema.prisma'],
  'deploy-config': ['.github/workflows/**', 'railway.json', 'railway.toml', 'deploy/**', 'Dockerfile', 'fly.toml', 'render.yaml'],
  'release-config': ['scripts/release*', '.github/workflows/release*'],
  secrets: ['.env*', '**/*.pem', '**/*secret*', '**/*credential*'],
  auth: ['**/auth/**', '**/*auth*.*', '**/session*.*', '**/totp*.*'],
  'test-machinery': ['scripts/**', 'test/harness*', 'test/run-*'],
};

export interface ChangeFile {
  path: string;
  added: number;
  removed: number;
  /** Added lines, for content checks (data deletion). */
  addedLines?: string[];
}

export interface LevelInput {
  files: ChangeFile[];
  labels: string[];
  /** Money-path regexes or globs (from money_path_source). */
  moneyPaths: RegExp[];
  verdict?: { patch_correct: boolean; test_correct: boolean; confidence: 'high' | 'medium' | 'low' };
  /** An agent may ask for more review, never less. */
  requested?: Level;
}

export interface LevelResult {
  level: Level;
  reasons: string[];
  categories: Record<string, string[]>;
}

/**
 * Money paths from the project's source of truth. A pattern containing
 * regex literals (/.../) yields those; otherwise each line is a glob.
 */
export function loadMoneyPaths(root: string, src: ReviewConfig['money_path_source']): RegExp[] {
  if (!src) return [];
  let text = readFileSync(join(root, src.file), 'utf8');
  if (src.pattern) {
    const m = text.match(new RegExp(src.pattern));
    if (!m) throw new Error(`money_path_source: pattern not found in ${src.file}`);
    text = m[1] ?? m[0];
  }
  const literals = [...text.matchAll(/\/((?:\\\/|[^/\n])+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1]!, m[2]!.replace('g', '')));
  if (literals.length) return literals;
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((g) => globToRegExp(g));
}

export function computeLevel(input: LevelInput, cfg: ReviewConfig, extraCategories: Record<string, string[]> = {}): LevelResult {
  const defs = { ...DEFAULT_CATEGORIES, ...extraCategories };
  const res = Object.fromEntries(Object.entries(defs).map(([k, globs]) => [k, globs.map((g) => globToRegExp(g))]));
  const categories: Record<string, string[]> = {};
  const add = (cat: string, path: string) => (categories[cat] ??= []).push(path);

  for (const f of input.files) {
    for (const [cat, list] of Object.entries(res)) if (list.some((re) => re.test(f.path))) add(cat, f.path);
    if (input.moneyPaths.some((re) => re.test(f.path))) add('money-path', f.path);
    if ((f.addedLines ?? []).some((l) => /\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i.test(l))) add('deletes-data', f.path);
  }
  const lines = input.files.reduce((n, f) => n + f.added + f.removed, 0);
  const isDocOrTest = (p: string) => (categories.docs ?? []).includes(p) || (categories.tests ?? []).includes(p);
  const app = input.files.filter((f) => !isDocOrTest(f.path) && !(categories['harness-config'] ?? []).includes(f.path));
  for (const f of app) if (!(categories['money-path'] ?? []).includes(f.path)) add('app-non-money', f.path);
  if (input.labels.includes('ui')) for (const f of app) add('ui', f.path);
  if (input.labels.includes('money-path')) for (const f of input.files) if (!(categories['money-path'] ?? []).includes(f.path)) add('money-path', f.path);

  const L = cfg.levels;
  const reasons: string[] = [];
  const present = (when: string[]) => when.filter((w) => categories[w]?.length);
  let level: Level = 'L0';

  // L0 only when every file is docs/tests/comments and the change is small.
  const allLow = input.files.length > 0 && input.files.every((f) => isDocOrTest(f.path));
  if (allLow && lines <= (L.L0_auto.max_lines ?? Infinity)) reasons.push(`only docs/tests, ${lines} lines`);
  else {
    level = 'L1';
    reasons.push(allLow ? `docs/tests but ${lines} lines (> ${L.L0_auto.max_lines})` : 'touches app code');
  }
  const l1Limits = (L.L1_evaluator.max_lines !== undefined && lines > L.L1_evaluator.max_lines) || (L.L1_evaluator.max_files !== undefined && input.files.length > L.L1_evaluator.max_files);
  if (l1Limits && (categories['app-non-money'] ?? []).length) {
    add('app-non-money-large', '*');
    level = max(level, 'L2');
    reasons.push(`large app change: ${lines} lines, ${input.files.length} files`);
  }
  const l2 = present(L.L2_notify.when);
  if (l2.length) {
    level = max(level, 'L2');
    reasons.push(...l2.map((c) => `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`));
  }
  const l3 = present(L.L3_human.when);
  if (l3.length) {
    level = 'L3';
    reasons.push(...l3.map((c) => `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`));
  }
  if (L.L3_human.over_lines !== undefined && lines > L.L3_human.over_lines) {
    level = 'L3';
    reasons.push(`${lines} lines (> ${L.L3_human.over_lines})`);
  }
  if (input.verdict && (!input.verdict.patch_correct || !input.verdict.test_correct || input.verdict.confidence === 'low')) {
    const from = level;
    level = up(level);
    reasons.push(`evaluator ${input.verdict.patch_correct ? '' : 'rejected the patch, '}${input.verdict.test_correct ? '' : 'doubts the test, '}confidence ${input.verdict.confidence}: ${from} -> ${level}`);
  }
  if (input.requested && ORDER.indexOf(input.requested) > ORDER.indexOf(level)) {
    reasons.push(`agent asked for ${input.requested}`);
    level = input.requested;
  }
  return { level, reasons, categories };
}
