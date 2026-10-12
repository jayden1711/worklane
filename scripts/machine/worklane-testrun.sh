#!/bin/bash
# The test-run sandbox, installed root:root 0755 by scripts/setup/test-user.sh as
# /usr/local/libexec/worklane-testrun. sudoers lets coordinator wl-<name> run it as root with first argument
# <name> only, so an instance reaches its own test user and nothing else. Every other argument is checked here,
# before anything is read or written. docs/test-runs.md has the why of each choice.
#
#   worklane-testrun <name> create <id>                       a new run: its workspace from a tar on stdin
#   worklane-testrun <name> file <id> changed-files           the change's paths (stdin) for {changed_files}
#   worklane-testrun <name> cache <cache> <key>               a cache's directory for this key (printed)
#   worklane-testrun <name> shared <dir>                      a directory all runs share, never wiped (printed)
#   worklane-testrun <name> db-start <id> <image> <db> <ready_s>   the run's own Postgres: prints "<port> <password>"
#   worklane-testrun <name> exec <id> <timeout_s> [--env K=V]... -- <command>
#   worklane-testrun <name> wipe <id>                         the run's units, containers, volumes and files
#   worklane-testrun <name> check                             the boundaries, as the test user and in the sandbox
#
# exec runs <command> under bash -o pipefail as wl-test-<name>, as a transient unit in worklane-test.slice (the
# test runs' CPU and memory caps), sandboxed: read-only system, no /home or /root, every worklane path and every
# other wl-* home inaccessible, no other run's workspace, no Docker socket, a private /tmp, no devices, no new
# privileges, and an environment of exactly the variables named here (never the caller's).
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
umask 077

# Fixed paths: the installed helper takes none from its caller.
BASE=/var/lib/worklane-test
SLICE=worklane-test.slice
DOCKER=/opt/worklane-test/docker/docker
LABEL=worklane.test-run
PROTECTED=(/srv/worklane /opt/worklane /var/lib/worklane /etc/worklane /etc/sudoers.d /root /run/docker.sock /var/run/docker.sock)

die() { echo "worklane-testrun: $*" >&2; exit 2; }
name="${1:-}" cmd="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "usage: worklane-testrun <name> create|file|cache|db-start|exec|wipe|check ..."
user="wl-test-$name"
root="$BASE/$name"
sock_dir="/run/worklane-test-$name-docker"
# The coordinator of instance <name> only (sudo sets SUDO_USER; root running it by hand has none).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "wl-$name" ]; then die "$SUDO_USER may not use $name's test runs"; fi
id -u "$user" >/dev/null 2>&1 || { echo "worklane-testrun: no user $user; run scripts/setup/test-user.sh install $name" >&2; exit 1; }
shift 2

valid_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "a run id is lowercase letters, digits and dashes (at most 48), got $1"; }
run_dir() { printf '%s/runs/%s' "$root" "$1"; }
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

create() {
  local id="${1:-}" d
  [ "$#" -eq 1 ] || die "usage: create <id>"
  valid_id "$id"; d="$(run_dir "$id")"
  [ ! -e "$d" ] || die "run $id exists; wipe it first"
  install -d -o root -g root -m 0711 "$root/runs"
  install -d -o "$user" -g "$user" -m 0700 "$d" "$d/work" "$d/tmp" "$d/home"
  # The tree arrives as a tar on stdin and is unpacked as the test user: nothing in it is ever written as root.
  as_user tar -x -C "$d/work" --no-same-owner --no-same-permissions --delay-directory-restore -f -
  echo "$d/work"
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
  local id="${1:-}" image="${2:-}" db="${3:-}" ready="${4:-}" c pw port i
  [ "$#" -eq 4 ] || die "usage: db-start <id> <image@sha256:...> <db> <ready_s>"
  valid_id "$id"
  [[ "$image" =~ ^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || die "the image must be pinned to its digest, got $image"
  [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "a lowercase database name, got $db"
  [[ "$ready" =~ ^[1-9][0-9]{0,2}$ ]] || die "ready_s: seconds, got $ready"
  [ -d "$(run_dir "$id")" ] || die "no run $id"
  [ -S "$sock_dir/docker.sock" ] || { echo "worklane-testrun: $user's Docker isn't running (systemctl status worklane-test-$name-docker)" >&2; exit 1; }
  c="worklane-test-$name-$id"
  pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker_as_user image inspect "$image" >/dev/null 2>&1 || docker_as_user pull -q "$image" >/dev/null
  # A unique name and a port the daemon picks, on loopback only: any number of runs at once, never a fixed port.
  docker_as_user run -d --name "$c" --label "$LABEL=$name-$id" -p 127.0.0.1::5432 \
    --tmpfs /var/lib/postgresql/data:rw -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB="$db" "$image" >/dev/null
  port="$(docker_as_user port "$c" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]\{1,5\}\)$/\1/p' | head -1)"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "worklane-testrun: no loopback port for $c" >&2; exit 1; }
  for i in $(seq "$ready"); do
    docker_as_user exec "$c" pg_isready -q -U postgres -d "$db" -h 127.0.0.1 >/dev/null 2>&1 && { echo "$port $pw"; return 0; }
    sleep 1
  done
  echo "worklane-testrun: $c wasn't ready after ${ready}s" >&2
  exit 1
}

exec_run() {
  local id="${1:-}" timeout="${2:-}" d inaccessible p
  local -a envs=()
  [ "$#" -ge 2 ] || die "usage: exec <id> <timeout_s> [--env K=V]... -- <command>"
  valid_id "$id"; shift 2
  [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] || die "timeout_s: seconds, got $timeout"
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    [ "$1" = --env ] && [ "$#" -ge 2 ] || die "exec: --env NAME=value, then -- <command>"
    valid_env "$2"; envs+=("--setenv=$2"); shift 2
  done
  [ "${1:-}" = -- ] && [ "$#" -eq 2 ] || die "exec: -- then exactly one command string"
  d="$(run_dir "$id")"
  [ -d "$d/work" ] || die "no run $id"
  inaccessible="-$sock_dir -$root/docker -$root/docker-home"
  while IFS= read -r p; do inaccessible="$inaccessible -$p"; done < <(protected_paths)
  # The unit's own name carries the run id, so wipe finds (and stops) whatever is left of it. Not --quiet: at the end
  # systemd-run reports the unit's CPU time and peak memory, which the coordinator records per tier.
  exec systemd-run --wait --pipe --collect \
    --unit="worklane-test-$name-$id-$$" --slice="$SLICE" --uid="$user" --gid="$user" \
    -p WorkingDirectory="$d/work" -p RuntimeMaxSec="$timeout" -p KillMode=control-group -p UMask=0077 \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
    -p TemporaryFileSystem="$root/runs:ro" -p BindPaths="$d" -p ReadWritePaths="$d" \
    -p "ReadWritePaths=-$root/cache -$root/shared" -p "InaccessiblePaths=$inaccessible" \
    --setenv=HOME="$d/home" --setenv=TMPDIR="$d/tmp" --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
    --setenv=LANG=C.UTF-8 --setenv=CI=1 --setenv=USER="$user" --setenv=LOGNAME="$user" \
    ${envs[@]+"${envs[@]}"} \
    /bin/bash -o pipefail -c "$2"
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
  left="$(leftovers "$id")"
  if [ -n "$left" ]; then printf 'worklane-testrun: run %s is not wiped:\n%s\n' "$id" "$left" >&2; exit 1; fi
  echo "wiped $id"
}

# PASS when the test user can't read, write or enter each protected path, as itself and inside the sandbox. A probe
# that can't run is a FAIL, never a pass.
check() {
  local fail=0 groups p out id
  [ "$#" -eq 0 ] || die "usage: check"
  groups="$(id -nG "$user")"
  if [ "$groups" = "$user" ]; then echo "PASS $user is in its own group only"; else echo "FAIL $user's groups: $groups"; fail=1; fi
  if sudo -n -l -U "$user" 2>&1 | grep -q 'is not allowed to run sudo'; then echo "PASS $user may not run sudo"; else echo "FAIL $user has sudo rules"; fail=1; fi
  while IFS= read -r p; do
    [ -e "$p" ] || continue
    out="$(cd / && runuser -u "$user" -- sh -c 'if [ -r "$1" ] || [ -w "$1" ] || { [ -d "$1" ] && [ -x "$1" ]; }; then echo open; else echo denied; fi' _ "$p" 2>/dev/null || true)"
    if [ "$out" = denied ]; then echo "PASS $user can't reach $p"; else echo "FAIL $user can reach $p (${out:-the probe did not run})"; fail=1; fi
  done < <(protected_paths)
  # The same, inside the sandbox a run gets: a probe run, wiped after.
  id="probe-$$"
  tar -cf - -T /dev/null | create "$id" >/dev/null
  out="$( (exec_run "$id" 60 -- 'n=0; while IFS= read -r p; do [ -e "$p" ] || continue; if [ -r "$p" ] || [ -w "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; }; then echo "open $p"; n=1; fi; done; echo probed; exit $n' <<<"$(protected_paths)") 2>&1 || true)"
  wipe "$id" >/dev/null || { echo "FAIL the probe run was not wiped"; fail=1; }
  if [ "$(tail -n1 <<<"$out")" = probed ] && ! grep -q '^open ' <<<"$out"; then echo "PASS a sandboxed run reaches none of them"
  else echo "FAIL in the sandbox: ${out:-the probe did not run}"; fail=1; fi
  [ "$fail" -eq 0 ] && echo "OK" || echo "FAILED"
  return "$fail"
}

case "$cmd" in
  create) create "$@" ;;
  file) put_file "$@" ;;
  cache) cache "$@" ;;
  shared) shared "$@" ;;
  db-start) db_start "$@" ;;
  exec) exec_run "$@" ;;
  wipe) wipe "$@" ;;
  check) check "$@" ;;
  *) die "unknown command ${cmd:-(none)}" ;;
esac
