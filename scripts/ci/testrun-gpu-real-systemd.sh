#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after test-user.sh install): GPU test runs
# (docs/test-runs.md "GPU") against real systemd, the real helper and its real sudoers rule, on a runner with no GPU.
# Stand-in device nodes with NVIDIA's major (195) and, for nvidia-uvm, the driver's major from /proc/devices or a
# major nothing here registers: opening one past the cgroup check fails with ENXIO or ENODEV (no driver), never EPERM
# (the device cgroup refused it) or EACCES (a nodev mount); absent is ENOENT.
#   devices: the nodes' own group (scripts/setup/gpu-devices.sh): check says FAIL on 0666 stand-ins; apply refuses
#         the test user, the coordinator user, a user an instance's agents run as and root; apply for the owner (this
#         runner's user) and udev's step (the installed fixer) make the stand-ins root:worklane-gpu-dev 0660, as the
#         fixed driver does at boot; check then says PASS. Outside any sandbox, an agent user, the test user and the
#         coordinator get EACCES on every node (they got through on 0666: the same probe, before); the owner gets
#         through. At the end, revert takes its files away and leaves the group.
#   off:  no root file: every node absent in a run that asks for the GPU, and in one that doesn't
#   on:   root's file lists ci, GPU 0: nvidiactl, nvidia-uvm and nvidia0 present and past the cgroup check and the
#         0660 nodes' permission (the unit's own worklane-gpu-dev group; never worklane-gpu, and the lock stays out of
#         reach); nvidia1,
#         nvidia-uvm-tools, nvidia-modeset, nvidia-caps and the host's other devices absent; mknod refused; the
#         unit capped at the file's max_minutes. The other instance (not listed) still gets nothing.
#   lock: two GPU runs at once run one after the other; one that can't get the GPU by its timeout fails saying who
#         holds it; a run that doesn't ask never waits; `worklane gpu hold` takes the same lock, both ways.
#   group: the locks are root:worklane-gpu (0750 directory, 0640 locks); the root script makes the owner (this
#         runner's user) the group's one member and refuses the test user, the coordinator user and a user an
#         instance's agents run as; each of those, and any other non-member, is refused the lock (EACCES), and
#         `worklane gpu hold` tells a non-member so; the member opens and flocks it.
# Usage: bash scripts/ci/testrun-gpu-real-systemd.sh <other instance>   (as the runner user, with sudo)
set -euo pipefail
I2="${1:?the other instance (not opted in)}"
H=/usr/local/libexec/worklane-testrun
CLI="$PWD/dist/src/cli.js"
NODE="$(command -v node)"
me="$(id -un)"
# As this user again through sudo, so a group added since this job's login applies (sudo sets the user's groups anew).
as_me() { sudo -u "$me" "$@"; }
t="$(mktemp -d)"
chmod 0755 "$t"
made=()
# WHY: test-user.sh check fails on a protected path made after the install (no ACL denies it to the test user): an
# /etc/worklane this step's root script makes goes again at the end, as on a runner it never existed.
etc_was=0; [ -d /etc/worklane ] && etc_was=1
cleanup() {
  for n in ${made[@]+"${made[@]}"}; do sudo rm -f -- "$n"; done
  sudo rmdir /dev/nvidia-caps 2>/dev/null || true
  sudo bash scripts/setup/testrun-gpu.sh disable ci >/dev/null 2>&1 || true
  sudo rm -f /etc/worklane/testrun-gpu.json /etc/tmpfiles.d/worklane-gpu.conf
  sudo rm -rf /run/worklane/gpu
  sudo rmdir /run/worklane 2>/dev/null || true
  [ "$etc_was" = 1 ] || sudo rmdir /etc/worklane 2>/dev/null || true
  sudo rm -f "$(getent passwd wl-ci | cut -d: -f6)/.local/state/worklane/instances/ci/instance.yaml"
  for u in gpuagent gpuother; do sudo userdel -r "$u" 2>/dev/null || true; done
  sudo groupdel worklane-gpu 2>/dev/null || true
  sudo bash scripts/setup/gpu-devices.sh revert >/dev/null 2>&1 || true
  sudo groupdel worklane-gpu-dev 2>/dev/null || true
  rm -rf "$t"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Nothing here may be a real driver: the stand-ins prove the sandbox, not a GPU.
if awk '/^Character devices:/{c=1; next} /^$/{c=0} c && $1 == 195' /proc/devices | grep -q .; then fail "major 195 is registered here: not a GPU-less runner"; fi
uvm="$(awk '/^Character devices:/{c=1; next} /^$/{c=0} c && $2 == "nvidia-uvm" { print $1 }' /proc/devices)"
if [ -z "$uvm" ]; then
  uvm=509
  if awk '/^Character devices:/{c=1; next} /^$/{c=0} c && $1 == 509' /proc/devices | grep -q .; then fail "major 509 is registered here"; fi
fi
echo "stand-in majors: nvidia 195, nvidia-uvm $uvm"
node_() { sudo mknod -m 0666 "/dev/$1" c "$2" "$3"; made+=("/dev/$1"); }
sudo mkdir -p /dev/nvidia-caps
node_ nvidiactl 195 255
node_ nvidia0 195 0
node_ nvidia1 195 1
node_ nvidia-modeset 195 254
node_ nvidia-uvm "$uvm" 0
node_ nvidia-uvm-tools "$uvm" 1
node_ nvidia-caps/nvidia-cap1 "$uvm" 2
ls -l /dev/nvidia* /dev/nvidia-caps
other=""
for d in /dev/sda /dev/vda /dev/nvme0n1 /dev/loop0; do if [ -b "$d" ]; then other="$d"; break; fi; done
[ -n "$other" ] || fail "no block device on the host to look for"
echo "a host block device to look for in the sandbox: $other"

# The users the device group must never have: an instance's agents run as gpuagent (instance.yaml run_as, where the
# coordinator keeps it); gpuother is any other local user.
sudo useradd --create-home --shell /bin/bash gpuagent
sudo useradd --create-home --shell /bin/bash gpuother
# An instance whose agents run as gpuagent (instance.yaml run_as, where the coordinator keeps it).
ch="$(getent passwd wl-ci | cut -d: -f6)"
for d in .local .local/state .local/state/worklane .local/state/worklane/instances .local/state/worklane/instances/ci; do sudo install -d -o wl-ci -g wl-ci "$ch/$d"; done
printf 'name: ci\nrun_as:\n  agent_user: gpuagent\n  agent_home: %s\n' "$(getent passwd gpuagent | cut -d: -f6)" | sudo tee "$ch/.local/state/worklane/instances/ci/instance.yaml" > /dev/null

echo "== the nodes' own group (gpu-devices.sh): 0666 FAILs; apply for the owner alone; then 0660 root:worklane-gpu-dev"
ALL_NODES=(/dev/nvidiactl /dev/nvidia0 /dev/nvidia1 /dev/nvidia-modeset /dev/nvidia-uvm /dev/nvidia-uvm-tools /dev/nvidia-caps/nvidia-cap1)
# Each node opened read-write directly, outside any sandbox: "<node> OPENED" or "<node> <errno name>".
open_py='import errno, os, sys
for p in sys.argv[1:]:
    try:
        os.close(os.open(p, os.O_RDWR)); print(p, "OPENED")
    except OSError as e:
        print(p, errno.errorcode.get(e.errno, str(e.errno)))'
# direct <user> <file>: what that user gets opening every node (sudo sets the user's groups anew).
direct() { (cd / && sudo -u "$1" python3 -c "$open_py" "${ALL_NODES[@]}") > "$2"; }
# all_are <file> <errno names...>: every node's result is one of them.
all_are() {
  local f="$1" p e; shift
  [ "$(wc -l < "$f")" = "${#ALL_NODES[@]}" ] || { cat "$f" >&2; fail "$f: not one line per node"; }
  while read -r p e; do [[ " $* " == *" $e "* ]] || { cat "$f" >&2; fail "$f: $p is $e, not one of: $*"; }; done < "$f"
}
DENIED=(gpuagent wl-test-ci wl-ci gpuother)
# Before: the stand-ins as the driver makes them by default (root:root 0666). Every user gets past the permission check
# (ENXIO/ENODEV: no driver): what the EACCES proof below would see if the nodes stayed 0666.
for u in "${DENIED[@]}"; do direct "$u" "$t/before-$u"; all_are "$t/before-$u" ENXIO ENODEV; done
echo "  0666: ${DENIED[*]} each get past the permission check on every node"
rc=0; sudo bash scripts/setup/gpu-devices.sh check > "$t/check-before" 2>&1 || rc=$?
grep -A20 '^FAIL: ' "$t/check-before" | head -n 4
[ "$rc" = 1 ] && grep -q '^FAIL: ' "$t/check-before" || { cat "$t/check-before" >&2; fail "check on 0666 nodes: exit $rc, no FAIL line"; }
grep -q 'is root:root, not root:worklane-gpu-dev' "$t/check-before" || { cat "$t/check-before" >&2; fail "check doesn't name the 0666 nodes"; }
for u in wl-test-ci wl-ci gpuagent root; do
  if out="$(sudo bash scripts/setup/gpu-devices.sh apply --users "$me,$u" 2>&1)"; then fail "apply added $u: $out"; fi
  echo "  apply --users $me,$u: $out"
  grep -q '^refused: ' <<<"$out" || fail "apply --users $me,$u: $out"
done
if getent group worklane-gpu-dev > /dev/null; then fail "a refused apply made the group"; fi
sudo bash scripts/setup/gpu-devices.sh apply --users "$me" > "$t/apply" 2>&1 || { cat "$t/apply" >&2; fail "apply --users $me"; }
gid="$(getent group worklane-gpu-dev | cut -d: -f3)"
[ "$(getent group worklane-gpu-dev | cut -d: -f4)" = "$me" ] || fail "the device group isn't just $me: $(getent group worklane-gpu-dev)"
[ "$gid" != "$(getent group worklane-gpu | cut -d: -f3)" ] || fail "the device group is the locks' group"
grep -qx "options nvidia NVreg_DeviceFileUID=0 NVreg_DeviceFileGID=$gid NVreg_DeviceFileMode=0660" /etc/modprobe.d/worklane-gpu-devices.conf || fail "the modprobe options"
[ "$(stat -c '%U:%G %a' /etc/modprobe.d/worklane-gpu-devices.conf)" = 'root:root 644' ] || fail "the modprobe file isn't root:root 0644"
[ "$(stat -c '%U:%G %a' /etc/udev/rules.d/99-worklane-gpu-devices.rules)" = 'root:root 644' ] || fail "the udev rule isn't root:root 0644"
[ "$(stat -c '%U:%G %a' /usr/local/libexec/worklane-gpu-devices)" = 'root:root 755' ] || fail "the fixer isn't root:root 0755"
grep -q 'RUN+="/usr/local/libexec/worklane-gpu-devices"' /etc/udev/rules.d/99-worklane-gpu-devices.rules || fail "the udev rule doesn't run the fixer"
if ls -a /etc/modprobe.d /etc/udev/rules.d /usr/local/libexec | grep -q '\.tmp$'; then fail "a temp file was left"; fi
# udev's step, as on the driver's "add" (no driver here to send one): the installed fixer, as root.
sudo /usr/local/libexec/worklane-gpu-devices
for n in "${ALL_NODES[@]}"; do [ "$(stat -c '%U:%G %a' "$n")" = 'root:worklane-gpu-dev 660' ] || fail "$n is $(stat -c '%U:%G %a' "$n") after the fixer"; done
rc=0; sudo bash scripts/setup/gpu-devices.sh check > "$t/check-after" 2>&1 || rc=$?
tail -n 1 "$t/check-after"
[ "$rc" = 0 ] && tail -n 1 "$t/check-after" | grep -q '^PASS: every NVIDIA device node is root:worklane-gpu-dev' || { cat "$t/check-after" >&2; fail "check on 0660 root:worklane-gpu-dev nodes: exit $rc"; }
echo "== an agent user, the test user, the coordinator and any other user, directly: EACCES on every node"
for u in "${DENIED[@]}"; do
  id -nG "$u" | tr ' ' '\n' | grep -qx worklane-gpu-dev && fail "$u is in the device group"
  direct "$u" "$t/after-$u"; all_are "$t/after-$u" EACCES
  echo "  $u: EACCES on ${#ALL_NODES[@]} nodes"
done
direct "$me" "$t/after-me"; all_are "$t/after-me" ENXIO ENODEV
echo "  $me (the group's member): past the permission check on every node"

GRANTED=(/dev/nvidiactl /dev/nvidia-uvm /dev/nvidia0)
NEVER=(/dev/nvidia1 /dev/nvidia-uvm-tools /dev/nvidia-modeset /dev/nvidia-caps/nvidia-cap1 "$other" /dev/mem)

# What a run sees of each node: opened, or the errno's name; then whether mknod of an NVIDIA node works.
probe_py='import errno, os, sys
for p in sys.argv[1:]:
    try:
        os.close(os.open(p, os.O_RDWR)); print(p, "OPENED")
    except OSError as e:
        print(p, errno.errorcode.get(e.errno, str(e.errno)))
try:
    os.mknod(os.path.join(os.environ["TMPDIR"], "n"), 0o600 | 0o020000, os.makedev(195, 0)); print("mknod MADE")
except OSError as e:
    print("mknod", errno.errorcode.get(e.errno, str(e.errno)))
import fcntl, grp
def gname(g):
    try:
        return grp.getgrgid(g).gr_name
    except KeyError:
        return str(g)
print("groups", ",".join(sorted(gname(g) for g in set(os.getgroups()) | {os.getgid()})))
try:
    fd = os.open("/run/worklane/gpu/0.lock", os.O_RDONLY); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print("lock LOCKED")
except OSError as e:
    print("lock", errno.errorcode.get(e.errno, str(e.errno)))'
probe="printf %s $(printf %s "$probe_py" | base64 -w0) | base64 -d > \"\$TMPDIR/p.py\" && python3 \"\$TMPDIR/p.py\" ${GRANTED[*]} ${NEVER[*]}"

as_() { local i="$1"; shift; sudo -u "wl-$i" sudo -n "$H" "$i" "$@"; }
# A run of instance $1 with id $2, made as its coordinator through the helper (as the job's other steps do).
mkrun() {
  local i="$1" id="$2" r id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  r="$(mktemp -d)"
  git init -q "$r" && date +%s%N > "$r/f" && git -C "$r" add f && git -C "$r" "${id_[@]}" commit -q -m probe
  for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
  git -C "$r" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
  as_ "$i" create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
  rm -rf "$r"
}
# exec of run <id> of instance <i>: stdout to $t/<id>.out, stderr to $t/<id>.err; its exit code.
ex() {
  local i="$1" id="$2"; shift 2
  local rc=0
  as_ "$i" exec "$id" "$@" < /dev/null > "$t/$id.out" 2> "$t/$id.err" || rc=$?
  echo "$rc" > "$t/$id.rc"
  return 0
}
seen() { awk -v p="$2" '$1 == p { print $2 }' "$t/$1.out"; }
expect() { # <id> <path> <errno names...>: what the run saw of the path is one of them
  local id="$1" p="$2" got; shift 2
  got="$(seen "$id" "$p")"
  for e in "$@"; do [ "$got" = "$e" ] && { echo "  $id: $p $got"; return 0; }; done
  echo "--- $id stdout:" >&2; cat "$t/$id.out" >&2; echo "--- $id stderr:" >&2; cat "$t/$id.err" >&2
  fail "$id: $p is ${got:-not reported}, expected one of: $*"
}
wipe() { as_ "$1" wipe "$2" > /dev/null; }

echo "== off: no root file"
sudo rm -f /etc/worklane/testrun-gpu.json
for id in gpu-off-ask gpu-off-plain; do mkrun ci "$id"; done
ex ci gpu-off-ask 120 --gpu -- "$probe"
ex ci gpu-off-plain 120 -- "$probe"
for id in gpu-off-ask gpu-off-plain; do
  [ "$(cat "$t/$id.rc")" = 0 ] || { cat "$t/$id.err" >&2; fail "$id exited $(cat "$t/$id.rc")"; }
  for p in "${GRANTED[@]}" "${NEVER[@]}"; do expect "$id" "$p" ENOENT; done
  expect "$id" mknod EPERM
done
head -n 1 "$t/gpu-off-ask.err" | grep -qx 'worklane-testrun: gpu none (GPU test runs are off on this machine (no /etc/worklane/testrun-gpu.json))' || { cat "$t/gpu-off-ask.err" >&2; fail "the off line"; }
if grep -q 'worklane-testrun: gpu' "$t/gpu-off-plain.err"; then fail "a run that didn't ask got a GPU line"; fi
for id in gpu-off-ask gpu-off-plain; do wipe ci "$id"; done

echo "== on for ci, GPU 0, at most 5 min a GPU command (root's script)"
sudo bash scripts/setup/testrun-gpu.sh enable ci --devices 0 --max-minutes 5
[ "$(stat -c '%U:%G %a' /etc/worklane/testrun-gpu.json)" = 'root:root 644' ] || fail "the root file isn't root:root 0644"
[ "$(sudo stat -c '%U:%G %a' /run/worklane/gpu)" = 'root:worklane-gpu 750' ] || fail "the locks' directory isn't root:worklane-gpu 0750: $(sudo stat -c '%U:%G %a' /run/worklane/gpu)"
[ "$(sudo stat -c '%U:%G %a' /run/worklane/gpu/0.lock)" = 'root:worklane-gpu 640' ] || fail "GPU 0's lock isn't root:worklane-gpu 0640"

echo "== the locks' group: the owner alone; never an agent, test or coordinator user"
for u in wl-test-ci wl-ci gpuagent root; do
  if out="$(sudo bash scripts/setup/testrun-gpu.sh holder "$u" 2>&1)"; then fail "the script added $u to the GPU group: $out"; fi
  echo "  holder $u: $out"
  grep -q '^refused: ' <<<"$out" || fail "holder $u: $out"
done
[ -z "$(getent group worklane-gpu | cut -d: -f4)" ] || fail "the GPU group has members: $(getent group worklane-gpu)"
sudo bash scripts/setup/testrun-gpu.sh holder "$me"
[ "$(getent group worklane-gpu | cut -d: -f4)" = "$me" ] || fail "the GPU group isn't just $me: $(getent group worklane-gpu)"
# What each user gets trying the lock: open it read-only, then an exclusive flock without waiting.
try_py='import errno, fcntl, os, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY)
except OSError as e:
    print(errno.errorcode.get(e.errno, str(e.errno))); sys.exit(0)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print("LOCKED")
except OSError as e:
    print("open, flock", errno.errorcode.get(e.errno, str(e.errno)))'
for u in wl-test-ci wl-ci gpuagent gpuother; do
  got="$(sudo -u "$u" python3 -c "$try_py" /run/worklane/gpu/0.lock)"
  echo "  $u tries GPU 0's lock: $got"
  [ "$got" = EACCES ] || fail "$u got $got, not EACCES"
done
got="$(as_me python3 -c "$try_py" /run/worklane/gpu/0.lock)"
echo "  $me (the group's member) tries GPU 0's lock: $got"
[ "$got" = LOCKED ] || fail "the member got $got"
# The CLI where another user can run it (this job's checkout is in the runner's own home): the build, its
# dependencies and node, world-readable.
cli_dir="$(mktemp -d /tmp/wl-gpu-cli-XXXXXX)"
cp -r dist package.json node_modules "$cli_dir/"
cp "$NODE" "$cli_dir/node"
chmod -R a+rX "$cli_dir"
rc=0; sudo -u gpuother env -i PATH=/usr/bin:/bin HOME="$(getent passwd gpuother | cut -d: -f6)" sh -c 'cd / && exec "$1/node" "$1/dist/src/cli.js" gpu hold -- true' _ "$cli_dir" 2> "$t/hold-other.err" || rc=$?
rm -rf "$cli_dir"
echo "  gpu hold as gpuother: exit $rc: $(cat "$t/hold-other.err")"
[ "$rc" = 2 ] && grep -q '^gpu hold: only a member of the worklane-gpu group may hold a GPU' "$t/hold-other.err" || fail "gpu hold as a non-member"
for id in gpu-on-ask gpu-on-plain; do mkrun ci "$id"; done
mkrun "$I2" gpu-on-other
ex ci gpu-on-ask 600 --gpu -- "$probe"
ex ci gpu-on-plain 120 -- "$probe"
ex "$I2" gpu-on-other 120 --gpu -- "$probe"
cat "$t/gpu-on-ask.err" | head -n 3
[ "$(cat "$t/gpu-on-ask.rc")" = 0 ] || { cat "$t/gpu-on-ask.err" >&2; fail "the GPU run exited $(cat "$t/gpu-on-ask.rc")"; }
head -n 1 "$t/gpu-on-ask.err" | grep -Eqx 'worklane-testrun: gpu 0 \(devices /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia0; max 300 s; waited [0-9]+ s\)' || fail "the grant line (max 300 s: the file's 5 min under the tier's 600 s)"
for p in "${GRANTED[@]}"; do expect gpu-on-ask "$p" ENXIO ENODEV; done
# Through the 0660 nodes by the unit's own device group, never the locks' group; and no lock of its own.
g="$(seen gpu-on-ask groups)"
echo "  gpu-on-ask's groups: $g"
[[ ",$g," == *,worklane-gpu-dev,* && ",$g," != *,worklane-gpu,* ]] || fail "gpu-on-ask's groups: $g"
expect gpu-on-ask lock EACCES ENOENT
g="$(seen gpu-on-plain groups)"
[[ ",$g," != *,worklane-gpu-dev,* ]] || fail "a run that didn't ask has the device group: $g"
for p in "${NEVER[@]}"; do expect gpu-on-ask "$p" ENOENT; done
expect gpu-on-ask mknod EPERM
for p in "${GRANTED[@]}" "${NEVER[@]}"; do expect gpu-on-plain "$p" ENOENT; done
if grep -q 'worklane-testrun: gpu' "$t/gpu-on-plain.err"; then fail "a run that didn't ask got a GPU line"; fi
head -n 1 "$t/gpu-on-other.err" | grep -qx "worklane-testrun: gpu none (not on for $I2 in /etc/worklane/testrun-gpu.json)" || { cat "$t/gpu-on-other.err" >&2; fail "the other instance's line"; }
for p in "${GRANTED[@]}" "${NEVER[@]}"; do expect gpu-on-other "$p" ENOENT; done
[ -z "$(sudo cat /run/worklane/gpu/0.lock)" ] || fail "the lock's note was left"
wipe ci gpu-on-ask; wipe ci gpu-on-plain; wipe "$I2" gpu-on-other

echo "== one GPU command per GPU"
for id in gpu-lock-a gpu-lock-b gpu-lock-c gpu-lock-d; do mkrun ci "$id"; done
ex ci gpu-lock-a 120 --gpu -- 'sleep 8; date +%s' &
pa=$!
for _ in $(seq 50); do sudo grep -q . /run/worklane/gpu/0.lock && break; sleep 0.2; done
sudo grep -q '^ci/gpu-lock-a since ' /run/worklane/gpu/0.lock || fail "A's note isn't in the lock: $(sudo cat /run/worklane/gpu/0.lock)"
ex ci gpu-lock-b 60 --gpu -- 'date +%s' &
pb=$!
ex ci gpu-lock-c 60 -- 'date +%s'
c_at="$(tail -n 1 "$t/gpu-lock-c.out")"
ex ci gpu-lock-d 3 --gpu -- 'echo ran'
wait "$pa" "$pb"
a_end="$(tail -n 1 "$t/gpu-lock-a.out")"; b_at="$(tail -n 1 "$t/gpu-lock-b.out")"
echo "  A ended $a_end; B ran at $b_at; C (no GPU) ran at $c_at"
[ "$b_at" -ge "$a_end" ] || fail "B ran ($b_at) before A ended ($a_end)"
[ "$c_at" -lt "$a_end" ] || fail "C, which asked for no GPU, waited for A"
w="$(head -n 1 "$t/gpu-lock-b.err" | sed -n 's/.*; waited \([0-9]*\) s)$/\1/p')"
[ -n "$w" ] && [ "$w" -ge 3 ] || { head -n 1 "$t/gpu-lock-b.err" >&2; fail "B's line doesn't say it waited"; }
[ "$(cat "$t/gpu-lock-d.rc")" = 1 ] || fail "D, out of time waiting, exited $(cat "$t/gpu-lock-d.rc")"
head -n 1 "$t/gpu-lock-d.err" | grep -Eq '^worklane-testrun: gpu 0: still held after [0-9]+ s, the run.s timeout \(held by ci/gpu-lock-a since [0-9T:-]+Z\)$' || { cat "$t/gpu-lock-d.err" >&2; fail "D's message doesn't name A"; }
grep -q '^ran$' "$t/gpu-lock-d.out" && fail "D ran"
head -n 1 "$t/gpu-lock-d.err"
for id in gpu-lock-a gpu-lock-b gpu-lock-c gpu-lock-d; do wipe ci "$id"; done

echo "== worklane gpu hold takes the same lock"
for id in gpu-hold-e gpu-hold-f; do mkrun ci "$id"; done
as_me "$NODE" "$CLI" gpu hold -- bash -c "sleep 6; date +%s > $t/hold.end" 2> "$t/hold.err" &
ph=$!
for _ in $(seq 100); do grep -q 'holding GPU 0' "$t/hold.err" 2>/dev/null && break; sleep 0.2; done
grep -q 'gpu hold: holding GPU 0' "$t/hold.err" || { cat "$t/hold.err" >&2; fail "gpu hold didn't take GPU 0"; }
ex ci gpu-hold-e 3 --gpu -- 'echo ran'
[ "$(cat "$t/gpu-hold-e.rc")" = 1 ] || fail "a GPU run while the owner holds the GPU exited $(cat "$t/gpu-hold-e.rc")"
head -n 1 "$t/gpu-hold-e.err" | grep -Eq "^worklane-testrun: gpu 0: still held after [0-9]+ s, the run.s timeout \(held by pid [0-9]+ \($(id -un): perl\)\)" || { cat "$t/gpu-hold-e.err" >&2; fail "the GPU run doesn't name gpu hold's holder"; }
wait "$ph"
# And the other way: a GPU run holds it; gpu hold waits, saying who, then runs.
ex ci gpu-hold-f 60 --gpu -- 'sleep 6; date +%s' &
pf=$!
for _ in $(seq 50); do sudo grep -q . /run/worklane/gpu/0.lock && break; sleep 0.2; done
as_me "$NODE" "$CLI" gpu hold -- bash -c "date +%s > $t/hold2.start" 2> "$t/hold2.err"
wait "$pf"
f_end="$(tail -n 1 "$t/gpu-hold-f.out")"
grep -q "gpu hold: waiting for /run/worklane/gpu/0.lock (held by ci/gpu-hold-f since " "$t/hold2.err" || { cat "$t/hold2.err" >&2; fail "gpu hold didn't say who held the GPU"; }
[ "$(cat "$t/hold2.start")" -ge "$f_end" ] || fail "gpu hold's command ran before the GPU run ended"
for id in gpu-hold-e gpu-hold-f; do wipe ci "$id"; done
echo "== revert: its files go, the group stays"
sudo bash scripts/setup/gpu-devices.sh revert
for f in /etc/modprobe.d/worklane-gpu-devices.conf /etc/udev/rules.d/99-worklane-gpu-devices.rules /usr/local/libexec/worklane-gpu-devices; do [ ! -e "$f" ] || fail "revert left $f"; done
getent group worklane-gpu-dev > /dev/null || fail "revert removed the group"
# Nothing of this step is left for the steps after it: the sandbox's own check still passes.
cleanup
trap - EXIT
sudo bash scripts/setup/test-user.sh check ci | tail -n 1 | grep -qx 'OK: all checks passed' || { sudo bash scripts/setup/test-user.sh check ci | grep FAIL >&2; fail "test-user.sh check ci fails after this step"; }
echo "OK: GPU test runs, off and on, one per GPU, gpu hold, and the nodes' own group, on real systemd"
