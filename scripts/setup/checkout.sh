#!/usr/bin/env bash
# Clone an instance's repo as its coordinator, through its GitHub App, with
# permissions that let agents write the code but not the repo's git config
# or hooks. Install the guardrail hooks for the instance's agent runs, every
# time, in the coordinator's own instance home. If the repo has no Worklane
# config yet, auto-config drafts it (`worklane instance auto-config`: the
# project's commands detected and run as the agent user on the default
# branch) and proposes it as a PR from worklane/setup, through the App, for
# you to review and merge; a rerun finds that PR. Never pushes the default branch.
# Re-running it fast-forwards an existing checkout (e.g. after that PR merges). Its pre-push hook (install
# --git-hooks-only) refuses any push to the default branch from the checkout, by anyone.
#   bash scripts/setup/checkout.sh <name> <owner/repo>
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: checkout.sh <name> <owner/repo>}"
repo="${2:?the instance repo (owner/name) missing}"
coord="wl-$name" work="wl-$name-work"
dest="/srv/worklane/$name/${repo#*/}"
# GitHub itself, always: the clone carries the App's token, so no setting names another host.

# Issue #926: .git/ itself, and everything in it but objects/, refs/, logs/ and worktrees/ (and lfs/ and modules/,
# which git-lfs and submodules write from a worktree), is the coordinator's alone: owned by it, and writable by no one
# else. Agents' worktrees write only those (their commits, branches, index and HEAD; measured: commit, checkout -b,
# fetch, rebase, merge, stash and worktree add all work with the rest locked; deleting a branch or tag, and setting
# an upstream, don't, as they rewrite packed-refs or config). Otherwise an agent could rename its own file over .git/config, or add info/attributes, a hook or a
# commondir, and the coordinator's git, which runs here as itself, would run what it names. The working tree stays
# group-writable. The top is locked first, so nothing in it can be swapped while the rest is; a symlink in it is
# refused (root never follows one there), and chown never follows one inside.
lock_git_dir() {
  local g="$dest/.git"
  if [ -L "$g" ] || [ ! -d "$g" ]; then echo "refusing: $g is not a directory" >&2; exit 1; fi
  chown -h "$coord" "$g"
  chmod go-w "$g"
  if [ -n "$(find "$g" -mindepth 1 -maxdepth 1 -type l)" ]; then
    echo "refusing: $g holds a symlink ($(find "$g" -mindepth 1 -maxdepth 1 -type l | head -3 | tr '\n' ' ')); git never makes one there: look at it and remove it, then run this again" >&2
    exit 1
  fi
  find "$g" -mindepth 1 -maxdepth 1 ! -name objects ! -name refs ! -name logs ! -name worktrees ! -name lfs ! -name modules -exec chown -R -h -P "$coord" {} + -exec chmod -R go-w {} +
}
# A checkout from before #926: locked before the coordinator's git runs in it again.
if [ -d "$dest/.git" ]; then
  say "lock $dest/.git to $coord before its git runs there"
  lock_git_dir
fi

say "clone $repo into $dest as $coord (authenticated by the App, through the credential helper)"
run_as "$coord" '
  export WORKLANE_INSTANCE="$1"
  # As the engine runs an instance git (src/os/git.ts, #926): no system or global config, and never on a config that
  # names a command or a host for git (the same keys as its REFUSED_KEYS; test/git-config-guard.test.ts ties them).
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  refused="^(include\.path|includeif\..*\.path|filter\..*\.(clean|smudge|process)|diff\..*\.(command|textconv)|merge\..*\.driver|(mergetool|difftool)\..*\.cmd|url\..*\.(insteadof|pushinsteadof)|remote\..*\.(uploadpack|receivepack|proxy|proxyauthmethod|vcs)|http\.(.*\.)?(ssl[a-z]*|proxy[a-z]*|schannel[a-z]*|pinnedpubkey|curloptresolve|extraheader|cookiefile|savecookies|followredirects)|core\.(worktree|gitproxy|hookspath)|submodule\..*\.update)$"
  # The instance is on the helper line itself: `sudo -u <coordinator> git ...` clears the environment.
  helper="!/usr/local/bin/worklane git-credential --instance $1"
  if [ ! -d "$2/.git" ]; then
    git -c credential.helper= -c "credential.helper=$helper" clone -q "https://github.com/$3.git" "$2"
  fi
  cd "$2"
  # The listing first, on its own: a config git can not read stops here (set -e), never passes as clean.
  listing="$(git config --list --name-only --show-scope --includes)"
  planted="$(printf "%s\n" "$listing" | awk -F "\t" "\$1 != \"command\" { print \$2 }" | grep -Ei "$refused" || true)"
  if [ -n "$planted" ]; then
    echo "refusing to run git in $2: its git config sets $(printf "%s" "$planted" | tr "\n" " ")which names a command or a host for git; take it out of .git/config (git config --unset ...), then run this again" >&2
    exit 1
  fi
  # Later fetches and pushes from this checkout use the App too; nothing else can authenticate here.
  git config --replace-all credential.helper ""
  git config --add credential.helper "$helper"
  git config core.sharedRepository group
  # Re-run after a config PR merges: fast-forward to it, running no hooks (the checkout is agent-writable).
  git -c core.hooksPath=/dev/null pull -q --ff-only
  # Every agent commit, in any worktree of this checkout, is secret-scanned first (gitleaks from tools.sh), and no
  # push from it may update the default branch (the pre-push hook; the harness merges through GitHub only).
  worklane install --root . --git-hooks-only
  git log -1 --format="checkout at %h (%s)"
' "$name" "$dest" "$repo"

say "permissions: the code is group-writable for agents; .git/ is $coord's, but for objects/, refs/, logs/ and worktrees/"
chgrp -R "$work" "$dest"
chmod -R g+rwX "$dest"
find "$dest" -type d -exec chmod g+s {} +
lock_git_dir

say "Worklane config in the repo, and the guardrail hooks for $name's agent runs"
# The hooks and permission rules go to the instance's agent settings, in the coordinator's own instance home (only
# that user can read it): they apply to agent runs only, never to people's own sessions in the repo, and the repo
# commits no .claude/settings.json. Written on every run, whether or not the repo has its config yet; a re-run
# rewrites them from the current config.
run_as "$coord" '
  export WORKLANE_INSTANCE="$1"
  cd "$2"
  engine=/opt/worklane/current/dist/src/cli.js
  if [ -d .worklane ]; then
    echo ".worklane/ present on $(git rev-parse --abbrev-ref HEAD)"
    worklane install --root . --instance "$1" --engine "$engine"
    exit 0
  fi
  # No config on the default branch yet: auto-config (as local mode has it) detects the commands, runs them as the
  # agent user in a scratch worktree beside the checkout (group-writable, hence the umask), and proposes the config
  # as a PR from worklane/setup through the App. Nothing is branched or committed in this checkout, so a rerun finds
  # the PR it opened (or the one still open from before) rather than a branch in its way.
  umask 0002
  set +e
  line="$(worklane instance auto-config "$1")"
  rc=$?
  set -e
  kind="$(printf "%s" "$line" | sed -n "s/^{\"kind\":\"\([a-z]*\)\".*/\1/p")"
  echo "auto-config: ${line:-no answer (exit $rc)}"
  case "$kind" in
    merged) echo "the config is on the default branch now: run this again to bring the checkout up to it" ;;
    proposed) echo "the config is proposed in its setup PR: review and merge it; the coordinator starts once it has merged (add-project waits for it; or run this, then service.sh, again)" ;;
    questions) echo "auto-config has questions to answer before it proposes the config (the line above says how)" ;;
    *) echo "auto-config failed: the line above says why" >&2; exit 1 ;;
  esac
' "$name" "$dest"
