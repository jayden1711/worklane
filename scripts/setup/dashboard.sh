#!/usr/bin/env bash
# An instance's dashboard on this machine, in the foreground (Ctrl+C stops it).
# It runs as the instance's coordinator user, the only user that can read the
# instance's event log (and record your answers to its decisions in it), and
# listens on 127.0.0.1 only, on a port fixed by the instance's name.
# From another machine, reach it through an ssh tunnel to the same port:
#   ssh -N -L <port>:127.0.0.1:<port> <you>@<this-host>
# then open the URL this prints (it carries the dashboard's token).
#   bash scripts/setup/dashboard.sh <name> [<your GitHub login>]
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: dashboard.sh <name> [<your GitHub login>]}"
login="${2:-}"
coord="wl-$name"
id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run instance.sh $name first" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no engine installed; run engine.sh first" >&2; exit 1; }

say "dashboard for $name, as $coord"
# Its token is the owner's break-glass (it grants owner, on this machine only); --user only names who answered.
# Anyone else signs in through the hub (dashboards.sh, docs/dashboard.md).
run_as "$coord" '
  args=(dashboard --instance "$1" --no-open)
  [ -n "$2" ] && args+=(--user "$2")
  exec worklane "${args[@]}"
' "$name" "$login"
