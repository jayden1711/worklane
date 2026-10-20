#!/usr/bin/env bash
# The engine, once per machine, at a pinned ref of the public repo:
# /opt/worklane/<sha>, with /opt/worklane/current and /usr/local/bin/worklane
# pointing at it. Root-owned and world-readable: coordinators run it, and
# agents' hooks call it, so it must not live in anyone's private home.
# With an instance, also creates that instance's home as its coordinator.
#   bash scripts/setup/engine.sh --release <vX.Y.Z> <commit> [<name> <owner/repo>]   a release (bootstrap --hardened)
#   bash scripts/setup/engine.sh <commit id> [<name> <owner/repo>]                   a commit, by its id
# A release (#832): its tag is checked here, at install time, before anything is built as root, by the engine
# updater's own rules (engine-release.cjs): one tag object, its SSH signature verified against the
# .github/release-signers of the checkout this script runs from (never origin's, never the tagged tree's), naming
# itself <vX.Y.Z>, at <commit> (the pin in scripts/bootstrap.sh); then exactly that commit is built, never the name
# again. A tag or branch by name alone is refused: origin's tags can be moved by anyone who can push.
source "$(dirname "$0")/lib.sh"
as_root "$@"
usage="usage: engine.sh --release <vX.Y.Z> <commit> [<name> <owner/repo>], or engine.sh <commit id> [<name> <owner/repo>]"
by_release=0 release="" commit=""
if [ "${1:-}" = --release ]; then
  by_release=1 release="${2-}" commit="${3-}"
  shift 3 2>/dev/null || shift $#
  ref="$release"
else
  ref="${1:?$usage}"
  shift
  # As before #832: a commit by its id. Anything else is a name origin can move (a tag, a branch).
  [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || { echo "engine.sh: refused: $ref: a tag is a name origin can move: install a release as engine.sh --release <vX.Y.Z> <its commit> (the pin in scripts/bootstrap.sh), or a commit by its id" >&2; exit 2; }
fi
name="${1:-}" repo="${2:-}"

say "engine at $ref"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
# The same public repo these scripts were cloned from.
origin="$(git -C "$(dirname "$0")" remote get-url origin)"
if [ "$by_release" = 1 ]; then
  # The signers beside this script: the checkout it runs from, as trusted as the script itself.
  signers="$(cd "$(dirname "$0")/../.." && pwd)/.github/release-signers"
  node "$(dirname "$0")/engine-release.cjs" "$origin" "$release" "$commit" "$signers" "$work" || exit 1
else
  git clone -q "$origin" "$work/src"
  git -C "$work/src" checkout -q --detach "$ref"
fi
sha="$(git -C "$work/src" rev-parse HEAD)"
dest="/opt/worklane/$sha"
# An install is the CLI plus the dashboard's web UI (the dashboard serves dist/web next to dist/src).
if [ ! -f "$dest/dist/src/cli.js" ] || [ ! -f "$dest/dist/web/index.html" ]; then
  # --ignore-scripts: no dependency's install script runs as root; the builds are plain tsc and vite.
  (cd "$work/src" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run -s build && npm run -s build:web >/dev/null)
  [ -f "$work/src/dist/web/index.html" ] || { echo "the web UI build wrote no dist/web/index.html" >&2; exit 1; }
  install -d -m 0755 /opt/worklane
  if [ -f "$dest/dist/src/cli.js" ]; then
    # Installed earlier without the UI, maybe in use by a running service: add only the UI, renamed into place.
    rm -rf "$dest/dist/.web.new" && mv "$work/src/dist/web" "$dest/dist/.web.new"
    chown -R root:root "$dest/dist/.web.new" && chmod -R a+rX,go-w "$dest/dist/.web.new"
    rm -rf "$dest/dist/web" && mv "$dest/dist/.web.new" "$dest/dist/web"
  else
    rm -rf "$dest" && mv "$work/src" "$dest"
    chown -R root:root "$dest" && chmod -R a+rX,go-w "$dest"
  fi
fi
ln -sfn "$dest" /opt/worklane/current
chmod 0755 "$dest/dist/src/cli.js"
ln -sfn /opt/worklane/current/dist/src/cli.js /usr/local/bin/worklane
echo "engine $(git -C "$dest" log -1 --format='%h %s')"

if [ -n "$name" ]; then
  [ -n "$repo" ] || { echo "with an instance, give its repo too (owner/name)" >&2; exit 2; }
  coord="wl-$name"
  id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run instance.sh $name first" >&2; exit 1; }
  say "instance home for $name, as $coord"
  ensure_instance_home "$name" "$repo"
  echo "next: credentials.sh $name github-app ..., then checkout.sh $name $repo"
fi
