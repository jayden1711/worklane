#!/usr/bin/env bash
# Once per instance, as root (review it first): the sandboxed test user its coordinator runs PRs' tests as, below
# the instances in CPU and memory. docs/test-runs.md has the why of each choice.
#
#   bash scripts/setup/test-user.sh install <name> [options]
#   bash scripts/setup/test-user.sh check <name>
#   bash scripts/setup/test-user.sh remove <name>
#   bash scripts/setup/test-user.sh update-helper          only the sandbox helper, from this checkout; nothing else
#   bash scripts/setup/test-user.sh --print install <name> [options]     (changes nothing)
#
# What install does:
#   - A test user, wl-test-<name>: its own group only, no sudo, no login shell, and no access to the engine
#     (/opt/worklane), the checkouts (/srv/worklane), /var/lib/worklane, /etc/worklane (each denied to it by an
#     ACL entry), any other wl-* home (instance homes hold App keys and credentials) or /root. Checked as that
#     user, path by path, before anything else is installed and again at the end; any failure stops there.
#   - The sandbox helper, /usr/local/libexec/worklane-testrun (scripts/machine/worklane-testrun.sh), root-owned,
#     and a sudoers rule letting wl-<name> run it for <name> only. Each run is a transient unit in
#     worklane-test.slice, as the test user, sandboxed (the helper's header lists how), in a workspace of its own
#     that is wiped after the run with its containers and temp files.
#   - The wrapper that gives each run a user and network namespace of its own (#545),
#     /usr/local/libexec/worklane-testrun-userns: a root-owned copy of this machine's unshare (util-linux 2.38 or later),
#     and where user namespaces are restricted (Ubuntu 24.04), an AppArmor profile letting it, and nothing else of
#     worklane's but the pinned rootlesskit, make one. Shared by every instance, like the helper.
#   - Rootless Docker for the runs' databases (pinned static release, sha256-checked): one daemon, as the test
#     user, so no root daemon and no docker group. Ports it publishes bind 127.0.0.1. The runs themselves can't
#     reach its socket: only the helper starts containers, each with a unique name and a port the daemon picks.
#   - worklane-test.slice, a top-level slice: hard caps (CPUQuota over AllowedCPUs, MemoryMax, no swap) and a CPU
#     and IO weight below worklane.slice's, so the instances always win under contention. check fails if its
#     memory cap isn't below every instance's.
#
# options (defaults in brackets):
#   --cpus <list>           [the last 8 CPUs]  AllowedCPUs for all test runs (e.g. 16-23); CPUQuota follows it
#   --memory-max <size>     [6G]  for all test runs together, databases included
#   --cpu-weight <1-10000>  [10]  must stay below worklane.slice's (20 by default)
#   --io-weight <1-10000>   [10]
# update-helper reinstalls just /usr/local/libexec/worklane-testrun (shared by every instance), atomically, root:root
# 0755: no user, slice, Docker or sudoers change, so it keeps every option an install was given. An engine whose
# helper is outdated (its `version` isn't the engine's protocol) names this command; restart the instances after it.
# The full-run lock (/run/lock/worklane-full-run.lock) must already exist, root-owned 0644: the project's own
# machine script makes it at boot. The coordinator takes it shared for each run; agents' full runs take it exclusive.
source "$(dirname "$0")/lib.sh"
all_args=("$@")
here="$(cd "$(dirname "$0")" && pwd)"
machine_dir="$here/../machine"

# Pins: change a version only together with its sha256s (the same release scripts/setup/ci-runner.sh pinned).
#   docker  https://download.docker.com/linux/static/stable/x86_64/ (Docker publishes no checksum file for the
#           static builds: these are the sha256 of the files as downloaded over https on 2026-10-12)
docker_version=29.8.2
docker_sha256_x64=995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f
docker_rootless_sha256_x64=707ebf6a5afd88104086e7b6749997b2366e816aeaf2c3ef2305b08fde9ee007

usage="usage: test-user.sh [--print] install <name> [options] | check <name> | remove <name> | update-helper"
print="" cpus="" memory_max=6G cpu_weight=10 io_weight=10
pos=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print=1; shift ;;
    --cpus) cpus="${2:?--cpus needs a CPU list}"; shift 2 ;;
    --memory-max) memory_max="${2:?--memory-max needs a size}"; shift 2 ;;
    --cpu-weight) cpu_weight="${2:?--cpu-weight needs a weight}"; shift 2 ;;
    --io-weight) io_weight="${2:?--io-weight needs a weight}"; shift 2 ;;
    -*) echo "unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
cmd="${pos[0]:-}" name="${pos[1]:-}"
case "$cmd" in
  install) [ "${#pos[@]}" -eq 2 ] || { echo "$usage" >&2; exit 2; } ;;
  check | remove) [ "${#pos[@]}" -eq 2 ] && [ -z "$print" ] || { echo "$usage" >&2; exit 2; } ;;
  update-helper) [ "${#pos[@]}" -eq 1 ] && [ -z "$print" ] || { echo "$usage" >&2; exit 2; }; name=helper ;; # no instance: a placeholder name, never used
  *) echo "$usage" >&2; exit 2 ;;
esac
# check and remove take an instance made before its name was reserved (machine, console; #902 round 9): what it has
# already is checked and removed. Nothing is installed under such a name.
if [ "$cmd" = check ] || [ "$cmd" = remove ]; then need_instance_name "$name" "the instance name" kept; else
need_instance_name "$name" "the instance name"
fi
[[ "$memory_max" =~ ^[1-9][0-9]*[KMGT]$ ]] || { echo "--memory-max: a size such as 6G, got $memory_max" >&2; exit 2; }
for w in "$cpu_weight" "$io_weight"; do [[ "$w" =~ ^[0-9]+$ ]] && [ "$w" -ge 1 ] && [ "$w" -le 10000 ] || { echo "weights are 1 to 10000, got $w" >&2; exit 2; }; done
if [ -z "$cpus" ]; then n="$(getconf _NPROCESSORS_ONLN)"; if [ "$n" -gt 8 ]; then cpus="$((n - 8))-$((n - 1))"; else cpus="0-$((n - 1))"; fi; fi
# The CPUs in a list like 0-3,8,10-11: CPUQuota is that many cores, so the cap and what the tests see agree
# (Node's availableParallelism() counts the CPUs a process may run on, not a quota).
ncpus=0
IFS=, read -ra parts <<<"$cpus"
for part in "${parts[@]}"; do
  if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ]; then ncpus=$((ncpus + BASH_REMATCH[2] - BASH_REMATCH[1] + 1))
  elif [[ "$part" =~ ^[0-9]+$ ]]; then ncpus=$((ncpus + 1))
  else echo "--cpus: a CPU list such as 16-23 or 0,2,4-5, got $cpus" >&2; exit 2; fi
done

user="wl-test-$name"
coord="wl-$name"
root="/var/lib/worklane-test/$name"
helper=/usr/local/libexec/worklane-testrun
# The helper's USERNS and USERNS_PROFILE (a test keeps them equal).
userns_bin=/usr/local/libexec/worklane-testrun-userns
userns_profile=worklane-testrun-userns
docker_dir="/opt/worklane-test/docker-$docker_version"
docker_unit_name="worklane-test-$name-docker.service"
lock=/run/lock/worklane-full-run.lock
deny_acl=(/srv/worklane /opt/worklane /var/lib/worklane /etc/worklane)

slice() {
  cat <<EOF
[Unit]
Description=worklane test runs: hard CPU and memory caps, weights below worklane.slice

[Slice]
CPUWeight=$cpu_weight
IOWeight=$io_weight
AllowedCPUs=$cpus
CPUQuota=$((ncpus * 100))%
MemoryMax=$memory_max
MemorySwapMax=0
TasksMax=8192
EOF
}

# The host's egress rule (egress-firewall.sh) covers the test user; this unit's cgroup is its one exception, so Docker
# can pull a run's database image: systemd puts the cgroup in the rule's set while the unit runs (systemd 255 or later;
# on an older one the rule covers test users only with --with-test-users, and then Docker can't pull). Never where the
# rule's record says dropped: that install's rule covered the test user with all of Docker's traffic dropped before, and
# the exception would reopen routes out through Docker that it had closed (lib.sh egress_docker_mode).
docker_egress() {
  local rec="$EGRESS_RECORD"
  # --print changes nothing, so a test may point it at a record of its own.
  [ -z "$print" ] || rec="${EGRESS_RECORD_PRINT:-$rec}"
  if [ "$(egress_docker_mode "$rec")" = dropped ]; then
    printf '# No NFTSet=: the host egress rule (egress-firewall.sh) drops all traffic of the test user, Docker included, as the rule of this install did before (its record, %s).\n' "$rec"
  elif [ "$(systemd_major)" -ge "$EGRESS_NFTSET_SYSTEMD" ]; then
    printf '# Its image pulls get past the host egress rule for the test user (egress-firewall.sh): this cgroup only.\nNFTSet=cgroup:inet:%s:%s\n' "$EGRESS_TABLE" "$EGRESS_SET"
  else
    printf '# No NFTSet= (systemd %s; it needs %s): the host egress rule leaves the test user out unless --with-test-users.\n' "$(systemd_major)" "$EGRESS_NFTSET_SYSTEMD"
  fi
}

docker_unit() {
  cat <<EOF
[Unit]
Description=rootless Docker for $name's test-run databases, as $user (no root daemon, no docker group)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$user
Group=$user
Slice=worklane-test.slice
Environment=HOME=$root/docker-home
Environment=XDG_RUNTIME_DIR=/run/worklane-test-$name-docker
# /usr/sbin and /sbin: dockerd-rootless.sh runs sysctl (and iptables) from there.
Environment=PATH=$docker_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=builtin
RuntimeDirectory=worklane-test-$name-docker
RuntimeDirectoryMode=0700
UMask=0077
# Containers' cgroups: Docker's default systemd driver needs a systemd user session (it reads
# /sys/fs/cgroup/user.slice/user-<uid>.slice), which the test user doesn't have. With cgroupfs, rootless Docker
# leaves each container's cgroup to runc, which makes it beside its own: the daemon runs in <this unit>/daemon, so
# each container gets <this unit>/<id>, in this unit's delegated subtree, under worklane-test.slice's caps.
Delegate=cpu io memory pids
DelegateSubgroup=daemon
$(docker_egress)
# Published ports bind 127.0.0.1.
ExecStart=$docker_dir/dockerd-rootless.sh --data-root $root/docker --ip 127.0.0.1 --exec-opt native.cgroupdriver=cgroupfs
KillMode=mixed
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

apparmor_profile() {
  cat <<EOF
abi <abi/4.0>,
include <tunables/global>

# Lets only the test runs' pinned rootlesskit create user namespaces (rootless Docker); the restriction stays on.
profile worklane-test-rootlesskit $docker_dir/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/worklane-test-rootlesskit>
}
EOF
}

# The same allowance for the test runs' own wrapper (#545): it makes each run a user and network namespace of its own.
userns_apparmor_profile() {
  cat <<EOF
abi <abi/4.0>,
include <tunables/global>

# Lets only the test runs' wrapper (a root-owned copy of unshare) create user namespaces: each test run's own, which
# keeps it out of every other process's namespaces (#545). The restriction stays on.
profile $userns_profile $userns_bin flags=(unconfined) {
  userns,
  include if exists <local/$userns_profile>
}
EOF
}

# Where test-user.sh install keeps each instance's state (the helper's BASE): an instance has a test user here only once
# its directory is there.
BASE=/var/lib/worklane-test

# Whether user <u> is the test user of an instance on this machine: the helper's is_test_user, word for word (a test
# keeps them equal). WHY not the pattern wl-test-*: instance test's agent, eval and MCP users are wl-test-agent,
# wl-test-eval and wl-test-mcp.
is_test_user() {
  local n
  [[ "$1" =~ ^wl-test-(.+)$ ]] || return 1
  n="${BASH_REMATCH[1]}"
  [ -z "$(instance_name_problem "$n")" ] && [ -d "$BASE/$n" ] && [ ! -L "$BASE/$n" ]
}

# Why the wrapper's ACL lets anyone but the test users run it, or anyone but root write it: the helper's
# wrapper_acl_problem, word for word (a test keeps them equal); it checks the same before every run.
wrapper_acl_problem() {
  local l who perm mine=0
  while IFS= read -r l; do
    l="${l%%[[:space:]]*}"
    case "$l" in
      '' | user::*) ;;
      mask::*) [[ "${l#mask::}" != *w* ]] || { echo "its ACL mask lets a named entry write it ($l)"; return 0; } ;;
      user:*:*) who="${l#user:}"; perm="${who##*:}"; who="${who%:*}"
        [[ "$perm" != *w* ]] || { echo "$who may write it"; return 0; }
        if [ "$who" = "$user" ]; then [[ "$perm" == *x ]] && mine=1
        elif ! is_test_user "$who"; then echo "$who, not the test user of an instance here, may run it"; return 0; fi ;;
      group::---) ;;
      group:*) echo "a group may run it ($l)"; return 0 ;;
      other::---) ;;
      other:*) echo "every user may run it ($l)"; return 0 ;;
      *) echo "an ACL entry this helper doesn't know: $l"; return 0 ;;
    esac
  done <<<"$1"
  [ "$mine" -eq 1 ] || echo "$user may not run it"
  return 0
}

# Whether only the test users (this one among them) may run the wrapper, and only root write it (wrapper_acl_problem).
userns_acl_ok() {
  local acl
  acl="$(getfacl -cp "$userns_bin" 2>/dev/null)" || return 1
  [ -z "$(wrapper_acl_problem "$acl")" ]
}

# Why this machine's unshare can't be the wrapper, or nothing when it can: the helper's prelude needs
# --map-current-user and --keep-caps (util-linux 2.38 or later), and setpriv beside it. The helper's userns_unsupported
# asks the same of the file (it never runs it).
userns_unsupported_why() {
  local help v
  help="$(unshare --help 2>/dev/null || true)"
  if ! grep -q -- '--map-current-user' <<<"$help" || ! grep -q -- '--keep-caps' <<<"$help"; then
    v="$(unshare --version 2>/dev/null | head -n 1 || true)"
    echo "${v:-no unshare}: no --map-current-user or --keep-caps"
  elif ! command -v setpriv >/dev/null 2>&1; then echo "no setpriv"
  fi
}

userns_supported() {
  [ -z "$(userns_unsupported_why)" ]
}

# The test users on this machine, one a line: this instance's (its directory may not be there yet on a first install),
# and each other user is_test_user takes. The only users the wrapper's ACL lets run it.
test_users() {
  local u
  { echo "$user"; getent passwd | cut -d: -f1 | while IFS= read -r u; do if is_test_user "$u"; then echo "$u"; fi; done; } | sort -u
}

# The wrapper (a copy of this machine's unshare), atomically: root:root 0700, and an ACL entry letting each test user
# (and nobody else) run it. WHY: where user namespaces are restricted its AppArmor profile lets whoever runs it make one,
# so no other user, and no NoNewPrivileges unit (a DynamicUser one included), may run it. And its AppArmor profile where
# user namespaces are restricted. On a machine whose unshare is too old, a note: the helper then runs each run in the
# host's user namespace, as before #545, and its check says so.
install_userns() {
  local u
  if ! userns_supported; then
    echo "note: this machine's unshare ($(unshare --version 2>/dev/null | head -n 1)) has no --map-current-user or --keep-caps, or there's no setpriv: test runs share the host's user namespace (docs/test-runs.md, \"Known gap\")"
    return 0
  fi
  install -o root -g root -m 0700 "$(command -v unshare)" "$userns_bin.tmp"
  for u in $(test_users); do setfacl -m "u:$u:r-x" "$userns_bin.tmp"; done
  mv -f "$userns_bin.tmp" "$userns_bin"
  echo "installed $userns_bin (a copy of $(command -v unshare)), root:root 0700; the test users may run it: $(test_users | paste -sd' ' -)"
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    userns_apparmor_profile > "/etc/apparmor.d/.$userns_profile.tmp"
    apparmor_parser -Q "/etc/apparmor.d/.$userns_profile.tmp" || { rm -f "/etc/apparmor.d/.$userns_profile.tmp"; echo "AppArmor profile $userns_profile refused; nothing installed" >&2; exit 1; }
    mv -f "/etc/apparmor.d/.$userns_profile.tmp" "/etc/apparmor.d/$userns_profile"
    apparmor_parser -r "/etc/apparmor.d/$userns_profile"
    echo "loaded the AppArmor profile $userns_profile: $userns_bin may make a user namespace (the restriction stays on for everything else)"
  fi
}

# wl-<name> may run the helper for <name> only; the helper checks every other argument itself.
sudoers_rule() {
  printf '# %s runs its test runs as %s, through one validating helper, and nothing else.\n' "$coord" "$user"
  printf '%s ALL=(root) NOPASSWD: %s %s *\n' "$coord" "$helper" "$name"
}

if [ -n "$print" ]; then
  echo "# /etc/systemd/system/worklane-test.slice"; slice; echo
  echo "# /etc/systemd/system/$docker_unit_name"; docker_unit; echo
  echo "# sudoers rule worklane-test-$name"; sudoers_rule; echo
  echo "# $helper (scripts/machine/worklane-testrun.sh)"; cat "$machine_dir/worklane-testrun.sh"; echo
  echo "# /etc/apparmor.d/worklane-test-rootlesskit (only where user namespaces are restricted)"; apparmor_profile; echo
  echo "# $userns_bin: a copy of this machine's unshare (util-linux 2.38 or later), root:root 0700, an ACL entry r-x for each test user"
  echo "# /etc/apparmor.d/$userns_profile (only where user namespaces are restricted)"; userns_apparmor_profile
  exit 0
fi
as_root "${all_args[@]}"
# Set here, never inherited: useradd, usermod, setfacl, sysctl, iptables and ip are in /usr/sbin or /sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The tools every subcommand uses; install adds the packages for the rest and checks them after.
need_tools() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t (PATH=$PATH)" >&2; exit 1; }; done; }
need_tools systemctl getent install id stat

# put <file> <generator>: writes /etc/systemd/system/<file>; put_changed=1 when its content differs from before.
put_changed=0
put() {
  local file="$1" tmp="/etc/systemd/system/.$1.tmp" check
  "$2" > "$tmp"; chmod 0644 "$tmp"
  if cmp -s "$tmp" "/etc/systemd/system/$file"; then put_changed=0; else put_changed=1; fi
  check="$(mktemp -d)/$file"; cp "$tmp" "$check"
  if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "$file invalid; nothing installed" >&2; exit 1; fi
  rm -f "$check"
  mv -f "$tmp" "/etc/systemd/system/$file"
  echo "installed /etc/systemd/system/$file"
}

protected_paths() {
  local u h
  printf '%s\n' "${deny_acl[@]}" /etc/sudoers.d /root /run/docker.sock /var/run/docker.sock
  while IFS=: read -r u _ _ _ _ h _; do
    [[ "$u" == wl-* && "$u" != "$user" && -n "$h" && "$h" != / ]] && printf '%s\n' "$h"
  done < <(getent passwd)
}

access_checks() {
  local fail=0 groups members paths
  groups="$(id -nG "$user" 2>/dev/null || true)"
  if [ "$groups" = "$user" ]; then echo "PASS $user is in its own group only"; else echo "FAIL $user's groups: ${groups:-none (no such user?)}"; fail=1; fi
  members="$(getent group "$user" | cut -d: -f4)"
  if [ -z "$members" ]; then echo "PASS no other user is in group $user"; else echo "FAIL group $user has members: $members"; fail=1; fi
  if sudo -n -l -U "$user" 2>&1 | grep -q 'is not allowed to run sudo'; then echo "PASS $user may not run sudo"; else echo "FAIL $user has sudo rules (sudo -l -U $user)"; fail=1; fi
  mapfile -t paths < <(protected_paths)
  deny_check "$user" "${paths[@]}" || fail=1
  if [ -e "$lock" ] && [ "$(stat -c '%u %a' "$lock")" = "0 644" ] && (cd / && sudo -n -u "$coord" sh -c 'exec 9<"$1"' _ "$lock"); then
    echo "PASS $lock is root-owned 0644 and $coord can open it to lock"
  else
    echo "FAIL $lock must exist, root-owned 0644, openable by $coord (the project's machine script makes it at boot)"; fail=1
  fi
  return "$fail"
}

# Docker's daemon runs in its unit's subgroup "daemon", and the unit's cgroup has the controllers delegated, so each
# container gets a cgroup of its own beside it, inside worklane-test.slice.
# Is the running daemon in the delegated layout (its main process in <unit>/daemon)? Quiet; for install.
docker_layout_ok() {
  local cg pid
  cg="$(systemctl show "$docker_unit_name" -p ControlGroup --value 2>/dev/null || true)"
  pid="$(systemctl show "$docker_unit_name" -p MainPID --value 2>/dev/null || true)"
  [ -n "$cg" ] && [ "${pid:-0}" != 0 ] && [ "$(sed -n 's/^0:://p' "/proc/$pid/cgroup" 2>/dev/null)" = "$cg/daemon" ]
}

# This instance's test runs in progress: their units (worklane-test-<name>_<id>_<pid>.service, or
# worklane-test-<name>-<id>-<pid>.service from a helper before protocol 9; not the Docker unit) and their directories
# (wipe removes both). One per line, empty when there are none. A unit counts only when it runs as this instance's test
# user (User=): instance a-b's runs (worklane-test-a-b-...) match instance a's old pattern, and are never a's.
active_runs() {
  local u
  while read -r u _; do
    [ "$u" != "$docker_unit_name" ] || continue
    [ "$(systemctl show -p User --value "$u" 2>/dev/null)" = "$user" ] && echo "unit $u"
  done < <(systemctl list-units --plain --no-legend --full --state=active,activating,deactivating "worklane-test-${name}_*.service" "worklane-test-$name-*.service" 2>/dev/null)
  find "$root/runs" -mindepth 1 -maxdepth 1 -type d -printf 'run %f\n' 2>/dev/null || true
}

docker_cgroup_check() {
  local cg pid own ctl c missing=""
  cg="$(systemctl show "$docker_unit_name" -p ControlGroup --value 2>/dev/null || true)"
  pid="$(systemctl show "$docker_unit_name" -p MainPID --value 2>/dev/null || true)"
  own="$(sed -n 's/^0:://p' "/proc/${pid:-0}/cgroup" 2>/dev/null || true)"
  ctl="$(cat "/sys/fs/cgroup$cg/cgroup.controllers" 2>/dev/null || true)"
  for c in cpu io memory pids; do [[ " $ctl " == *" $c "* ]] || missing="$missing $c"; done
  if [[ "$cg" == /worklane.slice/worklane-test.slice/* && "$own" == "$cg/daemon" && -z "$missing" ]]; then
    echo "PASS Docker runs in $cg/daemon, with cpu io memory pids delegated: each container gets a cgroup of its own in $cg"
  else
    echo "FAIL Docker's cgroups: unit ${cg:-none}, daemon in ${own:-unknown}, delegated: ${ctl:-none}${missing:+ (missing:$missing)}"; return 1
  fi
}

service_checks() {
  local fail=0 t_mem t_w wl_w u m
  t_mem="$(systemctl show worklane-test.slice -p MemoryMax --value)"
  t_w="$(systemctl show worklane-test.slice -p CPUWeight --value)"
  if [[ "$t_mem" =~ ^[0-9]+$ ]]; then echo "PASS worklane-test.slice MemoryMax=$t_mem"; else echo "FAIL worklane-test.slice has no memory cap ($t_mem)"; fail=1; fi
  for u in $(systemctl list-units --type=service --all --plain --no-legend 'worklane-*.service' | awk '{print $1}'); do
    [[ "$u" == worklane-test-* || "$u" == worklane-ci-* || "$u" == worklane-dashboard* ]] && continue
    m="$(systemctl show "$u" -p MemoryMax --value)"
    [[ "$m" =~ ^[0-9]+$ && "$t_mem" =~ ^[0-9]+$ ]] || continue
    if [ "$t_mem" -lt "$m" ]; then echo "PASS test runs' memory cap is below $u's ($m)"; else echo "FAIL test runs' memory cap ($t_mem) is not below $u's ($m)"; fail=1; fi
  done
  wl_w="$(systemctl show worklane.slice -p CPUWeight --value 2>/dev/null || true)"
  if [[ "$wl_w" =~ ^[0-9]+$ ]]; then
    if [[ "$t_w" =~ ^[0-9]+$ ]] && [ "$t_w" -lt "$wl_w" ]; then echo "PASS test runs' CPU weight ($t_w) is below worklane.slice's ($wl_w)"; else echo "FAIL test runs' CPU weight ($t_w) is not below worklane.slice's ($wl_w)"; fail=1; fi
  fi
  if systemctl is-active -q "$docker_unit_name"; then echo "PASS $docker_unit_name is active"; else echo "FAIL $docker_unit_name is not active (journalctl -u $docker_unit_name)"; fail=1; fi
  docker_cgroup_check || fail=1
  if [ -x "$helper" ] && cmp -s "$helper" "$machine_dir/worklane-testrun.sh"; then echo "PASS $helper matches this checkout's"; else echo "FAIL $helper is missing or differs from scripts/machine/worklane-testrun.sh (run install)"; fail=1; fi
  userns_check "${1:-}" || fail=1
  return "$fail"
}

# Each run's own user namespace (#545): the wrapper as install puts it (the helper's own check, after, proves a run is
# in one). [standalone]: check run by hand (the check command, and nothing else, passes it), where a machine whose
# unshare can't be the wrapper is a FAIL naming the fix. Elsewhere (install's own check) a NOTE: a FAIL there would exit
# install 1, and the machine's test runs go on as they did before #545 (the helper's check, which keeps test runs on,
# prints only a NOTE too; doctor and the Machine page show that NOTE in red).
userns_check() {
  local why
  why="$(userns_unsupported_why)"
  if [ -n "$why" ]; then
    why="this machine's unshare can't be the test runs' wrapper ($why): install util-linux 2.38 or later and setpriv, then run test-user.sh install $name again"
    if [ "${1:-}" = standalone ]; then echo "FAIL $why"; return 1; fi
    echo "NOTE $why. Until then runs share the host's user namespace (docs/test-runs.md, \"Known gap\")"
  elif [ ! -f "$userns_bin" ] || [ -L "$userns_bin" ] || [ "$(stat -c '%U:%G' "$userns_bin")" != root:root ]; then
    echo "FAIL $userns_bin is missing or not root:root, so runs share the host's user namespace (run install)"; return 1
  elif ! userns_acl_ok; then
    echo "FAIL $userns_bin may be run by others than the test users, or not by $user: $(getfacl -cp "$userns_bin" 2>/dev/null | tr '\n' ' ') (run install)"; return 1
  else echo "PASS $userns_bin is root:root, and only the test users may run it"; fi
}

# [standalone]: run by hand (the check command); see userns_check. Install runs it without, and stops on a FAIL.
check_cmd() {
  local fail=0 mode="${1:-}" out rc=0
  id -u "$user" >/dev/null 2>&1 || { echo "FAIL no user $user; run install first"; exit 1; }
  say "boundaries, as $user"
  access_checks || fail=1
  say "caps, Docker, the helper"
  service_checks "$mode" || fail=1
  say "inside the sandbox a run gets (the helper's own check)"
  # As root, not as whoever ran sudo: the helper reads SUDO_USER as its caller, and refuses anyone but wl-<name>.
  out="$(env -u SUDO_USER "$helper" "$name" check)" || rc=$?
  printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail=1
  # WHY: the helper's check passes where a run shares the host's user namespace (a NOTE: its check keeps test runs on).
  # By hand, that is a FAIL whatever the reason, so this check never ends OK while the route #545 closes is open. The
  # machine's unshare is userns_check's FAIL already.
  if [ "$mode" = standalone ] && [ "$rc" -eq 0 ] && userns_supported && ! grep -q '^PASS a sandboxed run is in a user namespace of its own' <<<"$out"; then
    echo "FAIL a sandboxed run shares the host's user namespace (the helper's NOTE above says why), so it can join the namespaces of $user's rootless Docker: fix that, then run test-user.sh install $name again"; fail=1
  fi
  [ "$fail" -eq 0 ] && echo "OK: all checks passed" || echo "FAILED: see the FAIL lines above" >&2
  return "$fail"
}

# The helper, atomically: a temp file beside it, checked, then renamed over it (a run in progress keeps the old one).
install_helper() {
  local tmp
  tmp="$(dirname "$helper")/.worklane-testrun.tmp"
  install -d -o root -g root -m 0755 "$(dirname "$helper")"
  install -o root -g root -m 0755 "$machine_dir/worklane-testrun.sh" "$tmp"
  bash -n "$tmp" || { rm -f "$tmp"; echo "the helper doesn't parse; nothing installed" >&2; exit 1; }
  mv -f "$tmp" "$helper"
  echo "installed $helper (protocol $(sed -n 's/^PROTOCOL=\([0-9][0-9]*\)$/\1/p' "$helper"))"
}

update_helper_cmd() {
  if [ -f "$helper" ] && cmp -s "$helper" "$machine_dir/worklane-testrun.sh"; then echo "$helper already matches this checkout's"; return 0; fi
  install_helper
  echo "restart each instance (systemctl restart worklane-<name>.service) so its coordinator asks the helper again"
}

install_cmd() {
  local s
  [ "$(uname -m)" = x86_64 ] || { echo "the pins here are x86_64 builds; this is $(uname -m)" >&2; exit 1; }
  command -v apt-get >/dev/null && command -v systemctl >/dev/null || { echo "this script is for Ubuntu with systemd" >&2; exit 1; }
  id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run instance.sh $name first" >&2; exit 1; }
  [ -e "$lock" ] && [ "$(stat -c %u "$lock")" = 0 ] || { echo "no root-owned $lock: set the machine's locks up first (the project's machine script)" >&2; exit 1; }

  say "packages from the distribution: rootless Docker's helpers, acl"
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends uidmap slirp4netns iptables acl curl ca-certificates tar
  need_tools useradd usermod userdel setfacl sysctl iptables ip newuidmap newgidmap slirp4netns runuser systemd-run tar sha256sum curl

  say "the test user $user: its own group only, no sudo, no login shell"
  ensure_user "$user"
  usermod -s /usr/sbin/nologin "$user"
  if ! grep -q "^$user:" /etc/subuid || ! grep -q "^$user:" /etc/subgid; then
    s="$(cat /etc/subuid /etc/subgid 2>/dev/null | awk -F: 'BEGIN { m = 100000 } { e = $2 + $3; if (e > m) m = e } END { print m }')"
    usermod --add-subuids "$s-$((s + 65535))" --add-subgids "$s-$((s + 65535))" "$user"
  fi
  for p in "${deny_acl[@]}"; do [ -e "$p" ] && setfacl -m "u:$user:---" "$p" && echo "denied $p to $user (ACL)"; done
  say "check the boundaries as $user before anything else is installed"
  access_checks || { echo "refusing to go on: fix the FAIL lines above" >&2; exit 1; }

  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/$3" "$1"; echo "$2  $work/$3" | sha256sum -c -; }
  install -d -o root -g root -m 0755 /opt/worklane-test "$(dirname "$helper")"
  say "Docker $docker_version (static, rootless extras), sha256-pinned, in $docker_dir"
  if [ -x "$docker_dir/dockerd" ] && [ -x "$docker_dir/rootlesskit" ]; then echo "already installed"; else
    fetch "https://download.docker.com/linux/static/stable/x86_64/docker-$docker_version.tgz" "$docker_sha256_x64" docker.tgz
    fetch "https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-$docker_version.tgz" "$docker_rootless_sha256_x64" rootless.tgz
    mkdir -p "$work/d"
    tar -xzf "$work/docker.tgz" -C "$work/d" --no-same-owner
    tar -xzf "$work/rootless.tgz" -C "$work/d" --no-same-owner
    rm -rf "$docker_dir.new"; install -d -m 0755 "$docker_dir.new"
    cp -a "$work/d/docker/." "$work/d/docker-rootless-extras/." "$docker_dir.new/"
    chown -R root:root "$docker_dir.new"; chmod -R a+rX,go-w "$docker_dir.new"
    rm -rf "$docker_dir"; mv "$docker_dir.new" "$docker_dir"
  fi
  ln -sfn "$docker_dir" /opt/worklane-test/docker
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    say "AppArmor: let only the pinned rootlesskit create user namespaces (the machine-wide restriction stays on)"
    apparmor_profile > /etc/apparmor.d/.worklane-test-rootlesskit.tmp
    apparmor_parser -Q /etc/apparmor.d/.worklane-test-rootlesskit.tmp || { rm -f /etc/apparmor.d/.worklane-test-rootlesskit.tmp; echo "AppArmor profile refused; nothing installed" >&2; exit 1; }
    mv -f /etc/apparmor.d/.worklane-test-rootlesskit.tmp /etc/apparmor.d/worklane-test-rootlesskit
    apparmor_parser -r /etc/apparmor.d/worklane-test-rootlesskit
  fi
  say "each test run's own user and network namespace: the wrapper $userns_bin"
  install_userns

  say "the sandbox helper, root-owned, in $helper"
  install_helper

  say "state in $root: runs, caches and Docker's data, the test user's"
  install -d -o root -g root -m 0711 /var/lib/worklane-test
  # $root and its runs: entered by this instance's test user only (group), never by another instance's.
  # chown/chmod as well, so a re-run fixes directories an older install made 0711.
  install -d -o root -g "$user" -m 0710 "$root" "$root/runs"
  chown root:"$user" "$root" "$root/runs"; chmod 0710 "$root" "$root/runs"
  install -d -o "$user" -g "$user" -m 0700 "$root/cache" "$root/docker" "$root/docker-home"

  say "units: worklane-test.slice (CPUs $cpus, CPUQuota $((ncpus * 100))%, MemoryMax $memory_max, CPU weight $cpu_weight), $docker_unit_name"
  put worklane-test.slice slice
  put "$docker_unit_name" docker_unit
  docker_changed="$put_changed"
  systemctl daemon-reload
  # A running daemon keeps its old settings (and cgroup layout) until it restarts: restart it when its unit changed
  # or it isn't in the delegated layout, but never under a run in progress.
  if systemctl is-active -q "$docker_unit_name" && { [ "$docker_changed" = 1 ] || ! docker_layout_ok; }; then
    busy="$(active_runs)"
    if [ -n "$busy" ]; then
      echo "$docker_unit_name needs a restart for its new settings, but test runs of $name are in progress:" >&2
      printf '%s\n' "$busy" | sed 's/^/  /' >&2
      echo "let them finish (or stop the coordinator and wipe them: $helper $name wipe <id>), then run install again" >&2
      exit 1
    fi
    systemctl restart "$docker_unit_name"
    echo "restarted $docker_unit_name (its unit changed or it ran in the old cgroup layout)"
  fi
  systemctl enable --now "$docker_unit_name"
  for _ in $(seq 60); do [ -S "/run/worklane-test-$name-docker/docker.sock" ] && break; sleep 1; done
  systemctl is-active -q "$docker_unit_name" || { echo "$docker_unit_name didn't start; see: journalctl -u $docker_unit_name -n 50" >&2; systemctl --no-pager status "$docker_unit_name" >&2 || true; exit 1; }
  echo "$docker_unit_name is active"

  # The host egress rule names users by uid: where it is in use, load it again so it covers this test user too (with
  # the flags it was applied with, as experiments.sh install does).
  if [ -f "$EGRESS_RECORD" ]; then
    say "the host egress rule (egress-firewall.sh), now with $user in it"
    egress_flags=""
    if grep -qx '# --with-test-users' "$EGRESS_RECORD"; then egress_flags=--with-test-users; fi
    egress_rc=0
    bash "$here/egress-firewall.sh" apply $egress_flags || egress_rc=$?
    case "$egress_rc" in
      0) ;;
      3) echo "the egress rule is loaded, with $user in it, but its check failed: fix its FAIL lines above (they may be another instance's), then run install again" >&2; exit 1 ;;
      *) echo "the egress rule didn't load (egress-firewall.sh apply exited $egress_rc); fix that, then run install again" >&2; exit 1 ;;
    esac
  fi

  say "sudoers: $coord may run $helper $name ..., nothing else"
  install_sudoers "worklane-test-$name" "$(sudoers_rule)"

  say "check everything"
  check_cmd || { echo "fix the FAIL lines, then run install again; test runs refuse to start until check passes" >&2; exit 1; }
  echo
  echo "test user: $user; check: sudo bash $0 check $name"
}

remove_cmd() {
  say "the sudoers rule, Docker, the state, the ACLs and the user"
  remove_sudoers "worklane-test-$name"
  systemctl disable --now "$docker_unit_name" 2>/dev/null || true
  rm -f "/etc/systemd/system/$docker_unit_name"
  for p in "${deny_acl[@]}"; do [ -e "$p" ] && setfacl -x "u:$user" "$p" 2>/dev/null || true; done
  # Its entry in the wrapper's ACL too, before its uid is gone (a later user given that uid gets no entry).
  if [ -f "$userns_bin" ]; then setfacl -x "u:$user" "$userns_bin" 2>/dev/null || true; fi
  rm -rf --one-file-system "$root"
  if id -u "$user" >/dev/null 2>&1; then userdel -r "$user" 2>/dev/null || userdel "$user"; fi
  if [ -z "$(ls -A /var/lib/worklane-test 2>/dev/null)" ]; then
    echo "no other test users here: removing the shared parts too"
    rm -f /etc/systemd/system/worklane-test.slice "$helper" "$userns_bin"
    if [ -f /etc/apparmor.d/worklane-test-rootlesskit ]; then apparmor_parser -R /etc/apparmor.d/worklane-test-rootlesskit 2>/dev/null || true; rm -f /etc/apparmor.d/worklane-test-rootlesskit; fi
    if [ -f "/etc/apparmor.d/$userns_profile" ]; then apparmor_parser -R "/etc/apparmor.d/$userns_profile" 2>/dev/null || true; rm -f "/etc/apparmor.d/$userns_profile"; fi
    rm -rf /opt/worklane-test /var/lib/worklane-test
  fi
  systemctl daemon-reload
  echo "removed. Packages installed for it (uidmap, slirp4netns, acl, ...) stay."
}

case "$cmd" in
  install) install_cmd ;;
  check) check_cmd standalone ;;
  remove) remove_cmd ;;
  update-helper) update_helper_cmd ;;
esac
