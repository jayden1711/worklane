#!/usr/bin/env bash
# Once per machine, on macOS (review it first): roots for checkouts and state, the shared agent slots and
# their config, and a check that Claude Code's sandbox can run. The macOS counterpart of ../machine.sh.
#   bash scripts/setup/macos/machine.sh [--cap N] [--max-cap N] [--checkouts DIR]
#     --cap        the agent slot cap to start with (default 2)
#     --max-cap    the highest cap an instance may set from its dashboard (default 16)
#     --checkouts  where the instances' checkouts live (default /var/worklane: /srv can't be created on
#                  macOS, its system volume is read-only)
# --max-cap and --checkouts are recorded in /etc/worklane/machine.json (root:wheel 0644), which the setup
# scripts and the machine helper read. A re-run without them keeps what is recorded.
#
#   - /etc/worklane, /var/lib/worklane and the checkouts root (root:wheel 0755).
#   - The agent-slots group, its slot directory, and /etc/worklane/slots.json (root:wheel 0644: the cap
#     changes only through the machine helper, macos/machine-helper.sh).
#   - Claude Code's sandbox on macOS is Seatbelt (/usr/bin/sandbox-exec), part of the OS: nothing to
#     install, unlike bubblewrap and socat on Linux. This checks it's there and works.
source "$(dirname "$0")/lib.sh"
require_macos
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

say "roots"
install -d -o root -g "$ROOT_GROUP" -m 0755 "$checkouts" /var/lib/worklane /etc/worklane

say "machine settings (root-owned, readable by all)"
tmp=/etc/worklane/.machine.json.tmp
printf '{"max_cap":%s,"checkouts":"%s"}\n' "$max" "$checkouts" > "$tmp"
chown "root:$ROOT_GROUP" "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" /etc/worklane/machine.json
cat /etc/worklane/machine.json

say "shared agent slots (group agent-slots) and their config"
ensure_group agent-slots
install -d -o root -g agent-slots -m 2770 /var/lib/worklane/agent-slots
if [ ! -f /etc/worklane/slots.json ]; then printf '{"max_agents":%s}\n' "$cap" > /etc/worklane/slots.json; fi
# Readable by all, writable by root only: the cap changes through the machine helper.
chown "root:$ROOT_GROUP" /etc/worklane/slots.json
chmod 0644 /etc/worklane/slots.json
cat /etc/worklane/slots.json

say "the sandbox: Seatbelt, part of macOS"
[ -x /usr/bin/sandbox-exec ] || { echo "no /usr/bin/sandbox-exec: Claude Code's sandbox can't run here, and agent runs refuse to start without it" >&2; exit 1; }
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' /usr/bin/true || { echo "sandbox-exec doesn't run a profile here" >&2; exit 1; }
echo "sandbox-exec works"
