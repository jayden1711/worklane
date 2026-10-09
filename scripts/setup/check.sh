#!/usr/bin/env bash
# Read-only checks of an instance's boundaries. Prints PASS/FAIL per check.
#   bash scripts/setup/check.sh <name> [<other instance name>]
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: check.sh <name> [<other instance>]}"
other="${2:-}"
coord="wl-$name" agent="wl-$name-agent"
fail=0
check() { if "$@" >/dev/null 2>&1; then echo "PASS $label"; else echo "FAIL $label"; fail=1; fi; }
label="$coord can run as $agent"; check sudo -u "$coord" sudo -n -u "$agent" true
if [ -n "$other" ]; then label="$coord cannot run as wl-$other-agent"; check bash -c "! sudo -u $coord sudo -n -u wl-$other-agent true"; fi
label="$agent cannot list $coord's home"; check bash -c "! sudo -u $agent ls /home/$coord"
label="$agent can run bwrap"; check sudo -u "$agent" bwrap --ro-bind / / --unshare-user --unshare-net true
label="$coord can write the shared slots"; check sudo -u "$coord" bash -c 'f=/var/lib/worklane/agent-slots/.probe-$$; touch "$f" && rm "$f"'
label="sudoers file is valid"; check visudo -cf "/etc/sudoers.d/worklane-$name"
exit "$fail"
