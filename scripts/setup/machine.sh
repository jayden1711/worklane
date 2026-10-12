#!/usr/bin/env bash
# Once per machine: roots for checkouts and state, the shared agent slots
# and their config, and Claude Code's sandbox dependencies.
#   bash scripts/setup/machine.sh [--cap N]     (default cap 2)
source "$(dirname "$0")/lib.sh"
as_root "$@"
cap=2
[ "${1:-}" = --cap ] && cap="${2:?--cap needs a number}"

say "roots"
install -d -o root -g root -m 0755 /srv/worklane /var/lib/worklane /etc/worklane

say "shared agent slots (group agent-slots) and their config"
ensure_group agent-slots
install -d -o root -g agent-slots -m 2770 /var/lib/worklane/agent-slots
if [ ! -f /etc/worklane/slots.json ]; then printf '{"max_agents":%s}\n' "$cap" > /etc/worklane/slots.json; fi
# Readable by all, writable by root only: the cap changes through the machine helper (machine-helper.sh).
chown root:root /etc/worklane/slots.json
chmod 0644 /etc/worklane/slots.json
cat /etc/worklane/slots.json

say "sandbox dependencies"
apt-get install -y bubblewrap socat

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
