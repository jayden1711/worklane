#!/bin/bash
# Before every start of a CI runner, as root (its unit's ExecStartPre=+), installed root:root 0755 by
# scripts/setup/ci-runner.sh as /usr/local/libexec/worklane-ci/reset. The runner takes one job per start
# (run.sh --once), so this gives every job what an ephemeral runner gets:
#   1. no container, image build cache, volume or network the last job left (removed through the runner's own
#      rootless daemon, first, so nothing still running can write into what is made next);
#   2. a new runner directory: the pinned release's scripts and this runner's registration, with bin/ and
#      externals/ as empty mount points for the unit's read-only binds of the pinned release;
#   3. a new, empty workspace and home, with the machine's pinned Node as a tool-cache entry, so
#      actions/setup-node uses it instead of downloading one.
# Pulled images stay, as a cache: a job names what it runs.
#   reset <name> <index>
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
name="${1:-}" i="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ && "$i" =~ ^[1-9][0-9]?$ ]] || { echo "usage: reset <name> <index>" >&2; exit 2; }
user="wl-ci-$name"
root=/var/lib/worklane-ci/$name
base="$root/$i" reg="$root/reg-$i"
pristine="$(readlink -f /opt/worklane-ci/actions-runner)"
docker="$(readlink -f /opt/worklane-ci/docker)/docker"
sock="/run/worklane-ci-$name-docker-$i/docker.sock"
[ -d "$pristine/bin" ] && [ -x "$docker" ] || { echo "reset: no pinned runner or docker under /opt/worklane-ci; run ci-runner.sh install" >&2; exit 1; }
[ -f "$reg/.runner" ] && [ -f "$reg/.credentials" ] && [ -f "$reg/.credentials_rsaparams" ] || { echo "reset: runner $i of $name isn't registered ($reg/.runner); run ci-runner.sh install" >&2; exit 1; }

# 1. Containers, build cache, volumes and networks, through the runner user's own daemon (started before this unit).
for _ in $(seq 60); do [ -S "$sock" ] && break; sleep 1; done
[ -S "$sock" ] || { echo "reset: no docker socket at $sock after 60 s (journalctl -u worklane-ci-$name-docker@$i)" >&2; exit 1; }
as_user() { runuser -u "$user" -- env HOME="$base/docker-home" DOCKER_HOST="unix://$sock" "$docker" "$@"; }
ids="$(as_user ps -aq)"
# shellcheck disable=SC2086 # one id per word
[ -z "$ids" ] || as_user rm -f -v $ids >/dev/null
as_user volume prune -af >/dev/null
as_user network prune -f >/dev/null
as_user builder prune -af >/dev/null

# 2. The runner directory.
rm -rf "$base/runner" "$base/work" "$base/home"
install -d -o "$user" -g "$user" -m 0700 "$base/runner" "$base/work" "$base/home"
for f in "$pristine"/* "$pristine"/.[!.]*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    bin | externals) install -d -o root -g root -m 0755 "$base/runner/$(basename "$f")" ;;
    *) cp -a "$f" "$base/runner/" ;;
  esac
done
for f in .runner .credentials .credentials_rsaparams; do
  install -o "$user" -g "$user" -m 0600 "$reg/$f" "$base/runner/$f"
done
printf 'LANG=C.UTF-8\n' > "$base/runner/.env"
find "$base/runner" -mindepth 1 -maxdepth 1 ! -name bin ! -name externals -exec chown -R "$user:$user" {} +

# 3. The machine's pinned Node (node.sh) as actions/setup-node's tool-cache entry, in the new workspace.
node="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
if [ -n "$node" ] && [ -x "$node" ]; then
  v="$("$node" --version)"; v="${v#v}"
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) arch="" ;; esac
  if [ -n "$arch" ] && [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    tc="$base/work/_tool/node/$v"
    install -d -m 0700 "$tc"
    cp -a --reflink=auto "$(dirname "$(dirname "$node")")" "$tc/$arch"
    : > "$tc/$arch.complete"
    chown -R "$user:$user" "$base/work/_tool"
  fi
fi
echo "reset: runner $i of $name is new: no containers, a fresh runner directory, workspace and home"
