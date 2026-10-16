#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, where coordinator users wl-ci and wl-<I2> exist):
# experiment jobs (docs/experiments.md) against real systemd, the real helper and its real sudoers rule. No GPU here:
# the GPU's binds are the test runs' (proven by testrun-gpu-real-systemd.sh) and its lock functions are theirs.
#   install: the users, the helper, the sudoers rule, root's file; check passes.
#   data:    an approved source checked against the sha256 given; a wrong sha256 installs nothing.
#   job:     build, train, predict and score as units: no network in any; train and predict can't see the labels or
#            another job's outputs or write their own workspace; the scorer can't see the workspace or the environment;
#            the record says scored, with the scorer's score.
#   seal:    the outputs are root's after; the job user can't write them.
#   caps:    a job past its minutes is stopped by systemd and recorded as stopped.
#   callers: another instance's coordinator is refused by sudoers.
# Usage: bash scripts/ci/exp-real-systemd.sh <other instance>   (as the runner user, with sudo)
set -euo pipefail
I2="${1:?the other instance}"
H=/usr/local/libexec/worklane-exp
t="$(mktemp -d)"; chmod 0755 "$t"
cleanup() { sudo bash scripts/setup/experiments.sh remove ci >/dev/null 2>&1 || true; rm -rf "$t"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
as_coord() { sudo -u wl-ci sudo -n "$H" ci "$@"; }

echo "== install"
sudo bash scripts/setup/experiments.sh install ci | tee "$t/install.log"
grep -qx OK "$t/install.log" || fail "check didn't pass after install"
[ "$(as_coord version)" = "$(sed -n 's/^PROTOCOL=\([0-9]*\)$/\1/p' scripts/machine/worklane-exp.sh)" ] || fail "protocol"

echo "== data"
mkdir -p "$t/train" "$t/inputs" "$t/labels"
printf 'a\nb\nc\n' > "$t/train/rows.txt"; printf '1\n2\n' > "$t/inputs/x.txt"; printf '3\n4\n' > "$t/labels/y.txt"
for s in train inputs labels; do
  h="$(bash scripts/setup/experiments.sh data hash "$t/$s" | sed -n 's/^sha256: //p')"
  case "$s" in train) id=train-set vis=job ;; inputs) id=eval-inputs vis=job ;; labels) id=eval-labels vis=scorer ;; esac
  if [ "$s" = train ] && sudo bash scripts/setup/experiments.sh data add ci "$id" --from "$t/$s" --sha256 "$(printf '%064d' 0)" --visibility "$vis" --yes > "$t/bad.log" 2>&1; then fail "a wrong sha256 was accepted"; fi
  [ "$s" != train ] || { grep -q 'sha256 mismatch' "$t/bad.log" || fail "no mismatch message"; [ ! -e /var/lib/worklane-exp/ci/data/train-set ] || fail "a mismatched source was installed"; }
  sudo bash scripts/setup/experiments.sh data add ci "$id" --from "$t/$s" --sha256 "$h" --visibility "$vis" --yes
done
sudo bash scripts/setup/experiments.sh set ci --devices '' --max-minutes 30 --gpu-hours 2 --output-gb 1 --yes
sudo cat /etc/worklane/experiments/ci.json

echo "== eval copy"
printf '%s\n' 'set -e; [ ! -e "$WORK" ] || { echo "the workspace is visible"; exit 1; }; [ ! -e "$ENV" ] || { echo "the env is visible"; exit 1; }; if (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; then echo "network"; exit 1; fi; n="$(cat "$LABELS"/*.txt "$PRED"/*.txt | wc -l)"; echo "score=$n.5"' > "$t/score.sh"
tree="$(cd "$t" && printf '%s  %s\n' "$(sha256sum < score.sh | cut -d' ' -f1)" score.sh | sha256sum | cut -d' ' -f1)"
sudo -u wl-ci sudo -n "$H" ci eval-put "$tree" score.sh < "$t/score.sh"
as_coord eval-seal "$tree"
if sudo -u wl-ci sudo -n "$H" ci eval-put "$tree" score.sh < "$t/score.sh" 2>/dev/null; then fail "a sealed eval was written again"; fi

echo "== a job"
r="$t/repo"; git init -q -b main "$r"
cat > "$r/train.sh" <<'EOF'
v=0
open() { if [ -e "$1" ]; then echo "visible: $1"; v=1; fi; }
open "$LABELS"; open /var/lib/worklane-exp/ci/jobs/other/out; open /var/lib/worklane-exp/ci/data/eval-labels
if (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; then echo "network"; v=1; fi
if ( : > "$WORK/written" ) 2>/dev/null; then echo "wrote the workspace"; v=1; fi
cat "${DATA%%:*}/rows.txt" > "$OUT/model" || v=1
cat "$CONFIG" >> "$OUT/model"
exit $v
EOF
git -C "$r" add train.sh && git -C "$r" -c user.email=ci@example.com -c user.name=ci commit -q -m train
sha="$(git -C "$r" rev-parse HEAD)"
git -C "$r" bundle create -q "$t/b" HEAD main
spec() {
  printf '%s\0' "STUDY=example-speed" "EVAL=$tree" "MINUTES=$1" "GPUS=0" "OUTPUT_GB=1" "WAIT_MAX=0" "LOCK=$(printf '%064d' 1)" "DATA=train-set" \
    "INPUTS=eval-inputs" "LABELS=eval-labels" "BUILD=echo built > \"\$ENV/marker\"" "PREFLIGHT=test -f train.sh" "TRAIN=$2" \
    "PREDICT=[ ! -e \"\$LABELS\" ] && cat \"\$EVAL_INPUTS\"/*.txt > \"\$PRED/p.txt\"" "SCORE=bash score.sh" 'CONFIG={"lr":0.01}' "SEED=1"
}
as_coord create ci-job-1 "$sha" < "$t/b" >/dev/null
spec 5 'bash train.sh' | as_coord job ci-job-1 | tee "$t/job1.log"
tail -1 "$t/job1.log" | grep -q '"outcome":"scored"' || { sudo sh -c 'tail -n 30 /var/lib/worklane-exp/ci/jobs/ci-job-1/logs/*.log'; fail "job 1 not scored"; }
tail -1 "$t/job1.log" | grep -q '"score":4.5' || fail "job 1's score isn't the scorer's"

echo "== sealed"
o=/var/lib/worklane-exp/ci/jobs/ci-job-1/out
[ "$(sudo stat -c '%U %G %a' "$o")" = "root wl-ci 750" ] || fail "out is $(sudo stat -c '%U %G %a' "$o")"
if sudo -u wl-exp-ci sh -c ': > "$1"' _ "$o/model" 2>/dev/null; then fail "the job user wrote a sealed output"; fi
sudo -u wl-ci cat "$o/model" | grep -q '"lr":0.01' || fail "the coordinator can't read the output"

echo "== caps"
as_coord create ci-job-2 "$sha" < "$t/b" >/dev/null
s=$(date +%s)
spec 1 'sleep 600' | as_coord job ci-job-2 | tee "$t/job2.log"
e=$(($(date +%s) - s))
tail -1 "$t/job2.log" | grep -q '"outcome":"stopped","step":"train"' || fail "job 2 not stopped at train"
[ "$e" -lt 150 ] || fail "job 2 ran $e s with a 1-minute cap"

echo "== callers"
if sudo -u "wl-$I2" sudo -n "$H" ci version 2>/dev/null; then fail "another instance's coordinator ran ci's helper"; fi
echo "OK: experiment jobs on real systemd"
