#!/usr/bin/env bash
# Checks of an instance's boundaries on macOS (review it first; run as root). Prints PASS, FAIL or SKIP per
# check and exits non-zero on any FAIL. The checks ../check.sh makes on Linux, plus what an agent must
# not reach: the coordinator's secrets, other instances, protected paths, and the network outside the
# sandbox's allowlist. It changes nothing but a probe file in the checkout and a slot, both removed after.
#   bash scripts/setup/macos/check.sh <name> [<other instance name>]
source "$(dirname "$0")/lib.sh"
require_macos
as_root "$@"
name="${1:?usage: check.sh <name> [<other instance>]}"
other="${2:-}"
coord="wl-$name" agent="wl-$name-agent" work="wl-$name-work"
fail=0
pass() { echo "PASS $label"; }
flunk() { echo "FAIL $label"; fail=1; }
skip() { echo "SKIP $label: $1"; }
# check: the command must succeed. denied: it must fail.
check() { if "$@" >/dev/null 2>&1; then pass; else flunk; fi; }
denied() { if "$@" >/dev/null 2>&1; then flunk; else pass; fi; }
as_agent() { sudo -n -u "$agent" -- "$@"; }

home="$(home_of "$coord")"
inst="$(instance_dir_of "$name")"
checkout="$(checkouts_root)/$name"

# Users and sudo
label="$coord can run as $agent"; check sudo -u "$coord" sudo -n -u "$agent" true
label="$agent can't run anything as root"; denied as_agent sudo -n true
label="$agent can't run anything as $coord"; denied as_agent sudo -n -u "$coord" true
label="$agent is not in admin or staff"; if id -Gn "$agent" | tr ' ' '\n' | grep -qxE 'admin|staff|wheel'; then flunk; else pass; fi
label="sudoers file is valid"; check visudo -cf "/etc/sudoers.d/worklane-$name"

# The coordinator's secrets
label="$agent can't list $coord's home ($home)"; denied as_agent ls "$home"
label="$agent can't read $name's instance folder"
if [ -d "$inst" ]; then denied as_agent ls "$inst"; else skip "no $inst yet (engine.sh makes it)"; fi
for f in credentials.yaml instance.yaml policy.yaml agent-settings.json; do
  label="$agent can't read $name's $f"
  if [ -e "$inst/$f" ]; then denied as_agent cat "$inst/$f"; else skip "no $inst/$f yet"; fi
done
# Login users' homes: macOS makes them group staff, which the agent must not be in.
for h in /Users/*; do
  u="$(basename "$h")"
  case "$u" in Shared|Guest|wl-*|.*) continue ;; esac
  [ -d "$h" ] || continue
  label="$agent can't list $h"; denied as_agent ls "$h"
done
label="$agent can't read $coord's service log"
if [ -e "$LOG_DIR/$name.log" ]; then denied as_agent cat "$LOG_DIR/$name.log"; else skip "no $LOG_DIR/$name.log yet (macos/service.sh makes it)"; fi

# Protected paths
label="$agent can't rename or remove what $coord owns in the checkout"
if [ -d "$checkout" ]; then
  probe="$checkout/.wl-check-$$"
  install -o "$coord" -g "$work" -m 0664 /dev/null "$probe"
  if as_agent mv "$probe" "$probe.moved" >/dev/null 2>&1 || as_agent rm -f "$probe" >/dev/null 2>&1 || [ ! -e "$probe" ]; then flunk; else pass; fi
  rm -f "$probe" "$probe.moved"
else
  skip "no $checkout"
fi
label="$agent can add files in the checkout"
if [ -d "$checkout" ]; then check as_agent bash -c 'f="$1/.wl-agent-$$"; touch "$f" && rm "$f"' _ "$checkout"; else skip "no $checkout"; fi
for p in /usr/local/bin/worklane /opt/worklane /opt/worklane/current /usr/local/libexec/worklane-machine /etc/worklane /etc/worklane/slots.json /etc/worklane/machine.json /etc/sudoers.d "$LAUNCH_DAEMONS"; do
  label="$agent can't write $p"
  if [ -e "$p" ]; then denied as_agent test -w "$p"; else skip "no $p"; fi
done
label="$agent can't take a shared agent slot itself"; denied as_agent touch "/var/lib/worklane/agent-slots/.probe-agent-$$"
label="$coord can write the shared slots"; check sudo -u "$coord" bash -c 'f=/var/lib/worklane/agent-slots/.probe-$$; touch "$f" && rm "$f"'

# Other instances
if [ -n "$other" ]; then
  label="$coord can't run as wl-$other-agent"; denied sudo -u "$coord" sudo -n -u "wl-$other-agent" true
  label="$agent can't list wl-$other's home"; denied as_agent ls "$(home_of "wl-$other")"
  label="$agent can't list $other's checkout"; denied as_agent ls "$(checkouts_root)/$other"
  label="$agent can't write $other's checkout"; denied as_agent touch "$(checkouts_root)/$other/.wl-probe-$$"
fi

# The sandbox: Claude Code runs agent commands under Seatbelt with no network but the connection to its own
# proxy on localhost, which allows only the lane's hosts. The same rule, checked as the agent user.
label="$agent can run sandbox-exec"; check as_agent /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true
if ! command -v node >/dev/null; then
  label="the sandbox's network rule"; skip "no node on root's PATH to run a local listener with"
  exit "$fail"
fi
profile='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
portfile="$(mktemp)"
/usr/bin/env node -e '
  const fs = require("fs");
  const s = require("net").createServer((c) => c.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
  s.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[1], String(s.address().port)));
  setTimeout(() => process.exit(0), 60000);
' "$portfile" &
listener=$!
trap 'kill "$listener" 2>/dev/null || true; rm -f "$portfile"' EXIT
for _ in $(seq 1 20); do [ -s "$portfile" ] && break; sleep 0.25; done
port="$(cat "$portfile")"
label="in the sandbox, $agent reaches a proxy on localhost"; check as_agent /usr/bin/sandbox-exec -p "$profile" /usr/bin/curl -sf --max-time 5 "http://127.0.0.1:$port/"
label="in the sandbox, $agent reaches nothing else"
if as_agent /usr/bin/curl -sS --max-time 8 -o /dev/null https://example.com >/dev/null 2>&1; then
  denied as_agent /usr/bin/sandbox-exec -p "$profile" /usr/bin/curl -sS --max-time 8 -o /dev/null https://example.com
else
  skip "$agent can't reach https://example.com outside the sandbox either, so there's nothing to compare"
fi

exit "$fail"
