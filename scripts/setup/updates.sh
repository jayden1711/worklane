#!/usr/bin/env bash
# Once per machine, as root (review it first): engine updates without the terminal. Installs the
# updater and its timer, OFF: nothing is installed until you turn updates on (the hub's settings,
# or `sudo /usr/local/libexec/worklane-machine set-updates on` as a coordinator user once
# machine-helper.sh is set up).
#
#   bash scripts/setup/updates.sh [--check "name" ...] [--channel release|main] [--release-hold]
#                                 [--signer <principal> ssh-ed25519 <public key>] [--confirm-signer SHA256:<fingerprint>]
#                                 [--acknowledge-signers]
#       (repeat --check for each required check)
#   bash scripts/setup/updates.sh --add-check "name" [--add-check "name" ...]
#
#   --add-check        adds required checks to an EXISTING /etc/worklane/updates.json, and does only that: it installs,
#                      restarts and enables nothing (so it never puts this checkout's updater over a newer installed
#                      one), and takes no other option. Each name is appended to required_checks after the ones there;
#                      none is removed or moved, no other key changes, and every byte of the file stays as it was but
#                      the new entries. A name already listed is said and skipped, so running it twice changes nothing.
#                      A name that is empty, has a newline or another control character, starts or ends with a space,
#                      or has unbalanced parentheses (a name split at a comma) is refused, and then nothing is changed.
#                      It prints the list before and after, and writes a dotted temp file in /etc/worklane with the
#                      file's own owner and mode, then moves it into place. With no updates.json it refuses and says to
#                      run updates.sh without --add-check first: a missing file means the updater isn't installed, and
#                      an edit-only option that installed it would be the surprise it exists to avoid.
#                      A name the defaults below don't hold gets a warning: the updater installs a commit only when every
#                      required check ran on it and passed, so a check main never runs, or runs only on pull requests
#                      (dco, ci-runner (real systemd)), means nothing is ever installed.
#
# These are an admin's, at a root shell, and go through scripts/setup/updates-root.cjs, the only code that
# writes /etc/worklane/allowed_signers (it only ever adds a line). Each is checked before anything is installed.
#   --release-hold     the one way to release the updater's hold on a commit it rolled back (besides a newer commit):
#                      it shows what was held and why, moves the hold aside and logs it. Turning updates off and on,
#                      or changing the channel (anything the dashboard or a coordinator can do), never releases a hold.
#   --channel          what the updater follows. The dashboard can only set release; main is set here.
#   --signer           adds one release signer: one line in allowed_signers, the ones there kept as they are.
#   --confirm-signer   adds the signer the dashboard's Updater setup staged (the Machine page), named by the SHA256
#                      fingerprint the page shows. It applies only a staged signer with exactly that fingerprint,
#                      staged less than 24 hours ago, prints who staged it and its principal and key, asks you to TYPE
#                      the principal (a mismatch adds nothing), and clears it from the
#                      pending list. The dashboard itself can never add a signer: this command, or --signer, does.
#   --acknowledge-signers   the updater hashes allowed_signers on every run; a change that didn't come from --signer or
#                      --confirm-signer raises an incident and holds release installs. This prints the file's hash
#                      and key fingerprints as they are now, records them, and lifts the hold. Look first.
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
#     below). An existing file keeps its values, its channel included; --add-check adds checks to it.
#   - /etc/worklane/allowed_signers (root:root 0644, yours to create: --signer, --confirm-signer, or by hand): one
#     line per key allowed to sign releases, `<email> <public key>` (git's allowed signers format). Without it the
#     release channel installs nothing.
#   - /var/lib/worklane/updates.jsonl (root:root 0644): every attempt, install, refusal and rollback.
source "$(dirname "$0")/lib.sh"
as_root "$@"
# Check names hold commas ("test (macos-latest, 22)"), so each is its own argument: nothing is ever split.
checks=()
add_checks=()
others=0   # any option but --add-check, which takes none beside it
channel=""
signer=()
confirm=""
acknowledge=""
release_hold=""
# An absolute path: node's require takes a relative one for a package name.
root_steps="$(cd "$(dirname "$0")" && pwd)/updates-root.cjs"
while [ "$#" -gt 0 ]; do
  [ "$1" = --add-check ] || others=$((others + 1))
  case "$1" in
    --add-check) [ "$#" -ge 2 ] && [[ "$2" != --* ]] || { echo "--add-check needs a check name" >&2; exit 2; }; add_checks+=("$2"); shift 2 ;;
    --check) checks+=("${2:?--check needs a check name}"); shift 2 ;;
    --channel) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--channel needs release or main" >&2; exit 2; }; channel="$2"; shift 2 ;;
    --signer) [ "$#" -ge 4 ] || { echo "--signer needs <principal> ssh-ed25519 <public key>" >&2; exit 2; }; signer=("$2" "$3" "$4"); shift 4 ;;
    --confirm-signer) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--confirm-signer needs the staged signer's fingerprint (SHA256:...)" >&2; exit 2; }; confirm="$2"; shift 2 ;;
    --acknowledge-signers) acknowledge=1; shift ;;
    --release-hold) release_hold=1; shift ;;
    --checks) echo "--checks (a comma-separated list) is gone: check names contain commas. Pass each with --check \"name\"." >&2; exit 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
if [ "${#add_checks[@]}" -gt 0 ]; then
  # The edit alone: nothing below (the updater, its units, the timer) runs.
  [ "$others" -eq 0 ] || { echo "--add-check only edits /etc/worklane/updates.json and takes no other option; run it on its own. Nothing was installed or changed." >&2; exit 2; }
  for n in "${add_checks[@]}"; do
    known=""; for d in "${UPDATE_DEFAULT_CHECKS[@]}"; do [ "$n" != "$d" ] || known=1; done
    [ -n "$known" ] || echo "WARNING: \"$n\" isn't one of the checks a batched main commit gets (UPDATE_DEFAULT_CHECKS in scripts/setup/lib.sh). The updater installs a commit only when every required check ran on it and passed: if main never runs this one, or runs it only on pull requests, nothing is ever installed." >&2
  done
  exec node "$root_steps" add-checks "${add_checks[@]}"
fi
[ "${#checks[@]}" -gt 0 ] || checks=("${UPDATE_DEFAULT_CHECKS[@]}")
# Checked before anything is installed: a channel there is, a signer of the exact shape, a fingerprint that is staged.
if [ -n "$channel" ]; then
  node "$root_steps" check channel "$channel" 2>/dev/null || { echo "--channel is release or main, not $channel" >&2; exit 2; }
fi
if [ "${#signer[@]}" -gt 0 ]; then
  node "$root_steps" check add-signer "${signer[@]}" 2>/dev/null || { echo "--signer takes one principal of an email's shape, then ssh-ed25519, then that public key (a .pub file's second word); nothing was installed or changed" >&2; exit 2; }
fi
if [ -n "$confirm" ]; then
  node "$root_steps" check confirm-signer "$confirm" || { echo "--confirm-signer takes the SHA256 fingerprint of a signer staged from the dashboard in the last 24 hours; nothing was installed or changed" >&2; exit 2; }
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
node -e 'const { unbalanced } = require(process.argv[1]); const c = JSON.parse(require("fs").readFileSync("/etc/worklane/updates.json", "utf8")).required_checks || []; const bad = c.filter(unbalanced); if (bad.length) { console.error("WARNING: /etc/worklane/updates.json required_checks has split names: " + JSON.stringify(bad) + ". Fix them by hand (or remove the file and run this again)."); }' "$root_steps" || true
chmod 0644 /etc/worklane/updates.json
cat /etc/worklane/updates.json
install -d -o root -g root -m 0755 /var/lib/worklane
[ -f /var/lib/worklane/updates.jsonl ] || install -o root -g root -m 0644 /dev/null /var/lib/worklane/updates.jsonl
chown root:root /var/lib/worklane/updates.jsonl
chmod 0644 /var/lib/worklane/updates.jsonl

say "the timer: every 10 minutes (the updater does nothing while updates are off)"
put_unit worklane-update.service "[Unit]
Description=worklane engine update: install the newest signed release or main commit (as updates.json's channel says) whose checks are green (off unless enabled)
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
  node "$root_steps" channel "$channel"
fi
if [ "${#signer[@]}" -gt 0 ]; then
  say "a release signer, added to /etc/worklane/allowed_signers (the ones already listed stay as they are)"
  node "$root_steps" add-signer "${signer[@]}"
fi
if [ -n "$confirm" ]; then
  say "the staged release signer $confirm, added to /etc/worklane/allowed_signers (the ones already listed stay as they are)"
  node "$root_steps" confirm-signer "$confirm"
fi
if [ -n "$acknowledge" ]; then
  say "the signers file, acknowledged as it is now"
  node "$root_steps" acknowledge-signers
fi
if [ -n "$release_hold" ]; then
  say "the updater's hold on a rolled-back commit, released"
  node "$root_steps" release-hold
fi
[ -f /etc/worklane/allowed_signers ] || echo "NOTE: no /etc/worklane/allowed_signers yet: the release channel installs nothing until it lists the key that signs releases (--signer <principal> ssh-ed25519 <public key>; or stage it on the Machine page's Updater setup, then --confirm-signer <its fingerprint>)"
echo "updates are $(node -e 'process.stdout.write(require("/etc/worklane/updates.json").enabled ? "ON" : "OFF")'); turn them on from the hub's settings once machine-helper.sh is set up"
