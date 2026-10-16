#!/bin/bash
# The test-run sandbox, installed root:root 0755 by scripts/setup/test-user.sh as
# /usr/local/libexec/worklane-testrun. sudoers lets coordinator wl-<name> run it as root with first argument
# <name> only, so an instance reaches its own test user and nothing else. Every other argument is checked here,
# before anything is read or written. docs/test-runs.md has the why of each choice.
#
# GPU (docs/test-runs.md "GPU"): a tier that asks (exec --gpu) gets NVIDIA's device nodes only when root's own file,
# $GPU_FILE (root:root 0644, written by scripts/setup/testrun-gpu.sh), lists this instance. This helper reads that
# file itself: whether a run gets a GPU never comes from an argument, the repo or anything the coordinator or the
# dashboard can write. A granted run keeps PrivateDevices=yes and gets /dev/nvidiactl, /dev/nvidia-uvm and the listed
# /dev/nvidia<N> bound in, with DeviceAllow= for exactly those (never nvidia-uvm-tools, nvidia-modeset, nvidia-caps or
# dri). One GPU run per GPU: a flock on $GPU_LOCK_DIR/<N>.lock, held by this helper (and the systemd-run it waits on)
# for the whole command; the wait counts against the run's timeout, and the unit's cap is the smaller of what is left
# and the file's max_minutes. On stderr, before the command: "worklane-testrun: gpu <N>[,<N>...] (devices ...; max
# <s> s; waited <s> s)" or "worklane-testrun: gpu none (<why>)". No nvidia-smi, no driver call: nodes and locks only.
#
# Network (docs/test-runs.md "Network"): a run's commands have none. Every exec unit gets PrivateNetwork=yes (its own
# loopback only) and an empty, read-only /run (no system daemon's socket: resolved, D-Bus, avahi, nscd and the like
# would reach the network for it). A command that asks (exec --network <tier>) gets the network only when root's own
# file, $NET_FILE (root:root 0644, written by scripts/setup/testrun-network.sh), lists that tier for this instance:
# then the host's network, minus the LAN, link-local and multicast addresses (IPAddressDeny=), the machine's DNS
# resolvers allowed. The tier's name comes from the coordinator, so the grant is per instance at most: a coordinator
# can only name a tier root listed for its own instance. On stderr, after any GPU line: "worklane-testrun: network
# granted (<tier>; ...)" or "worklane-testrun: network none (<why>)". The fetch command (below) is the one other way out:
# a fixed npm download of what the lockfile pins, with no script run, that never reaches this host's loopback or LAN.
# The run's Postgres has no network either (docker run --network none): it is reached on its Unix socket only.
#
#   worklane-testrun <name> create <id> <branch> <head> <base> <head sha> <base sha> [<dir>]...
#                                                             a new run: what the bundle on stdin carries goes into the
#                                                             object store, then a workspace reading it, <dir>s left out
#   worklane-testrun <name> store-tips                        the commits the object store keeps (one a line)
#   worklane-testrun <name> file <id> changed-files           the change's paths (stdin) for {changed_files}
#   worklane-testrun <name> cache <cache> <key>               a cache's directory for this key (printed)
#   worklane-testrun <name> shared <dir>                      a directory all runs share, never wiped (printed)
#   worklane-testrun <name> db-start <id> <image> <db> <ready_s> <max_connections>
#                                                             the run's own Postgres, no network: prints "<socket
#                                                             directory> <password>" (the directory under its TMPDIR)
#   worklane-testrun <name> fetch <id> npm <cache> <key> <timeout_s>
#                                                             downloads what the run's lockfile pins into the cache
#                                                             (npm ci --ignore-scripts in a directory of its own): no
#                                                             script, no repo config; public addresses only
#   worklane-testrun <name> exec <id> <timeout_s> [--gpu] [--network <tier>] -- <command>
#                                                             the run's variables on stdin, each NAME=value then a NUL;
#                                                             --gpu asks for the GPU, which root's file may grant (GPU below);
#                                                             --network asks for the network for that tier (Network above)
#   worklane-testrun <name> wipe <id>                         the run's units, containers, volumes and files
#   worklane-testrun <name> check                             the boundaries, as the test user and in the sandbox
#   worklane-testrun <name> version                           this helper's protocol version (an integer)
#
# The object store ($BASE/<name>/store) is a bare repo of the test user's: every run's workspace reads its objects
# through alternates, and each run's bundle carries only what the store lacks. create fetches into it as the test
# user, before anything of the run's runs; a run's own commands (exec) can read it and never write it (ProtectSystem=
# strict leaves only the run's directory, the caches and the shared directories writable; check proves it).
#
# The protocol version is the engine's HELPER_PROTOCOL (src/testrun/helper.ts; a test checks they match). Bump both
# whenever a command's arguments or output change: an engine refuses to start test runs with a helper whose version
# isn't its own (a helper too old to have `version` dies with "unknown command", and counts as outdated), and says
# how to reinstall it (scripts/setup/test-user.sh update-helper). The updater reinstalls it with each engine.
#
# exec runs <command> under bash -o pipefail as wl-test-<name>, as a transient unit in worklane-test.slice (the
# test runs' CPU and memory caps), sandboxed: read-only system, no /home or /root, every worklane path and every
# other wl-* home inaccessible, no other run's workspace, no Docker socket, a private /tmp, no devices, no new
# privileges, and an environment of exactly the variables named here (never the caller's).
#
# A run's TMPDIR (and TMP, TEMP) is its own short directory, $TMP_BASE/<8 hex> (run_tmp), never one under the run's
# directory. WHY: Chrome binds its SingletonSocket at $TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket, and a Unix
# socket's path is at most 107 bytes (sun_path is 108 with the NUL); under $BASE/<name>/runs/<id>/tmp every browser
# suite died with "Socket path too long". create makes it, the test user's, 0700, and refuses one already there; exec
# binds it into the sandbox, alone under an empty $TMP_BASE; wipe removes it with the run's directory.
#
# INVARIANT: every path this helper makes and systemd then binds (the run's directory, its TMPDIR, the caches, the
# shared directories, the store) is the same directory for this helper's caller and for PID 1. So none is under /tmp
# or /var/tmp: the coordinator calls this from its own unit, which has PrivateTmp=yes, and a directory made in /tmp
# there is not in the host's /tmp, where systemd looks for it (the run then died with exit 226, EXIT_NAMESPACE).
set -euo pipefail
# Set here, never inherited: sudo's secure_path differs between hosts, and runuser lives in /usr/sbin on Ubuntu.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
PROTOCOL=9

# Fixed paths: the installed helper takes none from its caller.
BASE=/var/lib/worklane-test
# Where each run's short TMPDIR is made (run_tmp): root's own, made here (tmp_base). Short, and never under /tmp or
# /var/tmp (the INVARIANT above). Not under $BASE, where every entry is an instance's.
TMP_BASE=/var/lib/wlt
# Where exec writes a run's variables for systemd to read (EnvironmentFile=): root's own, 0700, made here. Under /run,
# which the coordinator's unit shares with PID 1 (the INVARIANT above).
ENV_DIR=/run/worklane-testrun-env
SLICE=worklane-test.slice
DOCKER=/opt/worklane-test/docker/docker
LABEL=worklane.test-run
PROTECTED=(/srv/worklane /opt/worklane /var/lib/worklane /etc/worklane /etc/sudoers.d /root /run/docker.sock /var/run/docker.sock)
# GPU (above). Root's opt-in, the per-GPU locks (root:$GPU_GROUP 0750 under /run, which the coordinator's unit shares
# with PID 1; each lock root:$GPU_GROUP 0640: only root and the group's members, the owner alone, can open one, as
# `worklane gpu hold` does; never an agent, test or coordinator user), the locks' group, where the nodes are,
# and the oldest systemd a GPU run is proven on (CI's real-systemd job). Below it a run asking for the GPU runs without.
GPU_FILE=/etc/worklane/testrun-gpu.json
GPU_LOCK_DIR=/run/worklane/gpu
GPU_GROUP=worklane-gpu
DEV=/dev
GPU_MIN_SYSTEMD=255
# Network (above). Root's grants; the resolvers a granted run and a fetch may ask (nameserver lines); what neither
# ever reaches: the LAN (RFC 1918, CGNAT, IPv6 ULA), link-local, multicast and "this network". A fetch also never
# reaches this host's loopback (its services); a granted run keeps it (its own test servers, its database's socket
# needs none). Every unit's address families: no raw sockets, no packet sockets, no Bluetooth, nothing but these.
NET_FILE=/etc/worklane/testrun-network.json
RESOLV_CONF=/etc/resolv.conf
# WHY built from the first octets: the repo's denylist refuses any literal private address in its files (a real LAN's
# would be a project detail); these are only the ranges' names. The value is exactly
# "link-local multicast 0.0.0.0/8 <10>.0.0.0/8 <100>.64.0.0/10 <172>.16.0.0/12 <192>.168.0.0/16 fc00::/7".
NET_DENY="link-local multicast 0.0.0.0/8 $(printf '%s.0.0.0/8 %s.64.0.0/10 %s.16.0.0/12 %s.168.0.0/16' 10 100 172 192) fc00::/7"
FAMILIES='AF_UNIX AF_INET AF_INET6 AF_NETLINK'

die() { echo "worklane-testrun: $*" >&2; exit 2; }
name="${1:-}" cmd="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "usage: worklane-testrun <name> create|store-tips|file|cache|shared|db-start|fetch|exec|wipe|check|version ..."
user="wl-test-$name"
root="$BASE/$name"
store="$root/store"
sock_dir="/run/worklane-test-$name-docker"
# The coordinator of instance <name> only (sudo sets SUDO_USER; root running it by hand has none).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "wl-$name" ]; then die "$SUDO_USER may not use $name's test runs"; fi
# The version first: it reads nothing and needs no tool or test user, so an engine can always ask it.
if [ "$cmd" = version ]; then [ "$#" -eq 2 ] || die "usage: version"; echo "$PROTOCOL"; exit 0; fi
# Every tool this helper runs, found right after the caller check, before any probe: one clear line instead of a run of failed probes.
for tool in runuser systemd-run systemctl git getent install id stat sha256sum cut mkdir chown; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool (PATH=$PATH)"
done
id -u "$user" >/dev/null 2>&1 || { echo "worklane-testrun: no user $user; run scripts/setup/test-user.sh install $name" >&2; exit 1; }
shift 2

valid_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "a run id is lowercase letters, digits and dashes (at most 48), got $1"; }
run_dir() { printf '%s/runs/%s' "$root" "$1"; }
# INVARIANT: $TMP_BASE plus 9 bytes (/var/lib/wlt/<8 hex>, 21), whatever the name and id; the same for the same run
# every time, so wipe finds it from the id alone, never from anything a run could write.
run_tmp() { printf '%s/%s' "$TMP_BASE" "$(printf '%s/%s' "$name" "$1" | sha256sum | cut -c1-8)"; }
# The base of every run's TMPDIR: this helper's user's (root's) own real directory, 0711, so only this helper puts
# anything in it and a test user can only enter its own run's. Made here, so a machine set up earlier needs no step.
tmp_base() {
  local got
  if [ -L "$TMP_BASE" ]; then die "$TMP_BASE is a symlink"; fi
  [ -d "$TMP_BASE" ] || mkdir -m 0711 -- "$TMP_BASE" 2>/dev/null || [ -d "$TMP_BASE" ] || die "can't make $TMP_BASE"
  got="$(stat -c '%U %a' -- "$TMP_BASE")"
  [ "$got" = "$(id -un) 711" ] || die "$TMP_BASE is $got, not $(id -un)'s and 0711"
}
# Why the run's TMPDIR is not the test user's own real directory, 0700 (a symlink, anyone else's, another mode); empty when it is.
tmp_problem() {
  local t="$1" got
  if [ -L "$t" ] || [ ! -d "$t" ]; then echo "$t is not a directory"; return 0; fi
  got="$(stat -c '%U %a' -- "$t")"
  [ "$got" = "$user 700" ] || echo "$t is $got, not $user's and 0700"
}
# The run's TMPDIR is there and the wipe's to remove: a symlink at its path (only the link goes), a directory the
# test user owns, or one still this helper's user's (a create that died before handing it over). Another instance's
# there (the same 8 hex) was never this run's (create refused it), and is left alone.
own_tmp() {
  local o
  [ ! -L "$1" ] || return 0
  [ -d "$1" ] || return 1
  o="$(stat -c %U -- "$1")"
  [ "$o" = "$user" ] || [ "$o" = "$(id -un)" ]
}
as_user() { runuser -u "$user" -- "$@"; }
docker_as_user() { runuser -u "$user" -- env HOME="$root/docker-home" XDG_RUNTIME_DIR="$sock_dir" DOCKER_HOST="unix://$sock_dir/docker.sock" "$DOCKER" "$@"; }

# Every path the test user must not reach: worklane's own, every other wl-* user's home, root's, the Docker socket.
protected_paths() {
  local u h
  printf '%s\n' "${PROTECTED[@]}"
  while IFS=: read -r u _ _ _ _ h _; do
    [[ "$u" == wl-* && "$u" != "$user" && -n "$h" && "$h" != / ]] && printf '%s\n' "$h"
  done < <(getent passwd)
  for h in "$BASE"/*; do [ "$h" != "$root" ] && [ -e "$h" ] && printf '%s\n' "$h"; done
  return 0
}

# A variable a run may be given: a plain name, not one the sandbox sets, nothing that looks like a secret.
valid_env() {
  local k="${1%%=*}" v="${1#*=}"
  [[ "$1" == *=* && "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "--env takes NAME=value, got ${1%%=*}"
  [[ "$v" != *$'\n'* ]] || die "--env $k: one line"
  if [[ "$k" =~ ^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|IFS|ENV|BASH_ENV|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_FUNC_.*|GIT_.*|GH_.*|GITHUB_.*|SSH_.*|CLAUDE_.*|ANTHROPIC_.*|SUDO_.*|WORKLANE_.*|DOCKER_.*|XDG_.*)$ ]]; then die "--env $k: set by the sandbox, never by a run"; fi
  if [ "$k" != DATABASE_URL ] && [[ "$(printf %s "$k" | tr '[:lower:]' '[:upper:]')" =~ TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE ]]; then die "--env $k: looks like a secret; a test run gets none"; fi
}

# INVARIANT: no variable's value is ever in an argv: not this helper's (sudo logs its whole command line to the
# journal), not systemd-run's or docker's (any user reads a process's argv with ps or /proc/<pid>/cmdline), and not in
# the transient unit's Environment= (systemctl show and the unit file under /run/systemd/transient show it to anyone).
# DATABASE_URL carries the run's database password. So exec reads the run's variables on stdin, and systemd reads
# them from a root-only file (EnvironmentFile=), removed when the run's command ends and by wipe.
RUN_ENV=()
ENV_FILE=
read_run_env() {
  local kv=
  while IFS= read -r -d '' kv; do valid_env "$kv"; RUN_ENV+=("$kv"); kv=; done
  [ -z "$kv" ] || die "exec: each variable on stdin ends with a NUL"
  [ "${#RUN_ENV[@]}" -le 256 ] || die "exec: at most 256 variables"
}
# A value as an EnvironmentFile= line takes it, literally: double-quoted, with systemd's escapes for \ " ` and $.
env_quote() {
  local v="$1"
  v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//\`/\\\`}"; v="${v//\$/\\\$}"
  printf '"%s"' "$v"
}

# The clone a run's workspace is made with, as the test user: the same commands as src/testrun/workspace.ts
# cloneScript (a test checks they match). No remote, no credential helper, hooks off, no one's global config.
CLONE='set -euo pipefail
bundle="$1" work="$2" branch="$3" head="$4" base="$5" hsha="$6" bsha="$7" store="$8"
shift 8
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
sg() { git --git-dir="$store" -c core.hooksPath=/dev/null -c gc.autoDetach=false "$@"; }
for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(sg config --get core.bare 2>/dev/null)" = true ] && break; git init -q --bare "$store" >/dev/null 2>&1 || sleep 1; done
if [ -s "$bundle" ]; then
  refs=()
  for r in "$head" "$base"; do if sg bundle list-heads "$bundle" "$r" | grep -q .; then refs+=("$r"); fi; done
  [ "${#refs[@]}" -eq 0 ] || sg fetch -q --no-tags --no-write-fetch-head "$bundle" "${refs[@]}"
fi
for c in "$hsha" "$bsha"; do
  sg cat-file -e "$c^{commit}" || { echo "the object store has no commit $c" >&2; exit 1; }
  sg update-ref "refs/keep/$c" "$c" 2>/dev/null || true
done
sg for-each-ref --sort=-committerdate --format="%(refname)" refs/keep/ | tail -n +51 | while IFS= read -r r; do sg update-ref -d "$r" 2>/dev/null || true; done
sg gc --auto --quiet || true
git init -q -b "$branch" "$work"
cd "$work"
mkdir -p .git/objects/info .git/info
printf "%s\n" "$store/objects" > .git/objects/info/alternates
git config core.hooksPath /dev/null
git config credential.helper ""
git config user.name test-run
git config user.email test-run@example.com
git update-ref "refs/heads/$branch" "$bsha"
git update-ref "refs/remotes/origin/$branch" "$bsha"
git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$branch"
if [ "$#" -gt 0 ]; then
  git config core.sparseCheckout true
  git config core.sparseCheckoutCone false
  { echo "/*"; for d in "$@"; do echo "!/$d/"; done; } > .git/info/sparse-checkout
fi
git checkout -q --detach "$hsha"
rm -f "$bundle"'

# The fetch (fetch_cmd), as the test user, in the run's own fetch directory: the same commands as src/testrun/fetch.ts
# npmFetchScript (a test checks they match). Only package.json and the lockfile are copied in, so no .npmrc of the
# repo's (script-shell, node-options, git, registry, proxy) is read; the lockfile must pin every package to an https://
# tarball with its integrity hash (no git, file:, link or workspace: npm builds those, running their scripts); npm ci
# --ignore-scripts then fills the cache, and its node_modules goes. The install step after it is the project's own,
# offline (npm ci --offline), with no network: that is where the scripts run.
FETCH_NPM='set -euo pipefail
w=../work
for f in package.json package-lock.json npm-shrinkwrap.json; do
  if [ -L "$w/$f" ]; then echo "fetch: $f is a symlink: the fetch takes regular files only" >&2; exit 3; fi
done
[ -f "$w/package.json" ] || { echo "fetch: no package.json at the root of the repo" >&2; exit 3; }
lock=package-lock.json
if [ -f "$w/npm-shrinkwrap.json" ]; then lock=npm-shrinkwrap.json; fi
[ -f "$w/$lock" ] || { echo "fetch: no package-lock.json: the fetch takes only what a lockfile pins" >&2; exit 3; }
cp -- "$w/package.json" package.json
cp -- "$w/$lock" "$lock"
node - "$lock" <<"JS"
const fs = require("fs");
const file = process.argv[process.argv.length - 1];
const no = (m) => { console.error(`fetch: ${file}: ${m}`); process.exit(3); };
let j = null;
try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { no("not JSON"); }
if (!j || ![2, 3].includes(j.lockfileVersion) || !j.packages || typeof j.packages !== "object") no("needs lockfileVersion 2 or 3 (npm 7 and later), with its packages");
for (const [k, p] of Object.entries(j.packages)) {
  if (k === "") continue;
  if (!p || typeof p !== "object") no(`${k}: not a package entry`);
  if (p.link) no(`${k} is a link (a workspace or a file: dependency): the fetch takes registry tarballs only`);
  if (p.inBundle) continue;
  if (typeof p.resolved !== "string" || !p.resolved.startsWith("https://")) no(`${k} resolves to ${JSON.stringify(p.resolved ?? null).slice(0, 200)}: the fetch takes https:// tarballs only (git, file: and http: dependencies are built by running their scripts, or not pinned)`);
  if (typeof p.integrity !== "string" || !/^sha(256|384|512)-/.test(p.integrity)) no(`${k} has no integrity hash`);
}
JS
npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-offline --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000
rm -rf node_modules
echo "fetch: every package $lock pins is in the cache"'

# A directory a workspace leaves out: src/checkout.ts sparseDirProblem's rule (a test keeps them alike).
valid_dir() {
  local p="$1"
  [[ "$p" =~ ^[A-Za-z0-9._@+][A-Za-z0-9._@+/-]{0,199}$ && "/$p/" != *//* && "/$p/" != */./* && "/$p/" != */../* && "$p" != .git && "$p" != .git/* ]] || die "not a directory to leave out: $p"
}

create() {
  local id="${1:-}" branch="${2:-}" head="${3:-}" base="${4:-}" hsha="${5:-}" bsha="${6:-}" d p t
  [ "$#" -ge 6 ] || die "usage: create <id> <branch> <head ref> <base ref> <head sha> <base sha> [<dir left out>]..."
  shift 6
  valid_id "$id"; d="$(run_dir "$id")"
  [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ && "$branch" != *..* ]] || die "not a branch name: $branch"
  [ "$head" = "refs/worklane/test-run/$id/head" ] && [ "$base" = "refs/worklane/test-run/$id/base" ] || die "not run $id's bundle refs"
  for p in "$hsha" "$bsha"; do [[ "$p" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "not a full commit id: $p"; done
  [ "$#" -le 32 ] || die "at most 32 directories left out"
  for p in "$@"; do valid_dir "$p"; done
  [ ! -e "$d" ] || die "run $id exists; wipe it first"
  t="$(run_tmp "$id")"
  tmp_base
  # WHY: whatever is already at the run's TMPDIR (a directory, a symlink) is another run's (another instance's with
  # the same 8 hex) or was left behind, and the run never takes it.
  if [ -e "$t" ] || [ -L "$t" ]; then die "$t exists; refusing a temporary directory this run didn't make"; fi
  install -d -o root -g "$user" -m 0710 "$root/runs"
  install -d -o "$user" -g "$user" -m 0700 "$d" "$d/work" "$d/home"
  # mkdir, never mkdir -p or install -d: it fails on anything already there. Made here and handed over, not made as
  # the test user: nobody but this helper can write $TMP_BASE, so nothing can be planted at the path in between.
  mkdir -m 0700 -- "$t" || die "can't make $t"
  chown -h "$user:$user" -- "$t"
  p="$(tmp_problem "$t")"; [ -z "$p" ] || die "$p"
  [ -d "$store" ] || install -d -o "$user" -g "$user" -m 0700 "$store"
  # The bundle (only the objects the store lacks; empty when it has both commits; never the coordinator's .git)
  # arrives on stdin. The store takes it and the workspace is made as the test user, so nothing in either is ever
  # written as root and the test user owns it all.
  as_user sh -c 'cat > "$1"' _ "$d/tree.bundle"
  (cd "$d" && runuser -u "$user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$d/home" LANG=C.UTF-8 bash -c "$CLONE" _ "$d/tree.bundle" "$d/work" "$branch" "$head" "$base" "$hsha" "$bsha" "$store" "$@") >&2
  echo "$d/work"
}

store_tips() {
  [ "$#" -eq 0 ] || die "usage: store-tips"
  [ -f "$store/HEAD" ] || return 0
  (cd / && runuser -u "$user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git --git-dir="$store" for-each-ref --format="%(objectname)" refs/keep/)
}

put_file() {
  local id="${1:-}" what="${2:-}" d
  [ "$#" -eq 2 ] && [ "$what" = changed-files ] || die "usage: file <id> changed-files"
  valid_id "$id"; d="$(run_dir "$id")"
  [ -d "$d" ] || die "no run $id"
  as_user sh -c 'cat > "$1"' _ "$d/changed-files"
  echo "$d/changed-files"
}

cache() {
  local c="${1:-}" key="${2:-}" dir old
  [ "$#" -eq 2 ] && [[ "$c" =~ ^[a-z][a-z0-9_-]{0,39}$ && "$key" =~ ^[0-9a-f]{16,64}$ ]] || die "usage: cache <name> <hex key>"
  install -d -o "$user" -g "$user" -m 0700 "$root/cache"
  dir="$root/cache/$c-$key"
  [ -d "$dir" ] || install -d -o "$user" -g "$user" -m 0700 "$dir"
  touch "$dir"
  # Keep the two newest keys of each cache: the current lockfile's and the one before it.
  ls -1dt "$root/cache/$c-"* 2>/dev/null | tail -n +3 | while IFS= read -r old; do
    [[ "$old" =~ ^$root/cache/$c-[0-9a-f]{16,64}$ ]] && rm -rf -- "$old"
  done
  echo "$dir"
}

shared() {
  local s="${1:-}"
  [ "$#" -eq 1 ] && [[ "$s" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || die "usage: shared <name>"
  install -d -o "$user" -g "$user" -m 0700 "$root/shared" "$root/shared/$s"
  echo "$root/shared/$s"
}

db_start() {
  local id="${1:-}" image="${2:-}" db="${3:-}" ready="${4:-}" maxconn="${5:-}" c pw i envf pgdir
  [ "$#" -eq 5 ] || die "usage: db-start <id> <image@sha256:...> <db> <ready_s> <max_connections>"
  valid_id "$id"
  [[ "$image" =~ ^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || die "the image must be pinned to its digest, got $image"
  [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "a lowercase database name, got $db"
  [[ "$ready" =~ ^[1-9][0-9]{0,2}$ ]] || die "ready_s: seconds, got $ready"
  # A number in range (test_run.database.max_connections's bounds), never free text: it goes on Postgres's command line.
  [[ "$maxconn" =~ ^[1-9][0-9]{1,3}$ ]] && [ "$maxconn" -ge 20 ] && [ "$maxconn" -le 2000 ] || die "max_connections: 20 to 2000, got $maxconn"
  [ -d "$(run_dir "$id")" ] || die "no run $id"
  [ -S "$sock_dir/docker.sock" ] || { echo "worklane-testrun: $user's Docker isn't running (systemctl status worklane-test-$name-docker)" >&2; exit 1; }
  # The database's socket directory: in the run's own short TMPDIR (a socket's path is at most 107 bytes; the run's
  # directory is too deep), made here as the test user, never one already there. The container's root is the test user
  # (rootless Docker), and Postgres's entrypoint hands it to the postgres user, 3775: the run can enter it and connect.
  pgdir="$(run_tmp "$id")/pg"
  as_user mkdir -m 0700 -- "$pgdir" || die "can't make $pgdir (the run's TMPDIR must be there, and nothing at that path)"
  c="worklane-test-$name-$id"
  pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker_as_user image inspect "$image" >/dev/null 2>&1 || docker_as_user pull -q "$image" >/dev/null
  # The password never in docker's argv (the INVARIANT above): in a file of the test user's own, 0600, in the run's
  # 0700 directory, that the docker client reads and that goes right after. printf is bash's own: no argv either.
  envf="$(run_dir "$id")/.db-env"
  as_user rm -f -- "$envf"
  printf 'POSTGRES_PASSWORD=%s\n' "$pw" | as_user sh -c 'umask 077; set -C; cat > "$1"' _ "$envf"
  # A unique name; no network at all (--network none: no port, no way out for anything run inside it, such as COPY ...
  # TO PROGRAM as its superuser), its socket alone, bound into the run's TMPDIR: any number of runs at once.
  docker_as_user run -d --name "$c" --label "$LABEL=$name-$id" --network none -v "$pgdir:/var/run/postgresql" \
    --tmpfs /var/lib/postgresql/data:rw --env-file "$envf" -e POSTGRES_DB="$db" "$image" \
    -c max_connections="$maxconn" >/dev/null || { as_user rm -f -- "$envf"; exit 1; }
  as_user rm -f -- "$envf"
  # WHY 127.0.0.1, the container's own loopback (--network none keeps one): the image's first start runs a temporary
  # server on the socket alone, then restarts; only the final server listens on TCP, so only it answers here.
  for i in $(seq "$ready"); do
    docker_as_user exec "$c" pg_isready -q -U postgres -d "$db" -h 127.0.0.1 >/dev/null 2>&1 && { echo "$pgdir $pw"; return 0; }
    sleep 1
  done
  echo "worklane-testrun: $c wasn't ready after ${ready}s" >&2
  exit 1
}

# systemd's version (systemd-run's first line, "systemd 255 (...)"); 0 when it can't be read.
systemd_version() {
  local v
  v="$(systemd-run --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')"
  echo "${v:-0}"
}

# systemd expands ${VAR} and $VAR in a unit's command line itself, as it does in ExecStart=, before bash sees it: a
# shell-only ${x} or ${x%y} would become empty. A run's command is bash's alone. systemd 254 and later are told so
# (--expand-environment=no, printed on the first line); an older one always expands, so each $ goes as $$, its escape
# for a literal $ (the first line empty). The command follows on the next line.
systemd_command() {
  local v="$1" c="$2"
  [[ "$v" =~ ^[0-9]+$ ]] || die "not a systemd version: $v"
  if [ "$v" -ge 254 ]; then printf -- '--expand-environment=no\n%s' "$c"; else printf '\n%s' "${c//\$/\$\$}"; fi
}

# A character device node (never a symlink): what the GPU's nodes must be to be bound in.
is_char() { [ ! -L "$1" ] && [ -c "$1" ]; }

# Root's GPU opt-in for this instance, read from $GPU_FILE alone. Sets GPU_IDX (the listed indices) and GPU_MAX_S (the
# file's max_minutes in seconds) and returns 0; or sets GPU_WHY to why not and returns 1. The file is root's, 0644, a regular
# file, in a directory only root writes, and exactly in the form scripts/setup/testrun-gpu.sh writes (and
# src/testrun/gpu.ts reads): anything else is no GPU, never a guess.
GPU_IDX=()
GPU_MAX_S=0
gpu_opt_in() {
  local got lines=() i n entry=() m
  if [ ! -e "$GPU_FILE" ] && [ ! -L "$GPU_FILE" ]; then GPU_WHY="GPU test runs are off on this machine (no $GPU_FILE)"; return 1; fi
  if [ -L "$GPU_FILE" ] || [ ! -f "$GPU_FILE" ]; then GPU_WHY="$GPU_FILE is not a regular file"; return 1; fi
  got="$(stat -c '%U %a' -- "$GPU_FILE")"
  [ "$got" = "$(id -un) 644" ] || { GPU_WHY="$GPU_FILE is $got, not $(id -un)'s and 0644"; return 1; }
  got="$(stat -c '%U %a' -- "$(dirname "$GPU_FILE")")"
  [[ "$got" =~ ^$(id -un)\ [0-7][0145][0145]$ ]] || { GPU_WHY="$(dirname "$GPU_FILE") is $got: only $(id -un) may write it"; return 1; }
  while IFS= read -r m || [ -n "$m" ]; do lines+=("$m"); done < "$GPU_FILE"
  n="${#lines[@]}"
  local bad="$GPU_FILE is not in the form scripts/setup/testrun-gpu.sh writes; rewrite it with that script"
  [ "$n" -ge 5 ] && [ "$n" -le 70 ] && [ "${lines[0]}" = '{' ] && [ "${lines[1]}" = '  "version": 1,' ] && [ "${lines[$((n - 1))]}" = '}' ] || { GPU_WHY="$bad"; return 1; }
  [[ "${lines[2]}" =~ ^\ \ \"max_minutes\":\ ([1-9][0-9]{0,2}),$ ]] && [ "${BASH_REMATCH[1]}" -le 120 ] || { GPU_WHY="$bad (max_minutes: 1 to 120)"; return 1; }
  m="${BASH_REMATCH[1]}"
  if [ "$n" -eq 5 ]; then
    [ "${lines[3]}" = '  "instances": {}' ] || { GPU_WHY="$bad"; return 1; }
  else
    [ "${lines[3]}" = '  "instances": {' ] && [ "${lines[$((n - 2))]}" = '  }' ] || { GPU_WHY="$bad"; return 1; }
    for ((i = 4; i < n - 2; i++)); do
      [[ "${lines[$i]}" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,20})\":\ \{\ \"devices\":\ \[([0-9]{1,2}(,\ [0-9]{1,2}){0,15})\]\ \}(,?)$ ]] || { GPU_WHY="$bad (line $((i + 1)))"; return 1; }
      # A comma after every entry but the last.
      if [ "$i" -lt $((n - 3)) ]; then [ "${BASH_REMATCH[4]}" = , ]; else [ -z "${BASH_REMATCH[4]}" ]; fi || { GPU_WHY="$bad (line $((i + 1)))"; return 1; }
      if [ "${BASH_REMATCH[1]}" = "$name" ]; then
        [ "${#entry[@]}" -eq 0 ] || { GPU_WHY="$bad ($name is listed twice)"; return 1; }
        IFS=', ' read -r -a entry <<<"${BASH_REMATCH[2]}"
      fi
    done
  fi
  GPU_MAX_S=$((m * 60))
  [ "${#entry[@]}" -gt 0 ] || { GPU_WHY="not on for $name in $GPU_FILE"; return 1; }
  # Ascending and each once: the locks are taken in this order, so two runs never wait on each other's.
  GPU_IDX=()
  while IFS= read -r i; do GPU_IDX+=("$i"); done < <(printf '%s\n' "${entry[@]}" | sed 's/^0*\([0-9]\)/\1/' | sort -n -u)
  return 0
}

# Who holds a GPU's lock, for the message of a run that waited its whole timeout: the note the holding helper wrote
# (instance/run since time); with none (a `worklane gpu hold` writes none), the holder's pid and user from /proc/locks.
# WHY not both: a flock's pid in /proc/locks is the process that took it, here flock(1), long gone.
gpu_holder() {
  local f="$1" note ino pid
  note="$(head -c 200 -- "$f" 2>/dev/null | tr -cd '[:alnum:] ._:/+-' || true)"
  if [ -n "$note" ]; then printf '%s' "$note"; return 0; fi
  ino="$(stat -c %i -- "$f" 2>/dev/null || true)"
  pid="$(awk -v ino="$ino" '$2 == "FLOCK" && $4 == "WRITE" && $6 ~ (":" ino "$") { print $5; exit }' /proc/locks 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ -d "/proc/$pid" ]; then
    printf 'pid %s (%s: %s)' "$pid" "$(stat -c %U "/proc/$pid" 2>/dev/null || echo '?')" "$(tr -cd '[:alnum:] ._/-' < "/proc/$pid/comm" 2>/dev/null || echo '?')"
  else
    printf 'a holder this helper cannot name'
  fi
}

# The GPU's lock directory and one lock file in it, root's own (never a symlink, never anyone else's); made here, and
# by scripts/setup/testrun-gpu.sh's tmpfiles.d entry at each boot (/run is a tmpfs).
gpu_lock_file() {
  local f="$GPU_LOCK_DIR/$1.lock" up got me
  me="$(id -un)"
  up="$(dirname "$GPU_LOCK_DIR")"
  if [ -L "$up" ]; then die "$up is a symlink"; fi
  [ -d "$up" ] || mkdir -m 0755 -- "$up" 2>/dev/null || [ -d "$up" ] || die "can't make $up"
  got="$(stat -c '%U %a' -- "$up")"; [ "$got" = "$me 755" ] || die "$up is $got, not $me's and 0755"
  # The locks' directory and each lock: root's, group $GPU_GROUP, nothing for anyone else. Only this helper (as root)
  # and the group's members (the owner, for `worklane gpu hold`) can open a lock; no agent, test or coordinator user.
  # This helper's own: its group and mode are set here every time (a helper before the group made them 0755/0644).
  if [ -L "$GPU_LOCK_DIR" ]; then die "$GPU_LOCK_DIR is a symlink"; fi
  [ -d "$GPU_LOCK_DIR" ] || mkdir -m 0750 -- "$GPU_LOCK_DIR" 2>/dev/null || [ -d "$GPU_LOCK_DIR" ] || die "can't make $GPU_LOCK_DIR"
  [ "$(stat -c %U -- "$GPU_LOCK_DIR")" = "$me" ] || die "$GPU_LOCK_DIR is not $me's"
  chgrp "$GPU_GROUP" "$GPU_LOCK_DIR" && chmod 0750 "$GPU_LOCK_DIR" || die "can't set $GPU_LOCK_DIR to $me:$GPU_GROUP 0750"
  got="$(stat -c '%U %G %a' -- "$GPU_LOCK_DIR")"; [ "$got" = "$me $GPU_GROUP 750" ] || die "$GPU_LOCK_DIR is $got, not $me:$GPU_GROUP 0750"
  if [ -L "$f" ]; then die "$f is a symlink"; fi
  [ -e "$f" ] || ( umask 077; set -C; : > "$f" ) 2>/dev/null || [ -f "$f" ] || die "can't make $f"
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f is not a regular file"
  [ "$(stat -c %U -- "$f")" = "$me" ] || die "$f is not $me's"
  chgrp "$GPU_GROUP" "$f" && chmod 0640 "$f" || die "can't set $f to $me:$GPU_GROUP 0640"
  got="$(stat -c '%U %G %a' -- "$f")"; [ "$got" = "$me $GPU_GROUP 640" ] || die "$f is $got, not $me:$GPU_GROUP 0640"
  printf '%s' "$f"
}

# Decide a GPU run (GPU_ON, with GPU_IDX, GPU_MAX_S and the unit's properties GPU_PROPS) or not (GPU_WHY), from root's
# file, systemd's version and the nodes present. Never takes a lock.
GPU_ON=0
GPU_WHY=
GPU_PROPS=()
GPU_NODES=()
gpu_decide() {
  local sd="$1" i n skipped=()
  gpu_opt_in || return 0
  [[ "$sd" =~ ^[0-9]+$ ]] && [ "$sd" -ge "$GPU_MIN_SYSTEMD" ] || { GPU_WHY="systemd ${sd:-?} is older than $GPU_MIN_SYSTEMD, the first this helper's GPU sandbox is proven on"; return 0; }
  command -v flock >/dev/null 2>&1 || { GPU_WHY="no flock on this machine (util-linux), so no GPU lock"; return 0; }
  # The locks' group: there, and no harness user in it (scripts/setup/testrun-gpu.sh refuses them; this checks again).
  local members
  members="$(getent group "$GPU_GROUP" 2>/dev/null)" || { GPU_WHY="no $GPU_GROUP group (scripts/setup/testrun-gpu.sh makes it)"; return 0; }
  members="${members##*:}"
  case ",$members," in *,wl-*) GPU_WHY="the $GPU_GROUP group has a harness user ($members): only the owner may hold a GPU"; return 0 ;; esac
  for n in nvidiactl nvidia-uvm; do is_char "$DEV/$n" || { GPU_WHY="no $DEV/$n: the NVIDIA driver isn't loaded"; return 0; }; done
  local idx=()
  for i in "${GPU_IDX[@]}"; do if is_char "$DEV/nvidia$i"; then idx+=("$i"); else skipped+=("$DEV/nvidia$i"); fi; done
  [ "${#idx[@]}" -gt 0 ] || { GPU_WHY="none of the listed GPUs' nodes exist (${skipped[*]})"; return 0; }
  GPU_IDX=("${idx[@]}")
  GPU_NODES=("$DEV/nvidiactl" "$DEV/nvidia-uvm")
  for i in "${GPU_IDX[@]}"; do GPU_NODES+=("$DEV/nvidia$i"); done
  GPU_PROPS=()
  for n in "${GPU_NODES[@]}"; do GPU_PROPS+=(-p "BindPaths=$n" -p "DeviceAllow=$n rw"); done
  GPU_ON=1
  GPU_WHY="${skipped[*]:+skipped ${skipped[*]} (no node)}"
}

# Take each granted GPU's lock for run <id>, in ascending order, waiting at most until the run's deadline (epoch seconds). Each
# lock's fd stays open in this helper (and the systemd-run it starts) until it exits. On a wait that reaches the
# deadline: the line saying who holds it, and exit 1, with nothing started.
GPU_FDS=()
GPU_LOCKS=()
gpu_lock() {
  local id="$1" deadline="$2" started="$3" i f fd=19 left
  for i in "${GPU_IDX[@]}"; do
    f="$(gpu_lock_file "$i")" || exit 2
    # A fixed fd per lock (20 and up; at most 16 GPUs), opened read-only: the number alone goes through eval.
    fd=$((fd + 1))
    eval "exec $fd<\"\$f\""
    left=$((deadline - $(date +%s)))
    if [ "$left" -lt 1 ] || ! flock -x -w "$left" "$fd"; then
      if [ "$left" -lt 1 ] && flock -x -n "$fd"; then :; else
        echo "worklane-testrun: gpu $i: still held after $(($(date +%s) - started)) s, the run's timeout (held by $(gpu_holder "$f"))" >&2
        exit 1
      fi
    fi
    GPU_FDS+=("$fd"); GPU_LOCKS+=("$f")
    # The note a waiting run's message names. Root's file: only this helper writes it; it is emptied again at the end.
    printf '%s/%s since %s\n' "$name" "$id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$f" 2>/dev/null || true
  done
}
gpu_unlock() {
  local f
  for f in ${GPU_LOCKS[@]+"${GPU_LOCKS[@]}"}; do : > "$f" 2>/dev/null || true; done
}

# Whether root's $NET_FILE lets tier <tier> of this instance have the network: 0, or 1 with NET_WHY saying why not. The
# file is root's, 0644, a regular file, in a directory only root writes, and exactly in the form
# scripts/setup/testrun-network.sh writes (and src/testrun/network.ts reads): anything else grants nothing.
NET_WHY=
net_granted() {
  local tier="$1" got lines=() n i m found=0
  if [ ! -e "$NET_FILE" ] && [ ! -L "$NET_FILE" ]; then NET_WHY="no tier of any instance has the network on this machine (no $NET_FILE)"; return 1; fi
  if [ -L "$NET_FILE" ] || [ ! -f "$NET_FILE" ]; then NET_WHY="$NET_FILE is not a regular file"; return 1; fi
  got="$(stat -c '%U %a' -- "$NET_FILE")"
  [ "$got" = "$(id -un) 644" ] || { NET_WHY="$NET_FILE is $got, not $(id -un)'s and 0644"; return 1; }
  got="$(stat -c '%U %a' -- "$(dirname "$NET_FILE")")"
  [[ "$got" =~ ^$(id -un)\ [0-7][0145][0145]$ ]] || { NET_WHY="$(dirname "$NET_FILE") is $got: only $(id -un) may write it"; return 1; }
  while IFS= read -r m || [ -n "$m" ]; do lines+=("$m"); done < "$NET_FILE"
  n="${#lines[@]}"
  local bad="$NET_FILE is not in the form scripts/setup/testrun-network.sh writes; rewrite it with that script"
  [ "$n" -ge 4 ] && [ "$n" -le 70 ] && [ "${lines[0]}" = '{' ] && [ "${lines[1]}" = '  "version": 1,' ] && [ "${lines[$((n - 1))]}" = '}' ] || { NET_WHY="$bad"; return 1; }
  if [ "$n" -eq 4 ]; then
    [ "${lines[2]}" = '  "instances": {}' ] || { NET_WHY="$bad"; return 1; }
  else
    [ "${lines[2]}" = '  "instances": {' ] && [ "${lines[$((n - 2))]}" = '  }' ] || { NET_WHY="$bad"; return 1; }
    for ((i = 3; i < n - 2; i++)); do
      [[ "${lines[$i]}" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,20})\":\ \{\ \"tiers\":\ \[(\"[a-z][a-z0-9_-]{0,39}\"(,\ \"[a-z][a-z0-9_-]{0,39}\"){0,31})\]\ \}(,?)$ ]] || { NET_WHY="$bad (line $((i + 1)))"; return 1; }
      if [ "$i" -lt $((n - 3)) ]; then [ "${BASH_REMATCH[4]}" = , ]; else [ -z "${BASH_REMATCH[4]}" ]; fi || { NET_WHY="$bad (line $((i + 1)))"; return 1; }
      if [ "${BASH_REMATCH[1]}" = "$name" ]; then
        [ "$found" -eq 0 ] || { NET_WHY="$bad ($name is listed twice)"; return 1; }
        found=1
        case ", ${BASH_REMATCH[2]}," in *", \"$tier\","*) found=2 ;; esac
      fi
    done
  fi
  [ "$found" -eq 2 ] && return 0
  NET_WHY="tier $tier of $name is not granted the network in $NET_FILE"
  return 1
}

# The machine's DNS resolvers (/etc/resolv.conf's nameserver lines, at most 3), one per line: the addresses a fetch or a
# granted run may reach although they are loopback or on the LAN. Only an address, never anything else from the file.
resolvers() {
  local l a k=0
  [ -r "$RESOLV_CONF" ] || return 0
  while IFS= read -r l || [ -n "$l" ]; do
    [[ "$l" =~ ^nameserver[[:space:]]+([0-9a-fA-F:.]{2,45})[[:space:]]*$ ]] || continue
    a="${BASH_REMATCH[1]}"
    [[ "$a" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || ( "$a" == *:* && "$a" =~ ^[0-9a-fA-F:]+$ ) ]] || continue
    printf '%s\n' "$a"
    k=$((k + 1)); [ "$k" -lt 3 ] || break
  done < "$RESOLV_CONF"
  return 0
}

# The unit properties of a run with no network (NET_PROPS), or of one granted it.
NET_PROPS=()
net_props() {
  local granted="$1" fetch="${2:-0}" allow
  NET_PROPS=(-p "RestrictAddressFamilies=$FAMILIES")
  if [ "$granted" -eq 0 ]; then
    # WHY /run too: a daemon's socket there would reach the network for the run (resolved's lookups, D-Bus, avahi).
    NET_PROPS+=(-p PrivateNetwork=yes -p TemporaryFileSystem=/run:ro)
    return 0
  fi
  allow="$(resolvers | tr '\n' ' ')"
  if [ "$fetch" -eq 1 ]; then NET_PROPS+=(-p "IPAddressDeny=localhost $NET_DENY"); else NET_PROPS+=(-p "IPAddressDeny=$NET_DENY"); fi
  [ -z "${allow// /}" ] || NET_PROPS+=(-p "IPAddressAllow=${allow% }")
}

# What exec leaves behind on any exit: the run's variables file, and the notes in the GPU locks it held.
exec_cleanup() {
  if [ -n "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
  gpu_unlock
}

exec_run() {
  local id="${1:-}" timeout="${2:-}" d t inaccessible p cmd flag kv rc=0 gpu=0 net="" started locking waited runtime unit pid
  local -a envfile=() noexpand=() gpuprops=()
  local usage="usage: exec <id> <timeout_s> [--gpu] [--network <tier>] -- <command> (the run's variables on stdin, each NAME=value then a NUL)"
  [ "$#" -ge 2 ] || die "$usage"
  shift 2
  # Each option at most once, in any order, before --; then exactly the command.
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    case "$1" in
      --gpu) [ "$gpu" -eq 0 ] || die "$usage"; gpu=1; shift ;;
      --network) [ -z "$net" ] && [ "$#" -ge 2 ] || die "$usage"; net="$2"; shift 2
        [[ "$net" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || die "--network takes a tier's name, got $net" ;;
      *) die "$usage" ;;
    esac
  done
  [ "$#" -eq 2 ] && [ "$1" = -- ] || die "$usage"
  set -- "$id" "$timeout" "$2"
  valid_id "$id"
  shift 1
  [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] || die "timeout_s: seconds, got $timeout"
  # A GPU command's clock starts here: its wait for the GPU counts against its timeout.
  if [ "$gpu" -eq 1 ]; then started="$(date +%s)"; fi
  d="$(run_dir "$id")"
  [ -d "$d/work" ] || die "no run $id"
  # WHY: systemd binds the TMPDIR in as root, following a symlink: only the test user's own 0700 directory goes in.
  t="$(run_tmp "$id")"
  p="$(tmp_problem "$t")"; [ -z "$p" ] || die "the run's TMPDIR: $p"
  cmd="$(systemd_command "$(systemd_version)" "$2")"
  flag="${cmd%%$'\n'*}"; cmd="${cmd#*$'\n'}"
  [ -z "$flag" ] || noexpand=("$flag")
  # The GPU locks too: a run (GPU or not) can't flock one and keep a GPU run waiting.
  inaccessible="-$sock_dir -$root/docker -$root/docker-home -$GPU_LOCK_DIR"
  while IFS= read -r p; do inaccessible="$inaccessible -$p"; done < <(protected_paths)
  unit="worklane-test-$name-$id-$$"
  trap exec_cleanup EXIT
  runtime="$timeout"
  # GPU (above): only when asked, and only as root's file says. The lock's wait counts against the run's timeout; the
  # unit gets what is left, at most the file's max_minutes.
  if [ "$gpu" -eq 1 ]; then
    gpu_decide "$(systemd_version)"
    if [ "$GPU_ON" -eq 1 ]; then
      locking="$(date +%s)"
      gpu_lock "$id" $((started + timeout)) "$started"
      waited=$(($(date +%s) - locking))
      runtime=$((timeout - ($(date +%s) - started)))
      [ "$runtime" -ge 1 ] || { echo "worklane-testrun: gpu $(IFS=,; echo "${GPU_IDX[*]}"): still held after $(($(date +%s) - started)) s, the run's timeout (no time left to run)" >&2; exit 1; }
      [ "$runtime" -le "$GPU_MAX_S" ] || runtime="$GPU_MAX_S"
      gpuprops=("${GPU_PROPS[@]}")
      echo "worklane-testrun: gpu $(IFS=,; echo "${GPU_IDX[*]}") (devices ${GPU_NODES[*]}; max $runtime s; waited $waited s${GPU_WHY:+; $GPU_WHY})" >&2
    else
      echo "worklane-testrun: gpu none ($GPU_WHY)" >&2
    fi
  fi
  # Network (above): none, unless asked for a tier that root's file grants it to. Only asking prints a line.
  if [ -n "$net" ] && net_granted "$net"; then
    net_props 1
    echo "worklane-testrun: network granted ($net; public addresses and the machine's DNS only)" >&2
  else
    net_props 0
    [ -z "$net" ] || echo "worklane-testrun: network none ($NET_WHY)" >&2
  fi
  # The run's variables (RUN_ENV), for systemd to read from a file of root's only: never on systemd-run's argv nor in
  # the unit's Environment= (the INVARIANT above). Only the run's own processes get them.
  if [ "${#RUN_ENV[@]}" -gt 0 ]; then
    if [ -L "$ENV_DIR" ]; then die "$ENV_DIR is a symlink"; fi
    [ -d "$ENV_DIR" ] || mkdir -m 0700 -- "$ENV_DIR" 2>/dev/null || [ -d "$ENV_DIR" ] || die "can't make $ENV_DIR"
    p="$(stat -c '%U %a' -- "$ENV_DIR")"; [ "$p" = "$(id -un) 700" ] || die "$ENV_DIR is $p, not $(id -un)'s and 0700"
    # Dots: no name or id has one, so wipe's "<name>.<id>.*" is this run's alone.
    ENV_FILE="$ENV_DIR/$name.$id.$$"
    ( umask 077; set -C; for kv in "${RUN_ENV[@]}"; do printf '%s=%s\n' "${kv%%=*}" "$(env_quote "${kv#*=}")"; done > "$ENV_FILE" ) || die "can't write $ENV_FILE"
    envfile=(-p "EnvironmentFile=$ENV_FILE")
  fi
  # The unit's own name carries the run id, so wipe finds (and stops) whatever is left of it. Not --quiet: at the end
  # systemd-run reports the unit's CPU time and peak memory, which the coordinator records per tier. Those lines (and
  # its "Running as unit" line first) are on stderr, which under --pipe is the run's own stderr too: a reader takes
  # the run's stdout as its own and reads systemd-run's summary only as the final block of stderr.
  local -a run=(systemd-run --wait --pipe --collect ${noexpand[@]+"${noexpand[@]}"} ${envfile[@]+"${envfile[@]}"}
    --unit="$unit" --slice="$SLICE" --uid="$user" --gid="$user"
    -p WorkingDirectory="$d/work" -p RuntimeMaxSec="$runtime" -p KillMode=control-group -p UMask=0077
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes
    ${gpuprops[@]+"${gpuprops[@]}"} "${NET_PROPS[@]}"
    -p TemporaryFileSystem="$root/runs:ro" -p BindPaths="$d" -p ReadWritePaths="$d"
    -p TemporaryFileSystem="$TMP_BASE:ro" -p BindPaths="$t" -p ReadWritePaths="$t"
    -p "ReadWritePaths=-$root/cache -$root/shared" -p "InaccessiblePaths=$inaccessible"
    --setenv=HOME="$d/home" --setenv=TMPDIR="$t" --setenv=TMP="$t" --setenv=TEMP="$t" --setenv=PATH=/usr/local/bin:/usr/bin:/bin
    --setenv=LANG=C.UTF-8 --setenv=CI=1 --setenv=USER="$user" --setenv=LOGNAME="$user"
    /bin/bash -o pipefail -c "$cmd")
  if [ "${#gpuprops[@]}" -eq 0 ]; then
    "${run[@]}" || rc=$?
  else
    # WHY: the GPU's lock must never be let go while the unit runs. bash runs a trap only once a foreground child
    # ends, so systemd-run goes in the background and is waited for: a TERM (sudo passes the coordinator's on) stops
    # the unit first, and the locks go with this helper after it. systemd-run keeps the lock fds open too.
    trap 'systemctl kill --signal=KILL "$unit.service" 2>/dev/null || true; systemctl stop "$unit.service" 2>/dev/null || true; exit 143' TERM INT HUP
    "${run[@]}" &
    pid=$!
    wait "$pid" || rc=$?
    trap - TERM INT HUP
  fi
  exec_cleanup
  ENV_FILE=
  return "$rc"
}

# Fill a cache with what the run's lockfile pins (FETCH_NPM above), in a unit of its own: the exec sandbox, but the
# host's network minus its loopback, the LAN, link-local and multicast (the machine's DNS resolvers allowed); no run's
# TMPDIR (where a database's socket is) and no workspace it can write. Root's grant is never needed: no code of the
# repo's runs here, only npm, on files the helper copied.
fetch_cmd() {
  local id="${1:-}" eco="${2:-}" c="${3:-}" key="${4:-}" timeout="${5:-}" d fd dir cmd flag inaccessible p unit rc=0
  local -a noexpand=()
  [ "$#" -eq 5 ] || die "usage: fetch <id> npm <cache> <key> <timeout_s>"
  valid_id "$id"
  [ "$eco" = npm ] || die "fetch: npm only, got $eco"
  [[ "$c" =~ ^[a-z][a-z0-9_-]{0,39}$ && "$key" =~ ^[0-9a-f]{16,64}$ ]] || die "usage: fetch <id> npm <cache name> <hex key> <timeout_s>"
  [[ "$timeout" =~ ^[1-9][0-9]{0,4}$ ]] || die "timeout_s: seconds, got $timeout"
  d="$(run_dir "$id")"
  [ -d "$d/work" ] || die "no run $id"
  dir="$root/cache/$c-$key"
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %U -- "$dir")" = "$user" ] || die "no cache $c with key $key (the cache command makes it)"
  fd="$d/fetch"
  as_user rm -rf -- "$fd"
  as_user mkdir -m 0700 -- "$fd" "$fd/home" || die "can't make $fd"
  cmd="$(systemd_command "$(systemd_version)" "$FETCH_NPM")"
  flag="${cmd%%$'\n'*}"; cmd="${cmd#*$'\n'}"
  [ -z "$flag" ] || noexpand=("$flag")
  inaccessible="-$sock_dir -$root/docker -$root/docker-home -$GPU_LOCK_DIR"
  while IFS= read -r p; do inaccessible="$inaccessible -$p"; done < <(protected_paths)
  net_props 1 1
  unit="worklane-test-$name-$id-fetch-$$"
  echo "worklane-testrun: fetch npm (no script run; public addresses and the machine's DNS only)" >&2
  systemd-run --wait --pipe --collect ${noexpand[@]+"${noexpand[@]}"} --unit="$unit" --slice="$SLICE" --uid="$user" --gid="$user" \
    -p WorkingDirectory="$fd" -p RuntimeMaxSec="$timeout" -p KillMode=control-group -p UMask=0077 \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
    "${NET_PROPS[@]}" \
    -p TemporaryFileSystem="$root/runs:ro" -p BindPaths="$d" -p ReadWritePaths="$fd" -p ReadWritePaths="$dir" \
    -p TemporaryFileSystem="$TMP_BASE:ro" -p "InaccessiblePaths=$inaccessible" \
    --setenv=HOME="$fd/home" --setenv=TMPDIR=/tmp --setenv=PATH=/usr/local/bin:/usr/bin:/bin --setenv=LANG=C.UTF-8 --setenv=CI=1 \
    --setenv=USER="$user" --setenv=LOGNAME="$user" --setenv=npm_config_cache="$dir" \
    /bin/bash -o pipefail -c "$cmd" < /dev/null || rc=$?
  as_user rm -rf -- "$fd" || true
  return "$rc"
}

# exec as called: the run's variables from stdin first, then the run (its stdin then at its end, as before).
exec_cmd() {
  read_run_env
  exec_run "$@" </dev/null
}

# What is left of a run: its units, containers, volumes and directory, one per line ("" when nothing).
leftovers() {
  local id="$1"
  systemctl list-units --all --plain --no-legend "worklane-test-$name-$id-*" 2>/dev/null | awk '{print "unit " $1}'
  if [ -S "$sock_dir/docker.sock" ]; then
    docker_as_user ps -aq --filter "label=$LABEL=$name-$id" | sed 's/^/container /'
    docker_as_user volume ls -q --filter "label=$LABEL=$name-$id" | sed 's/^/volume /'
  fi
  [ ! -e "$(run_dir "$id")" ] || echo "dir $(run_dir "$id")"
  if own_tmp "$(run_tmp "$id")"; then echo "dir $(run_tmp "$id")"; fi
  for f in "$ENV_DIR/$name.$id."*; do if [ -e "$f" ]; then echo "file $f"; fi; done
  return 0
}

wipe() {
  local id="${1:-}" units ids vols left
  [ "$#" -eq 1 ] || die "usage: wipe <id>"
  valid_id "$id"
  # Processes first, so nothing still running writes into what is removed next.
  units="$(systemctl list-units --all --plain --no-legend "worklane-test-$name-$id-*" 2>/dev/null | awk '{print $1}')"
  # shellcheck disable=SC2086 # one unit per word
  [ -z "$units" ] || { systemctl kill -s KILL $units 2>/dev/null || true; systemctl stop $units 2>/dev/null || true; systemctl reset-failed $units 2>/dev/null || true; }
  if [ -S "$sock_dir/docker.sock" ]; then
    ids="$(docker_as_user ps -aq --filter "label=$LABEL=$name-$id")"
    # shellcheck disable=SC2086
    [ -z "$ids" ] || docker_as_user rm -f -v $ids >/dev/null
    vols="$(docker_as_user volume ls -q --filter "label=$LABEL=$name-$id")"
    # shellcheck disable=SC2086
    [ -z "$vols" ] || docker_as_user volume rm -f $vols >/dev/null
  fi
  rm -rf --one-file-system -- "$(run_dir "$id")"
  # The run's variables, if an exec was killed before it removed them.
  rm -f -- "$ENV_DIR/$name.$id."*
  # rm never follows the path itself if it is a symlink, nor one inside it.
  if own_tmp "$(run_tmp "$id")"; then rm -rf --one-file-system -- "$(run_tmp "$id")"; fi
  left="$(leftovers "$id")"
  if [ -n "$left" ]; then printf 'worklane-testrun: run %s is not wiped:\n%s\n' "$id" "$left" >&2; exit 1; fi
  echo "wiped $id"
}

# A bundle of one commit (one file, made at this moment, so its objects are new to the store) under run <id>'s refs,
# for the sandbox probe: written to <file>, and the commit's id printed.
probe_bundle() {
  local id="$1" file="$2" t
  t="$(runuser -u "$user" -- mktemp -d)"
  runuser -u "$user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$t" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null bash -c 'set -e; cd "$1"; git init -q; date +%s%N > probe.txt; git add probe.txt; git -c user.name=p -c user.email=p@example.com commit -q -m probe; git update-ref "refs/worklane/test-run/$2/head" HEAD; git update-ref "refs/worklane/test-run/$2/base" HEAD; git bundle create --quiet "$3" "refs/worklane/test-run/$2/head" "refs/worklane/test-run/$2/base"; git rev-parse HEAD' _ "$t" "$id" "$file"
  rm -rf "$t"
}

# The sandbox probe passed: it exited 0, and its own stdout has the line "probed" and no "open " line. Only its
# stdout: systemd-run prints its unit line and its summary on stderr (not --quiet), which a run shares under --pipe.
probe_passed() {
  local rc="$1" out="$2"
  [ "$rc" -eq 0 ] && grep -qx probed <<<"$out" && ! grep -q '^open ' <<<"$out"
}

# PASS when the test user can't read, write or enter each protected path, as itself and inside the sandbox. A probe
# that can't run is a FAIL, never a pass.
check() {
  local fail=0 groups p out id err bundle sha rc=0
  [ "$#" -eq 0 ] || die "usage: check"
  groups="$(id -nG "$user")"
  if [ "$groups" = "$user" ]; then echo "PASS $user is in its own group only"; else echo "FAIL $user's groups: $groups"; fail=1; fi
  if sudo -n -l -U "$user" 2>&1 | grep -q 'is not allowed to run sudo'; then echo "PASS $user may not run sudo"; else echo "FAIL $user has sudo rules"; fail=1; fi
  while IFS= read -r p; do
    [ -e "$p" ] || continue
    out="$(cd / && runuser -u "$user" -- sh -c 'if [ -r "$1" ] || [ -w "$1" ] || { [ -d "$1" ] && [ -x "$1" ]; }; then echo open; else echo denied; fi' _ "$p" 2>/dev/null || true)"
    if [ "$out" = denied ]; then echo "PASS $user can't reach $p"; else echo "FAIL $user can reach $p (${out:-the probe did not run})"; fail=1; fi
  done < <(protected_paths)
  # The same, inside the sandbox a run gets: a probe run, wiped after. Its stdout and systemd-run's stderr apart.
  id="probe-$$"
  err="$(mktemp)"
  bundle="$(runuser -u "$user" -- mktemp)"
  sha="$(probe_bundle "$id" "$bundle")"
  create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$sha" "$sha" <"$bundle" >/dev/null
  rm -f "$bundle"
  # The run also reads its commit through the object store, and can't write the store (its objects or its refs).
  # No ${...} in the command: systemd-run expands those itself (as ExecStart= does) before bash sees them.
  out="$(exec_run "$id" 60 -- 'n=0; while IFS= read -r p; do [ -e "$p" ] || continue; if [ -r "$p" ] || [ -w "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; }; then echo "open $p"; n=1; fi; done; s="$(dirname "$(cat .git/objects/info/alternates)")"; [ "$s" = "'"$store"'" ] || { echo "not the store: $s"; n=1; }; git cat-file -e HEAD:probe.txt || { echo "store unread: $s"; n=1; }; for w in "$s/objects/probe-write" "$s/refs/keep/probe-write" "$s/probe-write"; do if ( : > "$w" ) 2>/dev/null; then echo "open $w (written)"; rm -f "$w"; n=1; fi; done; [ "$TMPDIR" = "'"$(run_tmp "$id")"'" ] && [ "$TMP" = "$TMPDIR" ] && [ "$TEMP" = "$TMPDIR" ] && ( : > "$TMPDIR/probe" ) || { echo "TMPDIR unusable: $TMPDIR"; n=1; }; echo probed; exit $n' <<<"$(protected_paths)" 2>"$err")" || rc=$?
  wipe "$id" >/dev/null || { echo "FAIL the probe run was not wiped"; fail=1; }
  # The probe's commit is no tip worth keeping: its ref goes (its objects go with git's gc).
  (cd / && runuser -u "$user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git --git-dir="$store" update-ref -d "refs/keep/$sha") || true
  if probe_passed "$rc" "$out"; then echo "PASS a sandboxed run reaches none of them, and reads the object store without writing it"
  else echo "FAIL in the sandbox (exit $rc): ${out:-the probe printed nothing}"; sed 's/^/  stderr: /' "$err"; fail=1; fi
  rm -f "$err"
  [ "$fail" -eq 0 ] && echo "OK" || echo "FAILED"
  return "$fail"
}

case "$cmd" in
  create) create "$@" ;;
  store-tips) store_tips "$@" ;;
  file) put_file "$@" ;;
  cache) cache "$@" ;;
  shared) shared "$@" ;;
  db-start) db_start "$@" ;;
  fetch) fetch_cmd "$@" ;;
  exec) exec_cmd "$@" ;;
  wipe) wipe "$@" ;;
  check) check "$@" ;;
  *) die "unknown command ${cmd:-(none)}" ;;
esac
