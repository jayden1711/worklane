#!/bin/bash
# CI only (the "test-run sandbox (real systemd)" job of .github/workflows/ci-slow.yml): the settings a coordinator's
# unit runs with, one KEY=value a line, each to be given to systemd-run as -p. They are read from the unit
# scripts/setup/service.sh itself generates (--print), so a transient unit made with them is the coordinator's
# sandbox as a machine has it, and can't drift from it.
#
# WHY: the coordinator calls the test-run helper from inside its unit (PrivateTmp=yes, ProtectSystem=full). A helper
# that only works when called from a plain shell passes every other check and fails on the machine.
#
# Every [Service] setting but the ones below, which say what the unit starts and when it restarts, not where it runs.
#
#   bash scripts/ci/coordinator-unit-props.sh <name>
set -euo pipefail
name="${1:?usage: coordinator-unit-props.sh <name>}"
SKIP='^(ExecStart|Type|Restart|RestartSec)$'
bash "$(dirname "$0")/../setup/service.sh" "$name" --print | awk -v unit="# /etc/systemd/system/worklane-$name.service" -v skip="$SKIP" '
  $0 == unit { in_unit = 1; next }
  !in_unit { next }
  /^\[/ { service = ($0 == "[Service]"); next }
  service && /^[A-Za-z]+=/ { k = $0; sub(/=.*/, "", k); if (k !~ skip) print }
'
