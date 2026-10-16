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
#   egress:  the host rule blocks the job and scorer users even with no PrivateNetwork (a unit run without it), and
#            only because of the rule (reverted, the same probe gets out; applied again, blocked).
#   quota:   a job writing past its output quota is stopped by the kernel (ENOSPC on its volume) and recorded so.
#   timing:  a timing metric is the helper's clock; the job printing a "score" or a time changes nothing.
#   canary:  one job tries each boundary once (network, the scorer's eval copy, the labels, another job's outputs, the
#            GPU lock, lifting its own timeout, starting a job through the helper); every attempt must fail.
# Usage: bash scripts/ci/exp-real-systemd.sh <other instance>   (as the runner user, with sudo)
set -euo pipefail
I2="${1:?the other instance}"
H=/usr/local/libexec/worklane-exp
t="$(mktemp -d)"; chmod 0755 "$t"
cleanup() { sudo bash scripts/setup/experiments.sh remove ci >/dev/null 2>&1 || true; sudo bash scripts/setup/egress-firewall.sh revert >/dev/null 2>&1 || true; sudo rmdir /run/worklane/gpu 2>/dev/null || true; rm -rf "$t"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
as_coord() { sudo -u wl-ci sudo -n "$H" ci "$@"; }

command -v nft >/dev/null 2>&1 || sudo apt-get install -y -q nftables >/dev/null
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
sudo bash scripts/setup/experiments.sh set ci --devices '' --max-minutes 20 --gpu-hours 2 --output-gb 1 --tasks-max 256 --memory-gb 2 --cpu-cores 1 --yes
sudo cat /etc/worklane/experiments/ci.json

echo "== eval copy"
printf '%s\n' 'set -e; [ ! -e "$WORK" ] || { echo "the workspace is visible"; exit 1; }; [ ! -e "$ENV" ] || { echo "the env is visible"; exit 1; }; if (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; then echo "network"; exit 1; fi; n="$(cat "$LABELS"/*.txt "$PRED"/*.txt | wc -l)"; echo "score=$n.5"' > "$t/score.sh"
# One scorer for the four study kinds (each the same contract: predictions out, scored apart against what only the
# scorer reads): supervised (CSV vs the labels), self-supervised (an .npy of predicted futures vs the targets),
# unsupervised (JSON cluster assignments, purity against the labels), generative (JSONL samples, the share found in the
# reference set). Plain python3, no numpy: the .npy is read from its header and raw floats.
cat > "$t/score.py" <<'PY'
import json, os, struct, sys
P, L = os.environ["PRED"], os.environ["LABELS"]
truth = [l.strip() for l in open(os.path.join(L, "y.txt")) if l.strip()]
f = sorted(os.listdir(P))[0]
x = os.path.join(P, f)
if f.endswith(".csv"):
    rows = [l.strip().split(",")[1] for l in open(x)][1:]
    s = sum(a == b for a, b in zip(rows, truth))
elif f.endswith(".npy"):
    b = open(x, "rb").read(); n = struct.unpack("<H", b[8:10])[0]; v = struct.unpack("<%dd" % ((len(b) - 10 - n) // 8), b[10 + n:])
    s = sum((a - float(t)) ** 2 for a, t in zip(v, truth)) / len(truth)
elif f.endswith(".json"):
    a = json.load(open(x)); groups = {}
    for i, t in enumerate(truth): groups.setdefault(a[str(i)], []).append(t)
    s = sum(max(g.count(t) for t in set(g)) for g in groups.values()) / len(truth)
elif f.endswith(".jsonl"):
    xs = [json.loads(l)["text"] for l in open(x) if l.strip()]
    s = sum(v in truth for v in xs) / len(xs)
else:
    sys.exit("unknown predictions " + f)
print("score=%g" % s)
PY
mkdir -p "$t/eval"; cp "$t/score.sh" "$t/score.py" "$t/eval/"
tree="$(cd "$t/eval" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r p; do printf '%s  %s\n' "$(sha256sum < "$p" | cut -d' ' -f1)" "$p"; done | sha256sum | cut -d' ' -f1)"
for f in score.sh score.py; do sudo -u wl-ci sudo -n "$H" ci eval-put "$tree" "$f" < "$t/eval/$f"; done
as_coord eval-seal "$tree"
printf '%s\n' 'cat "$EVAL_INPUTS"/*.txt > "$PRED/p.txt"' > "$t/predict.sh"
ptree="$(cd "$t" && printf '%s  %s\n' "$(sha256sum < predict.sh | cut -d' ' -f1)" predict.sh | sha256sum | cut -d' ' -f1)"
sudo -u wl-ci sudo -n "$H" ci eval-put "$ptree" predict.sh < "$t/predict.sh"
as_coord eval-seal "$ptree"
if sudo -u wl-ci sudo -n "$H" ci eval-put "$tree" score.sh < "$t/eval/score.sh" 2>/dev/null; then fail "a sealed eval was written again"; fi

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
  printf '%s\0' "STUDY=example-speed" "EVAL=$tree" "PREDICT_EVAL=$ptree" "METRIC=${3:-score}" "MINUTES=$1" "GPUS=0" "OUTPUT_GB=1" "WAIT_MAX=0" "LOCK=$(printf '%064d' 1)" "DATA=train-set" \
    "INPUTS=eval-inputs" "LABELS=eval-labels" "BUILD=echo built > \"\$ENV/marker\"" "PREFLIGHT=test -f train.sh" "TRAIN=$2" \
    "PREDICT=${4:-[ ! -e \"\$LABELS\" ] && [ ! -e \"\$EVAL_CODE/score.sh\" ] && bash \"\$EVAL_CODE/predict.sh\"}" "SCORE=${5:-bash score.sh}" 'CONFIG={"lr":0.01}' "SEED=1"
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
echo "== egress"
probe='exec 3<>/dev/tcp/1.1.1.1/443'
timeout 10 bash -c "$probe" || fail "this runner can't reach 1.1.1.1:443 itself, so the egress proof would prove nothing"
# The one mutation: a unit as the job user without PrivateNetwork. Only the host rule stands in the way.
nopn() { sudo systemd-run --wait --pipe --quiet --uid="$1" -p PrivateNetwork=no -p RuntimeMaxSec=20 /usr/bin/timeout 10 /bin/bash -c "$probe"; }
for u in wl-exp-ci wl-score-ci; do if nopn "$u" 2>/dev/null; then fail "$u reached 1.1.1.1:443 with the egress rule loaded"; fi; done
sudo bash scripts/setup/egress-firewall.sh revert >/dev/null
nopn wl-exp-ci || fail "with the rule reverted wl-exp-ci still can't get out: the proof above didn't test the rule"
sudo bash scripts/setup/egress-firewall.sh apply >/dev/null
if nopn wl-exp-ci 2>/dev/null; then fail "wl-exp-ci got out after apply"; fi
timeout 10 bash -c "$probe" || fail "the rule blocked the runner user too: it must cover the sandbox users only"
sudo -u wl-ci timeout 10 bash -c "$probe" || fail "the rule blocked the coordinator user: the controller stays outside it"
echo "egress: blocked for wl-exp-ci and wl-score-ci with PrivateNetwork off; open for the runner and the coordinator"

echo "== quota"
as_coord create ci-job-3 "$sha" < "$t/b" >/dev/null
spec 5 'dd if=/dev/zero of="$OUT/big" bs=1M count=1500 status=none' | as_coord job ci-job-3 | tee "$t/job3.log"
tail -1 "$t/job3.log" | grep -q '"outcome":"crashed","step":"train"' || fail "job 3 wrote past its quota"
sudo grep -q 'No space left on device' /var/lib/worklane-exp/ci/jobs/ci-job-3/logs/train.log || fail "job 3 wasn't stopped by the volume (ENOSPC)"
kb="$(tail -1 "$t/job3.log" | sed -n 's/.*"output_kb":\([0-9]*\).*/\1/p')"; [ "$kb" -le 1048576 ] || fail "job 3's output is $kb KB, over 1 GB"

echo "== timing"
as_coord create ci-job-4 "$sha" < "$t/b" >/dev/null
spec 5 'echo "score=0"; echo "predict_ms=1"; true' predict_ms | as_coord job ci-job-4 | tee "$t/job4.log"
rec4="$(tail -1 "$t/job4.log")"
p_ms="$(sed -n 's/.*"predict_ms":\([0-9]*\).*/\1/p' <<<"$rec4")"
grep -q "\"score\":$p_ms," <<<"$rec4" || fail "a timing metric isn't the helper's own predict_ms ($rec4)"

echo "== kinds"
# Labels "3" and "4": each kind's predictions (a script in the job's repo), scored by the one scorer through the gate.
cat > "$r/pred-supervised.sh" <<'EOF'
printf 'id,label\n0,3\n1,9\n' > "$PRED/p.csv"
EOF
cat > "$r/pred-self_supervised.sh" <<'EOF'
python3 -c 'import os, struct
h = "{\x27descr\x27: \x27<f8\x27, \x27fortran_order\x27: False, \x27shape\x27: (2,), }"
h = h + " " * (117 - len(h)) + "\n"
open(os.environ["PRED"] + "/f.npy", "wb").write(b"\x93NUMPY\x01\x00" + struct.pack("<H", len(h)) + h.encode() + struct.pack("<2d", 3.0, 5.0))'
EOF
cat > "$r/pred-unsupervised.sh" <<'EOF'
printf '{"0": 0, "1": 1}' > "$PRED/c.json"
EOF
cat > "$r/pred-generative.sh" <<'EOF'
printf '{"text": "3"}\n{"text": "7"}\n' > "$PRED/s.jsonl"
EOF
git -C "$r" add pred-*.sh && git -C "$r" -c user.email=ci@example.com -c user.name=ci commit -q -m kinds
shak="$(git -C "$r" rev-parse HEAD)"; git -C "$r" bundle create -q "$t/bk" HEAD main
k=10
for kind in supervised:1 self_supervised:0.5 unsupervised:1 generative:0.5; do
  name="${kind%%:*}" want="${kind#*:}"
  k=$((k + 1))
  as_coord create "ci-kind-$k" "$shak" < "$t/bk" >/dev/null
  spec 5 'true' score "bash pred-$name.sh" 'python3 score.py' | as_coord job "ci-kind-$k" | tee "$t/kind-$k.log"
  tail -1 "$t/kind-$k.log" | grep -q "\"outcome\":\"scored\",\"step\":null,\"score\":$want," || { sudo sh -c "tail -n 20 /var/lib/worklane-exp/ci/jobs/ci-kind-$k/logs/*.log"; fail "the $name fixture didn't score $want"; }
  echo "kind $name: scored $want"
done

echo "== canary"
sudo install -d -o root -g root -m 0750 /run/worklane/gpu
cat > "$t/canary.sh" <<EOF
try() { if ( eval "\$2" ) >/dev/null 2>&1; then echo "ESCAPED \$1"; else echo "BLOCKED \$1"; fi; }
try network 'exec 3<>/dev/tcp/1.1.1.1/443'
try eval-files 'cat /var/lib/worklane-exp/ci/evals/$tree/files/score.sh'
try labels 'cat "\$LABELS"/y.txt'
try other-outputs 'cat /var/lib/worklane-exp/ci/jobs/ci-job-1/out/model'
try gpu-lock 'ls /run/worklane/gpu'
try own-timeout 'systemctl set-property --runtime "\$(cut -d/ -f3- /proc/self/cgroup | sed "s#.*/##")" RuntimeMaxSec=infinity'
try start-job 'sudo -n /usr/local/libexec/worklane-exp ci version'
echo done > "\$OUT/model"
EOF
cp "$t/canary.sh" "$r/canary.sh"; git -C "$r" add canary.sh && git -C "$r" -c user.email=ci@example.com -c user.name=ci commit -q -m canary
sha5="$(git -C "$r" rev-parse HEAD)"; git -C "$r" bundle create -q "$t/b5" HEAD main
as_coord create ci-job-5 "$sha5" < "$t/b5" >/dev/null
# Its prediction step plants a pickle checkpoint: the gate refuses it, and the scorer never reads it.
spec 5 'bash canary.sh' score 'cat "$EVAL_INPUTS"/*.txt > "$PRED/p.txt"; printf "\\x80\\x04K\\x01." > "$PRED/model.pt"' | as_coord job ci-job-5 | tee "$t/job5.log"
tail -1 "$t/job5.log" | grep -q '"outcome":"crashed","step":"pred-format"' || fail "a planted pickle reached the scorer"
sudo grep -q '^REFUSED model.pt:' /var/lib/worklane-exp/ci/jobs/ci-job-5/logs/gate.log || fail "the gate didn't name the pickle"
out5="$(sudo cat /var/lib/worklane-exp/ci/jobs/ci-job-5/logs/train.log)"
printf '%s\n' "$out5" | grep -E '^(BLOCKED|ESCAPED) '
[ "$(printf '%s\n' "$out5" | grep -c '^BLOCKED ')" = 7 ] && ! printf '%s\n' "$out5" | grep -q '^ESCAPED ' || fail "the canary escaped a boundary"
sudo rmdir /run/worklane/gpu

echo "OK: experiment jobs on real systemd"
