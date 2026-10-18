#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the egress job, after test-user.sh install ci; DB_IMAGE set): the host egress
# rule (scripts/setup/egress-firewall.sh, #543) on real systemd, real nft and the test user's real rootless Docker.
# A "public" stand-in, 198.51.100.7 (TEST-NET-2), in a network namespace of its own behind a veth, so it is neither
# this host's loopback nor its LAN; Docker's pull goes to the real registry.
#   before:    a test-user unit with no PrivateNetwork reaches the stand-in (so a drop below is the rule's doing).
#   apply:     test users covered by default (systemd 255 here); Docker, started before the set existed, is put in it.
#   refused:   a test-user process (a unit as wl-test-ci in worklane-test.slice, no PrivateNetwork) is dropped; its own
#              loopback works.
#   pull:      a real rootless docker pull of the database image, with the rule on.
#   reload:    the rule file loaded again (as the boot unit does, and apply) keeps Docker in the set; the pre-#543 way
#              (delete the table, make it again) empties it (fail-without), and apply puts Docker back.
#   restart:   the set follows Docker through a restart, with no reload.
#   no NFTSet: Docker's unit without NFTSet= can't pull, and check says why (fail-without); test-user.sh install puts it
#              back, loads the rule again, and the pull works.
#   join:      MEASURED, NOT ASSERTED: whether a test run (the real helper's exec, its real sandbox) can join the Docker
#              daemon's user+net namespaces, and reach the stand-in from there (through Docker's exempt slirp4netns).
#              The answer is printed and put in the job summary either way.
# Usage: bash scripts/ci/egress-real-systemd.sh   (as the runner user, with sudo)
set -euo pipefail
: "${DB_IMAGE:?the pinned database image}"
H=/usr/local/libexec/worklane-testrun
U=wl-test-ci
DU=worklane-test-ci-docker.service
PUB=198.51.100.7
EF=scripts/setup/egress-firewall.sh
t="$(mktemp -d)"
chmod 0755 "$t"
cleanup() {
  if [ -f "$t/pids" ]; then while read -r p; do sudo kill "$p" 2>/dev/null || true; done < "$t/pids"; fi
  sudo ip netns del wleg 2>/dev/null || true
  sudo ip link del wleg0 2>/dev/null || true
  rm -rf "$t"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
summary() { echo "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }

echo "== the host"
systemctl --version | head -1
nft --version
uname -r
sysctl kernel.apparmor_restrict_unprivileged_userns || true
[ "$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')" -ge 255 ] || fail "systemd older than 255: this job proves the default (NFTSet=) case"

# The public stand-in and a listener there.
sudo ip netns add wleg
sudo ip link add wleg0 type veth peer name wleg1
sudo ip link set wleg1 netns wleg
sudo ip addr add 198.51.100.1/24 dev wleg0
sudo ip link set wleg0 up
sudo ip netns exec wleg ip addr add "$PUB/24" dev wleg1
sudo ip netns exec wleg ip link set wleg1 up
sudo ip netns exec wleg ip link set lo up
cat > "$t/listen.py" <<'EOF'
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((sys.argv[1], 0)); s.listen(64)
open(sys.argv[2], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()
EOF
sudo ip netns exec wleg python3 "$t/listen.py" "$PUB" "$t/port" > /dev/null 2>&1 &
echo "$!" >> "$t/pids"
for _ in $(seq 50); do [ -s "$t/port" ] && break; sleep 0.1; done
PORT="$(cat "$t/port" 2>/dev/null || true)"
[ -n "$PORT" ] || fail "the stand-in's listener didn't start"
# A connect probe: prints OK or the error's name. Its own loopback too, with "lo".
cat > "$t/probe.py" <<'EOF'
import socket, sys, threading
if sys.argv[1] == "lo":
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
    threading.Thread(target=lambda: s.accept(), daemon=True).start()
    a, p = s.getsockname()
else:
    a, p = sys.argv[1], int(sys.argv[2])
try:
    socket.create_connection((a, p), 4).close(); print("OK")
except OSError as e:
    print(type(e).__name__)
EOF
chmod 0644 "$t/probe.py"
python3 "$t/probe.py" "$PUB" "$PORT" | grep -qx OK || fail "this host can't reach the stand-in $PUB:$PORT itself"
echo "stand-in: $PUB:$PORT"

# A test-user process outside any run's sandbox: a unit as wl-test-ci in worklane-test.slice, no PrivateNetwork.
as_test() { sudo systemd-run --wait --pipe --quiet --collect --uid="$U" --gid="$U" --slice=worklane-test.slice -p PrivateNetwork=no -p RuntimeMaxSec=30 /usr/bin/python3 "$t/probe.py" "$@" < /dev/null; }
dk() { sudo -u "$U" env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker "$@"; }
in_set() { sudo nft list set inet worklane_egress egress_ok | grep -qF "\"$(systemctl show -p ControlGroup --value "$DU" | sed 's#^/##')\""; }
# The image pulled afresh (removed first), within <seconds>.
pull() { dk rmi -f "$DB_IMAGE" > /dev/null 2>&1 || true; timeout "$1" sudo -u "$U" env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker pull -q "$DB_IMAGE" > /dev/null; }

echo "== before: no egress rule; a test-user unit reaches the stand-in"
sudo nft list table inet worklane_egress > /dev/null 2>&1 && fail "an egress table is loaded already"
[ "$(as_test "$PUB" "$PORT")" = OK ] || fail "with no rule, the test-user unit can't reach $PUB: this probe can't tell"
systemctl cat "$DU" | grep '^NFTSet=' || fail "$DU has no NFTSet="
sudo journalctl --no-pager -o cat -u "$DU" | grep -i nft || echo "(the Docker unit's journal says nothing of nft)"

echo "== apply: test users covered by default; Docker, started before the set existed, put in it"
sudo bash "$EF" apply | tee "$t/apply.log"
tail -n 1 "$t/apply.log" | grep -qx OK || fail "apply's check didn't pass"
grep -qx "PASS $U ($(id -u "$U")) is covered" "$t/apply.log" || fail "$U isn't covered by default"
grep -q "^exempt: $DU (NFTSet=): its cgroup " "$t/apply.log" || fail "apply didn't put the running Docker in the set"
grep -qx "PASS $DU may pull images (its cgroup is in the set egress_ok)" "$t/apply.log" || fail "check didn't find Docker in the set"
sudo nft list table inet worklane_egress | tee "$t/table"
grep -q 'socket cgroupv2 level 3 @egress_ok accept' "$t/table" || fail "no level-3 cgroup accept in the loaded table"
in_set || fail "Docker's cgroup isn't in the loaded set"

echo "== refused: a test-user process is dropped; its own loopback works"
got="$(as_test "$PUB" "$PORT")"
echo "  wl-test-ci unit -> $PUB: $got"
[ "$got" != OK ] || fail "a test-user process reached $PUB with the rule on"
[ "$(as_test lo)" = OK ] || fail "the test user's own loopback doesn't work under the rule"
python3 "$t/probe.py" "$PUB" "$PORT" | grep -qx OK || fail "the rule blocked the runner user too"

echo "== pull: a real rootless docker pull with the rule on"
pull 300 || fail "Docker couldn't pull $DB_IMAGE with the rule on"
dk image inspect "$DB_IMAGE" > /dev/null
echo "  pulled $DB_IMAGE"

echo "== reload: the rule file again keeps Docker in the set"
sudo nft -f /etc/worklane/egress.nft
in_set || fail "loading the rule file again emptied the set"
sudo bash "$EF" apply > "$t/apply2.log" || { cat "$t/apply2.log"; fail "apply again failed"; }
in_set || fail "apply again lost Docker from the set"
echo "  fail-without: the pre-#543 way, delete the table and make it again, empties the set"
printf 'table inet worklane_egress\ndelete table inet worklane_egress\n' | cat - /etc/worklane/egress.nft | sudo nft -f -
if in_set; then fail "the set survived a delete of its table: this probe can't tell"; fi
if pull 90 2> /dev/null; then fail "Docker pulled with its cgroup out of the set: the rule isn't what stops it"; fi
echo "  with the set emptied, Docker's pull was dropped"
sudo bash "$EF" apply > "$t/apply3.log" || { cat "$t/apply3.log"; fail "apply after the old-style reload failed"; }
in_set || fail "apply didn't put Docker back in the set"
pull 300 || fail "Docker couldn't pull after apply put it back"

echo "== restart: the set follows Docker, with no reload"
old_cg_in="$(sudo nft list set inet worklane_egress egress_ok | tr -s ' \n\t' ' ')"
sudo systemctl restart "$DU"
for _ in $(seq 60); do [ -S /run/worklane-test-ci-docker/docker.sock ] && dk info > /dev/null 2>&1 && break; sleep 1; done
in_set || fail "after a restart Docker's cgroup isn't in the set (set before: $old_cg_in)"
pull 300 || fail "Docker couldn't pull after a restart"

echo "== no NFTSet=: Docker's unit without it can't pull, and check says why (fail-without)"
sudo sed -i '/^NFTSet=/d' "/etc/systemd/system/$DU"
sudo systemctl daemon-reload
sudo systemctl restart "$DU"
for _ in $(seq 60); do [ -S /run/worklane-test-ci-docker/docker.sock ] && dk info > /dev/null 2>&1 && break; sleep 1; done
if in_set; then fail "Docker without NFTSet= is in the set"; fi
if pull 90 2> /dev/null; then fail "Docker without NFTSet= pulled with the rule on"; fi
if sudo bash "$EF" check > "$t/check-old.log"; then fail "check passed with Docker out of the set"; fi
grep -q "^FAIL $DU has no NFTSet=cgroup:inet:worklane_egress:egress_ok" "$t/check-old.log" || { cat "$t/check-old.log"; fail "check didn't say why"; }
echo "  without NFTSet= the pull was dropped, and check said: $(grep "^FAIL $DU" "$t/check-old.log")"
n="$(nproc)"
sudo bash scripts/setup/test-user.sh install ci --cpus "$((n - 2))-$((n - 1))" --memory-max 2G > "$t/reinstall.log" 2>&1 || { tail -n 40 "$t/reinstall.log"; fail "test-user.sh install didn't put it back"; }
grep -q '^== the host egress rule (egress-firewall.sh), now with wl-test-ci in it' "$t/reinstall.log" || fail "test-user.sh install didn't load the egress rule again"
in_set || fail "after test-user.sh install Docker isn't in the set"
pull 300 || fail "Docker couldn't pull after test-user.sh install"

echo "== join (measured, not asserted): can a test run join the Docker daemon's user+net namespaces?"
dpid="$(pgrep -u "$U" -x dockerd | head -n 1)"
[ -n "$dpid" ] || fail "no dockerd of $U's"
echo "  dockerd: pid $dpid, user ns $(sudo readlink "/proc/$dpid/ns/user"), net ns $(sudo readlink "/proc/$dpid/ns/net")"
# Control: root, joining the same namespaces, reaches the stand-in through Docker's slirp4netns (so a run that joins does too).
ctl="$(sudo nsenter --target "$dpid" --user --net --preserve-credentials python3 "$t/probe.py" "$PUB" "$PORT" 2>&1 || true)"
echo "  control, root in Docker's namespaces -> $PUB: $ctl"
[ "$ctl" = OK ] || fail "even root in Docker's namespaces can't reach $PUB: the join probe below couldn't tell"
# A run as the coordinator makes it (the real helper, its real sudoers rule and sandbox), its command the probe.
as_() { sudo -u wl-ci sudo -n "$H" ci "$@"; }
r="$(mktemp -d)"
id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
git init -q "$r" && date +%s%N > "$r/f" && git -C "$r" add -A && git -C "$r" "${id_[@]}" commit -q -m probe
for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/egress-join/$x" HEAD; done
git -C "$r" bundle create --quiet "$r/b" refs/worklane/test-run/egress-join/head refs/worklane/test-run/egress-join/base
as_ create egress-join main refs/worklane/test-run/egress-join/head refs/worklane/test-run/egress-join/base "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
rm -rf "$r"
probe64="$(base64 -w0 < "$t/probe.py")"
# No ${...}: systemd would expand those. Each line: what was tried, and what came of it.
cmd="printf %s $probe64 | base64 -d > \"\$TMPDIR/p.py\"; echo \"in its own netns -> $PUB: \$(python3 \"\$TMPDIR/p.py\" $PUB $PORT)\"; ls -l /proc/$dpid/ns/user /proc/$dpid/ns/net 2>&1 | sed 's/^/ns: /'; if out=\$(nsenter --target $dpid --user --net --preserve-credentials python3 \"\$TMPDIR/p.py\" $PUB $PORT 2>&1); then echo \"joined; -> $PUB: \$out\"; else echo \"join refused: \$out\"; fi"
as_ exec egress-join 60 -- "$cmd" < /dev/null > "$t/join.out" 2> "$t/join.err" || true
sed 's/^/  run: /' "$t/join.out"
as_ wipe egress-join > /dev/null
grep -q '^in its own netns -> ' "$t/join.out" || { cat "$t/join.err" >&2; fail "the run's probe didn't run"; }
own="$(sed -n "s/^in its own netns -> $PUB: //p" "$t/join.out")"
[ "$own" != OK ] || fail "the run reached $PUB from its own namespace"
if grep -q '^joined; ' "$t/join.out"; then
  via="$(sed -n "s/^joined; -> $PUB: //p" "$t/join.out")"
  summary "ANSWER (#543, measured): a test run CAN join the Docker daemon's user+net namespaces (nsenter as the test user, from the helper's real exec sandbox); from there it reached $PUB: $via."
else
  summary "ANSWER (#543, measured): a test run can NOT join the Docker daemon's user+net namespaces from the helper's real exec sandbox: $(sed -n 's/^join refused: //p' "$t/join.out" | head -n 1)."
fi

echo "== check, at the end"
sudo bash "$EF" check | tee "$t/check.log"
tail -n 1 "$t/check.log" | grep -qx OK || fail "check fails at the end"
echo "OK: test users covered by default on real systemd; Docker's pull the one exception, kept across reloads and restarts"
