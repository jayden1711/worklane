#!/usr/bin/env bash
# Run an instance's coordinator as a system service: a root-owned systemd
# unit that runs it as the instance's coordinator user, starts at boot and
# restarts on failure. Root-owned so the coordinator user can't change its
# own service. Checks the instance first (credentials, repo scope) as that user.
#   bash scripts/setup/service.sh <name>            install, enable and start
#   bash scripts/setup/service.sh <name> --print    print the unit only
source "$(dirname "$0")/lib.sh"
name="${1:?usage: service.sh <name> [--print]}"
coord="wl-$name"
unit_name="worklane-$name.service"

unit() {
  cat <<EOF
[Unit]
Description=worklane coordinator for instance $name
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$coord
Group=$coord
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane coordinator run --instance $name
Restart=on-failure
RestartSec=30
# Stopping the service stops the agents it started too (they are in its cgroup).
KillMode=control-group
TimeoutStopSec=60
# /usr, /boot and /etc read-only for the coordinator and its agents. Not
# NoNewPrivileges: the coordinator starts agents through sudo as their own user.
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
}

if [ "${2:-}" = "--print" ]; then unit; exit 0; fi
as_root "$@"

id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; run instance.sh $name first" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }

say "check the instance as $coord (credentials, repo scope)"
run_as "$coord" '
  worklane instance show "$1"
' "$name"

say "install /etc/systemd/system/$unit_name"
tmp="/etc/systemd/system/.$unit_name.tmp"
unit > "$tmp"
chmod 0644 "$tmp"
# Validate under the real name (verify reads the unit's type from its suffix), then move into place.
check="$(mktemp -d)/$unit_name"; cp "$tmp" "$check"
if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "unit invalid; nothing installed" >&2; exit 1; fi
rm -f "$check"
mv -f "$tmp" "/etc/systemd/system/$unit_name"
systemctl daemon-reload
systemctl enable --now "$unit_name"
sleep 3
systemctl --no-pager --lines=20 status "$unit_name" || true
echo
echo "logs:    journalctl -u $unit_name -f"
echo "stop:    sudo systemctl stop $unit_name      (all instances at once: worklane stop-all)"
echo "disable: sudo systemctl disable --now $unit_name"
