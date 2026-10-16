#!/bin/bash
# The experiment jobs' sandbox (docs/experiments.md), installed root:root 0755 by scripts/setup/experiments.sh as
# /usr/local/libexec/worklane-exp. sudoers lets coordinator wl-<name> run it as root with first argument <name> only,
# so an instance reaches its own job and scorer users and nothing else. Every other argument is checked here.
#
#   worklane-exp <name> version                  this helper's protocol version (an integer)
#   worklane-exp <name> eval-put <tree> <path>   one file of an eval copy, on stdin, into a tree not yet sealed
#   worklane-exp <name> eval-seal <tree>         seal it: the tree's hash must be <tree>; never written again
#   worklane-exp <name> create <job> <sha>       a job's workspace: the git bundle on stdin (one commit, <sha>)
#   worklane-exp <name> job <job>                run it: the spec on stdin (NAME=value, each then a NUL)
#   worklane-exp <name> stop <job>               stop its units now (recorded as stopped; never retried by itself)
#   worklane-exp <name> wipe <job>               its workspace and spec (the outputs and the record stay)
#   worklane-exp <name> prune <job>              its outputs (the record stays)
#   worklane-exp <name> check                    the boundaries, as each user and inside the sandbox
#
# Who may do what. The job user (wl-exp-<name>) runs the build, preflight, train and predict steps; the scorer user
# (wl-score-<name>) runs the score step. Root's own file, $ROOT_DIR/<name>.json (root:root 0644, written only by
# scripts/setup/experiments.sh), says which GPUs, how long a job may run, how many GPU-hours a day, how much output,
# whether the environment build may use the network, and which data sources are approved, with their sha256 and
# who may read them. Nothing of that ever comes from an argument, the spec, the repo or the coordinator.
#
# Each step is a transient unit in worklane-exp.slice with the test-run sandbox's properties (read-only system, no
# /home or /root, private /tmp, no devices but the granted GPU's, no new privileges) and, more strictly:
#   - TemporaryFileSystem=$BASE:ro, then binds of exactly what the step needs. Other instances, other jobs, the labels,
#     the eval copy and the data a step isn't given don't exist inside it.
#   - PrivateNetwork=yes for every step (the environment build too, unless root's file says env_network: true).
#   - The score step runs the sealed eval copy as the scorer user with the predictions and the labels, and never the
#     job's workspace, environment or code: a job can't reach the process or the user that scores it.
# GPU: the same per-GPU locks as the test runs (/run/worklane/gpu/<N>.lock; the lock functions below are the test-run
# helper's, kept alike by a test), held from before train until predict ends. The wait doesn't count against the
# job's time (WAIT_MAX bounds it). The device group (GPU_DEV_GROUP, made by scripts/setup/gpu-devices.sh) is added
# to the granted unit only (SupplementaryGroups=), never as a membership. A GPU job that timed out or was killed is
# never run again by itself (the engine records gpu=planned first).
#
# The record: the last line of `job`'s stdout is "worklane-exp: record <json>" (also written to the job's record.json,
# root's). Bump PROTOCOL with src/experiments/helper.ts EXP_PROTOCOL whenever a command's arguments or output change.
set -euo pipefail
# Set here, never inherited.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
PROTOCOL=1

# Fixed paths: the installed helper takes none from its caller.
BASE=/var/lib/worklane-exp
ROOT_DIR=/etc/worklane/experiments
ENV_DIR=/run/worklane-exp-env
SLICE=worklane-exp.slice
GPU_LOCK_DIR=/run/worklane/gpu
GPU_GROUP=worklane-gpu
GPU_DEV_GROUP=worklane-gpu-dev
DEV=/dev
GPU_MIN_SYSTEMD=255
PROTECTED=(/srv/worklane /opt/worklane /var/lib/worklane /var/lib/worklane-test /etc/worklane /etc/sudoers.d /root /run/docker.sock /var/run/docker.sock)

die() { echo "worklane-exp: $*" >&2; exit 2; }
name="${1:-}" cmd="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "usage: worklane-exp <name> version|eval-put|eval-seal|create|job|stop|wipe|prune|check ..."
juser="wl-exp-$name"
suser="wl-score-$name"
coord="wl-$name"
root="$BASE/$name"
rfile="$ROOT_DIR/$name.json"
# The coordinator of instance <name> only (sudo sets SUDO_USER; root running it by hand has none).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "$coord" ]; then die "$SUDO_USER may not use $name's experiments"; fi
if [ "$cmd" = version ]; then [ "$#" -eq 2 ] || die "usage: version"; echo "$PROTOCOL"; exit 0; fi
for tool in runuser systemd-run systemctl git getent install id stat sha256sum find chown chmod du; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool (PATH=$PATH)"
done
for u in "$juser" "$suser"; do id -u "$u" >/dev/null 2>&1 || { echo "worklane-exp: no user $u; run scripts/setup/experiments.sh install $name" >&2; exit 1; }; done
shift 2

valid_job() { [[ "$1" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die "a job id is lowercase letters, digits and dashes (at most 48), got $1"; }
valid_hex() { [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "not a sha256: $1"; }
job_dir() { printf '%s/jobs/%s' "$root" "$1"; }

# ---- root's file -------------------------------------------------------------------------------------------------
# Exactly the form scripts/setup/experiments.sh writes (src/experiments/root-file.ts reads the same): anything else
# is no experiments, never a guess. Sets R_DEVICES (indices), R_MAX_MIN, R_GPU_H, R_OUT_GB, R_ENV_NET (0/1), and
# R_SRC_SHA[id], R_SRC_VIS[id]; or says why not and exits 1.
R_DEVICES=() R_MAX_MIN=0 R_GPU_H=0 R_OUT_GB=0 R_ENV_NET=0
declare -A R_SRC_SHA=() R_SRC_VIS=()
read_root() {
  local got lines=() l n i bad
  bad="$rfile is not in the form scripts/setup/experiments.sh writes; rewrite it with that script"
  if [ -L "$rfile" ] || [ ! -f "$rfile" ]; then echo "worklane-exp: experiments are off for $name (no $rfile)" >&2; exit 1; fi
  got="$(stat -c '%U %a' -- "$rfile")"; [ "$got" = "$(id -un) 644" ] || { echo "worklane-exp: $rfile is $got, not $(id -un)'s and 0644" >&2; exit 1; }
  got="$(stat -c '%U %a' -- "$ROOT_DIR")"; [[ "$got" =~ ^$(id -un)\ [0-7][0145][0145]$ ]] || { echo "worklane-exp: $ROOT_DIR is $got: only $(id -un) may write it" >&2; exit 1; }
  while IFS= read -r l || [ -n "$l" ]; do lines+=("$l"); done < "$rfile"
  n="${#lines[@]}"
  [ "$n" -ge 9 ] && [ "$n" -le 80 ] || { echo "worklane-exp: $bad" >&2; exit 1; }
  [ "${lines[0]}" = '{' ] && [ "${lines[1]}" = '  "version": 1,' ] && [ "${lines[$((n - 1))]}" = '}' ] || { echo "worklane-exp: $bad" >&2; exit 1; }
  [[ "${lines[2]}" =~ ^\ \ \"devices\":\ \[([0-9]{1,2}(,\ [0-9]{1,2}){0,15})?\],$ ]] || { echo "worklane-exp: $bad (devices)" >&2; exit 1; }
  IFS=', ' read -r -a R_DEVICES <<<"${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^\ \ \"max_minutes\":\ ([1-9][0-9]{0,3}),$ ]] && [ "${BASH_REMATCH[1]}" -le 1440 ] || { echo "worklane-exp: $bad (max_minutes: 1 to 1440)" >&2; exit 1; }
  R_MAX_MIN="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^\ \ \"gpu_hours_per_day\":\ ([1-9][0-9]{0,2}),$ ]] || { echo "worklane-exp: $bad (gpu_hours_per_day)" >&2; exit 1; }
  R_GPU_H="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^\ \ \"output_gb\":\ ([1-9][0-9]{0,4}),$ ]] || { echo "worklane-exp: $bad (output_gb)" >&2; exit 1; }
  R_OUT_GB="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^\ \ \"env_network\":\ (true|false),$ ]] || { echo "worklane-exp: $bad (env_network)" >&2; exit 1; }
  [ "${BASH_REMATCH[1]}" = true ] && R_ENV_NET=1 || R_ENV_NET=0
  if [ "$n" -eq 9 ] && [ "${lines[7]}" = '  "sources": {}' ]; then return 0; fi
  [ "$n" -ge 11 ] || { echo "worklane-exp: $bad (sources)" >&2; exit 1; }
  [ "${lines[7]}" = '  "sources": {' ] && [ "${lines[$((n - 2))]}" = '  }' ] || { echo "worklane-exp: $bad (sources)" >&2; exit 1; }
  for ((i = 8; i < n - 2; i++)); do
    [[ "${lines[$i]}" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,39})\":\ \{\ \"sha256\":\ \"([0-9a-f]{64})\",\ \"visibility\":\ \"(job|scorer)\"\ \}(,?)$ ]] || { echo "worklane-exp: $bad (line $((i + 1)))" >&2; exit 1; }
    if [ "$i" -lt $((n - 3)) ]; then [ "${BASH_REMATCH[4]}" = , ]; else [ -z "${BASH_REMATCH[4]}" ]; fi || { echo "worklane-exp: $bad (line $((i + 1)))" >&2; exit 1; }
    [ -z "${R_SRC_SHA[${BASH_REMATCH[1]}]:-}" ] || { echo "worklane-exp: $bad (${BASH_REMATCH[1]} twice)" >&2; exit 1; }
    R_SRC_SHA[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
    R_SRC_VIS[${BASH_REMATCH[1]}]="${BASH_REMATCH[3]}"
  done
}

# An approved source's directory, checked: listed for <want> (job or scorer), its manifest root's and 0644 with the
# sha256 root's file names, its directory root's, group the user who reads it, 0750, and nothing in it a symlink.
source_dir() {
  local id="$1" want="$2" d m grp got
  [[ "$id" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die "not a data source id: $id"
  [ -n "${R_SRC_SHA[$id]:-}" ] || die "the data source $id is not approved in $rfile"
  [ "${R_SRC_VIS[$id]}" = "$want" ] || die "the data source $id is ${R_SRC_VIS[$id]}-only, not for the $want"
  d="$root/data/$id"; m="$root/data/$id.manifest"
  if [ -L "$m" ] || [ ! -f "$m" ]; then die "no manifest for $id ($m); add it with scripts/setup/experiments.sh data add"; fi
  got="$(stat -c '%U %a' -- "$m")"; [ "$got" = "$(id -un) 644" ] || die "$m is $got, not $(id -un)'s and 0644"
  [ "$(sha256sum < "$m" | cut -d' ' -f1)" = "${R_SRC_SHA[$id]}" ] || die "$id's manifest doesn't match the sha256 in $rfile"
  [ "$want" = job ] && grp="$juser" || grp="$suser"
  if [ -L "$d" ] || [ ! -d "$d" ]; then die "$d is not a directory"; fi
  got="$(stat -c '%U %G %a' -- "$d")"; [ "$got" = "$(id -un) $grp 750" ] || die "$d is $got, not $(id -un):$grp 0750"
  [ -z "$(find "$d" -type l -print -quit)" ] || die "$d holds a symlink"
  printf '%s' "$d"
}

# ---- the GPU (the test-run helper's lock functions, unchanged: test/experiments-helper.test.ts keeps them alike) ----
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
        echo "worklane-exp: gpu $i: still held after $(($(date +%s) - started)) s, the run's timeout (held by $(gpu_holder "$f"))" >&2
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
# ---- end of the test-run helper's lock functions ----------------------------------------------------------------

is_char() { [ ! -L "$1" ] && [ -c "$1" ]; }
systemd_version() {
  local v
  v="$(systemd-run --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')"
  echo "${v:-0}"
}

# The GPU for a job that asks for <want> of them: root's listed devices with nodes present, systemd new enough, flock
# there, the locks' group free of harness users. Sets GPU_IDX, GPU_PROPS (the unit's binds, allows and the device
# group); or dies saying why (a job asked for a GPU: running it without one would only waste its time).
GPU_IDX=()
GPU_PROPS=()
gpu_decide() {
  local want="$1" sd i n members idx=() nodes=()
  [ "${#R_DEVICES[@]}" -ge "$want" ] || { echo "worklane-exp: $want GPU(s) asked; $rfile lists ${#R_DEVICES[@]}" >&2; exit 1; }
  sd="$(systemd_version)"
  [[ "$sd" =~ ^[0-9]+$ ]] && [ "$sd" -ge "$GPU_MIN_SYSTEMD" ] || { echo "worklane-exp: systemd ${sd:-?} is older than $GPU_MIN_SYSTEMD, the first the GPU sandbox is proven on" >&2; exit 1; }
  command -v flock >/dev/null 2>&1 || { echo "worklane-exp: no flock on this machine (util-linux)" >&2; exit 1; }
  members="$(getent group "$GPU_GROUP" 2>/dev/null)" || { echo "worklane-exp: no $GPU_GROUP group (scripts/setup/testrun-gpu.sh makes it)" >&2; exit 1; }
  members="${members##*:}"
  case ",$members," in *,wl-*) echo "worklane-exp: the $GPU_GROUP group has a harness user ($members)" >&2; exit 1 ;; esac
  for n in nvidiactl nvidia-uvm; do is_char "$DEV/$n" || { echo "worklane-exp: no $DEV/$n: the NVIDIA driver isn't loaded" >&2; exit 1; }; done
  for i in $(printf '%s\n' "${R_DEVICES[@]}" | sort -n -u); do
    is_char "$DEV/nvidia$i" && idx+=("$i")
    [ "${#idx[@]}" -lt "$want" ] || break
  done
  [ "${#idx[@]}" -eq "$want" ] || { echo "worklane-exp: only ${#idx[@]} of the listed GPUs' nodes exist; $want asked" >&2; exit 1; }
  GPU_IDX=("${idx[@]}")
  nodes=("$DEV/nvidiactl" "$DEV/nvidia-uvm")
  for i in "${GPU_IDX[@]}"; do nodes+=("$DEV/nvidia$i"); done
  GPU_PROPS=()
  for n in "${nodes[@]}"; do GPU_PROPS+=(-p "BindPaths=$n" -p "DeviceAllow=$n rw"); done
  # WHY on the unit, never a membership: only a granted step's processes get the device nodes' group.
  if getent group "$GPU_DEV_GROUP" >/dev/null 2>&1; then GPU_PROPS+=(-p "SupplementaryGroups=$GPU_DEV_GROUP"); fi
}

# ---- the units ---------------------------------------------------------------------------------------------------
protected_paths() {
  local u h
  printf '%s\n' "${PROTECTED[@]}"
  while IFS=: read -r u _ _ _ _ h _; do
    [[ "$u" == wl-* && -n "$h" && "$h" != / && "$h" != /nonexistent ]] && printf '%s\n' "$h"
  done < <(getent passwd)
  return 0
}

ENV_FILE=
cleanup() {
  if [ -n "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
  gpu_unlock
}

# One step as a unit: unit <job> <step> <user> <seconds> <log> <network 0|1> -- <extra -p ...>... -- <command>
# Its stdout and stderr go to <log> (root's); it prints "<exit> <result>" (systemd's Result=, e.g. success, timeout).
step_unit() {
  local job="$1" step="$2" u="$3" secs="$4" log="$5" net="$6" inaccessible p rc=0 unit res
  shift 6
  [ "$1" = -- ] || die "step_unit: --"
  shift
  local -a extra=()
  while [ "$1" != -- ]; do extra+=("$1"); shift; done
  shift
  local cmd="$1"
  inaccessible="-$GPU_LOCK_DIR"
  while IFS= read -r p; do inaccessible="$inaccessible -$p"; done < <(protected_paths)
  unit="worklane-exp-$name-$job-$step-$$"
  local -a netp=()
  [ "$net" = 1 ] || netp=(-p PrivateNetwork=yes)
  local -a run=(systemd-run --wait --pipe --collect --expand-environment=no -p "EnvironmentFile=$ENV_FILE"
    --unit="$unit" --slice="$SLICE" --uid="$u" --gid="$u"
    -p RuntimeMaxSec="$secs" -p KillMode=control-group -p UMask=0077
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes
    ${netp[@]+"${netp[@]}"}
    -p "TemporaryFileSystem=$BASE:ro"
    ${extra[@]+"${extra[@]}"}
    -p "InaccessiblePaths=$inaccessible"
    --setenv=HOME=/tmp --setenv=PATH=/usr/local/bin:/usr/bin:/bin --setenv=LANG=C.UTF-8 --setenv=USER="$u" --setenv=LOGNAME="$u"
    /bin/bash -o pipefail -c "$cmd")
  "${run[@]}" </dev/null >"$log" 2>&1 || rc=$?
  res="$(sed -n 's/^.*Finished with result: \([a-z-]*\).*$/\1/p' "$log" | tail -1)"
  echo "$rc ${res:-$([ "$rc" -eq 0 ] && echo success || echo exit-code)}"
}

# ---- commands ----------------------------------------------------------------------------------------------------
eval_put() {
  local tree="${1:-}" path="${2:-}" t f
  [ "$#" -eq 2 ] || die "usage: eval-put <tree sha256> <path>"
  valid_hex "$tree"
  [[ "$path" =~ ^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,199}$ && "/$path/" != *//* && "/$path/" != */./* && "/$path/" != */../* ]] || die "not an eval file path: $path"
  t="$root/evals/$tree"
  [ ! -e "$t/.sealed" ] || die "eval $tree is sealed; it is never written again"
  install -d -o root -g root -m 0700 "$root/evals" "$t" "$t/files"
  f="$t/files/$path"
  install -d -o root -g root -m 0700 "$(dirname "$f")"
  if [ -L "$f" ]; then die "$f is a symlink"; fi
  head -c 10485760 > "$f"
  chmod 0600 "$f"
}

# The tree's hash: sha256 of "<sha256>  <path>" lines, sorted by path (src/experiments/helper.ts evalTreeHash).
tree_hash() { (cd "$1/files" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r p; do printf '%s  %s\n' "$(sha256sum < "$p" | cut -d' ' -f1)" "$p"; done) | sha256sum | cut -d' ' -f1; }

eval_seal() {
  local tree="${1:-}" t
  [ "$#" -eq 1 ] || die "usage: eval-seal <tree sha256>"
  valid_hex "$tree"
  t="$root/evals/$tree"
  [ -d "$t/files" ] || die "no eval $tree"
  [ ! -e "$t/.sealed" ] || { echo "sealed $tree"; return 0; }
  [ -z "$(find "$t/files" ! -type f ! -type d -print -quit)" ] || die "eval $tree holds something not a file"
  [ "$(tree_hash "$t")" = "$tree" ] || { rm -rf --one-file-system -- "$t"; die "eval $tree's files don't hash to $tree; removed"; }
  # Read by the scorer (score) and the job user (predict): root's, never writable by either.
  chown -R root:root "$t"; chmod -R u=rwX,go=rX "$t"
  : > "$t/.sealed"; chmod 0644 "$t/.sealed"
  echo "sealed $tree"
}

create() {
  local job="${1:-}" sha="${2:-}" d
  [ "$#" -eq 2 ] || die "usage: create <job> <commit sha>"
  valid_job "$job"
  [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "not a full commit id: $sha"
  d="$(job_dir "$job")"
  [ ! -e "$d" ] || die "job $job exists"
  install -d -o root -g "$coord" -m 0750 "$root/jobs" "$d" "$d/logs"
  install -d -o "$juser" -g "$juser" -m 0700 "$d/work" "$d/out" "$d/pred"
  # Relative paths only, from inside the workspace: the job user can't traverse the job's directory (root's, 0750).
  (cd "$d/work" && runuser -u "$juser" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 bash -c '
    set -euo pipefail
    cat > .wl-bundle
    git init -q . && git config core.hooksPath /dev/null && git config credential.helper ""
    git fetch -q --no-tags .wl-bundle "+refs/*:refs/bundle/*" && git checkout -q --detach "$1"
    rm -f .wl-bundle' _ "$sha") >&2
  echo "$d/work"
}

# The spec, from stdin: each NAME=value then a NUL. Only these names, each once, each checked.
declare -A SPEC=()
read_spec() {
  local kv k v
  while IFS= read -r -d '' kv; do
    [[ "$kv" == *=* ]] || die "spec: NAME=value, got ${kv%%=*}"
    k="${kv%%=*}" v="${kv#*=}"
    [[ "$k" =~ ^(STUDY|EVAL|MINUTES|GPUS|OUTPUT_GB|WAIT_MAX|LOCK|DATA|INPUTS|LABELS|BUILD|PREFLIGHT|TRAIN|PREDICT|SCORE|CONFIG|SEED)$ ]] || die "spec: unknown $k"
    [ -z "${SPEC[$k]+x}" ] || die "spec: $k twice"
    [[ "$v" != *$'\n'* ]] || die "spec: $k: one line"
    [ "${#v}" -le 4000 ] || die "spec: $k: at most 4000 characters"
    SPEC[$k]="$v"
  done
  for k in STUDY EVAL MINUTES GPUS OUTPUT_GB WAIT_MAX LOCK DATA INPUTS LABELS BUILD PREFLIGHT TRAIN PREDICT SCORE CONFIG SEED; do [ -n "${SPEC[$k]+x}" ] || die "spec: no $k"; done
  [[ "${SPEC[STUDY]}" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die "spec: STUDY"
  valid_hex "${SPEC[EVAL]}"; valid_hex "${SPEC[LOCK]}"
  [[ "${SPEC[MINUTES]}" =~ ^[1-9][0-9]{0,3}$ ]] && [ "${SPEC[MINUTES]}" -le "$R_MAX_MIN" ] || die "spec: MINUTES ${SPEC[MINUTES]} is above root's $R_MAX_MIN (or not a number)"
  [[ "${SPEC[GPUS]}" =~ ^[0-9]{1,2}$ ]] || die "spec: GPUS"
  [[ "${SPEC[OUTPUT_GB]}" =~ ^[1-9][0-9]{0,4}$ ]] && [ "${SPEC[OUTPUT_GB]}" -le "$R_OUT_GB" ] || die "spec: OUTPUT_GB ${SPEC[OUTPUT_GB]} is above root's $R_OUT_GB (or not a number)"
  [[ "${SPEC[WAIT_MAX]}" =~ ^[0-9]{1,5}$ ]] && [ "${SPEC[WAIT_MAX]}" -le 86400 ] || die "spec: WAIT_MAX: 0 to 86400 seconds"
  [[ "${SPEC[DATA]}" =~ ^([a-z][a-z0-9-]{0,39}(,[a-z][a-z0-9-]{0,39}){0,19})?$ ]] || die "spec: DATA"
  [[ "${SPEC[SEED]}" =~ ^[0-9]{1,9}$ ]] || die "spec: SEED"
  for k in BUILD TRAIN PREDICT SCORE; do [ -n "${SPEC[$k]}" ] || die "spec: $k is empty"; done
}

# A run's variables file for systemd (root's, 0600, removed at the end): paths only, never anything secret.
write_env() {
  local k
  [ -d "$ENV_DIR" ] || mkdir -m 0700 -- "$ENV_DIR"
  [ "$(stat -c '%U %a' -- "$ENV_DIR")" = "$(id -un) 700" ] || die "$ENV_DIR is not $(id -un)'s and 0700"
  ENV_FILE="$ENV_DIR/$name.$1.$$"
  ( umask 077; set -C; for k in "${!VARS[@]}"; do printf '%s="%s"\n' "$k" "${VARS[$k]}"; done > "$ENV_FILE" )
}

jstr() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"; }

job() {
  local job="${1:-}" d ev cache r rc res locked waited=0 score="" outcome="" step="" gpu_s=0 t0="" used_kb cap_kb id
  [ "$#" -eq 1 ] || die "usage: job <job> (the spec on stdin)"
  valid_job "$job"
  read_root
  read_spec
  local mins="${SPEC[MINUTES]}" wait_max="${SPEC[WAIT_MAX]}" sd
  sd="$(systemd_version)"
  [ "$sd" -ge "$GPU_MIN_SYSTEMD" ] || die "systemd $sd is older than $GPU_MIN_SYSTEMD, the first the experiment sandbox is proven on"
  d="$(job_dir "$job")"
  [ -d "$d/work" ] || die "no job $job (create it first)"
  [ ! -e "$d/record.json" ] || die "job $job has a record; it never runs again"
  ev="$root/evals/${SPEC[EVAL]}"
  [ -e "$ev/.sealed" ] || die "eval ${SPEC[EVAL]} is not sealed"
  # Every source resolved and checked before anything runs.
  local -a jbind=() sbind=()
  local data_paths="" ids
  IFS=, read -r -a ids <<<"${SPEC[DATA]}"
  for id in ${ids[@]+"${ids[@]}"}; do r="$(source_dir "$id" job)"; jbind+=(-p "BindReadOnlyPaths=$r"); data_paths="$data_paths${data_paths:+:}$r"; done
  local inputs labels
  inputs="$(source_dir "${SPEC[INPUTS]}" job)"
  labels="$(source_dir "${SPEC[LABELS]}" scorer)"
  trap cleanup EXIT
  cache="$root/cache/${SPEC[LOCK]}"
  declare -gA VARS=([DATA]="$data_paths" [OUT]="$d/out" [PRED]="$d/pred" [EVAL_INPUTS]="$inputs" [EVAL_CODE]="$ev/files" [ENV]="$cache" [CONFIG]="$d/config.json" [SEED]="${SPEC[SEED]}" [WORK]="$d/work")
  printf '%s\n' "${SPEC[CONFIG]}" > "$d/config.json"; chmod 0644 "$d/config.json"
  write_env "$job"
  local -a work=(-p "BindReadOnlyPaths=$d/work" -p "BindReadOnlyPaths=$d/config.json" -p "WorkingDirectory=$d/work")
  echo "worklane-exp: job $job started" >&2
  # 1. The environment, built once per lockfile: the job user's while it builds, root's (read-only to all) after.
  if [ ! -e "$cache/.done" ]; then
    rm -rf --one-file-system -- "$cache"
    install -d -o root -g root -m 0755 "$root/cache"
    install -d -o "$juser" -g "$juser" -m 0700 "$cache"
    read -r rc res < <(step_unit "$job" build "$juser" 900 "$d/logs/build.log" "$R_ENV_NET" -- ${work[@]+"${work[@]}"} -p "BindPaths=$cache" -p "ReadWritePaths=$cache" -- "${SPEC[BUILD]}")
    if [ "$rc" -ne 0 ]; then outcome=crashed; step=build; rm -rf --one-file-system -- "$cache"; fi
    [ -n "$outcome" ] || { chown -R root:"$juser" "$cache"; chmod -R u=rwX,g=rX,o= "$cache"; chmod 0750 "$cache"; : > "$cache/.done"; }
  fi
  local -a envb=(-p "BindReadOnlyPaths=$cache")
  # 2. Preflight: no GPU, no network, two minutes.
  if [ -z "$outcome" ] && [ -n "${SPEC[PREFLIGHT]}" ]; then
    read -r rc res < <(step_unit "$job" preflight "$juser" 120 "$d/logs/preflight.log" 0 -- "${work[@]}" "${envb[@]}" -- "${SPEC[PREFLIGHT]}")
    [ "$rc" -eq 0 ] || { outcome=crashed; step=preflight; }
  fi
  # 3. Train, then predict, under the GPU lock (held for both). The wait is bounded by WAIT_MAX, not the job's time.
  if [ -z "$outcome" ]; then
    local -a gpu=()
    if [ "${SPEC[GPUS]}" -gt 0 ]; then
      gpu_decide "${SPEC[GPUS]}"
      locked="$(date +%s)"
      # A wait that reaches WAIT_MAX exits 1 here, saying who holds the GPU: no record, nothing ran (the engine logs it).
      gpu_lock "$job" $((locked + wait_max)) "$locked"
      waited=$(($(date +%s) - locked))
      gpu=("${GPU_PROPS[@]}")
    fi
  fi
  if [ -z "$outcome" ]; then
    t0="$(date +%s)"
    read -r rc res < <(step_unit "$job" train "$juser" $((mins * 60)) "$d/logs/train.log" 0 -- "${work[@]}" "${envb[@]}" ${jbind[@]+"${jbind[@]}"} -p "BindPaths=$d/out" -p "ReadWritePaths=$d/out" ${gpu[@]+"${gpu[@]}"} -- "${SPEC[TRAIN]}")
    if [ "$rc" -ne 0 ]; then step=train; [ "$res" = timeout ] || [ "$res" = signal ] && outcome=stopped || outcome=crashed; fi
  fi
  if [ -z "$outcome" ]; then
    read -r rc res < <(step_unit "$job" predict "$juser" $(((mins * 6 > 120) ? mins * 6 : 120)) "$d/logs/predict.log" 0 -- "${work[@]}" "${envb[@]}" -p "BindReadOnlyPaths=$d/out" -p "BindReadOnlyPaths=$inputs" -p "BindReadOnlyPaths=$ev/files" -p "BindPaths=$d/pred" -p "ReadWritePaths=$d/pred" ${gpu[@]+"${gpu[@]}"} -- "${SPEC[PREDICT]}")
    if [ "$rc" -ne 0 ]; then step=predict; [ "$res" = timeout ] || [ "$res" = signal ] && outcome=stopped || outcome=crashed; fi
  fi
  [ -z "${t0:-}" ] || gpu_s=$(( ${#GPU_IDX[@]} * ($(date +%s) - t0) ))
  gpu_unlock
  # 4. Seal: nothing but plain files and directories; root's after; within the output cap.
  find "$d/out" "$d/pred" -mindepth 1 \( ! -type f ! -type d \) -delete
  chown -R root:"$coord" "$d/out"; chmod -R u=rwX,g=rX,o= "$d/out"
  chown -R root:"$suser" "$d/pred"; chmod -R u=rwX,g=rX,o= "$d/pred"
  used_kb="$(du -sk "$d/out" "$d/pred" | awk '{ s += $1 } END { print s + 0 }')"
  cap_kb=$((${SPEC[OUTPUT_GB]} * 1024 * 1024))
  if [ "$used_kb" -gt "$cap_kb" ]; then rm -rf --one-file-system -- "$d/out" "$d/pred"; outcome=crashed; step=output-cap; fi
  # 5. Score: the scorer, the sealed eval copy, the predictions and the labels; never the job's workspace or code.
  if [ -z "$outcome" ]; then
    read -r rc res < <(step_unit "$job" score "$suser" 300 "$d/logs/score.log" 0 -- -p "BindReadOnlyPaths=$ev/files" -p "BindReadOnlyPaths=$labels" -p "BindReadOnlyPaths=$d/pred" -p "WorkingDirectory=$ev/files" -- "${SPEC[SCORE]}")
    if [ "$rc" -ne 0 ]; then outcome=crashed; step=score
    else
      score="$(grep -E '^score=-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,16})?([eE][-+]?[0-9]{1,3})?$' "$d/logs/score.log" | sed 's/^score=//')"
      if [ "$(printf '%s\n' "$score" | grep -c .)" -ne 1 ]; then score=""; outcome=crashed; step=score-unreadable; else outcome=scored; fi
    fi
  fi
  chown root:"$coord" "$d"/logs/*.log 2>/dev/null || true; chmod 0640 "$d"/logs/*.log 2>/dev/null || true
  rm -rf --one-file-system -- "$d/work"
  local rec
  rec="{\"protocol\":$PROTOCOL,\"job\":$(jstr "$job"),\"outcome\":$(jstr "$outcome"),\"step\":$([ -n "$step" ] && jstr "$step" || echo null),\"score\":${score:-null},\"gpu_seconds\":$gpu_s,\"waited_s\":$waited,\"gpus\":[$(IFS=,; echo "${GPU_IDX[*]:-}")],\"output_kb\":$used_kb}"
  printf '%s\n' "$rec" > "$d/record.json"; chown root:"$coord" "$d/record.json"; chmod 0640 "$d/record.json"
  echo "worklane-exp: record $rec"
}

stop_job() {
  local job="${1:-}" units
  [ "$#" -eq 1 ] || die "usage: stop <job>"
  valid_job "$job"
  units="$(systemctl list-units --all --plain --no-legend "worklane-exp-$name-$job-*" 2>/dev/null | awk '{print $1}')"
  # shellcheck disable=SC2086
  [ -z "$units" ] || { systemctl kill -s KILL $units 2>/dev/null || true; systemctl stop $units 2>/dev/null || true; }
  echo "stopped $job"
}

wipe() {
  local job="${1:-}" d
  [ "$#" -eq 1 ] || die "usage: wipe <job>"
  valid_job "$job"
  d="$(job_dir "$job")"
  stop_job "$job" >/dev/null
  rm -rf --one-file-system -- "$d/work" "$d/config.json"
  rm -f -- "$ENV_DIR/$name.$job."*
  echo "wiped $job"
}

prune() {
  local job="${1:-}" d
  [ "$#" -eq 1 ] || die "usage: prune <job>"
  valid_job "$job"
  d="$(job_dir "$job")"
  [ -e "$d/record.json" ] || die "job $job has no record yet"
  rm -rf --one-file-system -- "$d/out" "$d/pred"
  echo "pruned $job"
}

# PASS when each user can't reach what isn't its own, as itself: the labels and the eval copy from the job user, the
# workspace and the GPU locks from both, and every protected path. A probe that can't run is a FAIL.
check() {
  local fail=0 u p out g
  [ "$#" -eq 0 ] || die "usage: check"
  for u in "$juser" "$suser"; do
    g="$(id -nG "$u")"
    if [ "$g" = "$u" ]; then echo "PASS $u is in its own group only"; else echo "FAIL $u's groups: $g"; fail=1; fi
    if sudo -n -l -U "$u" 2>&1 | grep -q 'is not allowed to run sudo'; then echo "PASS $u may not run sudo"; else echo "FAIL $u has sudo rules"; fail=1; fi
    while IFS= read -r p; do
      [ -e "$p" ] || continue
      out="$(cd / && runuser -u "$u" -- sh -c 'if [ -r "$1" ] || [ -w "$1" ] || { [ -d "$1" ] && [ -x "$1" ]; }; then echo open; else echo denied; fi' _ "$p" 2>/dev/null || true)"
      if [ "$out" = denied ]; then echo "PASS $u can't reach $p"; else echo "FAIL $u can reach $p (${out:-the probe did not run})"; fail=1; fi
    done < <(protected_paths; echo "$GPU_LOCK_DIR"; [ "$u" = "$juser" ] && find "$root/data" -mindepth 1 -maxdepth 1 -type d -group "$suser" 2>/dev/null; [ "$u" = "$suser" ] && find "$root/data" -mindepth 1 -maxdepth 1 -type d -group "$juser" 2>/dev/null; true)
  done
  [ "$fail" -eq 0 ] && echo "OK" || echo "FAILED"
  return "$fail"
}

case "$cmd" in
  eval-put) eval_put "$@" ;;
  eval-seal) eval_seal "$@" ;;
  create) create "$@" ;;
  job) job "$@" ;;
  stop) stop_job "$@" ;;
  wipe) wipe "$@" ;;
  prune) prune "$@" ;;
  check) check "$@" ;;
  *) die "unknown command ${cmd:-(none)}" ;;
esac
