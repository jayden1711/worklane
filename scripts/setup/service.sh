#!/usr/bin/env bash
# Run an instance's coordinator as a system service: a root-owned systemd
# unit that runs it as the instance's coordinator user, starts at boot and
# restarts on failure. Root-owned so the coordinator user can't change its
# own service. Checks the instance first (credentials, repo scope) as that user.
#
# Resource limits, so agents' test runs can't starve other work on the machine
# (simulators, training):
# - All coordinators run in worklane.slice, a top-level slice beside
#   system.slice and user.slice (where rootless containers usually run). Its
#   CPU and IO weights are relative to those: at the default 20 against their
#   100, other work gets most of the CPU and disk under contention, while
#   agents still use whatever is idle. Machine-wide, for all instances.
# - Each instance gets a hard memory cap (MemoryMax, no swap): a runaway test
#   is killed when it reaches it, and the coordinator keeps running. A
#   MemoryHigh below it is optional: over it, the kernel slows the processes
#   instead of killing them, so a runaway stalls until its command times out.
#   Also a task limit, and a CPU weight among the instances. Percentages are of
#   the machine's RAM. Re-running with other values applies them to a running
#   service without restarting it.
# GPU time is not covered: cgroups don't control it.
#
#   bash scripts/setup/service.sh <name> [options]            install, enable and start
#   bash scripts/setup/service.sh <name> [options] --print    print the slice and unit only
# options (defaults in brackets):
#   --memory-max <size|N%>   [35%]    --memory-high <size|N%|infinity> [infinity]
#   --cpu-weight <1-10000>   [100]    (among instances)
#   --tasks-max <N>          [2048]
#   --slice-cpu-weight <1-10000> [20] --slice-io-weight <1-10000> [20]   (all instances)
source "$(dirname "$0")/lib.sh"
all_args=("$@")
name="${1:?usage: service.sh <name> [options] [--print]}"; shift
coord="wl-$name"
unit_name="worklane-$name.service"
memory_high=infinity memory_max=35% cpu_weight=100 tasks_max=2048 slice_cpu=20 slice_io=20 print=
while [ $# -gt 0 ]; do
  case "$1" in
    --memory-high) memory_high="${2:?}"; shift 2 ;;
    --memory-max) memory_max="${2:?}"; shift 2 ;;
    --cpu-weight) cpu_weight="${2:?}"; shift 2 ;;
    --tasks-max) tasks_max="${2:?}"; shift 2 ;;
    --slice-cpu-weight) slice_cpu="${2:?}"; shift 2 ;;
    --slice-io-weight) slice_io="${2:?}"; shift 2 ;;
    --print) print=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
size() { [[ "$2" =~ ^[0-9]+[KMGT]?$|^([1-9][0-9]?|100)%$ ]] || { echo "$1: a size (e.g. 8G) or a percentage of RAM (e.g. 30%), got $2" >&2; exit 2; }; }
weight() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 10000 ] || { echo "$1: a weight from 1 to 10000, got $2" >&2; exit 2; }; }
[ "$memory_high" = infinity ] || size --memory-high "$memory_high"; size --memory-max "$memory_max"
weight --cpu-weight "$cpu_weight"; weight --slice-cpu-weight "$slice_cpu"; weight --slice-io-weight "$slice_io"
# MemoryHigh above MemoryMax would never throttle before the hard cap. Comparable when both are sizes or both percentages.
bytes() { local n="${1%[KMGT%]}"; case "$1" in *K) echo $((n << 10)) ;; *M) echo $((n << 20)) ;; *G) echo $((n << 30)) ;; *T) echo $((n << 40)) ;; *) echo "$n" ;; esac; }
if [ "$memory_high" = infinity ]; then :
elif [ "${memory_high: -1}" = % ] && [ "${memory_max: -1}" = % ] || { [ "${memory_high: -1}" != % ] && [ "${memory_max: -1}" != % ]; }; then
  [ "$(bytes "$memory_high")" -le "$(bytes "$memory_max")" ] || { echo "--memory-high ($memory_high) must not exceed --memory-max ($memory_max)" >&2; exit 2; }
fi
[[ "$tasks_max" =~ ^[1-9][0-9]*$ ]] || { echo "--tasks-max: a positive number, got $tasks_max" >&2; exit 2; }

slice() {
  cat <<EOF
[Unit]
Description=worklane coordinators and their agents (weights relative to system.slice and user.slice)

[Slice]
CPUWeight=$slice_cpu
IOWeight=$slice_io
EOF
}

unit() {
  cat <<EOF
[Unit]
Description=worklane coordinator for instance $name
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$coord
Group=$coord
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane coordinator run --instance $name
Restart=on-failure
RestartSec=30
# Nothing the coordinator writes is for users outside its group (the process also sets this itself).
UMask=0007
Slice=worklane.slice
MemoryHigh=$memory_high
MemoryMax=$memory_max
# No swap: a runaway test would otherwise thrash the disk under MemoryHigh instead of
# reaching MemoryMax, slowing everything else on the machine.
MemorySwapMax=0
CPUWeight=$cpu_weight
TasksMax=$tasks_max
# An agent's test run killed at the memory cap must not stop the coordinator with it.
OOMPolicy=continue
# Stopping the service stops the agents it started too (they are in its cgroup).
KillMode=control-group
TimeoutStopSec=60
# /usr, /boot and /etc read-only for the coordinator and its agents. Not
# NoNewPrivileges: the coordinator starts agents through sudo as their own user.
ProtectSystem=full
# A /tmp of its own, shared with its agents and no other instance: tools keep
# fixed per-machine paths there (Claude Code's /tmp/cc-socks, a 0700 directory
# owned by whichever user made it first), which would lock out other instances' agents.
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
}

if [ -n "$print" ]; then echo "# /etc/systemd/system/worklane.slice"; slice; echo; echo "# /etc/systemd/system/$unit_name"; unit; exit 0; fi
as_root "${all_args[@]}"

id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run instance.sh $name first" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }

say "check the instance as $coord (credentials, repo scope)"
run_as "$coord" '
  worklane instance show "$1"
' "$name"

# Write each file to a dotted temp name, validate it under its real name, then move it into place.
put() {
  local file="$1" tmp="/etc/systemd/system/.$1.tmp" check
  "$2" > "$tmp"; chmod 0644 "$tmp"
  check="$(mktemp -d)/$file"; cp "$tmp" "$check"
  if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "$file invalid; nothing installed" >&2; exit 1; fi
  rm -f "$check"
  mv -f "$tmp" "/etc/systemd/system/$file"
  echo "installed /etc/systemd/system/$file"
}
say "install worklane.slice (CPU weight $slice_cpu, IO weight $slice_io) and $unit_name (memory $memory_high/$memory_max, CPU weight $cpu_weight, tasks $tasks_max)"
put worklane.slice slice
# Limits apply to a running service; any other change (e.g. PrivateTmp) needs a restart.
without_limits() { grep -vE '^(MemoryHigh|MemoryMax|CPUWeight|TasksMax)=' "$@" || true; }
restart=
if [ -f "/etc/systemd/system/$unit_name" ] && [ "$(without_limits "/etc/systemd/system/$unit_name")" != "$(unit | without_limits)" ]; then restart=1; fi
put "$unit_name" unit
systemctl daemon-reload

say "agents started through sudo stay in the service's cgroup, so its limits apply to them"
probe="$(systemd-run --quiet --wait --pipe --collect -p Slice=worklane.slice -p User="$coord" \
  sudo -n -u "$coord-agent" -- cat /proc/self/cgroup)"
echo "$probe"
grep -q '/worklane.slice/' <<<"$probe" || { echo "an agent started through sudo left the service's cgroup (a pam_systemd session?); limits would not apply to agents" >&2; exit 1; }

if systemctl is-active -q "$unit_name" && [ -n "$restart" ]; then
  echo "restarting $unit_name: its unit changed beyond the limits (agent runs in flight stop; the coordinator recovers them on start)"
  systemctl restart "$unit_name"
elif systemctl is-active -q "$unit_name"; then
  # Running already: apply the new limits now, without restarting it (and its agents).
  systemctl set-property --runtime "$unit_name" MemoryHigh="$memory_high" MemoryMax="$memory_max" CPUWeight="$cpu_weight" TasksMax="$tasks_max"
  systemctl set-property --runtime worklane.slice CPUWeight="$slice_cpu" IOWeight="$slice_io"
fi
systemctl enable --now "$unit_name"
sleep 3
systemctl --no-pager --lines=20 status "$unit_name" || true
echo
echo "limits:  systemctl show $unit_name -p MemoryHigh -p MemoryMax -p CPUWeight -p TasksMax   (in use: systemd-cgtop worklane.slice)"
echo "logs:    journalctl -u $unit_name -f"
echo "stop:    sudo systemctl stop $unit_name      (all instances at once: worklane stop-all)"
echo "disable: sudo systemctl disable --now $unit_name"
