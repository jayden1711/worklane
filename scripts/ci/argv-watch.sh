#!/bin/bash
# CI only (the "test-run sandbox (real systemd)" job of .github/workflows/ci-slow.yml): what any user on the machine
# can see of an instance's test runs while they run, printed every 0.1 s until <stop file> exists. Run as an
# unprivileged user that is neither the coordinator nor the test user (nobody): every process's argv (ps and
# /proc/<pid>/cmdline), and each test-run unit's `systemctl show` and `systemctl cat`. The step then looks for a
# canary value in this output.
#
#   bash argv-watch.sh <instance> <stop file>
set -uo pipefail
name="${1:?usage: argv-watch.sh <instance> <stop file>}" stop="${2:?usage: argv-watch.sh <instance> <stop file>}"
while [ ! -e "$stop" ]; do
  ps -eo args
  for f in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$f" 2>/dev/null; echo; done
  while read -r u _; do
    [ -n "$u" ] || continue
    systemctl show "$u" 2>&1
    systemctl cat "$u" 2>&1
  done < <(systemctl list-units --all --plain --no-legend "worklane-test-$name-*" 2>/dev/null)
  sleep 0.1
done
