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
export const claimRef = (issue) => `refs/${BRAND.cli}/claims/issue-${issue}`;
function git(repo, args, input) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
/** A parentless commit holding the lease as its message. CAS needs no ancestry. */
function leaseCommit(repo, lease) {
    const tree = git(repo, ['mktree'], '');
    return git(repo, ['-c', 'user.name=' + BRAND.cli, '-c', 'user.email=' + BRAND.cli + '@localhost', 'commit-tree', tree, '-m', JSON.stringify(lease)]);
}
/** Push `newSha` (or delete, when null) to the claim ref, only if it currently equals `expect` ('' = absent). */
function casPush(repo, remote, issue, expect, newSha) {
    const ref = claimRef(issue);
    const r = spawnSync('git', ['push', '--porcelain', `--force-with-lease=${ref}:${expect}`, remote, `${newSha ?? ''}:${ref}`], { cwd: repo, encoding: 'utf8' });
    if (r.status === 0)
        return true;
    if (/\[rejected\]|stale info|already exists|fetch first/.test(r.stdout + r.stderr))
        return false;
    throw new Error(`claim push failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
}
/** The current lease on an issue, read from the remote (never a local cache). */
export function readClaim(issue, opts) {
    const remote = opts.remote ?? 'origin';
    const line = git(opts.repo, ['ls-remote', remote, claimRef(issue)]);
    if (!line)
        return null;
    const sha = line.split(/\s+/)[0];
    git(opts.repo, ['fetch', '--quiet', remote, `+${claimRef(issue)}:${claimRef(issue)}`]);
    try {
        return { sha, lease: JSON.parse(git(opts.repo, ['log', '-1', '--format=%B', sha])) };
    }
    catch {
        return { sha, lease: { instance: 'unknown', run_id: '', issue, expires_at: new Date(0).toISOString(), base: '' } };
    }
}
export function claim(lease, opts, now = Date.now(), graceMs = 60_000) {
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
        if (casPush(opts.repo, remote, lease.issue, cur.sha, stolen))
            return { won: true, sha: stolen };
        return { won: false, holder: readClaim(lease.issue, opts)?.lease ?? null };
    }
    return { won: false, holder: cur?.lease ?? null };
}
export function renew(lease, currentSha, opts) {
    const next = leaseCommit(opts.repo, lease);
    return casPush(opts.repo, opts.remote ?? 'origin', lease.issue, currentSha, next) ? next : null;
}
export function release(issue, currentSha, opts) {
    return casPush(opts.repo, opts.remote ?? 'origin', issue, currentSha, null);
}
//# sourceMappingURL=claims.js.map