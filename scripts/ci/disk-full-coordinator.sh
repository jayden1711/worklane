#!/usr/bin/env bash
# CI only (ci-slow.yml, the add-project job), as root: an instance's real coordinator unit on a full disk. Its state
# directory is put on a tmpfs of its own (2 GiB), the tmpfs is filled to the last byte, and the coordinator must:
#   - stay up: the same main PID, no restart (the unit is Restart=on-failure, so a crash would show as one);
#   - say in its journal that the event log can't be written, and raise a red disk_full incident for the instance;
#   - once the filler is gone: write the events it kept, in order (ticks stamped while the disk was full are in
#     events.db afterwards, ids rising with their times), say so, and resolve the incident.
# Usage: disk-full-coordinator.sh <instance>
set -euo pipefail

name="$1"
coord="wl-$name"
unit="worklane-$name.service"
st="$(getent passwd "$coord" | cut -d: -f6)/.local/state/worklane/instances/$name/state"
work="$(mktemp -d)"
test -f "$st/events.db"

# WHY: the floor (src/disk-guard.ts) is the larger of min_free_gb GiB and min_free_pct %: 1 GiB on a 2 GiB tmpfs, so an
# empty one is above it and a full one below it. The runner's own disk (the test runs' base) has far more than 1 GiB.
install -d -m 0755 /etc/worklane
printf '{"min_free_gb": 1, "min_free_pct": 0}\n' > /etc/worklane/watchdog.json

events() {
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(JSON.stringify(db.prepare("SELECT id, ts, type FROM events ORDER BY id").all()));
  ' "$st/events.db" 2>/dev/null
}
journal_since() { journalctl --no-pager -o cat -u "$unit" --since "@$1"; }
restarts() { systemctl show -p NRestarts --value "$unit"; }
pid() { systemctl show -p MainPID --value "$unit"; }
incident() {
  node -e '
    const f = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const x = f.incidents.filter((i) => i.kind === "disk_full" && i.instance === process.argv[2]).sort((a, b) => b.since.localeCompare(a.since))[0];
    process.stdout.write(x ? `${x.severity} ${x.resolvedAt ? "resolved" : "open"}` : "none");
  ' /var/lib/worklane/agent-slots/incidents.json "$name" 2>/dev/null || echo none
}
wait_for() { # <seconds> <what> <command...>
  local s="$1" what="$2"; shift 2
  for _ in $(seq 1 "$s"); do "$@" && return 0; sleep 1; done
  echo "timed out after ${s}s waiting for: $what" >&2
  return 1
}

# WHY: the dashboard holds events.db open too; with both stopped, SQLite checkpoints and removes the WAL, so the
# coordinator's next writes must grow a fresh one on the full tmpfs, as on a machine whose disk filled up.
systemctl stop "$unit" "worklane-dashboard-$name.service"
cp -a "$st/." "$work/"
mount -t tmpfs -o size=2g tmpfs "$st"
chown --reference="$work" "$st" && chmod --reference="$work" "$st"
cp -a "$work/." "$st/"
started_at="$(date +%s)"
systemctl start "$unit"
wait_for 60 'the coordinator started' bash -c "$(declare -f events); st='$st'; events | grep -q '\"coordinator.started\"'" || { journal_since "$started_at" | tail -n 40; exit 1; }
sleep 5
p0="$(pid)"; r0="$(restarts)"
echo "coordinator up: pid $p0, $r0 restarts; $(df -h "$st" | tail -n 1)"

before="$(events)"

# The disk fills up.
full_at="$(date +%s)"
dd if=/dev/zero of="$st/filler" bs=1M status=none || true
df -h "$st" | tail -n 1
wait_for 180 "the journal says the event log can't be written" bash -c "journalctl --no-pager -o cat -u '$unit' --since '@$full_at' | grep -q \"the event log can't be written\"" || { journal_since "$full_at" | tail -n 60; exit 1; }
journal_since "$full_at" | grep "the event log can't be written" | head -n 1
wait_for 30 'a red disk_full incident' bash -c "$(declare -f incident); name='$name'; [ \"\$(incident)\" = 'red open' ]" || { incident; exit 1; }
# WHY: a minute and more on a full disk, so at least one more tick runs and its events are kept, not written.
sleep 75
[ "$(pid)" = "$p0" ] && [ "$(restarts)" = "$r0" ] || { echo "the coordinator restarted on the full disk: pid $(pid) (was $p0), restarts $(restarts) (was $r0)" >&2; journal_since "$full_at" | tail -n 60; exit 1; }
systemctl is-active "$unit"

# Room again.
freed_at="$(date +%s)"
rm -f "$st/filler"
wait_for 150 'the kept events written' bash -c "journalctl --no-pager -o cat -u '$unit' --since '@$freed_at' | grep -q 'the event log is written again'" || { journal_since "$full_at" | tail -n 60; exit 1; }
journal_since "$freed_at" | grep 'the event log is written again' | head -n 1
wait_for 120 'the incident resolved' bash -c "$(declare -f incident); name='$name'; [ \"\$(incident)\" = 'red resolved' ] || [ \"\$(incident)\" = 'amber resolved' ]" || { incident; exit 1; }
[ "$(pid)" = "$p0" ] && [ "$(restarts)" = "$r0" ] || { echo "the coordinator restarted: pid $(pid) (was $p0), restarts $(restarts) (was $r0)" >&2; exit 1; }
after="$(events)"

# The events stamped while the disk was full are in the log now, after everything written before, in order.
node -e '
  const [before, after, fullAt, freedAt] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), Number(process.argv[3]) * 1000, Number(process.argv[4]) * 1000];
  const lastBefore = before.at(-1).id;
  const kept = after.filter((e) => e.id > lastBefore && Date.parse(e.ts) >= fullAt && Date.parse(e.ts) < freedAt);
  if (!kept.some((e) => e.type === "coordinator.tick")) throw new Error(`no tick stamped while the disk was full was written afterwards: ${JSON.stringify(kept)}`);
  for (let i = 1; i < after.length; i++) if (Date.parse(after[i].ts) < Date.parse(after[i - 1].ts) - 1000) throw new Error(`out of order: ${JSON.stringify(after.slice(i - 1, i + 1))}`);
  console.log(`${kept.length} events stamped while the disk was full, written afterwards in order: ${[...new Set(kept.map((e) => e.type))].join(", ")}`);
' "$before" "$after" "$full_at" "$freed_at"
systemctl is-active "$unit"
echo "the coordinator stayed up through the full disk (pid $p0, $r0 restarts) and resumed"
rm -rf "$work"
