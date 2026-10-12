#!/usr/bin/env bash
# Inside the Worklane WSL2 distro: prove what WSL could add on top of Linux's isolation is closed.
# No Windows drive is mounted, no interop (no Windows program can be started), no Windows PATH, systemd is PID 1,
# and an agent user can't reach any of it either. Exit 1 on the first thing open; prints each probe.
# Read-only. Run as root:  bash isolation-check.sh [<agent user>]
# (The paths can be pointed elsewhere to test the script itself: MOUNTS, BINFMT_DIR, PID1_COMM, WSL_CONF.)
set -uo pipefail
MOUNTS="${MOUNTS:-/proc/mounts}"
BINFMT_DIR="${BINFMT_DIR:-/proc/sys/fs/binfmt_misc}"
PID1_COMM="${PID1_COMM:-/proc/1/comm}"
WSL_CONF="${WSL_CONF:-/etc/wsl.conf}"
agent="${1:-}"
bad=0
pass() { printf 'ok    %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; bad=1; }

drives="$(awk '$3 == "drvfs" || ($3 ~ /^(9p|virtiofs)$/ && ($4 ~ /aname=drvfs/ || $1 ~ /^[A-Za-z]:\\/)) { print $2 }' "$MOUNTS" | tr '\n' ' ')"
if [ -z "$drives" ]; then pass "no Windows drive mounted"; else fail "Windows drives mounted: $drives"; fi

if ls "$BINFMT_DIR" 2>/dev/null | grep -q '^WSLInterop'; then fail "interop registered ($BINFMT_DIR/WSLInterop*): Linux can start Windows programs"
else pass "no interop"; fi

if printf '%s' "${PATH:-}" | tr ':' '\n' | grep -q '^/mnt/'; then fail "PATH has Windows directories: $PATH"; else pass "no Windows directories on PATH"; fi
for exe in cmd.exe powershell.exe explorer.exe; do
  if command -v "$exe" >/dev/null 2>&1; then fail "$exe is reachable at $(command -v "$exe")"; fi
done

if [ "$(cat "$PID1_COMM" 2>/dev/null)" = systemd ]; then pass "systemd is PID 1"; else fail "PID 1 is $(cat "$PID1_COMM" 2>/dev/null || echo '?'), not systemd"; fi

conf="$(tr -d ' \r' < "$WSL_CONF" 2>/dev/null | tr '[:upper:]' '[:lower:]')"
for want in 'systemd=true' 'appendwindowspath=false'; do
  printf '%s\n' "$conf" | grep -qx "$want" && pass "wsl.conf: $want" || fail "wsl.conf lacks $want"
done
# [automount] and [interop] both have enabled=; both must be false.
[ "$(printf '%s\n' "$conf" | grep -cx 'enabled=false')" -ge 2 ] && pass "wsl.conf: automount and interop off" || fail "wsl.conf: [automount] and [interop] must both have enabled=false"

if [ -n "$agent" ]; then
  if ! id -u "$agent" >/dev/null 2>&1; then fail "no user $agent"
  elif su -s /bin/sh "$agent" -c 'ls /mnt/c >/dev/null 2>&1 || command -v cmd.exe >/dev/null 2>&1'; then fail "$agent can reach Windows (/mnt/c or cmd.exe)"
  else pass "$agent can't reach Windows"; fi
fi
exit "$bad"
