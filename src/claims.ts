// Issue claims via git refs. The GitHub Issues API has no compare-and-swap
// (assign, label and comment are last-writer-wins), but a git push carries
// the ref's expected old value and the server applies it atomically. So:
//   claim   = create refs/<cli>/claims/issue-<n>, which must not exist
//   renew   = move it, expecting our current lease
//   steal   = move an EXPIRED lease, expecting the lease we read
//   release = delete it, expecting our lease
// Two coordinators (one per human) racing for the same issue: exactly one
// push succeeds. Labels and assignees are cosmetic and follow the ref.
import { execFileSync, spawnSync } from 'node:child_process';
import { BRAND } from './brand.js';

export interface Lease {
  instance: string;
  run_id: string;
  issue: number;
  expires_at: string;
  base: string;
}

export interface ClaimOptions {
  /** A clone of the project repo; the coordinator's own checkout. */
  repo: string;
  remote?: string;
}

export const claimRef = (issue: number) => `refs/${BRAND.cli}/claims/issue-${issue}`;

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A parentless commit holding the lease as its message. CAS needs no ancestry. */
function leaseCommit(repo: string, lease: Lease): string {
  const tree = git(repo, ['mktree'], '');
  return git(repo, ['-c', 'user.name=' + BRAND.cli, '-c', 'user.email=' + BRAND.cli + '@localhost', 'commit-tree', tree, '-m', JSON.stringify(lease)]);
}

/** Push `newSha` (or delete, when null) to the claim ref, only if it currently equals `expect` ('' = absent). */
function casPush(repo: string, remote: string, issue: number, expect: string, newSha: string | null): boolean {
  const ref = claimRef(issue);
  const r = spawnSync('git', ['push', '--porcelain', `--force-with-lease=${ref}:${expect}`, remote, `${newSha ?? ''}:${ref}`], { cwd: repo, encoding: 'utf8' });
  if (r.status === 0) return true;
  if (/\[rejected\]|stale info|already exists|fetch first/.test(r.stdout + r.stderr)) return false;
  throw new Error(`claim push failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
}

/** The current lease on an issue, read from the remote (never a local cache). */
export function readClaim(issue: number, opts: ClaimOptions): { sha: string; lease: Lease } | null {
  const remote = opts.remote ?? 'origin';
  const line = git(opts.repo, ['ls-remote', remote, claimRef(issue)]);
  if (!line) return null;
  const sha = line.split(/\s+/)[0]!;
  git(opts.repo, ['fetch', '--quiet', remote, `+${claimRef(issue)}:${claimRef(issue)}`]);
  try {
    return { sha, lease: JSON.parse(git(opts.repo, ['log', '-1', '--format=%B', sha])) as Lease };
  } catch {
    return { sha, lease: { instance: 'unknown', run_id: '', issue, expires_at: new Date(0).toISOString(), base: '' } };
  }
}

export type ClaimResult = { won: true; sha: string } | { won: false; holder: Lease | null };

export function claim(lease: Lease, opts: ClaimOptions, now = Date.now(), graceMs = 60_000): ClaimResult {
  const remote = opts.remote ?? 'origin';
  const sha = leaseCommit(opts.repo, lease);
  if (casPush(opts.repo, remote, lease.issue, '', sha)) {
    // Re-read: the claim only counts if the remote now holds exactly our lease.
    const cur = readClaim(lease.issue, opts);
    return cur?.sha === sha ? { won: true, sha } : { won: false, holder: cur?.lease ?? null };
  }
  const cur = readClaim(lease.issue, opts);
  if (cur && Date.parse(cur.lease.expires_at) + graceMs < now) {
    // Expired: take it over by compare-and-swap against the lease we read. Only one stealer wins.
    const stolen = leaseCommit(opts.repo, lease);
    if (casPush(opts.repo, remote, lease.issue, cur.sha, stolen)) return { won: true, sha: stolen };
    return { won: false, holder: readClaim(lease.issue, opts)?.lease ?? null };
  }
  return { won: false, holder: cur?.lease ?? null };
}

export function renew(lease: Lease, currentSha: string, opts: ClaimOptions): string | null {
  const next = leaseCommit(opts.repo, lease);
  return casPush(opts.repo, opts.remote ?? 'origin', lease.issue, currentSha, next) ? next : null;
}

export function release(issue: number, currentSha: string, opts: ClaimOptions): boolean {
  return casPush(opts.repo, opts.remote ?? 'origin', issue, currentSha, null);
}
