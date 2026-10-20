// Governance mode (#704): which PRs the engine didn't open it governs, i.e. may judge and, where its policy allows,
// merge. Pure: one answer for the merge flow and the tests; nothing calls it yet (slice 1; docs/design.md stays as is
// until the mode can be turned on).
//
// INVARIANT: the only way to say "governed" is a GovernedPr, and the only way to make one is governedPr() below. Its
// constructor needs a symbol this module never exports, and isGoverned()/governs() accept only objects it made (a
// module-private WeakSet). Its fields are non-writable and it is frozen at birth (both captured when this module
// loads): a structural copy, Object.create on its prototype, a JSON round trip, a clone or a Proxy is never governed,
// and a real one can't be pointed at another repo, PR or head.
//
// INVARIANT: it fails closed (#704 constraints): off, no source, a fork, a head repo GitHub no longer has, an author it
// can't resolve or whose type doesn't fit its login, a base other than this repo's default branch, a head that isn't an
// exact SHA, a label whose latest application wasn't by an owner or writer, or any fact it compares that is empty or
// not plain ASCII of its kind (repo, branch, login): never governed. Names are compared after an ASCII-only case fold.
//
// It judges the facts it is given: reading them from GitHub (the PR, its head repo, its labels' timeline, each
// labeller's role) is its caller's job (#704 slice S4), and a token proves only that these facts passed.
import type { Role } from './dashboard-auth.js';

/** The PRs an owner put under governance (policy.yaml `governance`, #704 slice S3). Defaults: none. */
export interface GovernanceSource {
  /**
   * GitHub logins as REST's `user.login` spells them, matched whole and in any (ASCII) case. An App's login keeps its
   * `[bot]` suffix (`renovate[bot]`); a few Bots have none (`Copilot`). User `claude` and Bot `claude[bot]` are two
   * accounts.
   */
  authors: readonly string[];
  /** A label that governs a PR while it carries it, counted only when an owner or writer applied it last. */
  label: string | null;
  /** Every same-repo PR into the default branch. */
  all: boolean;
}

/** One labelled or unlabelled event from a PR's timeline, oldest first, with the actor's role here (null: none). */
export interface LabelEvent {
  action: 'labeled' | 'unlabeled';
  label: string;
  actor: string;
  role: Role | null;
}

/** A PR as GitHub's REST API reports it (`GET /repos/{o}/{r}/pulls/{n}`). */
export interface PrFacts {
  number: number;
  /** `head.sha`: the head commit's full SHA. */
  head: string;
  /** `base.repo.full_name` and `base.ref`. */
  baseRepo: string;
  base: string;
  /** `head.repo.full_name`; null when GitHub has none (a deleted fork). */
  headRepo: string | null;
  /**
   * `user.login`, verbatim: a Bot's keeps its `[bot]` suffix. Never GraphQL's `author.login` (it drops the suffix, so
   * Bot `claude[bot]` would read as the User `claude`) nor `gh`'s `app/<slug>`. Empty when GitHub has none.
   */
  author: string;
  /** `user.type`: anything but User or Bot is refused, and a `[bot]` login must be a Bot. */
  authorType: 'User' | 'Bot';
  /** The labels it carries now. */
  labels: readonly string[];
  /** Its timeline's labelled and unlabelled events, oldest first, every page (a partial read must not reach here). */
  labelEvents: readonly LabelEvent[];
}

/** The instance's repo (owner/name) and its default branch. */
export interface GovernanceScope {
  repo: string;
  defaultBranch: string;
}

export type GovernedVia = 'authors' | 'label' | 'all';

const MINT = Symbol('governance mint');
const minted = new WeakSet<object>();
// WHY: captured at load, so code that later replaces Object.freeze or Object.defineProperty can't leave a token writable.
const freeze = Object.freeze;
const defineProperty = Object.defineProperty;

/** A PR this instance governs, in one repo, at one head. Made only by governedPr(); check one with governs(). */
export class GovernedPr {
  declare readonly repo: string;
  declare readonly number: number;
  declare readonly head: string;
  declare readonly via: GovernedVia;
  constructor(mint: symbol, repo: string, number: number, head: string, via: GovernedVia) {
    if (mint !== MINT) throw new Error('a GovernedPr is made only by governedPr()');
    for (const [k, value] of [['repo', repo], ['number', number], ['head', head], ['via', via]] as const) defineProperty(this, k, { value, enumerable: true, writable: false, configurable: false });
    freeze(this);
    minted.add(this);
  }
}

/** Whether x is a GovernedPr the matcher made (never a copy or a look-alike). */
export function isGoverned(x: unknown): x is GovernedPr {
  return typeof x === 'object' && x !== null && minted.has(x);
}

// WHY: ASCII only: Unicode case folding maps other letters onto ASCII ones (the Kelvin sign K lowercases to k).
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const same = (a: string, b: string) => fold(a) === fold(b);
// WHY: GitHub's owner/name characters, ASCII only.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const validRepo = (r: unknown): r is string => typeof r === 'string' && REPO.test(r);

/** Whether token governs PR `number` of `repo` at exactly `head`: false for anything else, a forgery included. */
export function governs(token: unknown, repo: string, number: number, head: string): boolean {
  return isGoverned(token) && validRepo(repo) && same(token.repo, repo) && token.number === number && token.head === head;
}

// WHY: GitHub's login rules (letters, digits, single inner hyphens, at most 39), plus the `[bot]` suffix of an App.
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}(?:\[bot\])?$/i;
// WHY: a full SHA-1 or SHA-256 commit id, as GitHub sends it (lowercase): the head the token is pinned to.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// WHY: git's branch-name rules (check-ref-format), ASCII printable only: never empty, so two blanks never match.
const BRANCH = /^(?![-/.])(?!@$)(?!.*(?:\/\/|\.\.|@\{|\/\.))(?!.*\.lock(?:\/|$))(?!.*[./]$)[!-~]+$/;
const validBranch = (b: unknown): b is string => typeof b === 'string' && BRANCH.test(b) && !/[~^:?*[\\]/.test(b);
// WHY: `ghost` is the login GitHub shows for a deleted account: not someone.
const resolved = (login: string) => LOGIN.test(login) && !same(login, 'ghost');
/** The author is someone, and GitHub's type for them fits the login's shape. */
const authorFits = (pr: PrFacts) => resolved(pr.author) && (pr.authorType === 'Bot' || (pr.authorType === 'User' && !pr.author.endsWith('[bot]')));

/** The label counts: it is on the PR, and its latest application in the timeline was by an owner or writer. */
function labelCounts(label: string, pr: PrFacts): boolean {
  if (!pr.labels.some((l) => same(l, label))) return false;
  const last = pr.labelEvents.filter((e) => same(e.label, label)).at(-1);
  return last?.action === 'labeled' && (last.role === 'owner' || last.role === 'writer');
}

/** Whether this instance governs the PR: its token, or why not. */
export function governedPr(source: GovernanceSource | null, scope: GovernanceScope, pr: PrFacts): { token: GovernedPr; why: null } | { token: null; why: string } {
  const no = (why: string) => ({ token: null, why: `not governed: ${why}` });
  if (!source) return no('governance is off');
  const label = source.label?.trim() ? source.label.trim() : null;
  const authors = source.authors.filter(resolved);
  if (!source.all && !label && !authors.length) return no('no source is set (authors, label or all)');
  if (!validRepo(scope.repo) || !validBranch(scope.defaultBranch)) return no("this instance's repo or default branch is not a valid name");
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) return no('it has no PR number');
  if (!SHA.test(pr.head)) return no('its head is not an exact commit');
  if (!validRepo(pr.baseRepo)) return no('its base repo is not a valid name');
  if (!same(pr.baseRepo, scope.repo)) return no(`it targets ${pr.baseRepo}, not ${scope.repo}`);
  if (!validBranch(pr.base)) return no('its base branch is not a valid name');
  if (pr.base !== scope.defaultBranch) return no(`it targets ${pr.base}, not the default branch`);
  if (!validRepo(pr.headRepo) || !same(pr.headRepo, scope.repo)) return no('it comes from a fork');
  if (!authorFits(pr)) return no('its author is unknown, or not the kind of account its login says');
  const via: GovernedVia | null = authors.some((a) => same(a, pr.author)) ? 'authors' : label && labelCounts(label, pr) ? 'label' : source.all ? 'all' : null;
  if (!via) return no('no source names it');
  return { token: new GovernedPr(MINT, scope.repo, pr.number, pr.head, via), why: null };
}
