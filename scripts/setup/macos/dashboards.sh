#!/usr/bin/env bash
# Once per machine, on macOS, as root (review it first): one dashboard over several instances. Re-run it
# with the same list after adding an instance. The macOS counterpart of ../dashboards.sh, with launchd
# daemons instead of systemd units and chmod +a ACLs instead of setfacl.
#
#   - Each instance gets its own dashboard daemon, as its own coordinator user
#     (com.worklane.dashboard.<name>): the only process that reads that instance's log and records your
#     answers in it.
#   - A viewer user, wl-dash, runs the hub (com.worklane.dashboard-hub). It forwards the page's calls to
#     the selected instance's own dashboard.
#   - wl-dash gets read access to each instance's dashboard-token file, plus traverse (search: no listing)
#     on the directories above it, through ACLs. It gets nothing else: no read of any log, config or
#     credential, and no write anywhere. No instance user gets any new access.
#
#   bash scripts/setup/macos/dashboards.sh <your GitHub login> <name> [<name>...]
#
# Then from your laptop: ssh -N -L 4399:127.0.0.1:4399 <you>@<this-host> and open the URL this prints.
source "$(dirname "$0")/lib.sh"
require_macos
as_root "$@"
login="${1:?usage: dashboards.sh <your GitHub login> <name> [<name>...]}"
shift
[ "$#" -ge 1 ] || { echo "usage: dashboards.sh <your GitHub login> <name> [<name>...]" >&2; exit 2; }
[[ "$login" =~ ^[A-Za-z0-9-]+$ ]] || { echo "GitHub login: letters, digits and dashes" >&2; exit 2; }
[ -x /usr/local/bin/worklane ] || { echo "no /usr/local/bin/worklane; run engine.sh first" >&2; exit 1; }
viewer=wl-dash

state_of() { printf '%s/state\n' "$(instance_dir_of "$1")"; }
for name in "$@"; do
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name $name: lowercase letters, digits and dashes" >&2; exit 2; }
  id -u "wl-$name" >/dev/null 2>&1 || { echo "no wl-$name; run macos/instance.sh $name first" >&2; exit 1; }
  [ -d "$(state_of "$name")" ] || { echo "no state for instance $name at $(state_of "$name"); run engine.sh with it first" >&2; exit 1; }
  # An ACL on the way to the token would expose anything there that others may read: refuse first.
  refuse_if_open "$(state_of "$name")" "grant $viewer any access"
done

daemon() { # label user home args...
  local label="$1" user="$2" home="$3" a
  shift 3
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$user</string>
  <key>GroupName</key><string>$user</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/worklane</string>$(for a in "$@"; do printf '<string>%s</string>' "$(xml "$a")"; done)</array>
  <key>WorkingDirectory</key><string>$(xml "$home")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$(xml "$home")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>7</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.log</string>
</dict>
</plist>
EOF
}
dash_plist() { daemon "com.worklane.dashboard.$1" "wl-$1" "$(home_of "wl-$1")" dashboard --instance "$1" --service --user "$login"; }
hub_plist() { daemon com.worklane.dashboard-hub "$viewer" "$(home_of "$viewer")" dashboard --hub "$hub_arg" --service; }

wait_for() { local i; for i in $(seq 1 30); do [ -s "$1" ] && return 0; sleep 1; done; echo "no $1 after 30 s; see $LOG_DIR/$2.log" >&2; exit 1; }

say "viewer user $viewer (runs the hub; holds no credential)"
ensure_user "$viewer"

hub_arg=""
for name in "$@"; do
  coord="wl-$name" state="$(state_of "$name")" label="com.worklane.dashboard.$name"
  say "instance $name: its own dashboard, as $coord"
  daemon_log "$coord" "$label"
  put_daemon "$label" dash_plist "$name"
  restart_daemon "$label"
  wait_for "$state/dashboard-token" "$label"

  say "instance $name: $viewer may read its dashboard token, nothing else"
  refuse_if_open "$state" "grant $viewer any access"
  # Traverse only (search): $viewer can reach the token file by name, but can't list or read anything on the way.
  home="$(home_of "$coord")" d="$state"
  while :; do
    acl_traverse "$viewer" "$d"
    [ "$d" = "$home" ] && break
    d="$(dirname "$d")"
  done
  acl_read "$viewer" "$state/dashboard-token"
  hub_arg="${hub_arg:+$hub_arg,}$name=$state"
done

say "the hub, as $viewer"
daemon_log "$viewer" com.worklane.dashboard-hub
put_daemon com.worklane.dashboard-hub hub_plist
restart_daemon com.worklane.dashboard-hub
hub_token_file="$(state_root_of "$viewer")/dashboard-hub/dashboard-token"
wait_for "$hub_token_file" com.worklane.dashboard-hub

say "check: $viewer reads each token and nothing else"
for name in "$@"; do
  state="$(state_of "$name")"
  sudo -u "$viewer" test -r "$state/dashboard-token" || { echo "FAIL: $viewer can't read $name's token" >&2; exit 1; }
  if sudo -u "$viewer" test -r "$state/events.db" || sudo -u "$viewer" ls "$state" >/dev/null 2>&1; then echo "FAIL: $viewer can read $name's state beyond its token" >&2; exit 1; fi
  if sudo -u "$viewer" test -w "$state/dashboard-token" || sudo -u "$viewer" test -w "$state"; then echo "FAIL: $viewer can write $name's state" >&2; exit 1; fi
  echo "OK: $name"
done

echo
echo "hub: http://127.0.0.1:4399/?t=$(cat "$hub_token_file")"
echo "from your laptop: ssh -N -L 4399:127.0.0.1:4399 <you>@<this-host>, then open the hub URL above"
echo "logs: $LOG_DIR/com.worklane.dashboard-hub.log; $LOG_DIR/com.worklane.dashboard.<name>.log"
