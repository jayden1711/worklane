#!/usr/bin/env bash
# Once per machine, as root (review it first): let instances change machine-wide settings from
# their dashboards, through one root-owned helper that validates and writes only those settings.
#
#   bash scripts/setup/machine-helper.sh <name> [<name>...]     every instance on this machine
#
#   - Installs the helper as /usr/local/libexec/worklane-machine (root:root 0755). It accepts
#     exactly `set-slots <1..16>` and `set-updates on|off`, writes atomically, and logs each
#     change to /var/lib/worklane/machine-changes.jsonl and the journal.
#   - Lets each coordinator user wl-<name> run exactly those 18 commands as root (sudoers,
#     listed one by one). The dashboard viewer wl-dash gets nothing.
#   - Makes /etc/worklane/slots.json root:root 0644: until now the agent-slots group could
#     write any content to it; from now on the cap changes only through the helper.
# Re-run it with the full list after adding an instance.
source "$(dirname "$0")/lib.sh"
as_root "$@"
[ "$#" -ge 1 ] || { echo "usage: machine-helper.sh <name> [<name>...]" >&2; exit 2; }
users=()
for name in "$@"; do
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name $name: lowercase letters, digits and dashes" >&2; exit 2; }
  [ "$name" != dash ] || { echo "wl-dash is the dashboard viewer, not a coordinator; it gets no access" >&2; exit 2; }
  id -u "wl-$name" >/dev/null 2>&1 || { echo "no wl-$name; run instance.sh $name first" >&2; exit 1; }
  users+=("wl-$name")
done
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
[ -d /etc/worklane ] || { echo "no /etc/worklane; run machine.sh first" >&2; exit 1; }

say "the helper, root-owned"
src="$(dirname "$0")/../machine/worklane-machine.cjs"
tmp="$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp"
install -d -o root -g root -m 0755 "$(dirname "$MACHINE_HELPER")"
install -o root -g root -m 0755 "$src" "$tmp"
node --check "$tmp"
mv -f "$tmp" "$MACHINE_HELPER"
echo "installed $MACHINE_HELPER"

say "its change log"
install -d -o root -g root -m 0755 /var/lib/worklane
[ -f /var/lib/worklane/machine-changes.jsonl ] || install -o root -g root -m 0644 /dev/null /var/lib/worklane/machine-changes.jsonl
chown root:root /var/lib/worklane/machine-changes.jsonl
chmod 0644 /var/lib/worklane/machine-changes.jsonl

say "the slot cap: root-owned, readable by all, changed only through the helper"
[ -f /etc/worklane/slots.json ] || printf '{"max_agents":2}\n' > /etc/worklane/slots.json
chown root:root /etc/worklane/slots.json
chmod 0644 /etc/worklane/slots.json
cat /etc/worklane/slots.json

say "sudoers: ${users[*]} may run exactly the helper's 18 commands"
install_sudoers worklane-machine "$(machine_sudoers "${users[@]}")"

say "check"
for u in "${users[@]}"; do
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 1 >/dev/null || { echo "FAIL: $u can't run set-slots 1" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 17 >/dev/null 2>&1; then echo "FAIL: $u may run set-slots 17" >&2; exit 1; fi
done
if id -u wl-dash >/dev/null 2>&1 && sudo -n -l -U wl-dash "$MACHINE_HELPER" set-slots 1 >/dev/null 2>&1; then echo "FAIL: wl-dash may run the helper" >&2; exit 1; fi
echo "OK: each coordinator may run the helper's exact commands; nothing else, and not wl-dash"
