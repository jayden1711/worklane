#!/usr/bin/env bash
# CI only (ci-slow.yml, the add-project job, after the MCP broker step), as the runner user (sudo for root): the
# broker's unit runs with ProtectKernelTunables and ProtectControlGroups on (#551), and still starts its servers in
# their sandbox-runtime sandboxes (bubblewrap mounts a fresh /proc under those read-only mounts). A server the broker
# starts can write neither the kernel's tunables (/proc/sys) nor the cgroup tree:
#   - the unit as systemd runs it: both properties yes, and /proc/sys and /sys/fs/cgroup read-only mounts in the
#     broker's own mount namespace;
#   - the escape fixture's kernel server (test/fixtures/plugins/escape, server.js kernel), approved as an MCP server
#     and started by the broker as for a session (mcp-snapshot), tries to write two sysctls (each its own value back),
#     to make a child cgroup of its own and to move itself to the root cgroup, and reports each try in its tool's
#     description: every one must be denied, none WROTE.
# Needs the MCP broker step's state: the broker for the instance running and the escape plugin approved for it.
# Usage: mcp-broker-kernel.sh <instance>
set -euo pipefail

name="$1"
unit="worklane-mcp@$name.service"
E=/opt/worklane/current/dist/src
HELPER=/usr/local/libexec/worklane-machine
st="/var/lib/worklane/plugins/fetch-status/$name.json"
id=escape-kernel
p="/var/lib/worklane/plugins/previews/$name/$id/preview.json"

echo "kernel $(uname -r); $(systemctl --version | head -n 1); $(bwrap --version)"

# The unit as systemd runs it.
systemctl is-active "$unit"
[ "$(systemctl show -p ProtectKernelTunables --value "$unit")" = yes ]
[ "$(systemctl show -p ProtectControlGroups --value "$unit")" = yes ]
pid="$(systemctl show -p MainPID --value "$unit")"
[ "$pid" -gt 0 ]
# The top mount at each path (mountinfo lists stacked mounts bottom first): its mount options, field 6.
top() { sudo awk -v m="$1" '$5 == m { o = $6 } END { print o }' "/proc/$pid/mountinfo"; }
for m in /proc/sys /sys/fs/cgroup; do
  o="$(top "$m")"
  echo "the broker's $m: ${o:-not a mount}"
  case ",$o," in *,ro,*) ;; *) echo "$m is not read-only in the broker's namespace" >&2; exit 1 ;; esac
done

wait_status() { for _ in $(seq 90); do [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$1 running" ] || [ "$(sudo jq -r .id "$st" 2>/dev/null)" != "$1" ] || break; sleep 2; done; sudo jq -c . "$st"; }
digest() { (cd / && sudo -u "wl-$name" /usr/local/bin/node --input-type=module -e "import {approvalDigest} from '$E/plugins/approval.js'; import {readPreview, recordOf} from '$E/plugins/root-ops.js'; const p = readPreview(process.argv[1], process.argv[2]); console.log(approvalDigest(recordOf(p, ['builder'], {network: [], secrets: []})))" "$name" "$id"); }
confirm() { printf '%s\n' "$id" | sudo script -qec "bash /opt/worklane/current/scripts/setup/plugins.sh confirm $name $id $1" /dev/null | tail -n 1; }

# The kernel server: previewed in quarantine, approved (no network, no secrets), then started by the broker.
sudo -u "wl-$name" sudo -n "$HELPER" mcp-preview "$id" escape kernel && wait_status "$id"
d="$(digest)"
sudo -u "wl-$name" sudo -n "$HELPER" mcp-stage "$id" "$d" builder none none
confirm "$d" | grep -q "confirmed $id for $name"
sudo -u "wl-$name" sudo -n "$HELPER" mcp-snapshot "$id" && wait_status "$id"
if ! jq -e '.snapshotWithSecrets == true and .snapshot != null' "$p" > /dev/null; then
  jq -c '{snapshotError, snapshotWithSecrets}' "$p" >&2
  sudo journalctl -u "$unit" --no-pager | tail -n 30 >&2
  echo "the broker didn't start the kernel server" >&2
  exit 1
fi
tries="$(jq -r '.snapshot.tools[0].description' "$p")"
echo "$tries" | tr ' ' '\n'
for t in '/proc/sys/kernel/domainname' '/proc/sys/vm/swappiness' '/sys/fs/cgroup/.*/escaped' '/sys/fs/cgroup/cgroup.procs'; do
  echo "$tries" | tr ' ' '\n' | grep -qE "^$t=denied\(" || { echo "no denied try at $t" >&2; exit 1; }
done
if echo "$tries" | grep -q 'WROTE'; then echo "a server inside the broker wrote the kernel's tunables or the cgroup tree" >&2; exit 1; fi
echo "OK: $unit has ProtectKernelTunables and ProtectControlGroups on; the broker starts servers; a server inside it wrote neither /proc/sys nor the cgroup tree"
