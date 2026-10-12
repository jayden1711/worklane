# macOS versions of the setup helpers, for scripts/setup/macos/*. Sourced, not run.
# Takes as_root, run_as, say, install_sudoers, machine_sudoers and refuse_if_open from ../lib.sh, and
# replaces what's Linux-only there:
#   - users and groups come from Directory Services (dscl, dseditgroup), not useradd/groupadd;
#   - root's group is wheel, not root;
#   - services are launchd daemons in /Library/LaunchDaemons, not systemd units;
#   - ACLs are set with chmod +a, not setfacl.
# Written for the bash 3.2 that macOS ships (no mapfile, no namerefs).
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

ROOT_GROUP=wheel
LAUNCH_DAEMONS=/Library/LaunchDaemons
LOG_DIR=/var/log/worklane
# Hidden service accounts: below 500, so they never show in the login window.
ID_MIN=400 ID_MAX=499

require_macos() {
  [ "$(uname -s)" = Darwin ] || { echo "these are the macOS setup scripts; on Linux use scripts/setup/*.sh" >&2; exit 1; }
}

# Re-run as root through sudo, as ../lib.sh does, without its Linux-with-systemd check.
as_root() {
  require_macos
  if [ "$(id -u)" -ne 0 ]; then exec sudo -- bash "$0" "$@"; fi
}

# A user's home, from Directory Services (macOS has no getent, which ../lib.sh's home_of uses).
home_of() {
  local h
  # || true: under pipefail an unknown user would exit here, before the message below.
  h="$(dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p' || true)"
  [ -n "$h" ] || { echo "no home for $1 in Directory Services" >&2; return 1; }
  printf '%s\n' "$h"
}

# Where the engine keeps a user's state on macOS (stateDir in src/os/index.ts), and an instance's folder.
state_root_of() { printf '%s/Library/Application Support/worklane\n' "$(home_of "$1")"; }
instance_dir_of() { printf '%s/instances/%s\n' "$(state_root_of "wl-$1")" "$1"; }

# Where instances' checkouts live: /etc/worklane/machine.json "checkouts" (machine_conf in ../lib.sh) when set,
# else /var/worklane (/srv can't be created on macOS: the system volume is read-only).
CHECKOUTS_DEFAULT=/var/worklane
checkouts_root() { machine_conf checkouts "$CHECKOUTS_DEFAULT" "$@"; }

# The lowest id from ID_MIN to ID_MAX that no user (UniqueID) or group (PrimaryGroupID) has.
free_id() {
  local used n
  used="$( { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } 2>/dev/null | awk '{print $2}')"
  for n in $(seq "$ID_MIN" "$ID_MAX"); do
    printf '%s\n' "$used" | grep -qx "$n" || { echo "$n"; return 0; }
  done
  echo "no free id from $ID_MIN to $ID_MAX for a hidden service account" >&2
  return 1
}

group_exists() { dscl . -read "/Groups/$1" PrimaryGroupID >/dev/null 2>&1; }
group_id() { dscl . -read "/Groups/$1" PrimaryGroupID | awk '{print $2}'; }

ensure_group() {
  if group_exists "$1"; then echo "group $1 exists"; return 0; fi
  local gid
  gid="$(free_id)"
  dseditgroup -o create -i "$gid" -r "worklane $1" "$1"
  echo "created group $1 ($gid)"
}

ensure_member() {
  dseditgroup -o checkmember -m "$1" "$2" >/dev/null 2>&1 || dseditgroup -o edit -a "$1" -t user "$2"
}

# A hidden service account with a private home, if it doesn't exist yet: its own primary group (as useradd
# makes on Linux; never staff, which every login user is in) and no password, so nobody logs in as it. Its
# shell is bash, as on Linux, for `sudo -iu` (credentials.sh claude).
ensure_user() {
  local u="$1" id home
  if id -u "$u" >/dev/null 2>&1; then
    echo "user $u exists"
  else
    if group_exists "$u"; then id="$(group_id "$u")"; else id="$(free_id)"; dseditgroup -o create -i "$id" -r "worklane $u" "$u"; fi
    dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$id" && { echo "id $id is taken by another user; remove group $u or pick another name" >&2; exit 1; }
    dscl . -create "/Users/$u"
    dscl . -create "/Users/$u" UniqueID "$id"
    dscl . -create "/Users/$u" PrimaryGroupID "$id"
    dscl . -create "/Users/$u" RealName "worklane $u"
    dscl . -create "/Users/$u" UserShell /bin/bash
    dscl . -create "/Users/$u" NFSHomeDirectory "/Users/$u"
    dscl . -create "/Users/$u" Password '*'
    dscl . -create "/Users/$u" IsHidden 1
    dscacheutil -flushcache
    echo "created user $u ($id)"
  fi
  home="$(home_of "$u")"
  install -d -o "$u" -g "$(id -gn "$u")" -m 0700 "$home"
  chmod 0700 "$home"
}

# ACLs, the macOS way. Linux `setfacl -m g:G:--x dir` is `search` (traverse, no listing); `g:G:r--` on a
# file is `read`. Removed first so a re-run doesn't stack duplicate entries.
acl_traverse() { chmod -a "group:$1 allow search" "$2" 2>/dev/null || true; chmod +a "group:$1 allow search" "$2"; }
acl_read() { chmod -a "group:$1 allow read" "$2" 2>/dev/null || true; chmod +a "group:$1 allow read" "$2"; }

# XML-escape a plist string.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# Install a launchd daemon safely: write a dotted temp name (launchd loads only *.plist), check it with
# plutil -lint, make it root:wheel 0644, and only then move it into place.
put_daemon() {
  local label="$1" tmp="$LAUNCH_DAEMONS/.$1.plist.tmp"
  shift
  "$@" > "$tmp"
  chown "root:$ROOT_GROUP" "$tmp"
  chmod 0644 "$tmp"
  if ! plutil -lint -s "$tmp"; then rm -f "$tmp"; echo "$label: not a valid plist; nothing installed" >&2; exit 1; fi
  mv -f "$tmp" "$LAUNCH_DAEMONS/$label.plist"
  echo "installed $LAUNCH_DAEMONS/$label.plist"
}

# (Re)load a daemon from its plist: launchd reads a plist only when it's bootstrapped.
restart_daemon() {
  local label="$1" i
  launchctl bootout "system/$label" 2>/dev/null || true
  for i in $(seq 1 20); do launchctl print "system/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl enable "system/$label"
  launchctl bootstrap system "$LAUNCH_DAEMONS/$label.plist"
}

# A log file for a daemon, owned by the user it runs as and readable by nobody else.
daemon_log() {
  install -d -o root -g "$ROOT_GROUP" -m 0755 "$LOG_DIR"
  [ -f "$LOG_DIR/$2.log" ] || install -o "$1" -g "$(id -gn "$1")" -m 0640 /dev/null "$LOG_DIR/$2.log"
  chown "$1:$(id -gn "$1")" "$LOG_DIR/$2.log"
  chmod 0640 "$LOG_DIR/$2.log"
}
