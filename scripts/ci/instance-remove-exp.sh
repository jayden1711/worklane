#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after scripts/ci/exp-real-systemd.sh with
# KEEP_FOR_REMOVE=1): instance-remove.sh takes away an instance that ran a study, as root on real systemd.
#   - its study cut off mid-job: the output volume still mounted, a loop device behind it;
#   - a mount the engine didn't make, inside what goes, refuses it (nothing changed), and so does one at a job's
#     volume path that isn't that job's loop-mounted image;
#   - then every experiments user, unit, sudoers rule, root file, state and volume of ci's is gone, the egress rule no
#     longer names ci's users, its test user and its records are gone, and the other instance's are as they were.
# Usage: bash scripts/ci/instance-remove-exp.sh <other instance>   (as the runner user, with sudo)
set -euo pipefail
I2="${1:?the other instance}"
fail() { echo "FAIL: $*" >&2; exit 1; }
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
v6=/var/lib/worklane-exp/ci/jobs/ci-job-6/vol
sudo mountpoint -q "$v6" || fail "the cut-off study's volume isn't mounted"
uids="$(for u in wl-exp-ci wl-score-ci wl-test-ci wl-ci; do id -u "$u" 2>/dev/null || true; done)"
sudo grep -qxFf <(printf '%s\n' $uids) /etc/worklane/egress.users || fail "the egress rule doesn't name ci's users before"
other_view() {
  id "wl-$I2"; id "wl-test-$I2"
  sudo sha256sum "/etc/sudoers.d/worklane-$I2" "/etc/sudoers.d/worklane-test-$I2" 2>/dev/null || true
  sudo stat -c '%U:%G %a %n' "/var/lib/worklane-test/$I2"
  systemctl is-active "worklane-test-$I2-docker.service"
}
other_view > "$t/other-before"

echo "== a mount the engine didn't make refuses the removal"
x="$(getent passwd wl-ci | cut -d: -f6)/scratch-mount"
sudo install -d "$x" && sudo mount -t tmpfs -o size=1m tmpfs "$x"
fake=/var/lib/worklane-exp/ci/jobs/ci-job-7/vol
sudo install -d "$fake" && sudo mount -t tmpfs -o size=1m tmpfs "$fake"
set +e; sudo bash scripts/setup/instance-remove.sh ci --yes > "$t/r0.out" 2> "$t/r0.err"; rc=$?; set -e
cat "$t/r0.err"
[ "$rc" = 1 ] || fail "removed with a foreign mount inside (exit $rc)"
grep -qF "a filesystem is mounted at $x, inside what goes, and it is not one the engine made" "$t/r0.err" || fail "the home's mount isn't named"
grep -qF "a filesystem is mounted at $fake, inside what goes, and it is not one the engine made" "$t/r0.err" || fail "a tmpfs at a job's volume path passed for the engine's"
if grep -qF "$v6, inside" "$t/r0.err"; then fail "the study's own volume was counted as foreign"; fi
id wl-ci >/dev/null && id wl-exp-ci >/dev/null && sudo mountpoint -q "$v6" || fail "the refused removal changed something"
sudo umount "$x" "$fake"; sudo rmdir "$x" "$fake"

echo "== --print names the study's volume to unmount"
sudo bash scripts/setup/instance-remove.sh ci --print | tee "$t/print"
grep -qF "unmount  $v6 (an experiment job's output volume" "$t/print" || fail "--print doesn't name the volume"
grep -q 'run      experiments.sh remove ci' "$t/print" || fail "--print doesn't name the experiments removal"

echo "== the removal"
sudo bash scripts/setup/instance-remove.sh ci --yes 2>&1 | tee "$t/r1.out"
grep -qF "unmounted $v6" "$t/r1.out" || fail "the volume wasn't unmounted by the removal"
if findmnt -rn -o TARGET | grep -q '^/var/lib/worklane-exp/ci'; then fail "a mount of ci's is left"; fi
if sudo losetup -a | grep -q '/var/lib/worklane-exp/ci/'; then fail "a loop device on ci's image is left"; fi
for u in wl-ci wl-ci-agent wl-exp-ci wl-score-ci wl-test-ci; do if id "$u" 2>/dev/null; then fail "user $u is left"; fi; done
for p in /var/lib/worklane-exp/ci /etc/worklane/experiments/ci.json /etc/sudoers.d/worklane-exp-ci /etc/sudoers.d/worklane-ci /etc/sudoers.d/worklane-test-ci /var/lib/worklane-test/ci /etc/systemd/system/worklane-test-ci-docker.service; do
  if sudo test -e "$p"; then fail "$p is left"; fi
done
if compgen -G '/run/worklane-exp-env/ci.*' >/dev/null; then fail "a job environment file of ci's is left"; fi
if systemctl list-units --all --plain --no-legend 'worklane-exp-ci_*' | grep -q .; then fail "a job unit of ci's is left"; fi
# The egress rule names none of ci's users, and is still loaded.
for u in $uids; do
  if sudo grep -qx "$u" /etc/worklane/egress.users; then fail "the egress rule still names uid $u"; fi
  if sudo nft list table inet worklane_egress | grep -Eq "skuid (\{[^}]*\b$u\b|$u\b)"; then fail "the loaded egress rule still names uid $u"; fi
done
sudo nft list table inet worklane_egress >/dev/null || fail "the egress table isn't loaded"
# Its history: the experiment records archived, root's 0600.
a="$(sudo sh -c 'ls -1 /var/lib/worklane/removed/ci-*.experiments.tar')"
[ "$(sudo stat -c '%U %a' "$a")" = "root 600" ] || fail "the experiment records' archive isn't root's 0600"
sudo tar -tf "$a" | grep -qx 'var/lib/worklane-exp/ci/jobs/ci-job-1/record.json' || fail "job 1's record isn't archived"
sudo tar -tf "$a" | grep -qx 'etc/worklane/experiments/ci.json' || fail "root's file isn't archived"
other_view > "$t/other-after"
diff "$t/other-before" "$t/other-after" || fail "the other instance changed"

echo "== again: nothing left"
sudo bash scripts/setup/instance-remove.sh ci --yes 2>&1 | tee "$t/r2.out"
grep -q 'nothing: no user, unit, file or record of ci is left' "$t/r2.out" || fail "a rerun found something"
echo "OK: an instance that ran a study, removed whole"
