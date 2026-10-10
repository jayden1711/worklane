#!/usr/bin/env bash
# Once per machine, as root, only if an instance's dashboard says it can't
# read its service's log: keep the systemd journal on disk, split per user.
# Then each instance's coordinator user can read its own service's lines
# (journalctl -u worklane-<name>.service as that user), and no one else's.
# Nobody is added to adm or systemd-journal: those groups read every
# service's journal, other instances' included.
#   bash scripts/setup/journal.sh [<name>]   with a name, check that wl-<name> can read its lines
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:-}"
dir=/etc/systemd/journald.conf.d
conf="$dir/50-worklane-per-user.conf"
tmp="$dir/.50-worklane-per-user.conf.tmp"

say "journal kept on disk, split per user ($conf)"
install -d -m 0755 "$dir"
printf '[Journal]\nStorage=persistent\nSplitMode=uid\n' > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$conf"
# The directory journald needs for persistent storage, with the ownership and ACLs systemd expects.
install -d -m 2755 -g systemd-journal /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
journalctl --flush
echo "installed $conf; journald restarted"

if [ -n "$name" ]; then
  coord="wl-$name"
  id -u "$coord" >/dev/null 2>&1 || { echo "no $coord" >&2; exit 1; }
  say "what $coord can read of worklane-$name.service"
  # Lines logged before the restart may sit in the system journal; new ones go to the user's own file.
  n="$(run_as "$coord" 'journalctl --unit "$1" --lines 20 --no-pager --quiet --output cat | wc -l' "worklane-$name.service")"
  if [ "$n" -gt 0 ]; then echo "OK: $coord reads $n recent line(s) of its service"; else echo "none yet: check again after the service logs something (restart it: systemctl restart worklane-$name.service)"; fi
fi
