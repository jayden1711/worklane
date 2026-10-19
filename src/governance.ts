// Governance mode (#704): which PRs the engine didn't open it governs, i.e. may judge and, where its policy allows,
// merge. Pure: one answer for the merge flow and the tests; nothing calls it yet (slice 1; docs/design.md stays as is
// until the mode can be turned on).
//
// INVARIANT: the only way to say "governed" is a GovernedPr, and the only way to make one is governedPr() below. Its
// constructor needs a symbol this module never exports, and isGoverned()/governs() accept only objects it made (a
// module-private WeakSet), frozen at birth: a structural copy, Object.create on its prototype, a JSON round trip, a
// clone or a Proxy is never governed, and a real one can't be pointed at another PR or head.
//
// INVARIANT: it fails closed (#704 constraints): off, no source, a fork, a head repo GitHub no longer has, an author it
// can't resolve, a base other than this repo's default branch, a head that isn't an exact SHA, or a label whose latest
// application wasn't by an owner or writer: never governed.
//
// It judges the facts it is given: reading them from GitHub (the PR, its head repo, its labels' timeline, each
// labeller's role) is its caller's job (#704 slice S4), and a token proves only that these facts passed.
import type { Role } from './dashboard-auth.js';

/** The PRs an owner put under governance (policy.yaml `governance`, #704 slice S3). Defaults: none. */
export interface GovernanceSource {
  /** GitHub logins, bots included (`name[bot]`), matched whole and in any case. */
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

/** A PR as GitHub reports it. */
export interface PrFacts {
  number: number;
  /** The head commit's full SHA. */
  head: string;
  /** owner/name of the repo the PR targets, and its base branch. */
  baseRepo: string;
  base: string;
  /** owner/name of the repo its head branch lives in; null when GitHub has none (a deleted fork). */
  headRepo: string | null;
  /** The author's login; empty when GitHub has none. */
  author: string;
  /** The labels it carries now. */
  labels: readonly string[];
  /** Its timeline's labelled and unlabelled events, oldest first. */
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

/** A PR this instance governs, at one head. Made only by governedPr(); check one with isGoverned() or governs(). */
export class GovernedPr {
  readonly number: number;
  readonly head: string;
  readonly via: GovernedVia;
  constructor(mint: symbol, number: number, head: string, via: GovernedVia) {
    if (mint !== MINT) throw new Error('a GovernedPr is made only by governedPr()');
    this.number = number;
    this.head = head;
    this.via = via;
    Object.freeze(this);
    minted.add(this);
  }
}

/** Whether x is a GovernedPr the matcher made (never a copy or a look-alike). */
export function isGoverned(x: unknown): x is GovernedPr {
  return typeof x === 'object' && x !== null && minted.has(x);
}

/** Whether token governs PR `number` at exactly `head`: false for anything else, a forgery included. */
export function governs(token: unknown, number: number, head: string): boolean {
  return isGoverned(token) && token.number === number && token.head === head;
}

// WHY: GitHub's login rules (letters, digits, single inner hyphens, at most 39), plus the `[bot]` suffix of an App.
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}(?:\[bot\])?$/i;
// WHY: a full SHA-1 or SHA-256 commit id, as GitHub sends it (lowercase): the head the token is pinned to.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// WHY: `ghost` is the login GitHub shows for a deleted account: not someone.
const resolved = (login: string) => LOGIN.test(login) && !same(login, 'ghost');

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
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) return no('it has no PR number');
  if (!SHA.test(pr.head)) return no('its head is not an exact commit');
  if (!REPO.test(scope.repo) || !same(pr.baseRepo, scope.repo)) return no(`it targets ${pr.baseRepo}, not ${scope.repo}`);
  if (pr.base !== scope.defaultBranch) return no(`it targets ${pr.base}, not the default branch`);
  if (pr.headRepo === null || !same(pr.headRepo, scope.repo)) return no('it comes from a fork');
  if (!resolved(pr.author)) return no('its author is unknown');
  const via: GovernedVia | null = authors.some((a) => same(a, pr.author)) ? 'authors' : label && labelCounts(label, pr) ? 'label' : source.all ? 'all' : null;
  if (!via) return no('no source names it');
  return { token: new GovernedPr(MINT, pr.number, pr.head, via), why: null };
}
