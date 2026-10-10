#!/usr/bin/env bash
# Once per machine, as root (review it first): engine updates without the terminal. Installs the
# updater and its timer, OFF: nothing is installed until you turn updates on (the hub's settings,
# or `sudo /usr/local/libexec/worklane-machine set-updates on` as a coordinator user once
# machine-helper.sh is set up).
#
#   bash scripts/setup/updates.sh [--checks "name,name,..."]
#
#   - /usr/local/libexec/worklane-update (root:root 0755): every 10 minutes, when on, installs main's
#     newest commit only if it fast-forwards the installed engine, every check on it is green and every
#     required check ran and passed (none missing, pending, failed or skipped), and no agent or full test
#     run is going. It builds as a throwaway unprivileged user (systemd DynamicUser) with
#     `npm ci --ignore-scripts`; root only copies the result. It restarts the worklane-*.service units and
#     rolls back if any isn't active and steady within 2 minutes.
#   - /etc/worklane/updates.json (root:root 0644): enabled (false), the repo and branch to follow (this
#     checkout's origin, main), and the required checks (--checks, or the defaults below). An existing file
#     keeps its values.
#   - /var/lib/worklane/updates.jsonl (root:root 0644): every attempt, install, refusal and rollback.
source "$(dirname "$0")/lib.sh"
as_root "$@"
checks="agentshield,dco,denylist,desktop,push-gate,scan,test (macos-latest, 22),test (macos-latest, 24),test (ubuntu-latest, 22),test (ubuntu-latest, 24),test (windows-latest, 22),test (windows-latest, 24)"
[ "${1:-}" = --checks ] && checks="${2:?--checks needs a comma-separated list}"
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
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
  node -e 'const [repo, checks] = process.argv.slice(1); process.stdout.write(JSON.stringify({ enabled: false, repo_url: repo, branch: "main", required_checks: checks.split(",").map((s) => s.trim()).filter(Boolean) }, null, 2) + "\n")' "$origin" "$checks" > /etc/worklane/.updates.json.tmp
  chmod 0644 /etc/worklane/.updates.json.tmp
  mv -f /etc/worklane/.updates.json.tmp /etc/worklane/updates.json
fi
chown root:root /etc/worklane/updates.json
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
echo "updates are $(node -e 'process.stdout.write(require("/etc/worklane/updates.json").enabled ? "ON" : "OFF")'); turn them on from the hub's settings once machine-helper.sh is set up"
