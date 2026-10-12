#!/usr/bin/env bash
# Once per machine: roots for checkouts and state, the shared agent slots
# and their config, and Claude Code's sandbox dependencies.
#   bash scripts/setup/machine.sh [--cap N] [--max-cap N] [--checkouts DIR]
#     --cap        the agent slot cap to start with (default 2)
#     --max-cap    the highest cap an instance may set from its dashboard (default 16)
#     --checkouts  where the instances' checkouts live (default /srv/worklane)
# --max-cap and --checkouts are recorded in /etc/worklane/machine.json (root-owned), which every
# setup script and the machine helper read. A re-run without them keeps what is recorded.
source "$(dirname "$0")/lib.sh"
as_root "$@"
cap=2
max="$(max_cap)"
checkouts="$(checkouts_root)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cap) cap="${2:?--cap needs a number}"; shift 2 ;;
    --max-cap) max="${2:?--max-cap needs a number}"; shift 2 ;;
    --checkouts) checkouts="${2:?--checkouts needs a directory}"; shift 2 ;;
    *) echo "unknown option $1 (--cap N, --max-cap N, --checkouts DIR)" >&2; exit 2 ;;
  esac
done
[[ "$max" =~ ^[1-9][0-9]?$ ]] || { echo "--max-cap: a whole number from 1 to 99" >&2; exit 2; }
[[ "$cap" =~ ^[1-9][0-9]?$ ]] && [ "$cap" -le "$max" ] || { echo "--cap: a whole number from 1 to the max cap ($max)" >&2; exit 2; }
[[ "$checkouts" =~ ^/[A-Za-z0-9._/-]+$ && "$checkouts" != */ ]] || { echo "--checkouts: an absolute path of letters, digits, . _ - and /, with no trailing /" >&2; exit 2; }
refuse_windows_fs "$checkouts" || exit 2

say "roots"
install -d -o root -g root -m 0755 "$checkouts" /var/lib/worklane /etc/worklane

say "machine settings (root-owned, readable by all)"
tmp=/etc/worklane/.machine.json.tmp
printf '{"max_cap":%s,"checkouts":"%s"}\n' "$max" "$checkouts" > "$tmp"
chown root:root "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" /etc/worklane/machine.json
cat /etc/worklane/machine.json

say "shared agent slots (group agent-slots) and their config"
ensure_group agent-slots
install -d -o root -g agent-slots -m 2770 /var/lib/worklane/agent-slots
if [ ! -f /etc/worklane/slots.json ]; then printf '{"max_agents":%s}\n' "$cap" > /etc/worklane/slots.json; fi
# Readable by all, writable by root only: the cap changes through the machine helper (machine-helper.sh).
chown root:root /etc/worklane/slots.json
chmod 0644 /etc/worklane/slots.json
cat /etc/worklane/slots.json

say "sandbox dependencies"
pkg_install bubblewrap socat

say "AppArmor: let bubblewrap create user namespaces (the machine-wide restriction stays on)"
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  if [ -f /etc/apparmor.d/bwrap-userns-restrict ]; then
    apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict; echo "using the distribution's bwrap-userns-restrict"
  elif [ -f /usr/share/apparmor/extra-profiles/bwrap-userns-restrict ]; then
    install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
    apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict; echo "using the distribution's bwrap-userns-restrict"
  else
    tmp=/etc/apparmor.d/.bwrap.tmp
    printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' '# Lets only /usr/bin/bwrap create user namespaces.' 'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '  include if exists <local/bwrap>' '}' > "$tmp"
    apparmor_parser -Q "$tmp"   # parse check only
    mv -f "$tmp" /etc/apparmor.d/bwrap
    apparmor_parser -r /etc/apparmor.d/bwrap; echo "using the bwrap-only profile"
  fi
  echo "kernel.apparmor_restrict_unprivileged_userns = $(sysctl -n kernel.apparmor_restrict_unprivileged_userns) (unchanged)"
else
  echo "no user-namespace restriction here; nothing to do"
fi
