#!/usr/bin/env bash
# Once per machine, as root (review it first): let instances change machine-wide settings from
# their dashboards, through one root-owned helper that validates and writes only those settings.
# The dashboard (hardened: NoNewPrivileges) never runs sudo itself: it records the request and the
# instance's coordinator runs the helper on its next tick (src/machine-requests.ts).
#
#   bash scripts/setup/machine-helper.sh <name> [<name>...]     every instance on this machine
#
#   - Installs the helper as /usr/local/libexec/worklane-machine (root:root 0755). It accepts
#     exactly `set-slots <1..16>`, `set-updates on|off` and `set-test-slots <1..8>`, writes atomically, and logs each
#     change to /var/lib/worklane/machine-changes.jsonl and the journal. And `add-project <name> <owner/repo>`,
#     which runs the installed engine's add-project.sh as root with exactly those (checked) arguments.
#     And `claude-account status|switch`, the Claude account switch (claude-account.sh): status runs it; switch starts
#     it as its own unit, taking the token from the asking instance's dashboard.
#     And `tailscale install|up|serve|public-url`, which start tailscale.sh with that one word as its own unit: the
#     pinned, signed install; `tailscale up` with no auth key; https 443 to the hub's sign-in port; the hub's URL.
#   - Lets each coordinator user wl-<name> run exactly those 32 commands as root (sudoers,
#     listed one by one), and add-project with two arguments of its fixed shapes (a pattern; sudo 1.9.10 or
#     later). The dashboard viewer wl-dash gets nothing.
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
# The temp name ends in .cjs: node --check refuses an unknown extension such as .tmp.
tmp="$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp.cjs"
install -d -o root -g root -m 0755 "$(dirname "$MACHINE_HELPER")"
rm -f "$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp"   # left by an earlier run that failed on that name
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

say "sudoers: ${users[*]} may run exactly the helper's 32 commands, and add-project <name> <owner/repo>"
install_sudoers worklane-machine "$(machine_sudoers "${users[@]}")"

say "check"
for u in "${users[@]}"; do
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 1 >/dev/null || { echo "FAIL: $u can't run set-slots 1" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 17 >/dev/null 2>&1; then echo "FAIL: $u may run set-slots 17" >&2; exit 1; fi
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-test-slots 2 >/dev/null || { echo "FAIL: $u can't run set-test-slots 2" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-test-slots 9 >/dev/null 2>&1; then echo "FAIL: $u may run set-test-slots 9" >&2; exit 1; fi
  sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account switch >/dev/null || { echo "FAIL: $u can't run claude-account switch" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account switch --token-from x >/dev/null 2>&1; then echo "FAIL: $u may pass claude-account switch its own arguments" >&2; exit 1; fi
  for ok in install up serve public-url; do
    sudo -n -l -U "$u" "$MACHINE_HELPER" tailscale "$ok" >/dev/null || { echo "FAIL: $u can't run tailscale $ok" >&2; exit 1; }
  done
  for bad in "tailscale funnel" "tailscale funnel 443" "tailscale serve --funnel" "tailscale serve funnel on" "tailscale serve --bg --https=443 http://127.0.0.1:4399" "tailscale serve --set-path=/x http://127.0.0.1:4398" "tailscale serve http://0.0.0.0:4399" "tailscale serve --tcp=22 tcp://127.0.0.1:22" "tailscale up --advertise-exit-node" "tailscale up --advertise-routes=198.51.100.0/24" "tailscale up --ssh" "tailscale up --accept-routes" "tailscale up --login-server=https://x.example" "tailscale" "tailscale up --auth-key=tskey-auth-x" "tailscale up --authkey tskey-auth-x" "tailscale up x" "tailscale serve 4398" "tailscale serve --https=443 http://127.0.0.1:4398" "tailscale public-url https://x.example" "tailscale install 1.0.0" "tailscale status" "tailscale logout" "tailscale UP"; do
    # shellcheck disable=SC2086 # each case is its words
    if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
  done
  for bad in "add-project x" "add-project x o/r extra" "add-project X o/r" "add-project x o" "add-project x o/r/s" "add-project x;id o/r" "add-project -x o/r"; do
    # shellcheck disable=SC2086 # each case is its words
    if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
  done
  if ! sudo -n -l -U "$u" "$MACHINE_HELPER" add-project probe-name example-owner/probe.repo >/dev/null 2>&1; then
    add_project_note="NOTE: this sudo ($(sudo -V | head -1)) doesn't match add-project's pattern (it needs 1.9.10 or later), so add-project from the dashboard is refused; run add-project.sh in a terminal instead"
  fi
done
if id -u wl-dash >/dev/null 2>&1 && sudo -n -l -U wl-dash "$MACHINE_HELPER" set-slots 1 >/dev/null 2>&1; then echo "FAIL: wl-dash may run the helper" >&2; exit 1; fi
[ -z "${add_project_note:-}" ] || echo "$add_project_note"
echo "OK: each coordinator may run the helper's exact commands; nothing else, and not wl-dash"
