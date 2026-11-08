// A PR that predates the test-run config. Tier commands come from tests.yaml test_run on the default branch, but
// they run on each PR's own head: a head older than the config may lack a script a command calls (bash exits 127)
// or have a test runner that rejects an option the command now passes (exit 2). That isn't the PR's code failing,
// and the check says so, with the fix (bring main in), instead of a bare "failed".
//
// "Older than the config": the head doesn't contain the commit that last changed test_run on the default branch.
// Only then is anything here called a predates; an up-to-date head that lacks a script deleted it itself.
// Every git question is asked of the coordinator's clone (the head and the default branch are fetched there), and
// any that can't be answered counts as "no": this never turns a run into a predates on a guess.
import { gitSpawnSync } from '../os/git.js';
import { parse } from 'yaml';
import { BRAND } from '../brand.js';
import { defaultBranch } from './workspace.js';

export const TESTS_YAML = `${BRAND.configDir}/tests.yaml`;

/** Why a tier can't be judged on this head: what it lacks, and the config's commit. */
export interface Predates {
  /** The commit on the default branch that last changed test_run. */
  configCommit: string;
  /** What the head lacks, in a line: "`<path>` is not in this PR's head" or "its test runner rejects `--x`". */
  what: string;
  /** The tier wasn't run (the file it calls is missing), rather than run and failed. */
  notRun: boolean;
}

function git(repo: string, ...args: string[]): { ok: boolean; out: string } {
  const r = gitSpawnSync(['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** tests.yaml's test_run at `rev`, as JSON (null: none there; an unparsable file is its text, so any edit to it counts). */
function testRunAt(repo: string, rev: string): string {
  const r = git(repo, 'show', `${rev}:${TESTS_YAML}`);
  if (!r.ok) return 'null';
  try {
    return JSON.stringify((parse(r.out) as { test_run?: unknown } | null)?.test_run ?? null);
  } catch {
    return `unparsable:${r.out}`;
  }
}

const configCommits = new Map<string, string | null>();

/** The commit, reachable from `base`, that last changed tests.yaml's test_run; null when none can be found. */
export function configCommit(repo: string, base: string): string | null {
  const key = `${repo}\0${base}`;
  if (configCommits.has(key)) return configCommits.get(key)!;
  let found: string | null = null;
  const log = git(repo, 'log', '--format=%H', '-n', '200', base, '--', TESTS_YAML);
  if (log.ok) {
    for (const c of log.out.split('\n').filter(Boolean)) {
      // A root commit has no parent: what it adds is a change from nothing.
      if (testRunAt(repo, c) !== testRunAt(repo, `${c}^`)) {
        found = c;
        break;
      }
    }
  }
  if (configCommits.size > 100) configCommits.clear();
  configCommits.set(key, found);
  return found;
}

/**
 * The config commit, when the head `sha` doesn't contain it (the head predates the config); null when it does, or
 * when there is no default branch or config commit to compare with.
 */
export function configBehind(repo: string, sha: string): string | null {
  const base = defaultBranch(repo);
  if (!base) return null;
  const c = configCommit(repo, base.sha);
  if (!c) return null;
  const r = gitSpawnSync(['-C', repo, 'merge-base', '--is-ancestor', c, sha], { stdio: 'ignore', timeout: 60_000 });
  // 1: not an ancestor. Anything else (0, or an error) is no evidence of an old head.
  return r.status === 1 ? c : null;
}

const unquote = (t: string) => t.replace(/^['"]|['"]$/g, '');

/**
 * The repo paths a command names, conservatively: words with a slash, inside the repo (relative, no `..`), and none
 * of the shell's or the placeholders' syntax (`$`, braces, globs, `=`, `:`). `bash ci/checks/x.sh`,
 * `node scripts/plan.mjs`: yes. `--flag=a/b`, `/usr/bin/x`, `$HOME/x`, `src/*.ts`, `https://…`: no.
 */
export function referencedPaths(command: string): string[] {
  const out = new Set<string>();
  for (const raw of command.split(/[\s;&|()<>]+/)) {
    const t = unquote(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!t.includes('/') || !/^[A-Za-z0-9_.][A-Za-z0-9_./@+-]*$/.test(t)) continue;
    if (t.split('/').some((p) => p === '..' || p === '')) continue;
    out.add(t);
  }
  return [...out];
}

/**
 * The first path the command names that the config's commit has and the head lacks; null when there is none. Only
 * paths on the default branch at the config's commit are required: anything else (an output path, a build
 * directory) the command may well make itself.
 */
export function missingReferencedPath(repo: string, sha: string, configCommitSha: string, command: string): string | null {
  for (const p of referencedPaths(command)) {
    if (!git(repo, 'cat-file', '-e', `${configCommitSha}:${p}`).ok) continue;
    if (!git(repo, 'cat-file', '-e', `${sha}:${p}`).ok) return p;
  }
  return null;
}

// What test runners and argument parsers say for an option they don't know: "Unknown option '--x'" (commander,
// node's parseArgs, cac), "Unknown argument: x" (yargs), "unrecognized arguments: --x" (argparse), "bad option".
const UNKNOWN_OPTION = /\b(unknown|unrecognized|unrecognised|unexpected|invalid|bad|unsupported)\b.{0,24}\b(options?|arguments?|args?|flags?|parameters?)\b/i;
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Whether a failed tier's output says the head can't run the command as configured: exit 127 with "No such file"
 * for a path the command names, or exit 2 with the runner's own unknown-option message naming one of its options.
 * What it lacks, in a line; null for any other failure.
 */
export function oldHeadFailure(command: string, code: number | null, out: string): string | null {
  const lines = out.split('\n');
  if (code === 127) {
    for (const p of referencedPaths(command)) if (lines.some((l) => /No such file/i.test(l) && l.includes(p))) return `\`${p}\` is not in this PR's head`;
    return null;
  }
  if (code === 2) {
    const options = [...new Set(command.split(/\s+/).map(unquote).filter((t) => /^--[A-Za-z0-9][A-Za-z0-9-]*(=|$)/.test(t)).map((t) => t.replace(/=.*$/, '')))];
    for (const l of lines.filter((x) => UNKNOWN_OPTION.test(x))) {
      const o = options.find((opt) => {
        const name = opt.replace(/^--/, '');
        return new RegExp(`(^|[^A-Za-z0-9-])-*${name}([^A-Za-z0-9-]|$)`).test(l) || (name.includes('-') && l.includes(camel(name)));
      });
      if (o) return `its test runner rejects \`${o}\``;
    }
  }
  return null;
}
