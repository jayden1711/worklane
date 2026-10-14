#!/usr/bin/env bash
# Once per machine, as root (review it first): engine updates without the terminal. Installs the
# updater and its timer, OFF: nothing is installed until you turn updates on (the hub's settings,
# or `sudo /usr/local/libexec/worklane-machine set-updates on` as a coordinator user once
# machine-helper.sh is set up).
#
#   bash scripts/setup/updates.sh [--check "name" ...] [--channel release|main] [--signer <principal> ssh-ed25519 <public key>]
#       (repeat --check for each required check)
#
# --channel and --signer are what the dashboard's Updater setup does (the Machine page), from a terminal: both go
# through the machine helper's own code (scripts/machine/worklane-machine.cjs set-update-channel, add-update-signer),
# so they check and write exactly as the page's steps do. --signer adds one line to /etc/worklane/allowed_signers and
# never removes or replaces one; --channel changes the channel in updates.json and nothing else.
#
#   - /usr/local/libexec/worklane-update (root:root 0755): every 10 minutes, when on, installs the newest
#     signed release tag (channel "release", new installs: verified with `git verify-tag` against
#     /etc/worklane/allowed_signers, which the owner creates) or main's newest commit (channel "main", what an
#     existing updates.json without a channel keeps), only if it moves forward, every check on it is green and every
#     required check ran and passed (none missing, pending, failed or skipped), and no agent or full test
#     run is going. It builds as a throwaway unprivileged user (systemd DynamicUser) with
#     `npm ci --ignore-scripts`; root only copies the result. It restarts the worklane-*.service units and
#     rolls back if any isn't active and steady within 2 minutes.
#   - /etc/worklane/updates.json (root:root 0644): enabled (false), channel ("release"), allowed_signers, the repo
#     and branch to follow (this checkout's origin, main), and the required checks (each --check, or the defaults
#     below). An existing file keeps its values, its channel included.
#   - /etc/worklane/allowed_signers (root:root 0644, yours to create: --signer, the Machine page, or by hand): one
#     line per key allowed to sign releases, `<email> <public key>` (git's allowed signers format). Without it the
#     release channel installs nothing.
#   - /var/lib/worklane/updates.jsonl (root:root 0644): every attempt, install, refusal and rollback.
source "$(dirname "$0")/lib.sh"
as_root "$@"
# Check names hold commas ("test (macos-latest, 22)"), so each is its own argument: nothing is ever split.
checks=()
channel=""
signer=()
# An absolute path: node's require takes a relative one for a package name.
helper="$(cd "$(dirname "$0")/../machine" && pwd)/worklane-machine.cjs"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) checks+=("${2:?--check needs a check name}"); shift 2 ;;
    --channel) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--channel needs release or main" >&2; exit 2; }; channel="$2"; shift 2 ;;
    --signer) [ "$#" -ge 4 ] || { echo "--signer needs <principal> ssh-ed25519 <public key>" >&2; exit 2; }; signer=("$2" "$3" "$4"); shift 4 ;;
    --checks) echo "--checks (a comma-separated list) is gone: check names contain commas. Pass each with --check \"name\"." >&2; exit 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ "${#checks[@]}" -gt 0 ] || checks=("${UPDATE_DEFAULT_CHECKS[@]}")
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
# Checked before anything is installed, by the helper's own rules: a channel it has, a signer of its exact shape.
if [ -n "$channel" ]; then
  node -e 'process.exit(require(process.argv[1]).parse(process.argv.slice(2)) ? 0 : 1)' "$helper" set-update-channel "$channel" || { echo "--channel is release or main, not $channel" >&2; exit 2; }
fi
if [ "${#signer[@]}" -gt 0 ]; then
  node -e 'process.exit(require(process.argv[1]).parseAddSigner(process.argv.slice(2)) ? 0 : 1)' "$helper" add-update-signer "${signer[@]}" || { echo "--signer takes one principal of an email's shape, then ssh-ed25519, then that public key (a .pub file's second word); nothing was installed or changed" >&2; exit 2; }
fi
command -v systemd-run >/dev/null || { echo "needs systemd" >&2; exit 1; }
[ -d /etc/worklane ] || { echo "no /etc/worklane; run machine.sh first" >&2; exit 1; }
origin="$(git -C "$(dirname "$0")" remote get-url origin)"

# Write each unit to a dotted temp name, validate it under its real name, then move it into place.
put_unit() {
  local file="$1" tmp="/etc/systemd/system/.$1.tmp" check
  printf '%s\n' "$2" > "$tmp"; chmod 0644 "$tmp"
  check="$(mktemp -d)/$file"; cp "$tmp" "$check"
  if ! systemd-analyze verify "$check"; then rm -f "$tmp" "$check"; echo "$file invalid; nothing installed" >&2; exit 1; fi
  rm -f "$check"
  mv -f "$tmp" "/etc/systemd/system/$file"
  echo "installed /etc/systemd/system/$file"
}

say "the updater, root-owned"
src="$(dirname "$0")/../machine/worklane-update.cjs"
# The temp name ends in .cjs: node --check refuses an unknown extension such as .tmp.
tmp=/usr/local/libexec/.worklane-update.tmp.cjs
install -d -o root -g root -m 0755 /usr/local/libexec
rm -f /usr/local/libexec/.worklane-update.tmp   # left by an earlier run that failed on that name
install -o root -g root -m 0755 "$src" "$tmp"
node --check "$tmp"
mv -f "$tmp" /usr/local/libexec/worklane-update
echo "installed /usr/local/libexec/worklane-update"

say "its config (off) and log"
if [ ! -f /etc/worklane/updates.json ]; then
  updates_config_json "$origin" "${checks[@]}" > /etc/worklane/.updates.json.tmp
  chmod 0644 /etc/worklane/.updates.json.tmp
  mv -f /etc/worklane/.updates.json.tmp /etc/worklane/updates.json
fi
chown root:root /etc/worklane/updates.json
# A file written by the comma-splitting version holds fragments like "test (macos-latest" and "22)",
# which never match a real check: the updater would wait forever. Say so (the file is kept as it is).
node -e 'const c = JSON.parse(require("fs").readFileSync("/etc/worklane/updates.json", "utf8")).required_checks || []; const bad = c.filter((n) => (n.match(/\(/g) || []).length !== (n.match(/\)/g) || []).length); if (bad.length) { console.error("WARNING: /etc/worklane/updates.json required_checks has split names: " + JSON.stringify(bad) + ". Fix them by hand (or remove the file and run this again)."); }' || true
chmod 0644 /etc/worklane/updates.json
cat /etc/worklane/updates.json
install -d -o root -g root -m 0755 /var/lib/worklane
[ -f /var/lib/worklane/updates.jsonl ] || install -o root -g root -m 0644 /dev/null /var/lib/worklane/updates.jsonl
chown root:root /var/lib/worklane/updates.jsonl
chmod 0644 /var/lib/worklane/updates.jsonl

say "the timer: every 10 minutes (the updater does nothing while updates are off)"
put_unit worklane-update.service "[Unit]
Description=worklane engine update: install main when it fast-forwards and its checks are green (off unless enabled)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/worklane-update
Environment=PATH=/usr/local/bin:/usr/bin:/bin
TimeoutStartSec=50min"
put_unit worklane-update.timer "[Unit]
Description=worklane engine update check, every 10 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target"
systemctl daemon-reload
systemctl enable --now worklane-update.timer
systemctl list-timers worklane-update.timer --no-pager
if [ -n "$channel" ]; then
  say "the channel: $channel"
  node "$helper" set-update-channel "$channel"
fi
if [ "${#signer[@]}" -gt 0 ]; then
  say "a release signer, added to /etc/worklane/allowed_signers (the ones already listed stay as they are)"
  node "$helper" add-update-signer "${signer[@]}"
fi
[ -f /etc/worklane/allowed_signers ] || echo "NOTE: no /etc/worklane/allowed_signers yet: the release channel installs nothing until it lists the key that signs releases (--signer <principal> ssh-ed25519 <public key>, or the Machine page's Updater setup)"
echo "updates are $(node -e 'process.stdout.write(require("/etc/worklane/updates.json").enabled ? "ON" : "OFF")'); turn them on from the hub's settings once machine-helper.sh is set up"
