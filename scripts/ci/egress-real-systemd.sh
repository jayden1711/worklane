#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the egress job, after test-user.sh install ci; DB_IMAGE set): the host egress
# rule (scripts/setup/egress-firewall.sh, #543) on real systemd, real nft and the test user's real rootless Docker.
# A "public" stand-in, 198.51.100.7 (TEST-NET-2), in a network namespace of its own behind a veth, so it is neither
# this host's loopback nor its LAN; Docker's pull goes to the real registry.
#   before:    a test-user unit with no PrivateNetwork reaches the stand-in (so a drop below is the rule's doing).
#   apply:     test users covered by default (systemd 255 here); Docker, started before the set existed, is put in it.
#   refused:   a test-user process (a unit as wl-test-ci in worklane-test.slice, no PrivateNetwork) is dropped; its own
#              loopback works. So is the same unit as the first and the last uid of wl-test-ci's subordinate range
#              (/etc/subuid, which a process in its user namespace can take, #740), and that reached the stand-in with
#              no rule.
#   cgroup:    the same kind of unit can't move itself into Docker's cgroup: its write of its own pid to cgroup.procs of
#              Docker's unit and of its daemon subgroup is refused (a plain permission check; the job fails if it isn't).
#   pull:      a real rootless docker pull of the database image, with the rule on.
#   reload:    the rule file loaded again (as the boot unit does, and apply) keeps Docker in the set; the pre-#543 way
#              (delete the table, make it again) empties it (fail-without), and apply puts Docker back.
#   restart:   the set follows Docker through a restart, with no reload.
#   no NFTSet: Docker's unit without NFTSet= can't pull, and check says why (fail-without); test-user.sh install puts it
#              back, loads the rule again, and the pull works.
#   join:      ASSERTED REFUSED (#545): a test run (the real helper's exec, its real sandbox: a user namespace of its own)
#              can't join the Docker daemon's user+net namespaces, nor the containers' netns through any thread of any
#              test-user process, and so can't reach the stand-in through Docker's exempt slirp4netns. The containers'
#              netns is looked for in every thread of every test-user process, not only its main one (Docker restarted,
#              at most 3 times, until a thread is there), and joined through each such thread. A plain test-user unit
#              (no run sandbox) must still join one and reach the stand-in, or the probe can't tell. Fail-without: the
#              helper before #545 ($PRE545) lets the run join and reach it. Whether a join through a thread other than a
#              main one gets out is still measured, not asserted (Docker restarted until such a start comes up).
#   granted:   #545: a granted run's slirp4netns runs as the test user, its unit in the set, and the run reaches the
#              stand-in through it; on the upgraded (dropped) install it is root's, as before, and the run still does.
#   upgrade:   an install that covered test users before #543 (the pre-#543 egress-firewall.sh, apply --with-test-users,
#              and a Docker unit with no NFTSet=) keeps dropping their Docker after the new test-user.sh install and
#              apply: no NFTSet=, no cgroup accept, the pull dropped, and the join probe, run before and after, reaches
#              the stand-in from nowhere it didn't before (asserted: the job fails if any blocked attempt opens, or if
#              any join, through any thread, reaches it after). The pre-#543 rule (wl-test-ci's own uid only) lets a
#              unit as its subordinate uid out (asserted: the fail-without for #740); after the upgrade it's dropped.
#              Before the after-upgrade probe, Docker is restarted
#              (at most 3 times) while no test-user thread is in a non-host netns; each look goes in the job summary,
#              and if it restarted, no NFTSet=, no cgroup exception and the dropped pull are asserted again after.
# Usage: bash scripts/ci/egress-real-systemd.sh   (as the runner user, with sudo)
set -euo pipefail
: "${DB_IMAGE:?the pinned database image}"
H=/usr/local/libexec/worklane-testrun
U=wl-test-ci
DU=worklane-test-ci-docker.service
PUB=198.51.100.7
EF=scripts/setup/egress-firewall.sh
# main's commit before #543, whose egress-firewall.sh and lib.sh the upgrade step runs (the rule a machine had).
PRE543=93fa37612bcdafe2f2cbe8426165ba1b29d99c63
# main before #545 (#543 merged): its helper runs a test run in the host's user namespace (the join probe's fail-without).
PRE545=689854dea0f90f963cf4f80f8bbc1945aaae1cbf
t="$(mktemp -d)"
chmod 0755 "$t"
cleanup() {
  if [ -f "$t/pids" ]; then while read -r p; do sudo kill "$p" 2>/dev/null || true; done < "$t/pids"; fi
  sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
  sudo bash scripts/setup/testrun-network.sh disable ci > /dev/null 2>&1 || true
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
# The same unit and probe as a uid of the test user's subordinate range (#740): <uid> <probe args>. WHY setpriv, not
# --uid=: these uids have no user database entry, which systemd looks the uid up in (inferred). The socket's owner is
# that uid, as for a process in the test user's user namespace that took it (inferred: the kernel maps it the same way).
as_sub() { local uid="$1"; shift; sudo systemd-run --wait --pipe --quiet --collect --slice=worklane-test.slice -p PrivateNetwork=no -p RuntimeMaxSec=30 /usr/bin/setpriv --reuid="$uid" --regid="$uid" --clear-groups -- /usr/bin/python3 "$t/probe.py" "$@" < /dev/null; }
# wl-test-ci's first subordinate uid range (test-user.sh install gave it one): its first and last uid.
read -r SUB_LO SUB_N < <(awk -F: -v u="$U" -v i="$(id -u "$U")" '($1 == u || $1 == i) && $3 > 0 { print $2, $3; exit }' /etc/subuid) || true
[ -n "${SUB_LO:-}" ] || fail "$U has no subordinate uid range in /etc/subuid"
SUB_HI=$((SUB_LO + SUB_N - 1))
echo "$U's subordinate uids: $SUB_LO-$SUB_HI"
# Each of the range's first and last uid, as a unit in worklane-test.slice: <want: OK or dropped> <when>.
sub_probe() {
  local want="$1" when="$2" uid got
  for uid in "$SUB_LO" "$SUB_HI"; do
    got="$(as_sub "$uid" "$PUB" "$PORT")"
    echo "  $when: a unit as $U's subordinate uid $uid -> $PUB: $got"
    summary "- $when: a unit as $U's subordinate uid $uid -> $PUB: $got"
    if [ "$want" = OK ]; then [ "$got" = OK ] || fail "$when: a unit as $U's subordinate uid $uid can't reach $PUB ($got): this probe can't tell"
    else [ "$got" != OK ] || fail "$when: a unit as $U's subordinate uid $uid reached $PUB"; fi
  done
}
dk() { sudo -u "$U" env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker "$@"; }
# Docker answers on its socket again (after a restart), within 60 s, or the job fails. WHY sudo test: its runtime
# directory is the test user's, 0700, so the runner user can't see the socket (a plain [ -S ] never passed).
docker_up() { for _ in $(seq 60); do sudo test -S /run/worklane-test-ci-docker/docker.sock && dk info > /dev/null 2>&1 && return 0; sleep 1; done; fail "$DU didn't come back up"; }
in_set() { sudo nft list set inet worklane_egress egress_ok | grep -qF "\"$(systemctl show -p ControlGroup --value "$DU" | sed 's#^/##')\""; }
# The image pulled afresh (removed first), within <seconds>.
pull() { dk rmi -f "$DB_IMAGE" > /dev/null 2>&1 || true; timeout "$1" sudo -u "$U" env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker pull -q "$DB_IMAGE" > /dev/null; }

echo "== before: no egress rule; a test-user unit reaches the stand-in"
sudo nft list table inet worklane_egress > /dev/null 2>&1 && fail "an egress table is loaded already"
[ "$(as_test "$PUB" "$PORT")" = OK ] || fail "with no rule, the test-user unit can't reach $PUB: this probe can't tell"
summary "### #740: a unit as $U's subordinate uids ($SUB_LO-$SUB_HI), with no exception (asserted)"
sub_probe OK "no rule"
systemctl cat "$DU" | grep '^NFTSet=' || fail "$DU has no NFTSet="
sudo journalctl --no-pager -o cat -u "$DU" | grep -i nft || echo "(the Docker unit's journal says nothing of nft)"

echo "== apply: test users covered by default; Docker, started before the set existed, put in it"
sudo bash "$EF" apply | tee "$t/apply.log"
tail -n 1 "$t/apply.log" | grep -qx OK || fail "apply's check didn't pass"
grep -qx "PASS $U ($(id -u "$U")) is covered" "$t/apply.log" || fail "$U isn't covered by default"
grep -qx "PASS $U's subordinate uids $SUB_LO-$SUB_HI are covered" "$t/apply.log" || fail "$U's subordinate uids aren't covered by default"
grep -qx "PASS uid $SUB_LO ($U's subordinate) can't reach 1.1.1.1:443" "$t/apply.log" || fail "check didn't probe $U's subordinate uids"
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
summary "### #740: the same units with the rule on (the default install: Docker's cgroup exempt, these units not in it)"
sub_probe dropped "the rule on"
python3 "$t/probe.py" "$PUB" "$PORT" | grep -qx OK || fail "the rule blocked the runner user too"

echo "== cgroup: a test-user unit can't move itself into Docker's cgroup (asserted)"
# A plain permission check, nothing else: the unit writes its own pid to cgroup.procs of Docker's unit and of its daemon
# subgroup (both the test user's, by Delegate=). cgroup v2 also wants write access to cgroup.procs of the common
# ancestor, worklane-test.slice, which is root's. The job fails if either write succeeds.
dcg="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$DU")"
for f in "$dcg/cgroup.procs" "$dcg/daemon/cgroup.procs"; do
  sudo test -e "$f" || fail "$f isn't there: this check can't tell"
  echo "  $f: $(sudo stat -c '%U:%G %a' "$f")"
done
cat > "$t/cgmove.sh" <<'EOF'
for f in "$@"; do
  if err="$( (echo "$$" > "$f") 2>&1 )"; then echo "moved: $f"; else echo "refused: $f: ${err##*: }"; fi
done
EOF
chmod 0644 "$t/cgmove.sh"
sudo systemd-run --wait --pipe --quiet --collect --uid="$U" --gid="$U" --slice=worklane-test.slice -p RuntimeMaxSec=30 \
  /bin/bash "$t/cgmove.sh" "$dcg/cgroup.procs" "$dcg/daemon/cgroup.procs" < /dev/null > "$t/cgmove.out" 2>&1 || true
sed 's/^/  wl-test-ci unit: /' "$t/cgmove.out"
[ "$(grep -c '^refused: ' "$t/cgmove.out")" -eq 2 ] || fail "a test-user unit's move into Docker's cgroup wasn't refused (or didn't run)"
summary "### #543: a test-user unit's write of its own pid to Docker's cgroup.procs (asserted refused)"
while IFS= read -r l; do summary "- $l"; done < "$t/cgmove.out"

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
docker_up
in_set || fail "after a restart Docker's cgroup isn't in the set (set before: $old_cg_in)"
pull 300 || fail "Docker couldn't pull after a restart"

echo "== no NFTSet=: Docker's unit without it can't pull, and check says why (fail-without)"
sudo sed -i '/^NFTSet=/d' "/etc/systemd/system/$DU"
sudo systemctl daemon-reload
sudo systemctl restart "$DU"
# Up first, so a dropped pull below is the rule's doing, not a daemon still starting.
docker_up
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

# The join probe's attempts, the same from a plain test-user unit and from a run: <probe> <pub> <port> <dockerd pid>
# <netns file|-> <pid>:<tid>:<netns inode>...
# Each thread is joined through its own namespace files, /proc/<pid>/task/<tid>/ns/{user,net}: rootlesskit's
# detach-netns puts only some threads of its child in the containers' netns, and /proc/<pid>/ns/net is the main
# thread's alone (#543). The user ns is the same for every thread of a process (setns into a user ns needs a
# single-threaded caller), and it's the one dockerd runs in, so this is the same join as dockerd's user ns plus the
# pid's net ns before, aimed at a thread.
cat > "$t/join.sh" <<'EOF'
p="$1" pub="$2" port="$3" d="$4" f="$5"; shift 5
try() { local what="$1" out; shift; if out="$("$@" python3 "$p" "$pub" "$port" 2>&1)"; then echo "$what: joined; -> $pub: $out"; else echo "$what: refused: $out"; fi; }
echo "own netns: -> $pub: $(python3 "$p" "$pub" "$port")"
try "the daemon's user+net" nsenter --target "$d" --user --net --preserve-credentials
try "the daemon's user ns only" nsenter --target "$d" --user --preserve-credentials
if [ "$f" != - ]; then
  if [ -e "$f" ]; then try "the containers' netns (file)" nsenter --user="/proc/$d/ns/user" --net="$f" --preserve-credentials
  else echo "the containers' netns (file): refused: $f isn't visible here"; fi
fi
for x in "$@"; do
  pp="${x%%:*}" rest="${x#*:}"
  tt="${rest%%:*}" nn="${rest#*:}"
  try "the containers' netns (pid $pp, tid $tt, net:[$nn])" nsenter --user="/proc/$pp/task/$tt/ns/user" --net="/proc/$pp/task/$tt/ns/net" --preserve-credentials
done
EOF
chmod 0644 "$t/join.sh"
as_() { sudo -u wl-ci sudo -n "$H" ci "$@"; }

# The join probe <tag> (measured): whether a process of the test user's can join Docker's namespaces and reach the
# stand-in from there. From a plain test-user unit (outside any run's sandbox, the host's /run and /proc: the upper
# bound) and from a run (as the coordinator makes it: the real helper, its real sudoers rule and sandbox). Each
# attempt's line goes to $t/join-<tag>-plain.out and $t/join-<tag>-run.out; JOIN_INFO says what it found.
# Two targets. The daemon's own namespaces: its user namespace, and its network namespace (with rootlesskit's
# detach-netns, the host's: it pulls from there, in its exempt cgroup). And the network namespace its containers get,
# which its slirp4netns (in the exempt cgroup) gives a way out: a bind-mounted file under its runtime directory, and
# any thread of any process of the test user's in a network namespace other than the host's.
# Every thread of every test-user process in a network namespace other than the host's, as <pid>:<tid>:<netns inode>,
# one a line, in $t/threads-<tag>. Each thread, not each pid: rootlesskit's detach-netns puts only some threads of its
# child in the containers' netns (measured, the three runs that read every thread: its main one (1 of its 9 to 11 threads
# where the total was logged) on 32 of 33 starts; on the 33rd no thread at all), so a pid's /proc/<pid>/ns/net (its main thread's) alone could miss
# one that is; this misses none. Over all nine runs of this job before the restarts below, 3 of 47 probed starts had
# no thread (or, in the six runs that read main threads only, no pid) there (measured: their job logs).
netns_threads() {
  local tag="$1" hostnet p tid n
  hostnet="$(sudo readlink /proc/1/ns/net)"
  : > "$t/threads-$tag"
  for p in $(pgrep -u "$U"); do
    for tid in $(sudo ls "/proc/$p/task" 2>/dev/null || true); do
      n="$(sudo readlink "/proc/$p/task/$tid/ns/net" 2>/dev/null || true)"
      if [ -n "$n" ] && [ "$n" != "$hostnet" ]; then echo "$p:$tid:$(echo "$n" | tr -dc 0-9)" >> "$t/threads-$tag"; fi
    done
  done
}
# Whether threads file $1 has a thread in a non-host netns and no process's main thread (tid = pid) among them.
no_main_thread() { [ -s "$1" ] && ! grep -q '^\([0-9]*\):\1:' "$1"; }
# What threads file $t/threads-<tag> holds, for the summary.
threads_line() { if [ -s "$t/threads-$1" ]; then echo "test-user threads in a non-host netns (pid:tid:netns): $(tr '\n' ' ' < "$t/threads-$1")"; else echo "no thread of any $U process in a non-host netns"; fi; }
# A start can leave no thread of any test-user process in a non-host netns (measured: 3 of 47 probed starts, comment
# above netns_threads), and the join probe then has nothing to join. Before a probe that fails on that, look at
# $t/threads-<tag>, and while it's empty restart Docker, at most 3 times, and look again. Each look goes in the job
# summary; DOCKER_RESTARTS says how many restarts it took. Nothing here passes or fails anything: the probe after it
# reads the threads again, and the job's own check on them (no thread: fail) is unchanged.
DOCKER_RESTARTS=0
await_netns_thread() {
  local tag="$1" i
  DOCKER_RESTARTS=0
  netns_threads "$tag"
  summary "- look 1 (no restart): $(threads_line "$tag")"
  for i in 1 2 3; do
    [ ! -s "$t/threads-$tag" ] || return 0
    sudo systemctl restart "$DU"
    docker_up
    DOCKER_RESTARTS="$i"
    netns_threads "$tag"
    summary "- look $((i + 1)) (after Docker restart $i of 3): $(threads_line "$tag")"
  done
  [ -s "$t/threads-$tag" ] || summary "- still none after 3 restarts: the probe below runs anyway, and the job fails at its no-thread check"
}
join_probe() {
  local tag="$1" id="egress-join-$1" dpid hostnet nsfile npids="" p tid n main r probe64 join64 cmd
  local id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  dpid="$(pgrep -u "$U" -x dockerd | head -n 1)"
  [ -n "$dpid" ] || fail "no dockerd of $U's"
  hostnet="$(sudo readlink /proc/1/ns/net)"
  echo "  host: net ns $hostnet; dockerd: pid $dpid, user ns $(sudo readlink "/proc/$dpid/ns/user"), net ns $(sudo readlink "/proc/$dpid/ns/net")"
  nsfile="$(sudo find /run/worklane-test-ci-docker -maxdepth 3 -name netns 2>/dev/null | head -n 1)"
  echo "  Docker's container netns file: ${nsfile:-none found} $([ -z "$nsfile" ] || sudo stat -c '(%U:%G %a)' "$nsfile")"
  netns_threads "$tag"
  JOIN_THREADS=""
  while IFS=: read -r p tid n; do
    npids="$npids $p:$tid:$n"
    if [ "$p" = "$tid" ]; then main=", its main thread"; else main=""; fi
    echo "  $U's pid $p ($(ps -o comm= -p "$p" || true)) tid $tid$main, user ns $(sudo readlink "/proc/$p/task/$tid/ns/user" || true), is in net ns net:[$n]"
    JOIN_THREADS="$JOIN_THREADS pid $p ($(ps -o comm= -p "$p" || true)) tid $tid$main in net:[$n];"
  done < "$t/threads-$tag"
  for p in $(sed 's/:.*//' "$t/threads-$tag" | sort -u); do
    echo "  $U's pid $p: main thread in net ns $(sudo readlink "/proc/$p/ns/net" 2>/dev/null || echo gone), $(sudo ls "/proc/$p/task" 2>/dev/null | wc -l) threads in all"
  done
  # Control: root in that netns reaches the stand-in (so a process of the test user's that joins it would too).
  if [ -n "$nsfile" ]; then
    echo "  control, root in Docker's container netns -> $PUB: $(sudo nsenter --net="$nsfile" python3 "$t/probe.py" "$PUB" "$PORT" 2>&1 || true)"
  fi
  # 300 s: one attempt a thread, each up to the probe's 4 s connect timeout where it's dropped.
  sudo systemd-run --wait --pipe --quiet --collect --uid="$U" --gid="$U" --slice=worklane-test.slice -p RuntimeMaxSec=300 \
    /bin/bash "$t/join.sh" "$t/probe.py" "$PUB" "$PORT" "$dpid" "${nsfile:--}" $npids < /dev/null > "$t/join-$tag-plain.out" 2>&1 || true
  sed 's/^/  plain test-user unit: /' "$t/join-$tag-plain.out"
  r="$(mktemp -d)"
  git init -q "$r" && date +%s%N > "$r/f" && git -C "$r" add -A && git -C "$r" "${id_[@]}" commit -q -m probe
  for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
  git -C "$r" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
  as_ create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
  rm -rf "$r"
  probe64="$(base64 -w0 < "$t/probe.py")"
  join64="$(base64 -w0 < "$t/join.sh")"
  # No ${...}: systemd would expand those.
  cmd="printf %s $probe64 | base64 -d > \"\$TMPDIR/p.py\"; printf %s $join64 | base64 -d > \"\$TMPDIR/j.sh\"; bash \"\$TMPDIR/j.sh\" \"\$TMPDIR/p.py\" $PUB $PORT $dpid ${nsfile:--}$npids"
  as_ exec "$id" 300 -- "$cmd" < /dev/null > "$t/join-$tag-run.out" 2> "$t/join-$tag-run.err" || true
  sed 's/^/  run: /' "$t/join-$tag-run.out"
  as_ wipe "$id" > /dev/null
  grep -q '^own netns: ' "$t/join-$tag-run.out" || { cat "$t/join-$tag-run.err" >&2; fail "the run's probe didn't run"; }
  [ "$(sed -n "s/^own netns: -> $PUB: //p" "$t/join-$tag-run.out")" != OK ] || fail "the run reached $PUB from its own namespace"
  JOIN_INFO="Host net ns $hostnet; dockerd pid $dpid in net ns $(sudo readlink "/proc/$dpid/ns/net"); containers' netns file: ${nsfile:-none}; test-user threads in a non-host netns (each joined below):${JOIN_THREADS:- none.}"
}
# The attempts in join probe output $1 that reached the stand-in, by what was tried (a thread's pid, tid and netns left
# out: they change when Docker restarts), sorted.
opened() { { grep -- "-> $PUB: OK\$" "$1" || true; } | sed -E 's/ \(pid [0-9]+, tid [0-9]+, net:\[[0-9]+\]\)/ (a thread)/; s/: .*//' | sort -u; }

# A granted run (#545) of ci's tier e2e (root's grant, testrun-network.sh): its probe to the stand-in, then it holds
# its unit 4 s while its network unit's User= and whether that unit's cgroup is in the set are read. Its lines in
# $t/granted-<tag>.out: the probe's answer, "net_user <User=>", "net_in_set yes|no".
granted_run() {
  local tag="$1" id="egress-granted-$1" r pid u="" i cmd
  local id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  sudo bash scripts/setup/testrun-network.sh enable ci --tiers e2e > /dev/null
  r="$(mktemp -d)"
  git init -q "$r" && date +%s%N > "$r/f" && git -C "$r" add -A && git -C "$r" "${id_[@]}" commit -q -m probe
  for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
  git -C "$r" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
  as_ create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
  rm -rf "$r"
  # No ${...}: systemd would expand those.
  cmd="printf %s $(base64 -w0 < "$t/probe.py") | base64 -d > \"\$TMPDIR/p.py\"; python3 \"\$TMPDIR/p.py\" $PUB $PORT; sleep 4"
  as_ exec "$id" 120 --network e2e -- "$cmd" < /dev/null > "$t/granted-$tag.out" 2> "$t/granted-$tag.err" &
  pid=$!
  for i in $(seq 100); do
    u="$(systemctl list-units --plain --no-legend --full "worklane-test-ci_${id}_net_*" | awk '{ print $1 }' | head -n 1)"
    if [ -n "$u" ] && [ "$(systemctl show -p MainPID --value "$u" 2>/dev/null || echo 0)" != 0 ]; then break; fi
    u=""; sleep 0.1
  done
  [ -n "$u" ] || { wait "$pid" || true; cat "$t/granted-$tag.err" >&2; fail "$tag: the granted run's network unit didn't come up"; }
  {
    echo "net_user $(systemctl show -p User --value "$u")"
    if sudo nft list set inet worklane_egress egress_ok 2> /dev/null | grep -qF "\"$(systemctl show -p ControlGroup --value "$u" | sed 's#^/##')\""; then echo "net_in_set yes"; else echo "net_in_set no"; fi
  } > "$t/granted-$tag.ns"
  wait "$pid" || { cat "$t/granted-$tag.err" >&2; fail "$tag: the granted run exited non-zero"; }
  cat "$t/granted-$tag.ns" >> "$t/granted-$tag.out"
  sed "s/^/  granted run ($tag): /" "$t/granted-$tag.out"
  as_ wipe "$id" > /dev/null
}

echo "== granted (#545): a granted run's slirp4netns is the test user's, in the set, and carries the run to the stand-in"
granted_run exempt
for x in OK "net_user $U" "net_in_set yes"; do grep -qx "$x" "$t/granted-exempt.out" || fail "the granted run (default install): no line \"$x\""; done
summary "### #545: a granted run on the default install: $(tr '\n' ';' < "$t/granted-exempt.out")"

echo "== join (asserted refused, #545): can a test run join the Docker daemon's user+net namespaces?"
# A thread to join first (Docker restarted at most 3 times while none is there), so the plain unit's join can show the
# route is there to be refused.
summary "### #545: a thread to join before the default join probe (Docker restarted, at most 3 times, while none is in a non-host netns)"
await_netns_thread default
join_probe default
summary "### #545: can a test run join the Docker daemon's namespaces? (asserted: no)"
summary "$JOIN_INFO"
while IFS= read -r l; do summary "- from a run (the helper's real exec sandbox): $l"; done < "$t/join-default-run.out"
while IFS= read -r l; do summary "- from a plain test-user unit (no run sandbox): $l"; done < "$t/join-default-plain.out"
if grep -q ": joined; -> $PUB: OK$" "$t/join-default-run.out"; then
  summary "ANSWER: a test run CAN get out through Docker's namespaces: $(grep ": joined; -> $PUB: OK$" "$t/join-default-run.out" | head -n 1)."
  fail "a test run joined Docker's namespaces and reached $PUB (#545): $(grep ": joined; -> $PUB: OK$" "$t/join-default-run.out" | head -n 1)"
fi
summary "ANSWER: a test run can NOT get out through Docker's namespaces here (each attempt above was refused or reached nothing)."
# Every attempt from the run is refused outright (it has no capability in Docker's user namespace), not only unanswered.
if grep -q ": joined; " "$t/join-default-run.out"; then fail "a test run joined one of Docker's namespaces (#545): $(grep ": joined; " "$t/join-default-run.out" | head -n 1)"; fi
grep -q "^the daemon's user+net: refused: " "$t/join-default-run.out" || fail "the run's join probe didn't try the daemon's user+net namespaces"
# The probe can tell: a plain test-user unit joins the containers' netns through a thread and reaches the stand-in.
grep -q "^the containers' netns (pid [0-9]*, tid [0-9]*, net:\[[0-9]*\]): joined; -> $PUB: OK$" "$t/join-default-plain.out" || fail "no plain test-user unit reached $PUB through the containers' netns: this probe can't tell whether a run is refused"
grep -q "^the containers' netns (pid [0-9]*, tid [0-9]*, net:\[[0-9]*\]): refused: " "$t/join-default-run.out" || fail "the run's join probe didn't try the containers' netns through a thread"
echo "  fail-without: the helper before #545 ($PRE545) lets a run join the containers' netns and reach $PUB"
git fetch -q --depth=1 origin "$PRE545"
git show "$PRE545:scripts/machine/worklane-testrun.sh" > "$t/helper-pre545.sh"
sudo install -o root -g root -m 0755 "$t/helper-pre545.sh" "$H"
await_netns_thread pre545
join_probe pre545
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
summary "### #545 fail-without: the helper before #545 ($PRE545), the same probe"
while IFS= read -r l; do summary "- from a run: $l"; done < "$t/join-pre545-run.out"
grep -q "^the containers' netns (pid [0-9]*, tid [0-9]*, net:\[[0-9]*\]): joined; -> $PUB: OK$" "$t/join-pre545-run.out" || fail "the helper before #545 didn't let a run reach $PUB through the containers' netns: this probe can't tell"

echo "== join through a thread other than a main one (measured, not asserted), on the default (exempt) install"
# Whether, on a Docker start where no test-user process's main thread is in a non-host netns (so a probe of
# /proc/<pid>/ns/net alone finds none), a join through another thread still gets out. Docker is restarted, at most 8
# times, until such a start comes up; the join probe then runs on it. The route was open on default installs before
# #543 too; this only measures it.
tag=default
for i in 1 2 3 4 5 6 7 8; do
  if no_main_thread "$t/threads-$tag"; then break; fi
  sudo systemctl restart "$DU"
  docker_up
  tag="restart$i"
  netns_threads "$tag"
  echo "  restart $i: threads in a non-host netns: $(tr '\n' ' ' < "$t/threads-$tag")"
done
summary "### #543: a join through a thread other than a main one, on the default (exempt) install (measured)"
if no_main_thread "$t/threads-$tag"; then
  [ "$tag" = default ] || join_probe "$tag"
  if no_main_thread "$t/threads-$tag"; then
    summary "Docker start: $tag (the first start, or the restart it took). No test-user process's main thread was in a non-host netns. $JOIN_INFO"
    while IFS= read -r l; do summary "- from a run: $l"; done < "$t/join-$tag-run.out"
    while IFS= read -r l; do summary "- from a plain test-user unit: $l"; done < "$t/join-$tag-plain.out"
    if grep -q ": joined; -> $PUB: OK$" "$t/join-$tag-run.out"; then
      summary "ANSWER: yes, through a thread other than a main one a test run gets out: $(grep ": joined; -> $PUB: OK$" "$t/join-$tag-run.out" | head -n 1)."
    else
      summary "ANSWER: no, through a thread other than a main one a test run did NOT get out here (each attempt above was refused or reached nothing)."
    fi
  else
    summary "NOT MEASURED: between the restart and the join probe a main thread came into the netns ($(tr '\n' ' ' < "$t/threads-$tag"))."
  fi
else
  summary "NOT MEASURED: in 9 Docker starts every one had a main thread in a non-host netns, or no thread there at all (last: $(tr '\n' ' ' < "$t/threads-$tag"))."
fi

echo "== check (the default: test users covered, their Docker the one exception)"
sudo bash "$EF" check | tee "$t/check.log"
tail -n 1 "$t/check.log" | grep -qx OK || fail "check fails with the default rule"

echo "== upgrade: an install whose rule covered test users before #543 keeps dropping their Docker (asserted)"
echo "  the pre-#543 opt-in: no rule, Docker's unit without NFTSet=, then $PRE543's egress-firewall.sh apply --with-test-users"
sudo bash "$EF" revert
sudo sed -i '/^NFTSet=/d' "/etc/systemd/system/$DU"
sudo systemctl daemon-reload
sudo systemctl restart "$DU"
docker_up
git fetch -q --depth=1 origin "$PRE543"
mkdir "$t/pre543"
git archive "$PRE543" scripts/setup | tar -x -C "$t/pre543"
grep -q 'delete table inet' "$t/pre543/scripts/setup/egress-firewall.sh" || fail "$PRE543's egress-firewall.sh isn't the pre-#543 rule"
sudo bash "$t/pre543/scripts/setup/egress-firewall.sh" apply --with-test-users > "$t/old-apply.log" 2>&1 || { cat "$t/old-apply.log"; fail "the pre-#543 apply --with-test-users failed"; }
cat "$t/old-apply.log"
grep -qx "PASS $U ($(id -u "$U")) is covered" "$t/old-apply.log" || fail "the pre-#543 apply --with-test-users didn't cover $U"
grep -qx '# --with-test-users' /etc/worklane/egress.users || fail "the pre-#543 record has no --with-test-users"
if grep -q '^# docker:' /etc/worklane/egress.users; then fail "the record has a '# docker:' line: not the pre-#543 record"; fi
sudo nft list table inet worklane_egress | tee "$t/old-table"
if grep -Eq 'socket cgroupv2|egress_ok' "$t/old-table"; then fail "the pre-#543 rule has a cgroup exception: this step can't tell"; fi
if pull 90 2> /dev/null; then fail "Docker pulled under the pre-#543 opt-in: there was no closed route to keep closed"; fi
echo "  before: Docker's pull was dropped"
# The fail-without for #740: that rule drops $U's own uid only, as main's did until #740.
summary "### #740: the same units under the pre-#543 opt-in's rule ($U's own uid only), then after the upgrade (asserted)"
sub_probe OK "the pre-#543 rule (own uid only)"
join_probe old
JOIN_INFO_OLD="$JOIN_INFO"
echo "  the new test-user.sh install (it loads the rule again), then the new apply, with no flags"
n="$(nproc)"
sudo bash scripts/setup/test-user.sh install ci --cpus "$((n - 2))-$((n - 1))" --memory-max 2G > "$t/upgrade-install.log" 2>&1 || { tail -n 40 "$t/upgrade-install.log"; fail "the new test-user.sh install failed on the pre-#543 opt-in"; }
grep -q '^== the host egress rule (egress-firewall.sh), now with wl-test-ci in it' "$t/upgrade-install.log" || fail "test-user.sh install didn't load the egress rule again"
docker_up
sudo bash "$EF" apply > "$t/upgrade-apply.log" 2>&1 || { cat "$t/upgrade-apply.log"; fail "the new apply failed after the upgrade"; }
cat "$t/upgrade-apply.log"
grep -qx "PASS $U ($(id -u "$U")) is covered" "$t/upgrade-apply.log" || fail "after the upgrade $U isn't covered"
grep -q '^PASS no exception: ' "$t/upgrade-apply.log" || fail "after the upgrade apply's check didn't say there's no exception"
grep -qx '# docker: dropped' /etc/worklane/egress.users || fail "after the upgrade the record doesn't say '# docker: dropped'"
# The upgraded install's Docker stays dropped: no NFTSet= on its unit, no cgroup exception in the loaded rule, and its
# pull dropped. <when> names the point in the job, in the failure.
assert_dropped() {
  local when="$1"
  # No grep -q here: an early exit could fail systemctl with SIGPIPE, and pipefail would hide the match.
  if systemctl cat "$DU" | grep '^NFTSet='; then fail "$when $DU has NFTSet= again"; fi
  grep -q '^# No NFTSet=: the host egress rule' "/etc/systemd/system/$DU" || fail "$when test-user.sh install's note on why $DU has no NFTSet= isn't there"
  sudo nft list table inet worklane_egress | tee "$t/new-table"
  if grep -Eq 'socket cgroupv2|egress_ok' "$t/new-table"; then fail "$when the rule has a cgroup exception"; fi
  if pull 90 2> /dev/null; then fail "$when Docker pulled: the route the pre-#543 opt-in had closed is open"; fi
  echo "  $when: Docker's pull was dropped"
}
assert_dropped "after the upgrade"
grep -qx "PASS $U's subordinate uids $SUB_LO-$SUB_HI are covered" "$t/upgrade-apply.log" || fail "after the upgrade $U's subordinate uids aren't covered"
sub_probe dropped "after the upgrade (Docker dropped)"
summary "### #543 upgrade: a thread to join before the after-upgrade probe (Docker restarted, at most 3 times, while none is in a non-host netns)"
await_netns_thread new
join_probe new
if [ "$DOCKER_RESTARTS" -gt 0 ]; then
  # A restart changes neither the unit's NFTSet= nor the rule (inferred); this shows it on the start the probe used.
  assert_dropped "after the upgrade and $DOCKER_RESTARTS Docker restart(s)"
  summary "- after $DOCKER_RESTARTS restart(s), asserted again: no NFTSet= on $DU, no cgroup exception in the rule, Docker's pull dropped"
fi
summary "### #543 upgrade: an install that covered test users before #543 keeps dropping their Docker (asserted)"
summary "Before: $PRE543's apply --with-test-users, Docker's unit without NFTSet=. After: the new test-user.sh install and apply. Both: no cgroup exception, Docker's pull dropped."
summary "Before: $JOIN_INFO_OLD"
summary "After: $JOIN_INFO"
for w in run plain; do
  while IFS= read -r l; do summary "- before, from a $w: $l"; done < "$t/join-old-$w.out"
  while IFS= read -r l; do summary "- after, from a $w: $l"; done < "$t/join-new-$w.out"
  newly="$(comm -13 <(opened "$t/join-old-$w.out") <(opened "$t/join-new-$w.out"))"
  [ -z "$newly" ] || fail "upgrade: from a $w, what the pre-#543 opt-in blocked now reaches $PUB: $newly"
  # Both installs drop Docker: every join, through every thread, must reach nothing.
  if grep -q -- "-> $PUB: OK\$" "$t/join-old-$w.out"; then fail "before the upgrade (the pre-#543 opt-in), from a $w, a join reaches $PUB: $(opened "$t/join-old-$w.out")"; fi
  if grep -q -- "-> $PUB: OK\$" "$t/join-new-$w.out"; then fail "upgrade: from a $w, a join still reaches $PUB: $(opened "$t/join-new-$w.out")"; fi
done
# The probe has to have something to measure: some thread of a test-user process in a non-host netns (any thread, not
# only a main one: which threads are there depends on the start), and a test-user process joining it. Docker's restarts above
# (await_netns_thread) only give it more starts to find one on; this check is the same with or without them.
[ -s "$t/threads-new" ] || fail "after the upgrade (and $DOCKER_RESTARTS Docker restart(s)) no thread of any $U process is in a non-host netns: this probe can't tell whether the containers' netns route is dropped"
# #545: a run joins none of them at all (its own user namespace), so the plain test-user unit is what shows the route is
# there and dropped: it must join one (and, above, reach nothing).
grep -q "^the containers' netns (pid [0-9]*, tid [0-9]*, net:\[[0-9]*\]): joined; " "$t/join-new-plain.out" || fail "after the upgrade the plain test-user unit couldn't join any $U thread's non-host netns: this probe can't tell whether that route is dropped"
if grep -q ": joined; " "$t/join-new-run.out"; then fail "after the upgrade a run joined one of Docker's namespaces (#545): $(grep ": joined; " "$t/join-new-run.out" | head -n 1)"; fi
echo "== granted (#545), the upgraded install (dropped): the granted run still reaches the stand-in, through root's slirp4netns as before"
granted_run dropped
for x in OK "net_user " "net_in_set no"; do grep -qx "$x" "$t/granted-dropped.out" || fail "the granted run (dropped install): no line \"$x\""; done
summary "### #545: a granted run on the upgraded (dropped) install: $(tr '\n' ';' < "$t/granted-dropped.out")"
sudo bash "$EF" check > "$t/check-upgrade.log" || { cat "$t/check-upgrade.log"; fail "check fails after the upgrade"; }
cat "$t/check-upgrade.log"
echo "OK: test users covered by default on real systemd; Docker's pull the one exception, kept across reloads and restarts; an install that covered test users before #543 keeps dropping their Docker"
