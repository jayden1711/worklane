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
#   bash scripts/setup/dashboards.sh --setup --public-url https://<machine>.<tailnet>.ts.net      (first, once)
#   bash scripts/setup/dashboards.sh --setup --loopback          (first, before the machine has an https origin)
#   bash scripts/setup/dashboards.sh [--machine-owner <login>[,<login>...]] [--console-user <admin user> --console-devices <tags,names>] [--siri] [--client-id <id> --public-url https://<machine>.<tailnet>.ts.net] <name> [<name>...]
#
#   --setup: before the sign-in App exists (the hub can't start without it). Starts the hub in setup mode
#     (worklane-dashboard-hub-setup.service, as wl-dash, loopback port 4399, no instances): one page that makes the
#     sign-in App through GitHub's manifest flow and stores its client secret, client id and the public URL for wl-dash
#     only (0400), then turns itself off. Only the machine's owner gets in: the page asks for a one-time setup token from
#     a 0600 file of wl-dash's, which this prints the path of (sudo cat it; it is never printed, logged or put in a
#     URL). Refused once the sign-in secret exists. Then run this again without --setup: --client-id and --public-url
#     default to what setup mode stored. By hand instead: credentials.sh dashboard-signin, then --client-id.
#     --loopback instead of --public-url: no https origin yet (no Tailscale name). The same page and token on
#     127.0.0.1:4399, for this machine or an ssh tunnel to it (never through a proxy); its App step can't run without an
#     origin, so it shows Tailscale and HTTPS (the wizard's screen 7) first. Run --setup --public-url once there is one.
#
#   --no-instances: the hub alone, with no instance yet, for a machine's first project: add-project.sh runs it before
#     its App step, because GitHub's manifest flow comes back to the hub, and an instance's dashboard can't start
#     before its checkout exists. Takes no names, and is refused once the hub serves any instance (it would drop
#     them). add-project's last step then runs this script with the names, as before.
#
#   --machine-owner: the GitHub logins that may change the machine itself from the dashboard (the slot caps, engine
#     updates), comma-separated. Written to /etc/worklane/machine-owners.json, root:root 0644. An instance's owners
#     who aren't machine owners see the machine settings read-only. A machine change also needs a signed-in session
#     and one of the --console-devices, as the terminal does. Left out: the file is kept as it
#     is (none yet: only the break-glass may change the machine).
#
#   --console-user (console_user): the admin user the hub's owner terminal runs as. Run console-shell.sh
#     with the same user first. Without it the terminal never opens. With it, the hub's unit drops
#     NoNewPrivileges and its read-only filesystem: sudo (to start the terminal, and in it) needs both.
#   --console-devices (console_devices): the Tailscale devices the terminal may be opened from, as Tailscale
#     tags (tag:owner-laptop) and/or MagicDNS node names, comma-separated. Prefer tags you alone own in the
#     tailnet policy. Empty or missing: every device is refused. Kept in the hub's unit on this machine only.
#
#   --siri: the hub's Siri gateway (docs/siri.md), on 127.0.0.1:4397, for "Hey Siri, tell / ask" Shortcuts. wl-dash
#     may then read each instance's siri-gateway-token too (the token that works on that instance's /api/siri/ routes
#     and nowhere else; never its dashboard token). Publish it on the tailnet with tailscale.sh serve-siri (8443).
#     Each instance still needs siri.enabled in its intake.yaml, and an owner's device token. Left out: no gateway,
#     and wl-dash's read of the Siri gateway tokens is removed.
#
# Then: tailscale serve --bg --https=443 http://127.0.0.1:4399 (docs/dashboard.md).
source "$(dirname "$0")/lib.sh"
as_root "$@"
usage="usage: dashboards.sh --setup (--public-url https://<machine>.<tailnet>.ts.net | --loopback) | dashboards.sh [--machine-owner <login>[,<login>...]] [--console-user <admin user> --console-devices <tags,names>] [--siri] [--client-id <sign-in App client id> --public-url https://<machine>.<tailnet>.ts.net] <name> [<name>...] | dashboards.sh --no-instances [--client-id <id> --public-url <url>]"
client_id="" public_url="" console_user="" console_devices="" machine_owner="" machine_owner_set="" setup="" no_instances="" loopback="" siri=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --setup) setup=1; shift ;;
    --no-instances) no_instances=1; shift ;;
    --loopback) loopback=1; shift ;;
    --siri) siri=1; shift ;;
    --client-id) client_id="${2:-}"; shift 2 ;;
    --public-url) public_url="${2:-}"; shift 2 ;;
    --console-user) console_user="${2:-}"; shift 2 ;;
    --console-devices) console_devices="${2:-}"; shift 2 ;;
    --machine-owner) machine_owner="${2:-}"; machine_owner_set=1; shift 2 ;;
    --) shift; break ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ -z "$machine_owner_set" ] || machine_owners_json "$machine_owner" >/dev/null || exit 2
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

viewer=wl-dash
setup_unit=worklane-dashboard-hub-setup.service
url_ok() { [[ "$1" =~ ^https://[a-z0-9.-]+$ ]] || { echo "--public-url: the hub's https origin, as browsers reach it through tailscale serve (https://<machine>.<tailnet>.ts.net)" >&2; exit 2; }; }

if [ -n "$setup" ]; then
  # Exactly one of --public-url and --loopback.
  [ "$#" -eq 0 ] && [ -n "$public_url$loopback" ] && [ -z "$client_id$console_user$console_devices$machine_owner_set$no_instances$siri" ] && { [ -z "$public_url" ] || [ -z "$loopback" ]; } || { echo "$usage" >&2; exit 2; }
  [ -n "$loopback" ] || url_ok "$public_url"
  [ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }
  say "viewer user $viewer (runs the hub; holds no credential)"
  ensure_user "$viewer"
  signin_dir="$(home_of "$viewer")/.config/dashboard-signin"
  hub_state="$(home_of "$viewer")/.local/state/worklane/dashboard-hub"
  # Setup mode is for before the sign-in App: once its secret is in place there is nothing to set up.
  if sudo -u "$viewer" test -e "$signin_dir/client-secret"; then
    echo "the sign-in App's secret is in $signin_dir already: setup mode is off. Start the hub with it: dashboards.sh <name>..." >&2
    exit 1
  fi
  setup_unit_text() {
    cat <<EOF
[Unit]
Description=worklane dashboard hub, setup mode: makes the sign-in GitHub App, then stops (loopback only)
After=network.target

[Service]
Type=simple
User=$viewer
Group=$viewer
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane dashboard --hub-setup --service ${loopback:+--loopback}${public_url:+--public-url $public_url} --signin-dir $signin_dir
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(home_of "$viewer")
PrivateTmp=yes
EOF
  }
  put "$setup_unit" setup_unit_text
  say "the hub in setup mode, as $viewer"
  # A fresh token each run: the old one (if any) goes, and the hub writes a new one (0600) as it starts.
  rm -f "$hub_state/setup-token"
  systemctl daemon-reload
  systemctl stop "$setup_unit" 2>/dev/null || true
  systemctl start "$setup_unit"
  for _ in $(seq 1 30); do sudo -u "$viewer" test -s "$hub_state/setup-token" && break; sleep 1; done
  sudo -u "$viewer" test -s "$hub_state/setup-token" || { echo "no setup token after 30 s; see journalctl -u $setup_unit" >&2; exit 1; }
  [ "$(stat -c '%U %a' "$hub_state/setup-token")" = "$viewer 600" ] || { echo "the setup token file isn't $viewer's 0600: stopping setup mode" >&2; systemctl stop "$setup_unit"; exit 1; }
  echo
  if [ -n "$loopback" ]; then
    echo "setup-mode hub, loopback only: http://127.0.0.1:4399/"
    echo "  open it on this machine, or from your computer through: ssh -L 4399:127.0.0.1:4399 <you>@<this machine>"
    echo "  no https origin yet: the sign-in App waits for one (the page shows Tailscale and HTTPS first); then: --setup --public-url"
  else
    echo "setup-mode hub: $public_url"
    echo "  open it there: tailscale serve --bg --https=443 http://127.0.0.1:4399 first (GitHub sends the browser back to that URL)"
  fi
  echo "  the one-time setup token, for the page: sudo cat $hub_state/setup-token"
  echo "  it makes the sign-in App with GitHub, then turns itself off; then: dashboards.sh [--machine-owner <login>] <name>..."
  exit 0
fi

signin_dir="$(home_of "$viewer" 2>/dev/null || true)/.config/dashboard-signin"
# What setup mode stored, when not given: the App's client id and the hub's public URL (each wl-dash's, 0400).
if [ -z "$client_id" ] && [ -s "$signin_dir/client-id" ]; then client_id="$(cat "$signin_dir/client-id")"; fi
if [ -z "$public_url" ] && [ -s "$signin_dir/public-url" ]; then public_url="$(cat "$signin_dir/public-url")"; fi
# --no-instances: the hub alone, for a machine's first project (add-project.sh runs it before the App step). Never
# with names, and never over a hub that serves instances already: that would drop them from it.
if [ -n "$no_instances" ]; then
  [ "$#" -eq 0 ] || { echo "$usage" >&2; exit 2; }
  served="$(hub_instances | tr '\n' ' ')"
  [ -z "$served" ] || { echo "--no-instances: the hub serves ${served% } already; run dashboards.sh with them" >&2; exit 1; }
fi
{ [ "$#" -ge 1 ] || [ -n "$no_instances" ]; } && [ -n "$client_id" ] && [ -n "$public_url" ] || { echo "$usage" >&2; echo "(no --client-id or --public-url, and none stored by --setup in $signin_dir)" >&2; exit 2; }
[[ "$client_id" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "--client-id: the sign-in App's client id (letters, digits, dots, dashes)" >&2; exit 2; }
url_ok "$public_url"
if [ -n "$console_user" ]; then
  [[ "$console_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$console_user" != root && "$console_user" != wl-* ]] || { echo "console user: your admin user's login name (never root or a wl- user)" >&2; exit 2; }
  [ -x "$CONSOLE_SHELL" ] && [ -f "$CONSOLE_SUDOERS" ] || { echo "no console shell or its sudoers rule: run console-shell.sh $console_user first" >&2; exit 1; }
fi
if [ -n "$console_devices" ]; then
  [ -n "$console_user" ] || { echo "--console-devices goes with --console-user" >&2; exit 2; }
  [[ "$console_devices" =~ ^[a-z0-9:.,-]+$ ]] || { echo "--console-devices: Tailscale tags (tag:x) and/or node names, comma-separated, lowercase" >&2; exit 2; }
fi
[ -z "$console_user" ] || [ -n "$console_devices" ] || echo "note: no --console-devices, so the owner terminal refuses every device until you list yours" >&2
command -v setfacl >/dev/null || { echo "needs setfacl: install the acl package (apt install acl), then run this again" >&2; exit 1; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }
for f in client-secret session-secret; do
  [ -s "$signin_dir/$f" ] || { echo "no $signin_dir/$f: run credentials.sh dashboard-signin first" >&2; exit 1; }
done

state_of() { local coord="wl-$1"; echo "$(home_of "$coord")/.local/state/worklane/instances/$1/state"; }
for name in "$@"; do
  need_instance_name "$name"
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
Description=worklane dashboard hub: sign-in with GitHub, one view over ${*:-no instance yet}, forwarding to each instance's own dashboard
After=network.target

[Service]
Type=simple
User=$viewer
Group=$viewer
WorkingDirectory=~
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/worklane dashboard --hub $hub_arg --service --client-id $client_id --public-url $public_url --signin-dir $signin_dir${siri:+ --siri-port 4397}${console_user:+ --console-user $console_user}${console_devices:+ --console-devices $console_devices}
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


if [ -n "$machine_owner_set" ]; then
  say "machine owners: who may change the machine from the dashboard"
  install_machine_owners "$machine_owner"
fi

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
  # The Siri gateway's token (works on the instance's /api/siri/ routes only): readable by $viewer only with --siri.
  wait_for "$state/siri-gateway-token" "$unit"
  if [ -n "$siri" ]; then
    setfacl -m "g:$viewer:r--" "$state/siri-gateway-token"
  else
    setfacl -x "g:$viewer" "$state/siri-gateway-token" 2>/dev/null || true
  fi
  hub_arg="${hub_arg:+$hub_arg,}$name=$state"
done

# No instance yet: said outright to the engine (--hub -), which refuses an empty list.
hub_arg="${hub_arg:--}"
say "the hub, as $viewer"
# Setup mode is over (the sign-in secret is in place): its unit goes, and the real hub takes its port.
if [ -e "/etc/systemd/system/$setup_unit" ]; then
  systemctl disable --now "$setup_unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$setup_unit"
  echo "removed /etc/systemd/system/$setup_unit (setup mode)"
fi
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
  if [ -n "$siri" ]; then
    sudo -u "$viewer" test -r "$state/siri-gateway-token" || { echo "FAIL: $viewer can't read $name's Siri gateway token" >&2; exit 1; }
    if sudo -u "$viewer" test -w "$state/siri-gateway-token"; then echo "FAIL: $viewer can write $name's Siri gateway token" >&2; exit 1; fi
  elif sudo -u "$viewer" test -r "$state/siri-gateway-token"; then
    echo "FAIL: $viewer can read $name's Siri gateway token without --siri" >&2; exit 1
  fi
  echo "OK: $name"
done

echo
echo "sign-in: $public_url (people sign in with GitHub; their role on each instance is their permission on its repo)"
echo "  once: tailscale serve --bg --https=443 http://127.0.0.1:4399   (MagicDNS and HTTPS certificates on; docs/dashboard.md)"
echo "  the sign-in App's callback URL must be exactly: $public_url/auth/callback"
[ -z "$siri" ] || echo "Siri gateway: 127.0.0.1:4397; publish it on the tailnet once with: sudo bash scripts/setup/tailscale.sh serve-siri (https 8443; docs/siri.md)"
echo "break-glass (the owner, this machine only): http://127.0.0.1:4398/ (the page asks for the key once: it is in $hub_token_file; never put it in a URL)"
echo "  from your laptop: ssh -N -L 4398:127.0.0.1:4398 <you>@<this-host>; never point tailscale serve at 4398"
if [ -s "$MACHINE_OWNERS" ]; then echo "machine owners (may change the slot caps and engine updates): $(cat "$MACHINE_OWNERS")"; else echo "machine owners: none yet, so only the break-glass may change the machine; rerun with --machine-owner <login>"; fi
echo "logs: journalctl -u worklane-dashboard-hub.service; journalctl -u worklane-dashboard-<name>.service"
