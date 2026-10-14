#!/usr/bin/env bash
# Once per repo, as root (review it first): self-hosted GitHub Actions runners for one repo on this machine,
# beside the worklane instances and below them, for trusted jobs only. docs/ci-runners.md has the why of each choice.
#
#   sudo bash scripts/setup/ci-runner.sh install <owner/repo> <count> [options]     asks for the registration token
#   sudo bash scripts/setup/ci-runner.sh check <owner/repo> [--name <name>]
#   sudo bash scripts/setup/ci-runner.sh remove <owner/repo> [--name <name>]        asks for a removal token (optional)
#   bash scripts/setup/ci-runner.sh --print install <owner/repo> <count> [options]  (changes nothing)
#
# The token: install asks for it at the terminal, input hidden, or reads it from a pipe. It is used once, never
# stored, printed, logged or put on a command line, and isn't needed again once the runners are registered.
#
# What install does:
#   - A runner user, wl-ci-<name>: its own group only, no sudo, no login shell, and no access to the engine
#     (/opt/worklane), the checkouts (/srv/worklane), /var/lib/worklane, /etc/worklane (each denied to it by an
#     ACL entry), any other wl-* home (instance homes hold App keys and credentials) or /root. Checked as that user,
#     path by path, before anything is registered and again after the runners start; any failure stops there.
#   - Trusted jobs only. The job-started hook (ci-runner/job-hook.sh) fails every job before its first step unless
#     it is this repo's, from a push, a dispatch or a schedule on <branch>, with the workflow file read from
#     <branch>: never a pull request (a fork's or a branch's), never a branch's own copy of a workflow.
#   - Its network: a firewall table for the runner user's uid (nftables, loaded by its own unit; the runners and
#     their Docker are bound to it, so neither runs without it). Public addresses only: nothing on this machine's
#     loopback (the instances' dashboards and test databases) but the DNS stub, nothing on the LAN, link-local,
#     multicast or Tailscale (its interface and addresses). The machine's upstream DNS servers stay reachable on
#     port 53, for rootless Docker's own lookups.
#   - The pinned runner release (sha256-checked) in /opt/worklane-ci, root-owned. Each runner takes exactly one job
#     per start (run.sh --once); before every start, as root, its containers are removed and its runner directory,
#     workspace and home are made new (ci-runner/reset.sh), as an ephemeral runner gets. The registration itself is
#     kept (root-only), so no credential that can register runners is ever stored on this machine. Auto-update is
#     off; versions change only here.
#   - Rootless Docker for docker build and docker run (pinned static release, sha256-checked): one daemon per
#     runner, as the runner user, so no root daemon and no docker group.
#   - The machine-wide full-run lock, taken shared by every job but the ones named in --no-lock-jobs, from job
#     start to job end, never while idle: CI waits while an agent's full run (exclusive) goes, and the reverse.
#   - worklane-ci.slice: hard caps (CPUQuota over AllowedCPUs, MemoryMax, no swap) and a CPU and IO weight below
#     worklane.slice's, so the instances always win under contention.
#   - Each runner is sandboxed by its unit: read-only system, no /home except its own (as /home/runner, the path
#     GitHub's runners use), the worklane paths inaccessible, other users' processes invisible, no devices, a
#     private /tmp, no capabilities.
#
# options (defaults in brackets):
#   --name <name>             [the repo's name]  the runner user is wl-ci-<name>; units and paths use it
#   --label <a,b>             [<name>]  the runner's labels, beside self-hosted, Linux and X64 (e.g. a name for this machine);
#                             workflows select it with runs-on: [self-hosted, <label>]
#   --branch <branch>         [main]  the only branch whose pushes, dispatches and schedules it runs
#   --no-lock-jobs <a,b>      [none]  job ids (GITHUB_JOB) that don't take the lock, e.g. a verdict-only job
#   --lock <path>             [/run/lock/worklane-full-run.lock]  root-owned, made at boot by the project
#   --lock-wait-min <N>       [45]  then the job fails rather than run unlocked
#   --cpus <list>             [the last 4 CPUs]  AllowedCPUs for all CI (e.g. 12-15); CPUQuota follows it
#   --memory-max <size>       [5G]  for all CI together, containers included
#   --cpu-weight <1-10000>    [10]  must stay below worklane.slice's (20 by default)
#   --io-weight <1-10000>     [10]
#   --deny-interface <a,b>    [tailscale0]  interfaces the runner user may not send on
# To undo: remove (above), which deregisters the runners (with a removal token; without one, delete them in the
# repo's Settings > Actions > Runners), and removes the units, the firewall table, the user, its files and the ACLs.
source "$(dirname "$0")/lib.sh"
all_args=("$@")
here="$(cd "$(dirname "$0")" && pwd)"
files_dir="$here/ci-runner"

# Pins: change a version only together with its sha256s.
#   runner  https://github.com/actions/runner/releases/tag/v2.338.0 (the sha256 the release notes publish, which
#           matches GitHub's asset digest)
#   docker  https://download.docker.com/linux/static/stable/x86_64/ (Docker publishes no checksum file for the
#           static builds: these are the sha256 of the files as downloaded over https on 2026-10-12, the same
#           release and sums scripts/setup/test-user.sh pins)
runner_version=2.338.0
runner_sha256_x64=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32
docker_version=29.8.2
docker_sha256_x64=995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f
docker_rootless_sha256_x64=707ebf6a5afd88104086e7b6749997b2366e816aeaf2c3ef2305b08fde9ee007

usage="usage: ci-runner.sh [--print] install <owner/repo> <count> [options] | check <owner/repo> [--name <name>] | remove <owner/repo> [--name <name>]"
print="" name="" label="" branch=main lock=/run/lock/worklane-full-run.lock wait_min=45 no_lock="" cpus="" memory_max=5G cpu_weight=10 io_weight=10 deny_if=tailscale0
pos=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print=1; shift ;;
    --name) name="${2:?--name needs a value}"; shift 2 ;;
    --label) label="${2:?--label needs a value}"; shift 2 ;;
    --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
    --no-lock-jobs) no_lock="${2?--no-lock-jobs needs a value}"; shift 2 ;;
    --lock) lock="${2:?--lock needs a path}"; shift 2 ;;
    --lock-wait-min) wait_min="${2:?--lock-wait-min needs minutes}"; shift 2 ;;
    --cpus) cpus="${2:?--cpus needs a CPU list}"; shift 2 ;;
    --memory-max) memory_max="${2:?--memory-max needs a size}"; shift 2 ;;
    --cpu-weight) cpu_weight="${2:?--cpu-weight needs a weight}"; shift 2 ;;
    --io-weight) io_weight="${2:?--io-weight needs a weight}"; shift 2 ;;
    --deny-interface) deny_if="${2?--deny-interface needs a value}"; shift 2 ;;
    -*) echo "unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
cmd="${pos[0]:-}" repo="${pos[1]:-}" count="${pos[2]:-}"
case "$cmd" in
  install) [ "${#pos[@]}" -eq 3 ] || { echo "$usage" >&2; exit 2; } ;;
  check | remove) [ "${#pos[@]}" -eq 2 ] && [ -z "$print" ] || { echo "$usage" >&2; exit 2; } ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "the repo is owner/name, got $repo" >&2; exit 2; }
[ -n "$name" ] || name="$(printf '%s' "${repo#*/}" | tr 'A-Z_.' 'a-z--')"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "--name: lowercase letters, digits and dashes, at most 21 (the repo's name doesn't fit: give one)" >&2; exit 2; }
[ -n "$label" ] || label="$name"
[[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}(,[A-Za-z0-9][A-Za-z0-9_.-]{0,40}){0,4}$ ]] || { echo "--label: up to 5 comma-separated labels of letters, digits, dots, dashes and underscores" >&2; exit 2; }
[[ ",$label," != *,self-hosted,* ]] || { echo "--label: self-hosted is every runner's own label already; give this machine's own label instead" >&2; exit 2; }
[[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$ && "$branch" != *..* ]] || { echo "--branch: a branch name, got $branch" >&2; exit 2; }
if [ "$cmd" = install ]; then
  [[ "$count" =~ ^[1-9]$ ]] || { echo "count: 1 to 9 runners, got $count" >&2; exit 2; }
fi
no_lock="${no_lock//,/ }"
for j in $no_lock; do [[ "$j" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "--no-lock-jobs: job ids (letters, digits, - and _), got $j" >&2; exit 2; }; done
deny_if="${deny_if//,/ }"
for j in $deny_if; do [[ "$j" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || { echo "--deny-interface: interface names, got $j" >&2; exit 2; }; done
[[ "$lock" =~ ^/[A-Za-z0-9/._-]+$ ]] || { echo "--lock: an absolute path" >&2; exit 2; }
[[ "$wait_min" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "--lock-wait-min: minutes, got $wait_min" >&2; exit 2; }
[[ "$memory_max" =~ ^[1-9][0-9]*[KMGT]$ ]] || { echo "--memory-max: a size such as 5G, got $memory_max" >&2; exit 2; }
for w in "$cpu_weight" "$io_weight"; do [[ "$w" =~ ^[0-9]+$ ]] && [ "$w" -ge 1 ] && [ "$w" -le 10000 ] || { echo "weights are 1 to 10000, got $w" >&2; exit 2; }; done
if [ -z "$cpus" ]; then n="$(getconf _NPROCESSORS_ONLN)"; if [ "$n" -gt 4 ]; then cpus="$((n - 4))-$((n - 1))"; else cpus="0-$((n - 1))"; fi; fi
# The CPUs in a list like 0-3,8,10-11: CPUQuota is that many cores, so the cap and what the jobs see agree
# (Node's availableParallelism() counts the CPUs a process may run on, not a quota).
ncpus=0
IFS=, read -ra parts <<<"$cpus"
for part in "${parts[@]}"; do
  if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ]; then ncpus=$((ncpus + BASH_REMATCH[2] - BASH_REMATCH[1] + 1))
  elif [[ "$part" =~ ^[0-9]+$ ]]; then ncpus=$((ncpus + 1))
  else echo "--cpus: a CPU list such as 12-15 or 0,2,4-5, got $cpus" >&2; exit 2; fi
done

user="wl-ci-$name"
root="/var/lib/worklane-ci/$name"
libexec=/usr/local/libexec/worklane-ci
runner_dir="/opt/worklane-ci/actions-runner-$runner_version"
docker_dir="/opt/worklane-ci/docker-$docker_version"
docker_unit_name="worklane-ci-$name-docker@.service"
reset_unit_name="worklane-ci-$name-reset@.service"
runner_unit_name="worklane-ci-$name@.service"
fw_unit_name="worklane-ci-$name-firewall.service"
fw_table="worklane_ci_${name//-/_}"
fw_file="/etc/worklane-ci/$name.nft"
hosted_home=/home/runner
deny_acl=(/srv/worklane /opt/worklane /var/lib/worklane /etc/worklane)
# What the runner user may not reach: v4 and v6 loopback, private, shared (CGNAT, Tailscale's), link-local, multicast.
deny_v4="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4"
deny_v6="::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8"

# The machine's upstream DNS servers (systemd-resolved's list, else resolv.conf's), loopback ones and Tailscale's
# (100.64.0.0/10, fd7a:115c:a1e0::/48: no Tailscale, not even its resolver) left out.
upstream_dns() {
  local f=/run/systemd/resolve/resolv.conf
  [ -r "$f" ] || f=/etc/resolv.conf
  sed -n 's/^nameserver[[:space:]]\{1,\}\([0-9A-Fa-f.:]\{2,\}\)[[:space:]]*$/\1/p' "$f" 2>/dev/null \
    | grep -viE '^(127\.|::1$|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|fd7a:115c:a1e0:)' | sort -u || true
}

slice() {
  cat <<EOF
[Unit]
Description=worklane CI runners: hard CPU and memory caps, weights below worklane.slice

[Slice]
CPUWeight=$cpu_weight
IOWeight=$io_weight
AllowedCPUs=$cpus
CPUQuota=$((ncpus * 100))%
MemoryMax=$memory_max
MemorySwapMax=0
TasksMax=4096
EOF
}

# The firewall for the runner user's uid (<uid>: its number, known once the user exists). Packets without a socket
# owner (the kernel's own) never match the jump, so nothing else on the machine is touched. Reject, not drop: a
# connection refused here fails at once ("No route to host"), where a dropped one would hang until it timed out.
firewall_rules() {
  local uid="$1" v4=() v6=() a
  while IFS= read -r a; do [ -n "$a" ] || continue; if [[ "$a" == *:* ]]; then v6+=("$a"); else v4+=("$a"); fi; done < <(upstream_dns)
  echo "# The CI runner user $user (uid $uid): public addresses only. Written by scripts/setup/ci-runner.sh."
  echo "table inet $fw_table"
  echo "delete table inet $fw_table"
  echo "table inet $fw_table {"
  echo "  chain output {"
  echo "    type filter hook output priority filter; policy accept;"
  echo "    meta skuid $uid jump ci"
  echo "  }"
  echo "  chain ci {"
  echo "    ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept comment \"the DNS stub\""
  if [ "${#v4[@]}" -gt 0 ]; then echo "    ip daddr { $(IFS=,; echo "${v4[*]}" | sed 's/,/, /g') } meta l4proto { tcp, udp } th dport 53 accept comment \"upstream DNS\""; fi
  if [ "${#v6[@]}" -gt 0 ]; then echo "    ip6 daddr { $(IFS=,; echo "${v6[*]}" | sed 's/,/, /g') } meta l4proto { tcp, udp } th dport 53 accept comment \"upstream DNS\""; fi
  echo "    oifname \"lo\" counter reject with icmpx admin-prohibited comment \"this machine's own services\""
  for a in $deny_if; do echo "    oifname \"$a\" counter reject with icmpx admin-prohibited"; done
  echo "    ip daddr { $deny_v4 } counter reject with icmpx admin-prohibited"
  echo "    ip6 daddr { $deny_v6 } counter reject with icmpx admin-prohibited"
  echo "  }"
  echo "}"
}

firewall_unit() {
  cat <<EOF
[Unit]
Description=firewall for the CI runner user $user: public addresses only (the runners and their Docker are bound to it)
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $fw_file
ExecStop=/usr/sbin/nft delete table inet $fw_table

[Install]
WantedBy=multi-user.target
EOF
}

docker_unit() {
  cat <<EOF
[Unit]
Description=rootless Docker for CI runner %i of $repo, as $user (no root daemon, no docker group)
Wants=network-online.target
After=network-online.target $fw_unit_name
BindsTo=$fw_unit_name

[Service]
Type=simple
User=$user
Group=$user
Slice=worklane-ci.slice
Environment=HOME=$root/%i/docker-home
Environment=XDG_RUNTIME_DIR=/run/worklane-ci-$name-docker-%i
# /usr/sbin and /sbin: dockerd-rootless.sh runs sysctl (and iptables) from there.
Environment=PATH=$docker_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=builtin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true
RuntimeDirectory=worklane-ci-$name-docker-%i
RuntimeDirectoryMode=0700
UMask=0077
# Containers' cgroups: Docker's default systemd driver needs a systemd user session, which the runner user doesn't
# have. With cgroupfs each container gets a cgroup of its own beside the daemon's, in this unit's delegated subtree,
# under worklane-ci.slice's caps.
Delegate=cpu io memory pids
DelegateSubgroup=daemon
ExecStart=$docker_dir/dockerd-rootless.sh --data-root $root/%i/docker --ip 127.0.0.1 --exec-opt native.cgroupdriver=cgroupfs
KillMode=mixed
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

# The reset, as root, before every start of runner %i: a unit of its own, with no sandbox, so it works on the real
# directories (in the runner's own unit, even a "+" command sees the runner's read-only binds). The runner Requires=
# it, so each start of the runner, the automatic ones after each job included, starts it again first.
reset_unit() {
  cat <<EOF
[Unit]
Description=reset CI runner %i of $repo before its next job: no containers, a new runner directory, workspace and home
Requires=worklane-ci-$name-docker@%i.service
After=worklane-ci-$name-docker@%i.service

[Service]
Type=oneshot
ExecStart=$libexec/reset $name %i
TimeoutStartSec=300
EOF
}

runner_unit() {
  cat <<EOF
[Unit]
Description=GitHub Actions runner %i for $repo, as $user: one job per start, then a new runner, workspace and home
Wants=network-online.target
Requires=worklane-ci-$name-docker@%i.service worklane-ci-$name-reset@%i.service
After=network-online.target $fw_unit_name worklane-ci-$name-docker@%i.service worklane-ci-$name-reset@%i.service
BindsTo=$fw_unit_name

[Service]
Type=simple
User=$user
Group=$user
Slice=worklane-ci.slice
WorkingDirectory=$root/%i/runner
Environment=HOME=$hosted_home
Environment=XDG_CONFIG_HOME=$hosted_home/.config
Environment=PATH=$docker_dir:/usr/local/bin:/usr/bin:/bin
Environment=DOCKER_HOST=unix:///run/worklane-ci-$name-docker-%i/docker.sock
Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=$libexec/job-started.sh
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$libexec/job-completed.sh
Environment=WORKLANE_CI_REPO=$repo
Environment=WORKLANE_CI_BRANCH=$branch
Environment=WORKLANE_CI_LOCK=$lock
Environment=WORKLANE_CI_LOCK_WAIT_MIN=$wait_min
Environment="WORKLANE_CI_NO_LOCK_JOBS=$no_lock"
Environment=WORKLANE_CI_STATE=/run/worklane-ci-$name-%i
RuntimeDirectory=worklane-ci-$name-%i
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=/bin/bash $root/%i/runner/run.sh --once
# One job, then exit: start again (after worklane-ci-$name-reset@%i, as root) for the next.
Restart=always
RestartSec=10
TimeoutStartSec=300
# The job's processes, and the lock holder, go with it.
KillMode=control-group
TimeoutStopSec=60
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=$root/%i/runner $root/%i/work -/run/worklane-ci-$name-docker-%i
BindReadOnlyPaths=$runner_dir/bin:$root/%i/runner/bin $runner_dir/externals:$root/%i/runner/externals
ProtectHome=tmpfs
BindPaths=$root/%i/home:$hosted_home
InaccessiblePaths=-/srv/worklane -/opt/worklane -/var/lib/worklane -/etc/worklane -/var/lib/worklane-test -$root/reg-%i
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF
}

apparmor_profile() {
  cat <<EOF
abi <abi/4.0>,
include <tunables/global>

# Lets only the CI runners' pinned rootlesskit create user namespaces (rootless Docker); the restriction stays on.
profile worklane-ci-rootlesskit $docker_dir/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/worklane-ci-rootlesskit>
}
EOF
}

# What config.sh is run with, as $user, for runner <i>. The token is not an argument: it reaches config.sh only in
# ACTIONS_RUNNER_INPUT_TOKEN, set inside the user's own shell from a pipe.
config_args() {
  printf '%s\n' --unattended --url "https://github.com/$repo" --name "$(hostname -s)-$name-$1" --labels "$label" \
    --work "$root/$1/work" --disableupdate --replace
}

if [ -n "$print" ]; then
  echo "# /etc/systemd/system/worklane-ci.slice"; slice; echo
  echo "# $fw_file (uid: the runner user's, once it exists)"; firewall_rules '<uid>'; echo
  echo "# /etc/systemd/system/$fw_unit_name"; firewall_unit; echo
  echo "# /etc/systemd/system/$docker_unit_name"; docker_unit; echo
  echo "# /etc/systemd/system/$reset_unit_name"; reset_unit; echo
  echo "# /etc/systemd/system/$runner_unit_name   (instances 1..$count)"; runner_unit; echo
  echo "# $libexec/job-started.sh and job-completed.sh (scripts/setup/ci-runner/job-hook.sh)"; cat "$files_dir/job-hook.sh"; echo
  echo "# $libexec/reset (scripts/setup/ci-runner/reset.sh)"; cat "$files_dir/reset.sh"; echo
  echo "# /etc/apparmor.d/worklane-ci-rootlesskit (only where user namespaces are restricted)"; apparmor_profile; echo
  for i in $(seq 1 "$count"); do
    echo "# runner $i registers as $user with: config.sh $(config_args "$i" | tr '\n' ' ')(the registration token you paste, in ACTIONS_RUNNER_INPUT_TOKEN)"
  done
  exit 0
fi
as_root "${all_args[@]}"
# Set here, never inherited: useradd, usermod, setfacl, sysctl, nft and visudo are in /usr/sbin or /sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Write each unit to a dotted temp name, validate it (a template as an instance of itself), then move it into place.
# put_changed=1 when its content differs from what was there.
put_changed=0
put() {
  local file="$1" tmp="/etc/systemd/system/.$1.tmp" check
  "$2" > "$tmp"; chmod 0644 "$tmp"
  if cmp -s "$tmp" "/etc/systemd/system/$file"; then put_changed=0; else put_changed=1; fi
  check="$(mktemp -d)/${file/@./@1.}"; cp "$tmp" "$check"
  if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "$file invalid; nothing installed" >&2; exit 1; fi
  rm -f "$check"
  mv -f "$tmp" "/etc/systemd/system/$file"
  echo "installed /etc/systemd/system/$file"
}

# A root-owned script from scripts/setup/ci-runner, checked to parse before it is moved into place.
put_script() {
  local src="$files_dir/$1" dest="$2" tmp
  tmp="$(dirname "$dest")/.$(basename "$dest").tmp"
  install -o root -g root -m 0755 "$src" "$tmp"
  bash -n "$tmp" || { rm -f "$tmp"; echo "$src doesn't parse; nothing installed" >&2; exit 1; }
  mv -f "$tmp" "$dest"
  echo "installed $dest"
}

# Every path the runner user must not reach: worklane's own, every other wl-* user's home, root's, sudoers.
protected_paths() {
  local u h
  printf '%s\n' "${deny_acl[@]}" /var/lib/worklane-test /etc/sudoers.d /root /run/docker.sock /var/run/docker.sock
  while IFS=: read -r u _ _ _ _ h _; do
    [[ "$u" == wl-* && "$u" != "$user" && -n "$h" && "$h" != / ]] && printf '%s\n' "$h"
  done < <(getent passwd)
}

# The docker CLI as the runner user, against runner <i>'s own rootless daemon.
docker_as_user() {
  local i="$1"; shift
  run_as "$user" 'export DOCKER_HOST="unix://$1" HOME="$2"; shift 2; exec "$@"' "/run/worklane-ci-$name-docker-$i/docker.sock" "$root/$i/docker-home" "$docker_dir/docker" "$@"
}

# One connection attempt as the runner user, to <host> <port>: prints what happened (connected, or the error).
probe_as_user() {
  run_as "$user" 'if out="$(timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1)"; then echo connected; elif [ -z "$out" ]; then echo "timed out"; else echo "$out"; fi' "$1" "$2" 2>&1 | tail -n 1
}

# The boundaries, as the runner user. Prints PASS/FAIL per check; non-zero if any failed.
access_checks() {
  local fail=0 groups members paths
  groups="$(id -nG "$user" 2>/dev/null || true)"
  if [ "$groups" = "$user" ]; then echo "PASS $user is in its own group only"; else echo "FAIL $user's groups: ${groups:-none (no such user?)}"; fail=1; fi
  members="$(getent group "$user" | cut -d: -f4)"
  if [ -z "$members" ]; then echo "PASS no other user is in group $user"; else echo "FAIL group $user has members: $members"; fail=1; fi
  if sudo -n -l -U "$user" 2>&1 | grep -q 'is not allowed to run sudo'; then echo "PASS $user may not run sudo"; else echo "FAIL $user has sudo rules (sudo -l -U $user)"; fail=1; fi
  mapfile -t paths < <(protected_paths)
  deny_check "$user" "${paths[@]}" || fail=1
  if [ -e "$lock" ] && [ "$(stat -c '%u %a' "$lock")" = "0 644" ] && (cd / && sudo -n -u "$user" sh -c 'exec 9<"$1"' _ "$lock"); then
    echo "PASS $lock is root-owned 0644 and $user can open it to lock"
  else
    echo "FAIL $lock must exist, root-owned 0644, openable by $user (set the machine's locks up first)"; fail=1
  fi
  return "$fail"
}

# The firewall, as the runner user: refused at once where it must be, through where it may go.
network_checks() {
  local fail=0 target out want
  if systemctl is-active -q "$fw_unit_name" && nft list table inet "$fw_table" >/dev/null 2>&1; then echo "PASS $fw_unit_name is active (table inet $fw_table)"; else echo "FAIL $fw_unit_name or table inet $fw_table is missing (journalctl -u $fw_unit_name)"; fail=1; fi
  if cmp -s <(firewall_rules "$(id -u "$user")") "$fw_file"; then echo "PASS $fw_file is current (this user's uid, today's upstream DNS)"; else echo "FAIL $fw_file is stale (the uid or the upstream DNS servers changed): run install again"; fail=1; fi
  # Loopback (a port nobody needs to listen on), a private address, a Tailscale address.
  for target in "127.0.0.1 9" "10.255.255.1 9" "100.100.100.100 80"; do
    out="$(probe_as_user ${target})"
    if [[ "$out" == *"No route to host"* || "$out" == *"Permission denied"* ]]; then echo "PASS $user is refused $target (${out##*: })"; else echo "FAIL $user reached, or wasn't refused, $target: $out"; fail=1; fi
  done
  want="github.com 443"
  out="$(probe_as_user ${want})"
  if [ "$out" = connected ]; then echo "PASS $user reaches $want"; else echo "FAIL $user can't reach $want: $out"; fail=1; fi
  return "$fail"
}

# Everything else check reports: the caps against the instances', the units, rootless Docker, the pinned version.
service_checks() {
  local fail=0 ci_mem ci_w wl_w u m i reg st
  ci_mem="$(systemctl show worklane-ci.slice -p MemoryMax --value)"
  ci_w="$(systemctl show worklane-ci.slice -p CPUWeight --value)"
  if [[ "$ci_mem" =~ ^[0-9]+$ ]]; then echo "PASS worklane-ci.slice MemoryMax=$ci_mem"; else echo "FAIL worklane-ci.slice has no memory cap ($ci_mem)"; fail=1; fi
  for u in $(systemctl list-units --type=service --all --plain --no-legend 'worklane-*.service' | awk '{print $1}'); do
    [[ "$u" == worklane-ci-* || "$u" == worklane-test-* || "$u" == worklane-dashboard* ]] && continue
    m="$(systemctl show "$u" -p MemoryMax --value)"
    [[ "$m" =~ ^[0-9]+$ && "$ci_mem" =~ ^[0-9]+$ ]] || continue
    if [ "$ci_mem" -lt "$m" ]; then echo "PASS CI's memory cap is below $u's ($m)"; else echo "FAIL CI's memory cap ($ci_mem) is not below $u's ($m)"; fail=1; fi
  done
  wl_w="$(systemctl show worklane.slice -p CPUWeight --value 2>/dev/null || true)"
  if [[ "$wl_w" =~ ^[0-9]+$ ]]; then
    if [[ "$ci_w" =~ ^[0-9]+$ ]] && [ "$ci_w" -lt "$wl_w" ]; then echo "PASS CI's CPU weight ($ci_w) is below worklane.slice's ($wl_w)"; else echo "FAIL CI's CPU weight ($ci_w) is not below worklane.slice's ($wl_w)"; fail=1; fi
  fi
  if [ "$(run_as "$user" '"$1" --version' "$runner_dir/bin/Runner.Listener" 2>/dev/null)" = "$runner_version" ]; then echo "PASS runner $runner_version"; else echo "FAIL the runner in $runner_dir is not $runner_version"; fail=1; fi
  for reg in "$root"/reg-*; do
    [ -d "$reg" ] || continue
    i="${reg##*/reg-}"
    u="worklane-ci-$name-docker@$i.service"
    if systemctl is-active -q "$u"; then echo "PASS $u is active"; else echo "FAIL $u is not active (journalctl -u $u)"; fail=1; fi
    # Between two jobs the runner is briefly starting again (auto-restart, then its reset): up, not failed.
    u="worklane-ci-$name@$i.service"
    st="$(systemctl show "$u" -p ActiveState --value)/$(systemctl show "$u" -p SubState --value)"
    case "$st" in
      active/*) echo "PASS $u is active" ;;
      activating/auto-restart | activating/start | activating/start-pre) echo "PASS $u is starting its next run ($st)" ;;
      *) echo "FAIL $u is $st (journalctl -u $u -u worklane-ci-$name-reset@$i.service)"; fail=1 ;;
    esac
    if docker_as_user "$i" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then echo "PASS runner $i's Docker is rootless, as $user"; else echo "FAIL runner $i's Docker isn't up or isn't rootless"; fail=1; fi
  done
  return "$fail"
}

check_cmd() {
  local fail=0
  id -u "$user" >/dev/null 2>&1 || { echo "FAIL no user $user; run install first"; exit 1; }
  say "boundaries, as $user"
  access_checks || fail=1
  say "network, as $user"
  network_checks || fail=1
  say "caps, services, Docker"
  service_checks || fail=1
  [ "$fail" -eq 0 ] && echo "OK: all checks passed" || echo "FAILED: see the FAIL lines above" >&2
  return "$fail"
}

stop_all() {
  local reg i
  for reg in "$root"/reg-*; do
    [ -d "$reg" ] || continue
    i="${reg##*/reg-}"
    systemctl disable --now "worklane-ci-$name@$i.service" "worklane-ci-$name-docker@$i.service" 2>/dev/null || true
    systemctl reset-failed "worklane-ci-$name@$i.service" "worklane-ci-$name-reset@$i.service" "worklane-ci-$name-docker@$i.service" 2>/dev/null || true
  done
}

# The token: hidden at a terminal, else one line from the pipe. Into the variable named $1, checked; never printed.
read_token() {
  local what="$1" t=""
  if [ -t 0 ]; then
    IFS= read -r -s -p "paste the $what token (input hidden), then Enter: " t || true
    echo >&2
  else
    IFS= read -r t || true
  fi
  t="${t//[[:space:]]/}"
  [[ "$t" =~ ^[A-Za-z0-9_-]{20,200}$ ]] || return 1
  printf -v token '%s' "$t"
}

install_cmd() {
  local i n s missing=()
  [ "$(uname -m)" = x86_64 ] || { echo "the pins here are x86_64 builds; this is $(uname -m)" >&2; exit 1; }
  command -v apt-get >/dev/null && command -v systemctl >/dev/null || { echo "this script is for Ubuntu with systemd" >&2; exit 1; }
  [ -e "$lock" ] && [ "$(stat -c %u "$lock")" = 0 ] || { echo "no root-owned $lock: set the machine's locks up first (the project's machine script)" >&2; exit 1; }
  for i in $(seq 1 "$count"); do [ -f "$root/reg-$i/.runner" ] || missing+=("$i"); done
  token=""
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "runner(s) ${missing[*]} need registering: a registration token from the repo's Settings > Actions > Runners > New self-hosted runner,"
    echo "or: gh api -X POST repos/$repo/actions/runners/registration-token --jq .token   (valid one hour)"
    read_token registration || { token=""; echo "that isn't a runner registration token; nothing installed" >&2; exit 1; }
  fi

  say "packages from the distribution: rootless Docker's helpers, nftables, the runner's libraries, zstd (actions/cache), acl"
  apt-get update -q
  icu="$(apt-cache pkgnames libicu | grep -xE 'libicu[0-9]+' | sort -V | tail -1)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
    uidmap slirp4netns iptables nftables zstd acl git curl ca-certificates tar libkrb5-3 zlib1g ${icu:+"$icu"}

  say "the runner user $user: its own group only, no sudo, no login shell"
  ensure_user "$user"
  usermod -s /usr/sbin/nologin "$user"
  # Subordinate ids for rootless Docker (useradd usually allocates them).
  if ! grep -q "^$user:" /etc/subuid || ! grep -q "^$user:" /etc/subgid; then
    s="$(cat /etc/subuid /etc/subgid 2>/dev/null | awk -F: 'BEGIN { m = 100000 } { e = $2 + $3; if (e > m) m = e } END { print m }')"
    usermod --add-subuids "$s-$((s + 65535))" --add-subgids "$s-$((s + 65535))" "$user"
  fi
  for p in "${deny_acl[@]}"; do [ -e "$p" ] && setfacl -m "u:$user:---" "$p" && echo "denied $p to $user (ACL)"; done
  say "check the boundaries as $user before anything is registered"
  access_checks || { echo "refusing to go on: fix the FAIL lines above (nothing is registered)" >&2; exit 1; }

  say "the firewall for $user (uid $(id -u "$user")): public addresses only"
  install -d -o root -g root -m 0755 /etc/worklane-ci
  firewall_rules "$(id -u "$user")" > "/etc/worklane-ci/.$name.nft.tmp"
  nft -c -f "/etc/worklane-ci/.$name.nft.tmp" || { rm -f "/etc/worklane-ci/.$name.nft.tmp"; echo "the firewall rules don't load; nothing installed" >&2; exit 1; }
  chmod 0644 "/etc/worklane-ci/.$name.nft.tmp"
  fw_changed=0; cmp -s "/etc/worklane-ci/.$name.nft.tmp" "$fw_file" || fw_changed=1
  mv -f "/etc/worklane-ci/.$name.nft.tmp" "$fw_file"
  put "$fw_unit_name" firewall_unit
  [ "$put_changed" = 0 ] || fw_changed=1
  systemctl daemon-reload
  systemctl enable "$fw_unit_name"
  # Loaded again only when it changed: the runners are bound to it, so a restart stops them (install starts them).
  if [ "$fw_changed" = 1 ] || ! systemctl is-active -q "$fw_unit_name"; then systemctl restart "$fw_unit_name"; else echo "$fw_unit_name is current"; fi
  nft list table inet "$fw_table" >/dev/null || { echo "table inet $fw_table didn't load (journalctl -u $fw_unit_name)" >&2; exit 1; }

  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/$3" "$1"; echo "$2  $work/$3" | sha256sum -c -; }
  install -d -o root -g root -m 0755 /opt/worklane-ci "$libexec"

  say "runner $runner_version, sha256-pinned, in $runner_dir"
  if [ -x "$runner_dir/bin/Runner.Listener" ]; then echo "already installed"; else
    fetch "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz" "$runner_sha256_x64" runner.tgz
    rm -rf "$runner_dir.new"; install -d -m 0755 "$runner_dir.new"
    tar -xzf "$work/runner.tgz" -C "$runner_dir.new" --no-same-owner
    chown -R root:root "$runner_dir.new"; chmod -R a+rX,go-w "$runner_dir.new"
    rm -rf "$runner_dir"; mv "$runner_dir.new" "$runner_dir"
  fi
  ln -sfn "$runner_dir" /opt/worklane-ci/actions-runner

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
  ln -sfn "$docker_dir" /opt/worklane-ci/docker
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    say "AppArmor: let only the pinned rootlesskit create user namespaces (the machine-wide restriction stays on)"
    apparmor_profile > /etc/apparmor.d/.worklane-ci-rootlesskit.tmp
    apparmor_parser -Q /etc/apparmor.d/.worklane-ci-rootlesskit.tmp || { rm -f /etc/apparmor.d/.worklane-ci-rootlesskit.tmp; echo "AppArmor profile refused; nothing installed" >&2; exit 1; }
    mv -f /etc/apparmor.d/.worklane-ci-rootlesskit.tmp /etc/apparmor.d/worklane-ci-rootlesskit
    apparmor_parser -r /etc/apparmor.d/worklane-ci-rootlesskit
  fi

  say "the job hooks (trusted jobs only, the lock) and the reset, root-owned in $libexec"
  put_script job-hook.sh "$libexec/job-started.sh"
  put_script job-hook.sh "$libexec/job-completed.sh"
  put_script reset.sh "$libexec/reset"

  say "state in $root: per runner, a root-only registration and the runner user's directories"
  install -d -o root -g root -m 0711 /var/lib/worklane-ci "$root"
  for i in $(seq 1 "$count"); do
    install -d -o root -g root -m 0711 "$root/$i"
    install -d -o root -g root -m 0700 "$root/reg-$i"
    install -d -o "$user" -g "$user" -m 0700 "$root/$i/docker" "$root/$i/docker-home" "$root/$i/runner" "$root/$i/work" "$root/$i/home"
    install -d -o root -g root -m 0755 "$root/$i/runner/bin" "$root/$i/runner/externals"
  done

  say "units: worklane-ci.slice (CPUs $cpus, CPUQuota $((ncpus * 100))%, MemoryMax $memory_max, CPU weight $cpu_weight), $docker_unit_name, $reset_unit_name, $runner_unit_name"
  units_changed=0
  put worklane-ci.slice slice; [ "$put_changed" = 0 ] || units_changed=1
  put "$docker_unit_name" docker_unit; [ "$put_changed" = 0 ] || units_changed=1
  put "$reset_unit_name" reset_unit; [ "$put_changed" = 0 ] || units_changed=1
  put "$runner_unit_name" runner_unit; [ "$put_changed" = 0 ] || units_changed=1
  systemctl daemon-reload

  for i in $(seq 1 "$count"); do
    say "runner $i: its Docker, then the registration"
    systemctl enable --now "worklane-ci-$name-docker@$i.service"
    for _ in $(seq 60); do [ -S "/run/worklane-ci-$name-docker-$i/docker.sock" ] && break; sleep 1; done
    docker_as_user "$i" info --format '{{json .SecurityOptions}}' | grep -q rootless || { echo "runner $i's Docker didn't come up rootless (journalctl -u worklane-ci-$name-docker@$i)" >&2; exit 1; }
    if [ -f "$root/reg-$i/.runner" ]; then echo "runner $i is registered already (remove first to register it again)"; else
      rm -rf "$root/$i/runner"; install -d -o "$user" -g "$user" -m 0700 "$root/$i/runner"
      cp -a "$runner_dir/." "$root/$i/runner/"; chown -R "$user:$user" "$root/$i/runner"
      mapfile -t args < <(config_args "$i")
      printf '%s\n' "$token" | run_as "$user" 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; cd "$1"; shift; ./config.sh "$@"' "$root/$i/runner" "${args[@]}"
      for n in .runner .credentials .credentials_rsaparams; do install -o root -g root -m 0600 "$root/$i/runner/$n" "$root/reg-$i/$n"; done
      rm -rf "$root/$i/runner"
      install -d -o "$user" -g "$user" -m 0700 "$root/$i/runner"; install -d -o root -g root -m 0755 "$root/$i/runner/bin" "$root/$i/runner/externals"
    fi
  done
  token=""; unset token

  # A runner already up on the current units is left alone (it may be in a job); a changed unit restarts them all.
  for i in $(seq 1 "$count"); do
    systemctl enable "worklane-ci-$name@$i.service"
    if [ "$units_changed" = 1 ]; then systemctl restart "worklane-ci-$name-docker@$i.service" "worklane-ci-$name@$i.service"; else systemctl start "worklane-ci-$name@$i.service"; fi
  done
  for _ in $(seq 120); do
    n=0; for i in $(seq 1 "$count"); do systemctl is-active -q "worklane-ci-$name@$i.service" && n=$((n + 1)); done
    [ "$n" -eq "$count" ] && break; sleep 1
  done
  say "check everything; on any failure, stop the runners"
  if ! check_cmd; then stop_all; echo "stopped the runners: fix the FAIL lines, then run install again" >&2; exit 1; fi
  echo
  echo "runners: worklane-ci-$name@1..$count (labels self-hosted, Linux, X64, $label); in GitHub: the repo's Settings > Actions > Runners"
  echo "logs:    journalctl -u 'worklane-ci-$name@*' -f      check: sudo bash $0 check $repo --name $name"
}

remove_cmd() {
  local reg i
  token=""
  if [ -n "$(ls -d "$root"/reg-*/ 2>/dev/null)" ]; then
    echo "to deregister the runners in GitHub too: a removal token (gh api -X POST repos/$repo/actions/runners/remove-token --jq .token);"
    echo "an empty line skips it (then delete them in the repo's Settings > Actions > Runners)"
    read_token removal || token=""
  fi
  say "stop and disable $name's runners and their Docker"
  stop_all
  for reg in "$root"/reg-*; do
    [ -f "$reg/.runner" ] || continue
    i="${reg##*/reg-}"
    if [ -n "$token" ]; then
      say "deregister runner $i"
      rm -rf "$root/$i/runner"; install -d -o "$user" -g "$user" -m 0700 "$root/$i/runner"
      cp -a "$runner_dir/." "$root/$i/runner/"
      for n in .runner .credentials .credentials_rsaparams; do install -m 0600 "$reg/$n" "$root/$i/runner/$n"; done
      chown -R "$user:$user" "$root/$i/runner"
      printf '%s\n' "$token" | run_as "$user" 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; cd "$1"; ./config.sh remove' "$root/$i/runner" \
        || echo "runner $i: not deregistered; delete it in the repo's Settings > Actions > Runners" >&2
    else
      echo "runner $i: not deregistered; delete it in the repo's Settings > Actions > Runners"
    fi
  done
  token=""; unset token
  say "units, the firewall, files, ACLs and the user"
  rm -f "/etc/systemd/system/$runner_unit_name" "/etc/systemd/system/$reset_unit_name" "/etc/systemd/system/$docker_unit_name"
  systemctl disable --now "$fw_unit_name" 2>/dev/null || true
  nft delete table inet "$fw_table" 2>/dev/null || true
  rm -f "/etc/systemd/system/$fw_unit_name" "$fw_file"
  for p in "${deny_acl[@]}"; do [ -e "$p" ] && setfacl -x "u:$user" "$p" 2>/dev/null || true; done
  rm -rf --one-file-system "$root"
  if id -u "$user" >/dev/null 2>&1; then userdel -r "$user" 2>/dev/null || userdel "$user"; fi
  if [ -z "$(ls -A /var/lib/worklane-ci 2>/dev/null)" ]; then
    echo "no other CI runners here: removing the shared parts too"
    rm -f /etc/systemd/system/worklane-ci.slice
    if [ -f /etc/apparmor.d/worklane-ci-rootlesskit ]; then apparmor_parser -R /etc/apparmor.d/worklane-ci-rootlesskit 2>/dev/null || true; rm -f /etc/apparmor.d/worklane-ci-rootlesskit; fi
    rm -rf "$libexec" /opt/worklane-ci /var/lib/worklane-ci
    rmdir /etc/worklane-ci 2>/dev/null || true
  fi
  systemctl daemon-reload
  echo "removed. Packages installed for it (uidmap, slirp4netns, nftables, zstd, acl, ...) stay; the workflows' runs-on is yours to change back."
}

case "$cmd" in
  install) install_cmd ;;
  check) check_cmd ;;
  remove) remove_cmd ;;
esac
