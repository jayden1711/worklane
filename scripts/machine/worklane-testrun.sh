#!/bin/bash
# The test-run sandbox, installed root:root 0755 by scripts/setup/test-user.sh as
# /usr/local/libexec/worklane-testrun. sudoers lets coordinator wl-<name> run it as root with first argument
# <name> only, so an instance reaches its own test user and nothing else. Every other argument is checked here,
# before anything is read or written. docs/test-runs.md has the why of each choice.
#
#   worklane-testrun <name> create <id> <branch> <head> <base> <head sha> <base sha> [<dir>]...
#                                                             a new run: what the bundle on stdin carries goes into the
#                                                             object store, then a workspace reading it, <dir>s left out
#   worklane-testrun <name> store-tips                        the commits the object store keeps (one a line)
#   worklane-testrun <name> file <id> changed-files           the change's paths (stdin) for {changed_files}
#   worklane-testrun <name> cache <cache> <key>               a cache's directory for this key (printed)
#   worklane-testrun <name> shared <dir>                      a directory all runs share, never wiped (printed)
#   worklane-testrun <name> db-start <id> <image> <db> <ready_s> <max_connections>
#                                                             the run's own Postgres: prints "<port> <password>"
#   worklane-testrun <name> exec <id> <timeout_s> -- <command>
#                                                             the run's variables on stdin, each NAME=value then a NUL
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
PROTOCOL=7

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

die() { echo "worklane-testrun: $*" >&2; exit 2; }
name="${1:-}" cmd="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "usage: worklane-testrun <name> create|store-tips|file|cache|shared|db-start|exec|wipe|check|version ..."
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
  local id="${1:-}" image="${2:-}" db="${3:-}" ready="${4:-}" maxconn="${5:-}" c pw port i envf
  [ "$#" -eq 5 ] || die "usage: db-start <id> <image@sha256:...> <db> <ready_s> <max_connections>"
  valid_id "$id"
  [[ "$image" =~ ^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || die "the image must be pinned to its digest, got $image"
  [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "a lowercase database name, got $db"
  [[ "$ready" =~ ^[1-9][0-9]{0,2}$ ]] || die "ready_s: seconds, got $ready"
  # A number in range (test_run.database.max_connections's bounds), never free text: it goes on Postgres's command line.
  [[ "$maxconn" =~ ^[1-9][0-9]{1,3}$ ]] && [ "$maxconn" -ge 20 ] && [ "$maxconn" -le 2000 ] || die "max_connections: 20 to 2000, got $maxconn"
  [ -d "$(run_dir "$id")" ] || die "no run $id"
  [ -S "$sock_dir/docker.sock" ] || { echo "worklane-testrun: $user's Docker isn't running (systemctl status worklane-test-$name-docker)" >&2; exit 1; }
  c="worklane-test-$name-$id"
  pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker_as_user image inspect "$image" >/dev/null 2>&1 || docker_as_user pull -q "$image" >/dev/null
  # The password never in docker's argv (the INVARIANT above): in a file of the test user's own, 0600, in the run's
  # 0700 directory, that the docker client reads and that goes right after. printf is bash's own: no argv either.
  envf="$(run_dir "$id")/.db-env"
  as_user rm -f -- "$envf"
  printf 'POSTGRES_PASSWORD=%s\n' "$pw" | as_user sh -c 'umask 077; set -C; cat > "$1"' _ "$envf"
  # A unique name and a port the daemon picks, on loopback only: any number of runs at once, never a fixed port.
  docker_as_user run -d --name "$c" --label "$LABEL=$name-$id" -p 127.0.0.1::5432 \
    --tmpfs /var/lib/postgresql/data:rw --env-file "$envf" -e POSTGRES_DB="$db" "$image" \
    -c max_connections="$maxconn" >/dev/null || { as_user rm -f -- "$envf"; exit 1; }
  as_user rm -f -- "$envf"
  port="$(docker_as_user port "$c" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]\{1,5\}\)$/\1/p' | head -1)"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "worklane-testrun: no loopback port for $c" >&2; exit 1; }
  for i in $(seq "$ready"); do
    docker_as_user exec "$c" pg_isready -q -U postgres -d "$db" -h 127.0.0.1 >/dev/null 2>&1 && { echo "$port $pw"; return 0; }
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

exec_run() {
  local id="${1:-}" timeout="${2:-}" d t inaccessible p cmd flag kv rc=0
  local -a envfile=() noexpand=()
  [ "$#" -eq 4 ] && [ "$3" = -- ] || die "usage: exec <id> <timeout_s> -- <command> (the run's variables on stdin, each NAME=value then a NUL)"
  valid_id "$id"; shift 2
  [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] || die "timeout_s: seconds, got $timeout"
  d="$(run_dir "$id")"
  [ -d "$d/work" ] || die "no run $id"
  # WHY: systemd binds the TMPDIR in as root, following a symlink: only the test user's own 0700 directory goes in.
  t="$(run_tmp "$id")"
  p="$(tmp_problem "$t")"; [ -z "$p" ] || die "the run's TMPDIR: $p"
  cmd="$(systemd_command "$(systemd_version)" "$2")"
  flag="${cmd%%$'\n'*}"; cmd="${cmd#*$'\n'}"
  [ -z "$flag" ] || noexpand=("$flag")
  inaccessible="-$sock_dir -$root/docker -$root/docker-home"
  while IFS= read -r p; do inaccessible="$inaccessible -$p"; done < <(protected_paths)
  # The run's variables (RUN_ENV), for systemd to read from a file of root's only: never on systemd-run's argv nor in
  # the unit's Environment= (the INVARIANT above). Only the run's own processes get them.
  if [ "${#RUN_ENV[@]}" -gt 0 ]; then
    if [ -L "$ENV_DIR" ]; then die "$ENV_DIR is a symlink"; fi
    [ -d "$ENV_DIR" ] || mkdir -m 0700 -- "$ENV_DIR" 2>/dev/null || [ -d "$ENV_DIR" ] || die "can't make $ENV_DIR"
    p="$(stat -c '%U %a' -- "$ENV_DIR")"; [ "$p" = "$(id -un) 700" ] || die "$ENV_DIR is $p, not $(id -un)'s and 0700"
    # Dots: no name or id has one, so wipe's "<name>.<id>.*" is this run's alone.
    ENV_FILE="$ENV_DIR/$name.$id.$$"
    trap 'rm -f -- "$ENV_FILE"' EXIT
    ( umask 077; set -C; for kv in "${RUN_ENV[@]}"; do printf '%s=%s\n' "${kv%%=*}" "$(env_quote "${kv#*=}")"; done > "$ENV_FILE" ) || die "can't write $ENV_FILE"
    envfile=(-p "EnvironmentFile=$ENV_FILE")
  fi
  # The unit's own name carries the run id, so wipe finds (and stops) whatever is left of it. Not --quiet: at the end
  # systemd-run reports the unit's CPU time and peak memory, which the coordinator records per tier. Those lines (and
  # its "Running as unit" line first) are on stderr, which under --pipe is the run's own stderr too: a reader takes
  # the run's stdout as its own and reads systemd-run's summary only as the final block of stderr.
  systemd-run --wait --pipe --collect ${noexpand[@]+"${noexpand[@]}"} ${envfile[@]+"${envfile[@]}"} \
    --unit="worklane-test-$name-$id-$$" --slice="$SLICE" --uid="$user" --gid="$user" \
    -p WorkingDirectory="$d/work" -p RuntimeMaxSec="$timeout" -p KillMode=control-group -p UMask=0077 \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
    -p TemporaryFileSystem="$root/runs:ro" -p BindPaths="$d" -p ReadWritePaths="$d" \
    -p TemporaryFileSystem="$TMP_BASE:ro" -p BindPaths="$t" -p ReadWritePaths="$t" \
    -p "ReadWritePaths=-$root/cache -$root/shared" -p "InaccessiblePaths=$inaccessible" \
    --setenv=HOME="$d/home" --setenv=TMPDIR="$t" --setenv=TMP="$t" --setenv=TEMP="$t" --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
    --setenv=LANG=C.UTF-8 --setenv=CI=1 --setenv=USER="$user" --setenv=LOGNAME="$user" \
    /bin/bash -o pipefail -c "$cmd" || rc=$?
  if [ -n "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
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
  exec) exec_cmd "$@" ;;
  wipe) wipe "$@" ;;
  check) check "$@" ;;
  *) die "unknown command ${cmd:-(none)}" ;;
esac
