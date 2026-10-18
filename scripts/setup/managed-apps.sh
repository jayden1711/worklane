#!/usr/bin/env bash
# Root's word on which instances' repos are managed apps, not the engine (src/managed-apps.ts). Review it first.
#
#   bash scripts/setup/managed-apps.sh add <instance> <owner/repo>   root says: this instance's repo is a managed app
#   bash scripts/setup/managed-apps.sh remove <instance>             take that back: every lock applies to it again
#   bash scripts/setup/managed-apps.sh show                          what root has said (any user)
#
# The engine's self-modification locks (src/review.ts) name its own source paths: src/, scripts/, test/ and docs/. In
# a managed app's repo those are the app's own files, so for an instance named here, working exactly the repo named
# with it (its instance.yaml), they stand aside: that includes the push gate's and release-tag check's scripts under
# scripts/. What holds in every repo: the config folder's review.yaml, guardrails.yaml and experiments.yaml, CI
# (.github/workflows/**, .github/release-signers), the hooks folder and secret-scan files (.githooks/**, .denylist*,
# .gitleaks*), and the agents' instructions. Which repo is the engine is never the repo's to say: nothing inside a
# repo (a file, its name, its remote, a package field) changes this.
#
# Only at a root shell: no sudoers rule or machine helper command runs it, the dashboard has no button for it, and it
# refuses a coordinator's sudo (SUDO_USER=wl-*). It refuses to add the engine's own repo: the repository.url of the
# package.json two folders up (the engine it ships with) and the repo /etc/worklane/updates.json's repo_url names.
# When either can't be told (no updates.json, or no GitHub repo named), it refuses to add anything. Each time the engine
# reads the file for an instance it names, it reads the same two again: that repo is no app when it is either one, and
# no repo is an app when either can't be told (no updates.json, one that can't be read as JSON or names no GitHub repo,
# or a package.json that can't be read or names no GitHub repository). Writes /etc/worklane/managed-apps.json whole,
# root:root 0644. No file, or an instance it doesn't name: every lock applies. A running coordinator reads it before
# each review level.
source "$(dirname "$0")/lib.sh"
usage() { sed -n '4,6p' "$0" | sed 's/^#   //' >&2; exit 2; }
cmd="${1:-}"
case "$cmd" in
  show)
    [ "$#" -eq 1 ] || usage
    if [ -f "$MANAGED_APPS" ]; then cat "$MANAGED_APPS"; else echo "no $MANAGED_APPS: every instance's repo is held as the engine's (every lock applies)"; fi
    ;;
  add|remove)
    as_root "$@"
    [[ "${SUDO_USER:-}" != wl-* ]] || { echo "managed-apps.sh is an admin's, at a root shell: a coordinator may not say which repo is the engine" >&2; exit 1; }
    if [ "$cmd" = add ]; then
      [ "$#" -eq 3 ] || usage
      install_managed_apps "$MANAGED_APPS" add "$2" "$3" "$UPDATES_JSON" "$(cd "$(dirname "$0")/../.." && pwd)/package.json"
      echo "instance $2 ($3) is a managed app: the locks on the engine's own source paths don't apply to it"
    else
      [ "$#" -eq 2 ] || usage
      install_managed_apps "$MANAGED_APPS" remove "$2"
      echo "instance $2: every self-modification lock applies to it"
    fi
    ;;
  *) usage ;;
esac
