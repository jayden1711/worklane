// The config follows the default branch. The coordinator's clone is never checked out again after it is made, so
// its working tree's config goes stale the moment a config change merges. Instead, each time the remote default
// branch moves, the config files are read at <remote>/<default_branch> straight from git, validated with the same
// schema and checks as at start, and swapped in whole. A config that fails validation is never applied: the last
// good one stays, and why is recorded. Settings read once at start (below) keep their running value until a restart.
// Merges are still judged by the config at their own parent (main-watch.ts requiredAt): this is for everything else.
import { gitSpawnSync } from '../os/git.js';
import { BRAND } from '../brand.js';
import { ConfigInvalid, loadConfigAt, type Config, type ConfigError } from './load.js';

/** The incident an invalid config on the default branch raises, by instance (resolved once a valid one is back). */
export const CONFIG_INCIDENT = 'config_invalid';

/** The git tree of the config directory at `rev`, or null (no such rev, or no config there). */
export function configTree(repo: string, rev: string): string | null {
  const r = gitSpawnSync(['rev-parse', '-q', '--verify', `${rev}:${BRAND.configDir}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A setting that only takes effect at a restart: what is running, and what the default branch now says. */
export interface RestartSetting {
  path: string;
  running: unknown;
  wanted: unknown;
}

type Section = 'project' | 'agents' | 'guardrails' | 'tests' | 'review' | 'deploy' | 'app' | 'roles';

/**
 * Settings the engine reads once, at start, to build something that lives as long as the process: a change to one
 * on the default branch keeps the running value and says a restart is needed, never half-applied.
 * `restart`: whether this change needs one (absent: any change does).
 */
export const RESTART_ONLY: { path: string; why: string; restart?: (running: unknown, wanted: unknown) => boolean }[] = [
  { path: 'project.project.name', why: 'names the service, its slots and its state' },
  { path: 'project.project.repo', why: 'the GitHub token is scoped to the repo at start' },
  { path: 'project.project.default_branch', why: 'the push guard and the coordinator hooks are written for it at start' },
  { path: 'project.backlog', why: 'the backlog client is built at start' },
  { path: 'project.agent_runtime.kind', why: 'the agent runner is built at start' },
  // Turning direct landing on needs the start-up protection gate and hooks that allow the land; turning it off is a tightening.
  { path: 'project.land_mode', why: 'direct landing is checked against branch protection, and its hooks written, at start', restart: (running, wanted) => running !== 'direct' && wanted === 'direct' },
  { path: 'tests.worktree.root', why: 'task worktrees and the pool live there' },
  { path: 'tests.test_run', why: 'the test-run sandbox is set up and checked at start' },
];

function get(c: Config, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), c);
}

function set(c: Config, path: string, value: unknown) {
  const keys = path.split('.');
  let o = c as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  if (value === undefined) delete o[keys.at(-1)!];
  else o[keys.at(-1)!] = structuredClone(value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The new config as it can run now: every restart-only setting kept at its running value, and which ones those were. */
export function liveMerge(running: Config, wanted: Config): { cfg: Config; restart: RestartSetting[] } {
  const cfg = structuredClone(wanted);
  const restart: RestartSetting[] = [];
  for (const s of RESTART_ONLY) {
    const r = get(running, s.path);
    const w = get(wanted, s.path);
    if (same(r, w) || !(s.restart ?? (() => true))(r, w)) continue;
    restart.push({ path: s.path, running: r, wanted: w });
    set(cfg, s.path, r);
  }
  return { cfg, restart };
}

/** The top-level sections that differ between two configs (for the record). */
export function changedSections(a: Config, b: Config): Section[] {
  return (['project', 'agents', 'guardrails', 'tests', 'review', 'deploy', 'app', 'roles'] as const).filter((k) => !same(a[k], b[k]));
}

export type ConfigPoll =
  | { kind: 'same' }
  /** The first poll: the default branch's config is the one running, and it validated (nothing to swap in). */
  | { kind: 'confirmed'; sha: string | null }
  /** The default branch's config is valid again (or back to the one running) after an invalid one. */
  | { kind: 'recovered'; sha: string | null }
  | { kind: 'applied'; sha: string; cfg: Config; restart: RestartSetting[]; changed: Section[] }
  | { kind: 'invalid'; sha: string; errors: ConfigError[] };

export interface LiveConfigOptions {
  repo: string;
  remote: string;
  branch: string;
  /** The config tree the running config was loaded from; absent: the checkout's HEAD (what loadConfig read). */
  tree?: string | null;
  /** Checks beyond the schema (an instance's: the repo may only tighten its policy). */
  check?: (cfg: Config) => ConfigError[];
}

/** The config at <remote>/<branch>, polled: a new tree is loaded and validated once, whatever it holds. */
export class LiveConfig {
  private good: string | null;
  private bad: string | null = null;
  /** Whether a poll has run: the first one validates the default branch's config even when it is the running one. */
  private polled = false;
  private readonly ref: string;

  constructor(private readonly o: LiveConfigOptions) {
    this.ref = `refs/remotes/${o.remote}/${o.branch}`;
    this.good = o.tree !== undefined ? o.tree : configTree(o.repo, 'HEAD');
  }

  /** Whether the default branch's config differs from the running one, and if so, the config to swap in. */
  poll(running: Config): ConfigPoll {
    const tree = configTree(this.o.repo, this.ref);
    // WHY: an incident raised for an invalid config outlives the process (incidents.json). The first poll checks the
    // branch's config for itself, never trusting `good` (a start on the checkout's config may be on the same tree), so
    // a start on a valid config resolves it, and a start on an invalid one raises it.
    const first = !this.polled;
    this.polled = true;
    // Checked before `good`: the running tree can be the one found invalid (by the instance's checks), never "recovered".
    if (tree !== null && tree === this.bad) return { kind: 'same' };
    if (tree === null || (tree === this.good && !first)) {
      if (this.bad === null) return { kind: 'same' };
      this.bad = null;
      return { kind: 'recovered', sha: this.sha() };
    }
    const sha = this.sha() ?? this.ref;
    let wanted: Config;
    try {
      wanted = loadConfigAt(this.o.repo, sha);
      const extra = this.o.check?.(wanted) ?? [];
      if (extra.length) throw new ConfigInvalid(extra);
    } catch (e) {
      this.bad = tree;
      const errors = e instanceof ConfigInvalid ? e.errors : [{ file: BRAND.configDir, path: '', message: (e as Error).message.split('\n')[0]! }];
      return { kind: 'invalid', sha, errors };
    }
    if (tree === this.good) {
      this.bad = null;
      return { kind: 'confirmed', sha: this.sha() };
    }
    this.good = tree;
    this.bad = null;
    const { cfg, restart } = liveMerge(running, wanted);
    return { kind: 'applied', sha, cfg, restart, changed: changedSections(running, cfg) };
  }

  private sha(): string | null {
    const r = gitSpawnSync(['rev-parse', '-q', '--verify', `${this.ref}^{commit}`], { cwd: this.o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0 ? r.stdout.trim() : null;
  }
}

/**
 * The config to start with: the default branch's, read from git after a fetch, when it is there and valid;
 * otherwise the checkout's (`fallback`), and why. `tree` is what the running config was loaded from.
 */
export function startConfig(o: { repo: string; remote: string; fallback: Config; check?: (cfg: Config) => ConfigError[] }): { cfg: Config; tree: string | null; note: string | null } {
  const branch = o.fallback.project.project.default_branch;
  gitSpawnSync(['fetch', '-q', o.remote, `+refs/heads/${branch}:refs/remotes/${o.remote}/${branch}`], { cwd: o.repo, stdio: 'ignore', timeout: 60_000 });
  const ref = `refs/remotes/${o.remote}/${branch}`;
  const tree = configTree(o.repo, ref);
  // WHY (#715): whenever main's config can't run (none there, or invalid), the checkout's config as committed (the
  // default branch as the clone last saw it) runs, never its working tree, where a hand edit could loosen the policy the
  // merges are judged by. The working tree only when HEAD has no valid config either (a first run before any commit).
  // The note names which one ran: the committed config (HEAD), or the working tree.
  const checkout = (why: string, detail = '') => {
    try {
      const committed = loadConfigAt(o.repo, 'HEAD');
      if (!(o.check?.(committed) ?? []).length) return { cfg: committed, tree: configTree(o.repo, 'HEAD'), note: `${why}, started with the checkout's committed config (HEAD)${detail}` };
    } catch {
      // none valid at HEAD either
    }
    return { cfg: o.fallback, tree: configTree(o.repo, 'HEAD'), note: `${why}, started with the checkout's working tree (no valid config committed at HEAD)${detail}` };
  };
  if (tree === null) return checkout(`no ${BRAND.configDir}/ at ${o.remote}/${branch}`);
  try {
    const cfg = loadConfigAt(o.repo, ref);
    const extra = o.check?.(cfg) ?? [];
    if (extra.length) throw new ConfigInvalid(extra);
    return { cfg, tree, note: null };
  } catch (e) {
    return checkout(`${BRAND.configDir}/ at ${o.remote}/${branch} is invalid`, `: ${(e as Error).message.slice(0, 1000)}`);
  }
}
