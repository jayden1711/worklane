#!/usr/bin/env bash
# CI only (ci-slow.yml, the add-project job, after the MCP broker step), as the runner user (sudo for root): the
# broker's unit runs with ProtectControlGroups on (#551) and still starts its servers in their sandbox-runtime
# sandboxes, and a server the broker starts can write neither the kernel's tunables (/proc/sys) nor the cgroup tree:
#   - what bubblewrap says when started as sandbox-runtime starts it (a fresh /proc in its own user and PID
#     namespaces), as the broker's user in a transient unit with ProtectKernelTunables, with ProtectControlGroups,
#     and with neither: printed, not checked (why the unit has the one and not the other);
#   - the unit as systemd runs it: ProtectControlGroups yes, and /sys/fs/cgroup a read-only mount in the broker's own
#     mount namespace;
#   - the escape fixture's kernel server (test/fixtures/plugins/escape, server.js kernel), approved as an MCP server
#     and started by the broker as for a session (mcp-snapshot), tries to write two sysctls (each its own value back),
#     to make a child cgroup of its own and to move itself to the root cgroup, and reports each try in its tool's
#     description, with how /proc/sys and /sys/fs/cgroup are mounted where it runs: every try denied, none WROTE, and
#     /sys/fs/cgroup read-only.
# Needs the MCP broker step's state: the broker for the instance running and the escape plugin approved for it.
# Usage: mcp-broker-kernel.sh <instance>
set -euo pipefail

name="$1"
mcp="wl-$name-mcp"
unit="worklane-mcp@$name.service"
E=/opt/worklane/current/dist/src
HELPER=/usr/local/libexec/worklane-machine
st="/var/lib/worklane/plugins/fetch-status/$name.json"
id=escape-kernel
p="/var/lib/worklane/plugins/previews/$name/$id/preview.json"
bwrap="$(command -v bwrap)"

echo "kernel $(uname -r); $(systemctl --version | head -n 1); $("$bwrap" --version)"

# What bubblewrap says under each directive alone, and under neither, as the broker's user. Printed only.
for prop in none ProtectKernelTunables ProtectControlGroups; do
  props=(-p User="$mcp" -p NoNewPrivileges=yes)
  [ "$prop" = none ] || props+=(-p "$prop=yes")
  if out="$(sudo systemd-run --quiet --wait --pipe --collect "${props[@]}" "$bwrap" --ro-bind / / --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc /bin/echo started 2>&1)"; then
    echo "bwrap with a fresh /proc, $prop: $out"
  else
    echo "bwrap with a fresh /proc, $prop: failed: $out"
  fi
done

# The unit as systemd runs it.
systemctl is-active "$unit"
[ "$(systemctl show -p ProtectControlGroups --value "$unit")" = yes ]
echo "ProtectKernelTunables: $(systemctl show -p ProtectKernelTunables --value "$unit")"
pid="$(systemctl show -p MainPID --value "$unit")"
[ "$pid" -gt 0 ]
# The top mount at /sys/fs/cgroup (mountinfo lists stacked mounts bottom first): its mount options, field 6.
o="$(sudo awk '$5 == "/sys/fs/cgroup" { o = $6 } END { print o }' "/proc/$pid/mountinfo")"
echo "the broker's /sys/fs/cgroup: ${o:-not a mount}"
case ",$o," in *,ro,*) ;; *) echo "/sys/fs/cgroup is not read-only in the broker's namespace" >&2; exit 1 ;; esac

wait_status() { for _ in $(seq 90); do [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$1 running" ] || [ "$(sudo jq -r .id "$st" 2>/dev/null)" != "$1" ] || break; sleep 2; done; sudo jq -c . "$st"; }
digest() { (cd / && sudo -u "wl-$name" /usr/local/bin/node --input-type=module -e "import {approvalDigest} from '$E/plugins/approval.js'; import {readPreview, recordOf} from '$E/plugins/root-ops.js'; const p = readPreview(process.argv[1], process.argv[2]); console.log(approvalDigest(recordOf(p, ['builder'], {network: [], secrets: []})))" "$name" "$id"); }
confirm() { printf '%s\n' "$id" | sudo script -qec "bash /opt/worklane/current/scripts/setup/plugins.sh confirm $name $id $1" /dev/null | tail -n 1; }
# WHY: a failed preview's reason (say "plugin escape has no MCP server kernel", from a fixture older than the step) is
# only in its unit's journal (worklane-machine starts mcp-preview as worklane-plugin-fetch-<instance>); without this,
# the step went on to readPreview's misleading "no preview of escape-kernel for ci: fetch it first" (#631).
preview_done() { [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$1 done" ] && return 0; { sudo journalctl -u "worklane-plugin-fetch-$name.service" --no-pager | tail -n 30 >&2; } || true; echo "the preview of $1 didn't finish: $(sudo jq -c . "$st" 2>/dev/null || echo 'no status')" >&2; return 1; }

# The kernel server: previewed in quarantine, approved (no network, no secrets), then started by the broker.
sudo -u "wl-$name" sudo -n "$HELPER" mcp-preview "$id" escape kernel && wait_status "$id"
preview_done "$id"
d="$(digest)"
sudo -u "wl-$name" sudo -n "$HELPER" mcp-stage "$id" "$d" builder none none
confirm "$d" | grep -q "confirmed $id for $name"
sudo -u "wl-$name" sudo -n "$HELPER" mcp-snapshot "$id"
# WHY: not wait_status. The status file still says "$id done" from the preview above until the snapshot's unit writes
# "running", so wait_status would return at once. The snapshot's own mark is its preview's snapshotWithSecrets (set
# with a snapshot or with the broker's error); a failure before that is "$id failed".
for _ in $(seq 90); do
  sudo jq -e '.snapshotWithSecrets == true' "$p" > /dev/null 2>&1 && break
  [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$id failed" ] && break
  sleep 2
done
sudo jq -c . "$st"
if ! jq -e '.snapshotWithSecrets == true and .snapshot != null' "$p" > /dev/null; then
  jq -c '{snapshotError, snapshotWithSecrets}' "$p" >&2
  sudo journalctl -u "$unit" --no-pager | tail -n 30 >&2
  echo "the broker didn't start the kernel server" >&2
  exit 1
fi
tries="$(jq -r '.snapshot.tools[0].description' "$p" | tr ' ' '\n')"
echo "$tries"
for t in '/proc/sys/kernel/domainname=denied\(' '/proc/sys/vm/swappiness=denied\(' '/sys/fs/cgroup/.*/escaped=denied\(' '/sys/fs/cgroup/cgroup.procs=denied\(' '/sys/fs/cgroup:mount=ro$'; do
  echo "$tries" | grep -qE "^$t" || { echo "nothing matches $t" >&2; exit 1; }
done
if echo "$tries" | grep -q 'WROTE'; then echo "a server inside the broker wrote the kernel's tunables or the cgroup tree" >&2; exit 1; fi
echo "OK: $unit has ProtectControlGroups on; the broker starts servers; a server inside it wrote neither /proc/sys nor the cgroup tree, and sees the cgroup tree read-only"
