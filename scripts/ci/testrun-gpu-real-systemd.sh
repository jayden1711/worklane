#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after test-user.sh install): GPU test runs
# (docs/test-runs.md "GPU") against real systemd, the real helper and its real sudoers rule, on a runner with no GPU.
# Stand-in device nodes with NVIDIA's major (195) and, for nvidia-uvm, the driver's major from /proc/devices or a
# major nothing here registers: opening one past the cgroup check fails with ENXIO or ENODEV (no driver), never EPERM
# (the device cgroup refused it) or EACCES (a nodev mount); absent is ENOENT.
#   off:  no root file: every node absent in a run that asks for the GPU, and in one that doesn't
#   on:   root's file lists ci, GPU 0: nvidiactl, nvidia-uvm and nvidia0 present and past the cgroup check; nvidia1,
#         nvidia-uvm-tools, nvidia-modeset, nvidia-caps and the host's other devices absent; mknod refused; the
#         unit capped at the file's max_minutes. The other instance (not listed) still gets nothing.
#   lock: two GPU runs at once run one after the other; one that can't get the GPU by its timeout fails saying who
#         holds it; a run that doesn't ask never waits; `worklane gpu hold` takes the same lock, both ways.
# Usage: bash scripts/ci/testrun-gpu-real-systemd.sh <other instance>   (as the runner user, with sudo)
set -euo pipefail
I2="${1:?the other instance (not opted in)}"
H=/usr/local/libexec/worklane-testrun
CLI="$PWD/dist/src/cli.js"
t="$(mktemp -d)"
chmod 0755 "$t"
made=()
cleanup() {
  for n in ${made[@]+"${made[@]}"}; do sudo rm -f -- "$n"; done
  sudo rmdir /dev/nvidia-caps 2>/dev/null || true
  sudo bash scripts/setup/testrun-gpu.sh disable ci >/dev/null 2>&1 || true
  sudo rm -f /etc/worklane/testrun-gpu.json /etc/tmpfiles.d/worklane-gpu.conf
  sudo rm -rf /run/worklane/gpu
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
    print("mknod", errno.errorcode.get(e.errno, str(e.errno)))'
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
[ "$(stat -c '%U:%G %a' /run/worklane/gpu/0.lock)" = 'root:root 644' ] || fail "GPU 0's lock isn't root:root 0644"
for id in gpu-on-ask gpu-on-plain; do mkrun ci "$id"; done
mkrun "$I2" gpu-on-other
ex ci gpu-on-ask 600 --gpu -- "$probe"
ex ci gpu-on-plain 120 -- "$probe"
ex "$I2" gpu-on-other 120 --gpu -- "$probe"
cat "$t/gpu-on-ask.err" | head -n 3
[ "$(cat "$t/gpu-on-ask.rc")" = 0 ] || { cat "$t/gpu-on-ask.err" >&2; fail "the GPU run exited $(cat "$t/gpu-on-ask.rc")"; }
head -n 1 "$t/gpu-on-ask.err" | grep -Eqx 'worklane-testrun: gpu 0 \(devices /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia0; max 300 s; waited [0-9]+ s\)' || fail "the grant line (max 300 s: the file's 5 min under the tier's 600 s)"
for p in "${GRANTED[@]}"; do expect gpu-on-ask "$p" ENXIO ENODEV; done
for p in "${NEVER[@]}"; do expect gpu-on-ask "$p" ENOENT; done
expect gpu-on-ask mknod EPERM
for p in "${GRANTED[@]}" "${NEVER[@]}"; do expect gpu-on-plain "$p" ENOENT; done
if grep -q 'worklane-testrun: gpu' "$t/gpu-on-plain.err"; then fail "a run that didn't ask got a GPU line"; fi
head -n 1 "$t/gpu-on-other.err" | grep -qx "worklane-testrun: gpu none (not on for $I2 in /etc/worklane/testrun-gpu.json)" || { cat "$t/gpu-on-other.err" >&2; fail "the other instance's line"; }
for p in "${GRANTED[@]}" "${NEVER[@]}"; do expect gpu-on-other "$p" ENOENT; done
[ -z "$(cat /run/worklane/gpu/0.lock)" ] || fail "the lock's note was left"
wipe ci gpu-on-ask; wipe ci gpu-on-plain; wipe "$I2" gpu-on-other

echo "== one GPU command per GPU"
for id in gpu-lock-a gpu-lock-b gpu-lock-c gpu-lock-d; do mkrun ci "$id"; done
ex ci gpu-lock-a 120 --gpu -- 'sleep 8; date +%s' &
pa=$!
for _ in $(seq 50); do grep -q . /run/worklane/gpu/0.lock && break; sleep 0.2; done
grep -q '^ci/gpu-lock-a since ' /run/worklane/gpu/0.lock || fail "A's note isn't in the lock: $(cat /run/worklane/gpu/0.lock)"
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
node "$CLI" gpu hold -- bash -c "sleep 6; date +%s > $t/hold.end" 2> "$t/hold.err" &
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
for _ in $(seq 50); do grep -q . /run/worklane/gpu/0.lock && break; sleep 0.2; done
node "$CLI" gpu hold -- bash -c "date +%s > $t/hold2.start" 2> "$t/hold2.err"
wait "$pf"
f_end="$(tail -n 1 "$t/gpu-hold-f.out")"
grep -q "gpu hold: waiting for /run/worklane/gpu/0.lock (held by ci/gpu-hold-f since " "$t/hold2.err" || { cat "$t/hold2.err" >&2; fail "gpu hold didn't say who held the GPU"; }
[ "$(cat "$t/hold2.start")" -ge "$f_end" ] || fail "gpu hold's command ran before the GPU run ended"
for id in gpu-hold-e gpu-hold-f; do wipe ci "$id"; done
echo "OK: GPU test runs, off and on, one per GPU, and gpu hold, on real systemd"
