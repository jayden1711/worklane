#!/usr/bin/env bash
# The engine, once per machine, at a pinned ref of the public repo:
# /opt/worklane/<sha>, with /opt/worklane/current and /usr/local/bin/worklane
# pointing at it. Root-owned and world-readable: coordinators run it, and
# agents' hooks call it, so it must not live in anyone's private home.
# With an instance, also creates that instance's home as its coordinator.
#   bash scripts/setup/engine.sh <engine-ref (commit sha or tag)> [<name> <owner/repo>]
source "$(dirname "$0")/lib.sh"
as_root "$@"
ref="${1:?usage: engine.sh <engine-ref> [<name> <owner/repo>]}"
name="${2:-}" repo="${3:-}"

say "engine at $ref"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
# The same public repo these scripts were cloned from.
origin="$(git -C "$(dirname "$0")" remote get-url origin)"
git clone -q "$origin" "$work/src"
git -C "$work/src" checkout -q --detach "$ref"
sha="$(git -C "$work/src" rev-parse HEAD)"
dest="/opt/worklane/$sha"
if [ ! -f "$dest/dist/src/cli.js" ]; then
  # --ignore-scripts: no dependency's install script runs as root; the build itself is plain tsc.
  (cd "$work/src" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run -s build)
  install -d -m 0755 /opt/worklane
  rm -rf "$dest" && mv "$work/src" "$dest"
  chown -R root:root "$dest" && chmod -R a+rX,go-w "$dest"
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
  run_as "$coord" '
    agent="wl-$1-agent"
    if worklane instance list | grep -qx "$1"; then
      # An instance made earlier (or by hand) may name another agent user: point it at this one.
      f="$HOME/.local/state/worklane/instances/$1/instance.yaml"
      if grep -qx "  agent_user: $agent" "$f"; then echo "instance $1 exists; agents run as $agent"; exit 0; fi
      sed -e "s|^  agent_user: .*|  agent_user: $agent|" -e "s|^  agent_home: .*|  agent_home: /home/$agent|" "$f" > "$f.new"
      cat "$f.new" > "$f" && rm -f "$f.new"
      grep -qx "  agent_user: $agent" "$f" || { echo "could not set run_as in $f; edit it by hand" >&2; exit 1; }
      echo "instance $1 exists; run_as now $agent"
      exit 0
    fi
    worklane instance init "$1" --repo "$2" --github "$3" --agent-user "$agent"
  ' "$name" "/srv/worklane/$name/${repo#*/}" "$repo"
  echo "next: credentials.sh $name github-app ..., then checkout.sh $name $repo"
fi
