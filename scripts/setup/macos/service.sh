#!/usr/bin/env bash
# Run an instance's coordinator as a launchd daemon on macOS (review it first): a root-owned plist in
# /Library/LaunchDaemons that runs it as the instance's coordinator user, starts at boot and restarts on
# failure. Root-owned so the coordinator user can't change its own service. Checks the instance first
# (credentials, repo scope) as that user. The macOS counterpart of ../service.sh.
#
# Limits, where launchd allows them. They apply to the coordinator and, inherited through sudo, to the
# agents it starts:
#   - priority under contention: nice (default 10) and low-priority disk IO, so other work on the machine
#     wins when both want the CPU or disk, while agents still use whatever is idle. (Not
#     ProcessType=Background: on Apple silicon it keeps a process on the efficiency cores even when the
#     machine is idle.)
#   - processes (default 2048) and open files (default 8192), as resource limits. The process limit counts
#     per user, so it bounds this instance's agents together, like TasksMax.
# What macOS can't limit, compared with the Linux unit's cgroups:
#   - memory: no hard cap (MemoryMax) and no throttle (MemoryHigh). setrlimit's RSS limit isn't enforced
#     on macOS, so a runaway test grows until the machine pages or the kernel kills something;
#   - CPU share: no weight or quota between instances, only nice;
#   - stopping the daemon stops the coordinator, which stops its agents itself; launchd has no cgroup to
#     kill an agent that escaped into its own process group;
#   - no private /tmp: each instance gets its own TMPDIR (/var/tmp/worklane/<name>, shared with its agents
#     only), which covers tools that honor TMPDIR, not ones that use a fixed /tmp path;
#   - no read-only /usr and /etc (ProtectSystem): file permissions and System Integrity Protection protect
#     them instead.
#
#   bash scripts/setup/macos/service.sh <name> [options]            install, load and start
#   bash scripts/setup/macos/service.sh <name> [options] --print    print the plist only
# options (defaults in brackets):
#   --nice <0-19> [10]   --low-priority-io <yes|no> [yes]   --max-procs <N> [2048]   --max-files <N> [8192]
source "$(dirname "$0")/lib.sh"
all_args=("$@")
name="${1:?usage: service.sh <name> [options] [--print]}"; shift
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name: lowercase letters, digits and dashes" >&2; exit 2; }
coord="wl-$name"
label="com.worklane.coordinator.$name"
nice=10 lowio=yes procs=2048 files=8192 print=
while [ $# -gt 0 ]; do
  case "$1" in
    --nice) nice="${2:?}"; shift 2 ;;
    --low-priority-io) lowio="${2:?}"; shift 2 ;;
    --max-procs) procs="${2:?}"; shift 2 ;;
    --max-files) files="${2:?}"; shift 2 ;;
    --print) print=1; shift ;;
    --memory-max|--memory-high|--cpu-weight|--tasks-max|--slice-cpu-weight|--slice-io-weight)
      echo "$1: macOS has no cgroups, so there's no memory cap or CPU weight; see the top of this script for what it can limit" >&2; exit 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$nice" =~ ^([0-9]|1[0-9])$ ]] || { echo "--nice: 0 to 19, got $nice" >&2; exit 2; }
[ "$lowio" = yes ] || [ "$lowio" = no ] || { echo "--low-priority-io: yes or no, got $lowio" >&2; exit 2; }
[[ "$procs" =~ ^[1-9][0-9]*$ ]] || { echo "--max-procs: a positive number, got $procs" >&2; exit 2; }
[[ "$files" =~ ^[1-9][0-9]*$ ]] || { echo "--max-files: a positive number, got $files" >&2; exit 2; }
# --print works before the account exists: it shows the home launchd will use.
home="$(home_of "$coord" 2>/dev/null || echo "/Users/$coord")"
tmp="/var/tmp/worklane/$name"

plist() {
  local io; [ "$lowio" = yes ] && io='<true/>' || io='<false/>'
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$coord</string>
  <key>GroupName</key><string>$coord</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/worklane</string><string>coordinator</string><string>run</string><string>--instance</string><string>$name</string></array>
  <key>WorkingDirectory</key><string>$(xml "$home")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$(xml "$home")</string>
    <key>TMPDIR</key><string>$tmp</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart on failure, not after a clean exit. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- 0007: nothing it writes is for users outside its group (the process also sets this itself). -->
  <key>Umask</key><integer>7</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>Nice</key><integer>$nice</integer>
  <key>LowPriorityIO</key>$io
  <key>SoftResourceLimits</key>
  <dict><key>NumberOfProcesses</key><integer>$procs</integer><key>NumberOfFiles</key><integer>$files</integer></dict>
  <key>HardResourceLimits</key>
  <dict><key>NumberOfProcesses</key><integer>$procs</integer><key>NumberOfFiles</key><integer>$files</integer></dict>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$name.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$name.log</string>
</dict>
</plist>
EOF
}

if [ -n "$print" ]; then echo "# $LAUNCH_DAEMONS/$label.plist"; plist; exit 0; fi
require_macos
as_root "${all_args[@]}"

id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run macos/instance.sh $name first" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }

say "check the instance as $coord (credentials, repo scope)"
run_as "$coord" '
  worklane instance show "$1"
' "$name"

say "its TMPDIR, shared with its agents and no other instance"
install -d -o root -g "$ROOT_GROUP" -m 0755 /var/tmp/worklane
install -d -o "$coord" -g "wl-$name-work" -m 1770 "$tmp"

say "its log, readable by $coord only"
daemon_log "$coord" "$name"

say "install $label (nice $nice, low-priority IO $lowio, processes $procs, open files $files)"
put_daemon "$label" plist
restart_daemon "$label"
sleep 2
launchctl print "system/$label" | sed -n '/^\tstate = /p;/^\tpid = /p;/last exit code/p'
echo
echo "logs:    $LOG_DIR/$name.log"
echo "limits:  launchctl print system/$label | grep -A3 'resource limits'"
echo "stop:    sudo launchctl bootout system/$label      (all instances at once: worklane stop-all)"
echo "start:   sudo launchctl bootstrap system $LAUNCH_DAEMONS/$label.plist"
