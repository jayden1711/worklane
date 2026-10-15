// Never push the default branch. The harness merges through GitHub's merge API, never by a push, so a push to
// refs/heads/<default> is refused in two places: in checkedPush (the only way the coordinator pushes code), and in
// git itself, by a pre-push hook. The hook lives in the checkout's common hooks dir (checkout.sh makes it root-owned,
// not agent-writable) for anyone pushing from the checkout, and in a hooks dir of the coordinator's own instance home
// (core.hooksPath in its git environment, service.ts), which holds that hook and nothing else.
// The one exception is land_mode direct, whose landing is a fast-forward push of the default branch by design: there
// the coordinator's own hooks dir has no pre-push, and checkedPush is told it is the direct land.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { EventLog } from './events/log.js';
import { ownerOnlyDir, writeExecutable } from './os/index.js';
/** The marker on the pre-push hook this engine writes (a hook without it is someone else's, kept and chained). */
export const PRE_PUSH_MARKER = `# managed by ${BRAND.cli}: never push the default branch`;
/** The full ref a push refspec's destination names (`main`, `heads/main` and `refs/heads/main` are all refs/heads/main). */
export function destinationRef(ref) {
    const r = ref.replace(/^\+/, '');
    const dst = r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r;
    if (dst.startsWith('refs/'))
        return dst;
    if (dst.startsWith('heads/'))
        return `refs/${dst}`;
    return `refs/heads/${dst}`;
}
/** Whether a push to `ref` would update the default branch. */
export const isDefaultBranchRef = (ref, defaultBranch) => destinationRef(ref) === `refs/heads/${defaultBranch}`;
/** Why this push may not go ahead, or null. A refusal is recorded through the guard. */
export function defaultBranchRefusal(guard, ref, head) {
    if (guard.directLand || !isDefaultBranchRef(ref, guard.defaultBranch))
        return null;
    guard.blocked(destinationRef(ref), head);
    return `pushes ${destinationRef(ref)}, the default branch: ${BRAND.name} never pushes it (merges go through GitHub's merge API)`;
}
/** Record a refused push to the default branch in an event log (the hook's `push-blocked`, and tune). */
export function recordPushBlocked(eventsDb, ref, head, via) {
    const log = new EventLog(eventsDb);
    try {
        log.append('push.blocked', { ref: ref.slice(0, 300), head: head && /^[0-9a-f]{7,40}$/.test(head) ? head : null, via }, BRAND.cli);
    }
    finally {
        log.close();
    }
}
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The pre-push hook: refuses any push to refs/heads/<branch> for the branches named here and the remote's HEAD
 * (whatever origin/HEAD names at push time), records each refusal through the engine when it is there (best effort:
 * the refusal never depends on it), then runs a hook it replaced, with the same input.
 */
export function prePushHook(o) {
    const log = o.node && o.engine ? `  [ -f ${shQuote(o.engine)} ] && ${shQuote(o.node)} ${shQuote(o.engine)} push-blocked --ref "$rref" --sha "$lsha" --via hook >/dev/null 2>&1\n` : '';
    const chain = o.chained ? `if [ -x ${shQuote(o.chained)} ]; then printf '%s\\n' "$input" | ${shQuote(o.chained)} "$@" || exit $?; fi\n` : '';
    return `#!/bin/sh
${PRE_PUSH_MARKER}.
# The harness merges through GitHub's merge API, never by a push. Refuses every push to these branches.
branches=${shQuote(o.branches.join(' '))}
remote_head=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
branches="$branches \${remote_head#origin/}"
input=$(cat)
refused=0
while read -r lref lsha rref rsha; do
  [ -n "$rref" ] || continue
  for b in $branches; do
    [ -n "$b" ] || continue
    if [ "$rref" = "refs/heads/$b" ]; then
      echo "${BRAND.cli}: refusing to push $rref, the default branch: merges go through GitHub's merge API, never a push" >&2
${log}      refused=1
      break
    fi
  done
done <<EOF
$input
EOF
[ "$refused" = 0 ] || exit 1
${chain}exit 0
`;
}
/**
 * Write the pre-push hook into `hooksDir`, keeping (and chaining) a pre-push hook that isn't ours. Returns its path.
 * `ownerOnly`: the directory and hook are this user's only (0700), as the coordinator's own hooks dir must be (a
 * hooks dir anyone else can write runs their code); otherwise 0755, beside a checkout's other hooks.
 */
export function installPrePushHook(hooksDir, o) {
    if (o.ownerOnly)
        ownerOnlyDir(hooksDir);
    else
        mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, 'pre-push');
    const chained = join(hooksDir, `pre-push.before-${BRAND.cli}`);
    if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(PRE_PUSH_MARKER))
        renameSync(hook, chained);
    const text = prePushHook({ branches: o.branches, ...(o.node ? { node: o.node } : {}), ...(o.engine ? { engine: o.engine } : {}), ...(existsSync(chained) ? { chained } : {}) });
    writeExecutable(hook, text, o.ownerOnly ? 0o700 : 0o755);
    return hook;
}
/** The coordinator's own git hooks dir, in its instance home (core.hooksPath in its git environment): only pre-push. */
export const coordinatorHooksDir = (instanceHome) => join(instanceHome, 'git-hooks');
/**
 * Write the coordinator's hooks dir: the pre-push hook for its default branch, or, with land_mode direct (whose land
 * is a push of the default branch), no hook at all. Run at every coordinator start, from the config in effect.
 */
export function writeCoordinatorHooks(instanceHome, o) {
    const dir = coordinatorHooksDir(instanceHome);
    ownerOnlyDir(dir);
    if (o.directLand)
        rmSync(join(dir, 'pre-push'), { force: true });
    else
        installPrePushHook(dir, { branches: [o.defaultBranch], ownerOnly: true, ...(o.node ? { node: o.node } : {}), ...(o.engine ? { engine: o.engine } : {}) });
    return dir;
}
//# sourceMappingURL=push-guard.js.map