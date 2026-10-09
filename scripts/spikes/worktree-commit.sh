#!/usr/bin/env bash
# Spike, not setup: can a sandboxed agent commit from a git worktree? A
# worktree's commits write to the main checkout's .git (objects, refs,
# worktrees/<name>), outside the worktree itself. Runs one short agent turn
# as the instance's agent user, with the installed engine's sandbox settings,
# in a scratch repo in that user's home (not /tmp, which sandboxes keep
# writable). Prints what was allowed. Spends one small turn of usage.
#   bash scripts/spikes/worktree-commit.sh <name>
source "$(dirname "$0")/../setup/lib.sh"
as_root "$@"
name="${1:?usage: worktree-commit.sh <name>}"
agent="wl-$name-agent"
home="/home/$agent"
probe="$home/wl-sandbox-probe"
trap 'rm -rf "$probe"' EXIT

say "scratch repo with a worktree laid out like the coordinator's, owned by $agent"
rm -rf "$probe"
sudo -u "$agent" -H bash -euo pipefail -c '
  mkdir -p "$1" && cd "$1" && git init -q -b main checkout && cd checkout
  git -c user.name=probe -c user.email=probe@localhost commit -q --allow-empty -m init
  git worktree add -q -b worklane/issue-0 .claude/worktrees/worklane-issue-0
' _ "$probe"
wt="$probe/checkout/.claude/worktrees/worklane-issue-0"
settings="$(node --input-type=module -e 'const m = await import("/opt/worklane/current/dist/src/sandbox.js"); process.stdout.write(JSON.stringify(m.sandboxSettings({ lane: { allowedDomains: [] }, denyRead: [] })))')"

say "one agent turn in the worktree: write outside it (should be refused), then commit"
cmd="touch $probe/checkout/outside-probe; echo TOUCH=\$?; git -c user.name=probe -c user.email=probe@localhost commit --allow-empty -m probe; echo COMMIT=\$?"
printf 'Run exactly this one command with the Bash tool, then reply with its full output and nothing else: %s' "$cmd" |
  (cd "$wt" && sudo -u "$agent" -- /usr/bin/env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin \
    claude -p --settings "$settings" --model haiku --max-turns 3 --permission-mode dontAsk --allowedTools Bash --setting-sources project) | tail -6

say "result"
[ -e "$probe/checkout/outside-probe" ] && echo "write outside the worktree: ALLOWED (sandbox not confining writes)" || echo "write outside the worktree: refused (as it should be)"
tip="$(sudo -u "$agent" git -C "$probe/checkout" log -1 --format=%s worklane/issue-0)"
[ "$tip" = probe ] && echo "commit from the worktree: OK" || echo "commit from the worktree: FAILED (branch tip: $tip)"
