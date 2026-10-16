#!/usr/bin/env bash
# An instance's MCP broker (src/mcp/), as root. Review it first.
#
#   bash scripts/setup/mcp-broker.sh <name>                       the broker's user, groups and unit (once per instance)
#   bash scripts/setup/mcp-broker.sh <name> secret <id> <NAME>    install one MCP server's secret: the value on stdin
#
# The broker runs as its own user, wl-<name>-mcp, holding nothing but the instance's MCP servers' secrets. It is the
# only process that reads them: each approved server starts in its own sandbox with its own secrets in its environment,
# and the agent reaches it only through the broker's socket. Who may open which socket:
#   wl-<name>-mcpc    the instance's agent user (the client socket: its runs' connectors)
#   wl-<name>-mcpctl  the instance's coordinator (the control socket: a ticket per run)
# Both groups also hold the broker's user, which owns the sockets. Neither the coordinator nor the agent can read a
# secret: each is 0400, the broker user's own, in a 0700 directory per server in its 0700 home.
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:-}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ && "$name" != dash ]] || { echo "usage: mcp-broker.sh <name> [secret <id> <NAME>]" >&2; exit 2; }
coord="wl-$name" agent="wl-$name-agent" mcp="wl-$name-mcp"
id -u "$coord" >/dev/null 2>&1 && id -u "$agent" >/dev/null 2>&1 || { echo "no $coord or $agent: run instance.sh $name first" >&2; exit 1; }

if [ "${2:-}" = secret ]; then
  sid="${3:-}" var="${4:-}"
  [[ "$sid" =~ ^[a-z0-9][a-z0-9-]{0,39}$ && "$var" =~ ^[A-Z][A-Z0-9_]{1,63}$ && "$#" -eq 4 ]] || { echo "usage: mcp-broker.sh <name> secret <id> <NAME>  (the value on stdin)" >&2; exit 2; }
  id -u "$mcp" >/dev/null 2>&1 || { echo "no $mcp: run mcp-broker.sh $name first" >&2; exit 1; }
  if [ -t 0 ]; then read -r -s -p "value of $var for $sid (not shown): " value; echo; else IFS= read -r value || true; fi
  [ -n "$value" ] || { echo "no value: nothing installed" >&2; exit 1; }
  home="$(home_of "$mcp")"
  install -d -o "$mcp" -g "$mcp" -m 0700 "$home/secrets" "$home/secrets/$sid"
  tmp="$home/secrets/$sid/.$var.$$"
  (umask 077; printf '%s\n' "$value" > "$tmp")
  unset value
  chown "$mcp:$mcp" "$tmp" && chmod 0400 "$tmp" && mv -f "$tmp" "$home/secrets/$sid/$var"
  echo "installed $var for $sid: $(stat -c '%U %a' "$home/secrets/$sid/$var") (the value is not shown, logged or kept anywhere else)"
  exit 0
fi
[ "$#" -eq 1 ] || { echo "usage: mcp-broker.sh <name> [secret <id> <NAME>]" >&2; exit 2; }

say "the sandbox's tools: bubblewrap and socat (machine.sh) and ripgrep"
command -v bwrap >/dev/null && command -v socat >/dev/null || { echo "no bwrap or socat: run machine.sh first" >&2; exit 1; }
command -v rg >/dev/null || { apt-get update -q && apt-get install -y -q ripgrep; }

say "the broker's user and its socket groups"
ensure_user "$mcp"
ensure_group "wl-$name-mcpc"; ensure_group "wl-$name-mcpctl"
ensure_member "$agent" "wl-$name-mcpc"; ensure_member "$mcp" "wl-$name-mcpc"
ensure_member "$coord" "wl-$name-mcpctl"; ensure_member "$mcp" "wl-$name-mcpctl"
install -d -o "$mcp" -g "$mcp" -m 0700 "$(home_of "$mcp")/secrets"

say "the unit: worklane-mcp@$name.service"
unit=/etc/systemd/system/worklane-mcp@.service
tmp="$(dirname "$unit")/.worklane-mcp@.service.tmp"
cat > "$tmp" <<'EOF'
[Unit]
Description=worklane MCP broker for %i
After=network-online.target

[Service]
User=wl-%i-mcp
Group=wl-%i-mcp
ExecStart=/usr/local/bin/node /opt/worklane/current/dist/src/cli.js mcp-broker --instance %i
RuntimeDirectory=worklane-mcp-%i
RuntimeDirectoryMode=0711
StateDirectory=worklane-mcp-%i
StateDirectoryMode=0750
UMask=0077
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
NoNewPrivileges=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$tmp" && mv -f "$tmp" "$unit"
systemctl daemon-reload
systemctl enable --now "worklane-mcp@$name.service"
systemctl restart "worklane-mcp@$name.service"
for _ in $(seq 20); do [ -S "/run/worklane-mcp-$name/broker.sock" ] && [ -S "/run/worklane-mcp-$name/control.sock" ] && break; sleep 0.5; done
for s in broker control; do stat -c "%n %U:%G %a" "/run/worklane-mcp-$name/$s.sock"; done

say "the coordinator joins the control group on its next start"
if systemctl is-active -q "worklane-$name.service"; then systemctl restart "worklane-$name.service"; echo "restarted worklane-$name.service"; fi
echo "OK: the broker for $name runs as $mcp; install a server's secret with: bash $0 $name secret <id> <NAME> (value on stdin)"
