#!/usr/bin/env bash
# Once per machine, as root (review it first): let instances change machine-wide settings from
# their dashboards, through one root-owned helper that validates and writes only those settings.
#
#   bash scripts/setup/machine-helper.sh <name> [<name>...]                  every instance on this machine
#   bash scripts/setup/machine-helper.sh --setup-user <login> [<name>...]    also let <login> onboard projects
#
#   - Installs the helper as /usr/local/libexec/worklane-machine (root:root 0755). It accepts
#     exactly `set-slots <1..16>` and `set-updates on|off`, writes atomically, and logs each
#     change to /var/lib/worklane/machine-changes.jsonl and the journal; and the setup commands
#     (see the helper's source), each one setup script with checked arguments.
#   - Copies these setup scripts, root-owned, to /usr/local/libexec/worklane-setup: the only
#     scripts the helper's setup commands run.
#   - Lets each coordinator user wl-<name> run exactly those 18 commands as root (sudoers,
#     listed one by one). The dashboard viewer wl-dash gets nothing.
#   - With --setup-user, lets that one login (yours, the owner's: it runs `worklane add` and the
#     setup console) run the helper's setup commands, and nothing else, without a password. No
#     coordinator ever gets them. Review the setup commands in the helper's source first.
#   - Makes /etc/worklane/slots.json root:root 0644: until now the agent-slots group could
#     write any content to it; from now on the cap changes only through the helper.
# Re-run it with the full list after adding an instance.
source "$(dirname "$0")/lib.sh"
as_root "$@"
setup_user=""
names=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --setup-user) setup_user="${2:?--setup-user needs a login}"; shift 2 ;;
    *) names+=("$1"); shift ;;
  esac
done
[ "${#names[@]}" -ge 1 ] || [ -n "$setup_user" ] || { echo "usage: machine-helper.sh [--setup-user <login>] <name> [<name>...]" >&2; exit 2; }
users=()
for name in "${names[@]}"; do
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name $name: lowercase letters, digits and dashes" >&2; exit 2; }
  [ "$name" != dash ] || { echo "wl-dash is the dashboard viewer, not a coordinator; it gets no access" >&2; exit 2; }
  id -u "wl-$name" >/dev/null 2>&1 || { echo "no wl-$name; run instance.sh $name first" >&2; exit 1; }
  users+=("wl-$name")
done
if [ -n "$setup_user" ]; then
  setup_sudoers "$setup_user" >/dev/null || exit 2
  id -u "$setup_user" >/dev/null 2>&1 || { echo "no user $setup_user" >&2; exit 1; }
fi
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
install -d -o root -g root -m 0755 /etc/worklane

say "the helper, root-owned"
src="$(dirname "$0")/../machine/worklane-machine.cjs"
# The temp name ends in .cjs: node --check refuses an unknown extension such as .tmp.
tmp="$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp.cjs"
install -d -o root -g root -m 0755 "$(dirname "$MACHINE_HELPER")"
rm -f "$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp"   # left by an earlier run that failed on that name
install -o root -g root -m 0755 "$src" "$tmp"
node --check "$tmp"
mv -f "$tmp" "$MACHINE_HELPER"
echo "installed $MACHINE_HELPER"
# The engine's ports (the hub's, which tailscale-serve exposes): the one copy, root-owned beside the helper.
install -o root -g root -m 0644 "$(dirname "$0")/../../templates/machine/ports.json" "$(dirname "$MACHINE_HELPER")/worklane-ports.json"

say "the setup scripts its setup commands run, root-owned"
setup_dir="$(dirname "$MACHINE_HELPER")/worklane-setup"
here="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$setup_dir.new"
install -d -o root -g root -m 0755 "$setup_dir.new"
for f in "$here"/*.sh "$here"/*.mjs; do install -o root -g root -m 0644 "$f" "$setup_dir.new/"; done
# engine.sh clones the engine from the repo these scripts came from; the copies have no git checkout to ask.
git -C "$here" remote get-url origin > "$setup_dir.new/engine-origin"
chown root:root "$setup_dir.new/engine-origin" && chmod 0644 "$setup_dir.new/engine-origin"
rm -rf "$setup_dir.old"
[ -d "$setup_dir" ] && mv "$setup_dir" "$setup_dir.old"
mv "$setup_dir.new" "$setup_dir" && rm -rf "$setup_dir.old"
echo "installed $setup_dir (from $(cat "$setup_dir/engine-origin"))"

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

if [ "${#users[@]}" -ge 1 ]; then
  say "sudoers: ${users[*]} may run exactly the helper's 18 commands"
  install_sudoers worklane-machine "$(machine_sudoers "${users[@]}")"
fi
if [ -n "$setup_user" ]; then
  say "sudoers: $setup_user may run the helper's setup commands, nothing else"
  install_sudoers worklane-setup "$(setup_sudoers "$setup_user")"
fi

say "check"
for u in "${users[@]}"; do
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 1 >/dev/null || { echo "FAIL: $u can't run set-slots 1" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 17 >/dev/null 2>&1; then echo "FAIL: $u may run set-slots 17" >&2; exit 1; fi
  if sudo -n -l -U "$u" "$MACHINE_HELPER" add-instance x >/dev/null 2>&1; then echo "FAIL: coordinator $u may run a setup command" >&2; exit 1; fi
done
if id -u wl-dash >/dev/null 2>&1 && sudo -n -l -U wl-dash "$MACHINE_HELPER" set-slots 1 >/dev/null 2>&1; then echo "FAIL: wl-dash may run the helper" >&2; exit 1; fi
if [ -n "$setup_user" ]; then
  sudo -n -l -U "$setup_user" "$MACHINE_HELPER" add-instance x >/dev/null || { echo "FAIL: $setup_user can't run add-instance" >&2; exit 1; }
  if sudo -n -l -U "$setup_user" /bin/sh >/dev/null 2>&1; then echo "NOTE: $setup_user may run other commands as root through other sudoers rules (e.g. as an admin); this rule adds only the helper's setup commands"; fi
fi
echo "OK: each coordinator may run the helper's exact commands; nothing else, and not wl-dash${setup_user:+; $setup_user may run its setup commands}"
