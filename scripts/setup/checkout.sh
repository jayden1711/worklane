#!/usr/bin/env bash
# Clone an instance's repo as its coordinator, through its GitHub App, with
# permissions that let agents write the code but not the repo's git config
# or hooks. If the repo has no Worklane config yet, scaffold it on a
# worklane/setup branch and push only that branch, for a PR you review and
# merge. Never pushes the default branch.
# Re-running it fast-forwards an existing checkout (e.g. after that PR merges).
#   bash scripts/setup/checkout.sh <name> <owner/repo>
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: checkout.sh <name> <owner/repo>}"
repo="${2:?the instance repo (owner/name) missing}"
coord="wl-$name" work="wl-$name-work"
dest="/srv/worklane/$name/${repo#*/}"

say "clone $repo into $dest as $coord (authenticated by the App, through the credential helper)"
run_as "$coord" '
  export WORKLANE_INSTANCE="$1"
  helper="!/usr/local/bin/worklane git-credential"
  if [ ! -d "$2/.git" ]; then
    git -c credential.helper= -c "credential.helper=$helper" clone -q "https://github.com/$3.git" "$2"
  fi
  cd "$2"
  # Later fetches and pushes from this checkout use the App too; nothing else can authenticate here.
  git config --replace-all credential.helper ""
  git config --add credential.helper "$helper"
  git config core.sharedRepository group
  # Re-run after a config PR merges: fast-forward to it, running no hooks (the checkout is agent-writable).
  git -c core.hooksPath=/dev/null pull -q --ff-only
  # Every agent commit, in any worktree of this checkout, is secret-scanned first (gitleaks from tools.sh).
  worklane install --root . --git-hooks-only
  git log -1 --format="checkout at %h (%s)"
' "$name" "$dest" "$repo"

say "permissions: the code is group-writable for agents; the repo's git config and hooks are not"
chgrp -R "$work" "$dest"
chmod -R g+rwX "$dest"
find "$dest" -type d -exec chmod g+s {} +
chmod 0644 "$dest/.git/config"
chmod 0755 "$dest/.git/hooks"
find "$dest/.git/hooks" -type f -exec chmod 0755 {} +

say "Worklane config in the repo"
run_as "$coord" '
  export WORKLANE_INSTANCE="$1"
  cd "$2"
  if [ -d .worklane ]; then echo ".worklane/ present on $(git rev-parse --abbrev-ref HEAD)"; exit 0; fi
  git switch -q -c worklane/setup
  worklane install --root . --engine /opt/worklane/current/dist/src/cli.js
  git add -A .worklane .claude/settings.json
  git -c user.name="$1 coordinator" -c user.email="noreply@localhost" commit -q -m "Add Worklane config (to review before the first task)"
  git push -q origin HEAD:refs/heads/worklane/setup
  git switch -q -
  echo "pushed branch worklane/setup. Open its PR, review and adjust the config, and merge it yourself:"
  echo "  https://github.com/$3/compare/worklane/setup?expand=1"
' "$name" "$dest" "$repo"
