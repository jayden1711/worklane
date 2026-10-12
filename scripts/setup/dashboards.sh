#!/usr/bin/env bash
# Once per machine, as root (review it first): one dashboard over several
# instances. Re-run it with the same list after adding an instance.
#
#   - Each instance gets its own dashboard service, as its own coordinator user
#     (worklane-dashboard-<name>.service): the only process that reads that
#     instance's log and records your answers in it.
#   - A viewer user, wl-dash, runs the hub (worklane-dashboard-hub.service). It
#     forwards the page's calls to the selected instance's own dashboard.
#   - wl-dash gets read access to each instance's dashboard-token file, plus
#     traverse (x, no listing) on the directories above it, through ACLs. It
#     gets nothing else: no read of any log, config or credential, and no
#     write anywhere. No instance user gets any new access, so no instance
#     can write, or read, another's log.
#   - People sign in to the hub with their own GitHub account, through a
#     GitHub App used only for sign-in (its client id here; its client secret
#     installed first with credentials.sh dashboard-signin). Each instance's
#     dashboard reads their role from their permission on its repo.
#   - Both listen on 127.0.0.1 only: the hub's sign-in port 4399, which
#     tailscale serve forwards over HTTPS, and the owner's break-glass port
#     4398 (the token, on this machine only), which it never forwards.
#
#   bash scripts/setup/credentials.sh dashboard-signin      (first, once)
#   bash scripts/setup/dashboards.sh [--console-user <admin user>] --client-id <id> --public-url https://<machine>.<tailnet>.ts.net <name> [<name>...]
#
#   --console-user (console_user): the admin user the hub's owner terminal runs as. Run console-shell.sh
#     with the same user first. Without it the terminal never opens. With it, the hub's unit drops
#     NoNewPrivileges and its read-only filesystem: sudo (to start the terminal, and in it) needs both.
#
# Then: tailscale serve --bg --https=443 http://127.0.0.1:4399 (docs/dashboard.md).
source "$(dirname "$0")/lib.sh"
as_root "$@"
usage="usage: dashboards.sh [--console-user <admin user>] --client-id <sign-in App client id> --public-url https://<machine>.<tailnet>.ts.net <name> [<name>...]"
client_id="" public_url="" console_user=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --client-id) client_id="${2:-}"; shift 2 ;;
    --public-url) public_url="${2:-}"; shift 2 ;;
    --console-user) console_user="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ "$#" -ge 1 ] && [ -n "$client_id" ] && [ -n "$public_url" ] || { echo "$usage" >&2; exit 2; }
[[ "$client_id" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "--client-id: the sign-in App's client id (letters, digits, dots, dashes)" >&2; exit 2; }
[[ "$public_url" =~ ^https://[a-z0-9.-]+$ ]] || { echo "--public-url: the hub's https origin, as browsers reach it through tailscale serve (https://<machine>.<tailnet>.ts.net)" >&2; exit 2; }
if [ -n "$console_user" ]; then
  [[ "$console_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$console_user" != root && "$console_user" != wl-* ]] || { echo "console user: your admin user's login name (never root or a wl- user)" >&2; exit 2; }
  [ -x "$CONSOLE_SHELL" ] && [ -f "$CONSOLE_SUDOERS" ] || { echo "no console shell or its sudoers rule: run console-shell.sh $console_user first" >&2; exit 1; }
fi
command -v setfacl >/dev/null || { echo "needs setfacl: install the acl package (apt install acl), then run this again" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }
viewer=wl-dash
signin_dir="/home/$viewer/.config/dashboard-signin"
for f in client-secret session-secret; do
  [ -s "$signin_dir/$f" ] || { echo "no $signin_dir/$f: run credentials.sh dashboard-signin first" >&2; exit 1; }
done

state_of() { local coord="wl-$1"; echo "$(home_of "$coord")/.local/state/worklane/instances/$1/state"; }
for name in "$@"; do
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name $name: lowercase letters, digits and dashes" >&2; exit 2; }
  id -u "wl-$name" >/dev/null 2>&1 || { echo "no wl-$name; run instance.sh $name first" >&2; exit 1; }
  [ -d "$(state_of "$name")" ] || { echo "no state for instance $name at $(state_of "$name"); run engine.sh with it first" >&2; exit 1; }
  # An ACL on the way to the token would expose anything there that others may read: refuse first.
  refuse_if_open "$(state_of "$name")" "grant $viewer any access"
done

dash_unit() {
  cat <<EOF
[Unit]
Description=worklane dashboard for instance $1 (read its log, record answers; roles from its repo), loopback only
After=network.target

[Service]
Type=simple
User=wl-$1
Group=wl-$1
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane dashboard --instance $1 --service
Restart=on-failure
UMask=0007
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
}

hub_unit() {
  cat <<EOF
[Unit]
Description=worklane dashboard hub: sign-in with GitHub, one view over $*, forwarding to each instance's own dashboard
After=network.target

[Service]
Type=simple
User=$viewer
Group=$viewer
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane dashboard --hub $hub_arg --service --client-id $client_id --public-url $public_url --signin-dir $signin_dir${console_user:+ --console-user $console_user}
Restart=on-failure
UMask=0007
RestartSec=10
$(hub_sandbox)

[Install]
WantedBy=multi-user.target
EOF
}

# The hub's sandbox. With the owner terminal, sudo must be able to switch users (no NoNewPrivileges), and the
# admin's shell, a child of the hub, must see the real filesystem (no read-only mounts), so both are dropped.
hub_sandbox() {
  if [ -n "$console_user" ]; then
    echo "NoNewPrivileges=no"
    return
  fi
  cat <<EOF
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(home_of "$viewer")
PrivateTmp=yes
EOF
}

# Write each unit to a dotted temp name, validate it under its real name, then move it into place.
put() {
  local file="$1" tmp="/etc/systemd/system/.$1.tmp" check
  shift
  "$@" > "$tmp"; chmod 0644 "$tmp"
  check="$(mktemp -d)/$file"; cp "$tmp" "$check"
  if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "$file invalid; nothing installed" >&2; exit 1; fi
  rm -f "$check"
  mv -f "$tmp" "/etc/systemd/system/$file"
  echo "installed /etc/systemd/system/$file"
}

wait_for() { for _ in $(seq 1 30); do [ -s "$1" ] && return 0; sleep 1; done; echo "no $1 after 30 s; see journalctl -u $2" >&2; exit 1; }

say "viewer user $viewer (runs the hub; holds no credential)"
ensure_user "$viewer"

hub_arg=""
for name in "$@"; do
  coord="wl-$name" state="$(state_of "$name")" unit="worklane-dashboard-$name.service"
  say "instance $name: its own dashboard, as $coord"
  put "$unit" dash_unit "$name"
  systemctl daemon-reload
  systemctl enable --now "$unit"
  systemctl restart "$unit"
  wait_for "$state/dashboard-token" "$unit"

  say "instance $name: $viewer may read its dashboard token, nothing else"
  refuse_if_open "$state" "grant $viewer any access"
  # Traverse only (x): $viewer can reach the token file by name, but can't list or read anything on the way.
  d="$state"
  while :; do
    setfacl -m "g:$viewer:--x" "$d"
    [ "$d" = "$(home_of "$coord")" ] && break
    d="$(dirname "$d")"
  done
  setfacl -m "g:$viewer:r--" "$state/dashboard-token"
  hub_arg="${hub_arg:+$hub_arg,}$name=$state"
done

say "the hub, as $viewer"
put worklane-dashboard-hub.service hub_unit "$@"
systemctl daemon-reload
systemctl enable --now worklane-dashboard-hub.service
systemctl restart worklane-dashboard-hub.service
hub_token_file="$(home_of "$viewer")/.local/state/worklane/dashboard-hub/dashboard-token"
wait_for "$hub_token_file" worklane-dashboard-hub.service

say "check: $viewer reads each token and nothing else"
for name in "$@"; do
  state="$(state_of "$name")"
  sudo -u "$viewer" test -r "$state/dashboard-token" || { echo "FAIL: $viewer can't read $name's token" >&2; exit 1; }
  if sudo -u "$viewer" test -r "$state/events.db" || sudo -u "$viewer" ls "$state" >/dev/null 2>&1; then echo "FAIL: $viewer can read $name's state beyond its token" >&2; exit 1; fi
  if sudo -u "$viewer" test -w "$state/dashboard-token" || sudo -u "$viewer" test -w "$state"; then echo "FAIL: $viewer can write $name's state" >&2; exit 1; fi
  echo "OK: $name"
done

echo
echo "sign-in: $public_url (people sign in with GitHub; their role on each instance is their permission on its repo)"
echo "  once: tailscale serve --bg --https=443 http://127.0.0.1:4399   (MagicDNS and HTTPS certificates on; docs/dashboard.md)"
echo "  the sign-in App's callback URL must be exactly: $public_url/auth/callback"
echo "break-glass (the owner, this machine only): http://127.0.0.1:4398/?t=<the token in $hub_token_file>"
echo "  from your laptop: ssh -N -L 4398:127.0.0.1:4398 <you>@<this-host>; never point tailscale serve at 4398"
echo "logs: journalctl -u worklane-dashboard-hub.service; journalctl -u worklane-dashboard-<name>.service"
