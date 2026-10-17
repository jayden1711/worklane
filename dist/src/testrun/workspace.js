// A test run's workspace: a git repo of its own, made fresh for each run, with the commit checked out and the default
// branch as `main`-style refs (refs/heads/<branch> and refs/remotes/origin/<branch>), so suites that call git (log,
// diff against main, lfs, merge-base) work as on CI. It has no remote URL, no credential helper, hooks off, and
// nothing of the coordinator's .git/config. It is wiped with everything else of the run.
//
// Its objects come from the instance's object store, the test user's own (never the coordinator's .git, which the
// test user can't read): a bare repo every run of the instance reads through alternates. The coordinator sends each
// run a bundle of only the objects the store lacks (nothing at all when it has the commit and the default branch),
// and the helper fetches it into the store as the test user before the run starts. A run's own commands can read the
// store and never write it: the sandbox's file system is read-only outside the run's directory, its caches and its
// shared directories. Objects are named by their hashes, and a fetch checks every one it takes, so one run's objects
// never change what another run reads.
//
// Directories the project leaves out (tests.yaml checkout.sparse_exclude) are left out of the workspace too (sparse
// checkout), unless a tier of the run sets full_checkout.
import { execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { BRAND } from '../brand.js';
import { safeProjectEnv } from '../project-env.js';
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
/** The default branch's name and commit in the coordinator's clone: origin/HEAD, else origin/main, else main. */
export function defaultBranch(repo) {
    try {
        const ref = git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD');
        const name = ref.replace(/^refs\/remotes\/origin\//, '');
        return { name, sha: git(repo, 'rev-parse', `${ref}^{commit}`) };
    }
    catch {
        // no origin/HEAD
    }
    for (const [name, ref] of [['main', 'refs/remotes/origin/main'], ['master', 'refs/remotes/origin/master'], ['main', 'refs/heads/main']]) {
        try {
            return { name, sha: git(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`) };
        }
        catch {
            // not this one
        }
    }
    return null;
}
/** Of the store's commits, the ones `repo` has too: a bundle can leave out everything they reach. */
export function sharedTips(repo, tips) {
    const wanted = [...new Set(tips.filter((t) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(t)))];
    if (!wanted.length)
        return [];
    const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: wanted.map((t) => `${t}\n`).join(''), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    return out
        .split('\n')
        .map((l) => l.split(' '))
        .filter(([, type]) => type === 'commit')
        .map(([sha]) => sha);
}
/** Whether `commit` is reachable from none of `have` (so the store lacks it). */
function lacks(repo, commit, have) {
    return !have.length || git(repo, 'rev-list', '--count', commit, '--not', ...have) !== '0';
}
/**
 * A bundle of `sha` and the default branch, as a stream, carrying only what the store lacks: every object they reach
 * that none of `have` (the store's commits this repo also has) reaches. Under temporary refs in the coordinator's
 * clone, private to this run (removed once the bundle is written). Empty when the store has both.
 */
export function treeBundle(repo, sha, id, have = []) {
    if (!/^[0-9a-f]{7,40}$/.test(sha))
        throw new Error(`not a commit: ${sha}`);
    const full = git(repo, 'rev-parse', '--verify', `${sha}^{commit}`);
    const base = defaultBranch(repo) ?? { name: 'main', sha: full };
    const head = `refs/${BRAND.cli}/test-run/${id}/head`;
    const baseRef = `refs/${BRAND.cli}/test-run/${id}/base`;
    const refs = [...(lacks(repo, full, have) ? [[head, full]] : []), ...(lacks(repo, base.sha, have) ? [[baseRef, base.sha]] : [])];
    if (!refs.length)
        return { stream: Readable.from([]), branch: base.name, headSha: full, baseSha: base.sha, refs: 0, done: Promise.resolve() };
    for (const [r, c] of refs)
        git(repo, 'update-ref', r, c);
    const child = spawn('git', ['-C', repo, 'bundle', 'create', '--quiet', '-', ...refs.map(([r]) => r), ...(have.length ? ['--not', ...have] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    const cleanup = () => {
        for (const [r] of refs) {
            try {
                git(repo, 'update-ref', '-d', r);
            }
            catch {
                // already gone
            }
        }
    };
    const done = new Promise((resolve, reject) => {
        child.on('error', (e) => (cleanup(), reject(e)));
        child.on('close', (code) => {
            cleanup();
            if (code === 0)
                resolve();
            else
                reject(new Error(`git bundle of ${sha} failed: ${err.trim().slice(0, 500)}`));
        });
    });
    return { stream: child.stdout, branch: base.name, headSha: full, baseSha: base.sha, refs: refs.length, done };
}
/**
 * The commands that make a run's workspace, run as the test user (the sandbox helper runs the same ones, checked by a
 * test): $1 the bundle (empty when the store has everything), $2 the workspace, $3 the default branch's name, $4 and
 * $5 the bundle's refs for the commit and the default branch, $6 and $7 the two commits, $8 the store; any more
 * arguments are directories left out of the checkout. No single quote in it: the helper holds it in one.
 */
export function cloneScript() {
    return [
        'set -euo pipefail',
        'bundle="$1" work="$2" branch="$3" head="$4" base="$5" hsha="$6" bsha="$7" store="$8"',
        'shift 8',
        // No system or global config of anyone's: only what is set here.
        'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
        // The store, made by the first run (another may be making it at the same moment: whichever init loses waits for
        // the other's), and read without discovery. Nothing in it runs a hook, and no config of its own is written later.
        'sg() { git --git-dir="$store" -c core.hooksPath=/dev/null -c gc.autoDetach=false "$@"; }',
        'for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(sg config --get core.bare 2>/dev/null)" = true ] && break; git init -q --bare "$store" >/dev/null 2>&1 || sleep 1; done',
        // What this run lacks is fetched in (each object checked); the two commits are kept by a ref each.
        'if [ -s "$bundle" ]; then',
        '  refs=()',
        '  for r in "$head" "$base"; do if sg bundle list-heads "$bundle" "$r" | grep -q .; then refs+=("$r"); fi; done',
        '  [ "${#refs[@]}" -eq 0 ] || sg fetch -q --no-tags --no-write-fetch-head "$bundle" "${refs[@]}"',
        'fi',
        'for c in "$hsha" "$bsha"; do',
        '  sg cat-file -e "$c^{commit}" || { echo "the object store has no commit $c" >&2; exit 1; }',
        '  sg update-ref "refs/keep/$c" "$c" 2>/dev/null || true',
        'done',
        // The newest 50 commits stay as the store's tips; older ones lose their ref (their objects stay, for git's gc).
        'sg for-each-ref --sort=-committerdate --format="%(refname)" refs/keep/ | tail -n +51 | while IFS= read -r r; do sg update-ref -d "$r" 2>/dev/null || true; done',
        'sg gc --auto --quiet || true',
        // The workspace: its objects read from the store, its own refs, the commit checked out.
        'git init -q -b "$branch" "$work"',
        'cd "$work"',
        'mkdir -p .git/objects/info .git/info',
        'printf "%s\\n" "$store/objects" > .git/objects/info/alternates',
        'git config core.hooksPath /dev/null',
        'git config credential.helper ""',
        'git config user.name test-run',
        'git config user.email test-run@example.com',
        'git update-ref "refs/heads/$branch" "$bsha"',
        'git update-ref "refs/remotes/origin/$branch" "$bsha"',
        'git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$branch"',
        'if [ "$#" -gt 0 ]; then',
        '  git config core.sparseCheckout true',
        '  git config core.sparseCheckoutCone false',
        '  { echo "/*"; for d in "$@"; do echo "!/$d/"; done; } > .git/info/sparse-checkout',
        'fi',
        'git checkout -q --detach "$hsha"',
        'rm -f "$bundle"',
    ].join('\n');
}
/** What the store has, as far as this repo can tell: its tips, never an error (a store unread just means a full bundle). */
async function storeHas(host, repo) {
    try {
        return sharedTips(repo, await host.storeTips());
    }
    catch {
        return [];
    }
}
/**
 * Make run `id`'s workspace at `sha`: the commit checked out, the default branch beside it, its objects from the
 * instance's store (sent only what the store lacks), leaving `exclude` (directories) out of the checkout.
 */
export async function createWorkspace(host, repo, sha, id, exclude = []) {
    const b = treeBundle(repo, sha, id, await storeHas(host, repo));
    // A create that fails before reading the bundle closes it, so git's bundle stops (and its refs go) instead of
    // waiting on a full pipe.
    const created = host.create(id, b.stream, { branch: b.branch, head: `refs/${BRAND.cli}/test-run/${id}/head`, base: `refs/${BRAND.cli}/test-run/${id}/base`, headSha: b.headSha, baseSha: b.baseSha, exclude }).catch((e) => {
        b.stream.destroy();
        throw e;
    });
    const [ws] = await Promise.all([created, b.done]);
    return { ...ws, bundleRefs: b.refs };
}
/**
 * Everything a run's commands get, and nothing else: the project's own variables (the same rules as tests.yaml
 * env: no secret-like or harness names), the caches' directories, and the run's DATABASE_URL. Never this
 * process's environment, so no credential the coordinator holds can reach a run.
 */
export function runEnv(projectEnv, caches, db) {
    const env = { ...safeProjectEnv(projectEnv), ...safeProjectEnv(caches) };
    delete env.DATABASE_URL;
    if (db)
        env.DATABASE_URL = db.url;
    return env;
}
/** Wipe run `id`; a wipe that leaves anything behind throws, naming what is left. */
export async function wipeWorkspace(host, id) {
    const r = await host.wipe(id);
    if (!r.ok)
        throw new Error(`run ${id} was not wiped: ${r.left.join(', ') || 'unknown'}`);
}
//# sourceMappingURL=workspace.js.map