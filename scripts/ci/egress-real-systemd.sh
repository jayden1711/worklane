#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the egress job, after test-user.sh install ci; DB_IMAGE set): the host egress
# rule (scripts/setup/egress-firewall.sh, #543) on real systemd, real nft and the test user's real rootless Docker.
# A "public" stand-in, 198.51.100.7 (TEST-NET-2), in a network namespace of its own behind a veth, so it is neither
# this host's loopback nor its LAN; Docker's pull goes to the real registry.
#   before:    a test-user unit with no PrivateNetwork reaches the stand-in (so a drop below is the rule's doing).
#   apply:     test users covered by default (systemd 255 here); Docker, started before the set existed, is put in it.
#   refused:   a test-user process (a unit as wl-test-ci in worklane-test.slice, no PrivateNetwork) is dropped; its own
#              loopback works.
#   cgroup:    the same kind of unit can't move itself into Docker's cgroup: its write of its own pid to cgroup.procs of
#              Docker's unit and of its daemon subgroup is refused (a plain permission check; the job fails if it isn't).
#   pull:      a real rootless docker pull of the database image, with the rule on.
#   reload:    the rule file loaded again (as the boot unit does, and apply) keeps Docker in the set; the pre-#543 way
#              (delete the table, make it again) empties it (fail-without), and apply puts Docker back.
#   restart:   the set follows Docker through a restart, with no reload.
#   no NFTSet: Docker's unit without NFTSet= can't pull, and check says why (fail-without); test-user.sh install puts it
#              back, loads the rule again, and the pull works.
#   join:      MEASURED, NOT ASSERTED: whether a test run (the real helper's exec, its real sandbox) can join the Docker
#              daemon's user+net namespaces, and reach the stand-in from there (through Docker's exempt slirp4netns).
#              The answer is printed and put in the job summary either way.
#   upgrade:   an install that covered test users before #543 (the pre-#543 egress-firewall.sh, apply --with-test-users,
#              and a Docker unit with no NFTSet=) keeps dropping their Docker after the new test-user.sh install and
#              apply: no NFTSet=, no cgroup accept, the pull dropped, and the join probe, run before and after, reaches
#              the stand-in from nowhere it didn't before (asserted: the job fails if any blocked attempt opens).
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
# Docker answers on its socket again (after a restart), within 60 s, or the job fails. WHY sudo test: its runtime
# directory is the test user's, 0700, so the runner user can't see the socket (a plain [ -S ] never passed).
docker_up() { for _ in $(seq 60); do sudo test -S /run/worklane-test-ci-docker/docker.sock && dk info > /dev/null 2>&1 && return 0; sleep 1; done; fail "$DU didn't come back up"; }
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
# <netns file|-> <pid>...
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
for n in "$@"; do try "the containers' netns (pid $n)" nsenter --user="/proc/$d/ns/user" --net="/proc/$n/ns/net" --preserve-credentials; done
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
# any process of the test user's in a network namespace other than the host's.
join_probe() {
  local tag="$1" id="egress-join-$1" dpid hostnet nsfile npids="" p n r probe64 join64 cmd
  local id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  dpid="$(pgrep -u "$U" -x dockerd | head -n 1)"
  [ -n "$dpid" ] || fail "no dockerd of $U's"
  hostnet="$(sudo readlink /proc/1/ns/net)"
  echo "  host: net ns $hostnet; dockerd: pid $dpid, user ns $(sudo readlink "/proc/$dpid/ns/user"), net ns $(sudo readlink "/proc/$dpid/ns/net")"
  nsfile="$(sudo find /run/worklane-test-ci-docker -maxdepth 3 -name netns 2>/dev/null | head -n 1)"
  echo "  Docker's container netns file: ${nsfile:-none found} $([ -z "$nsfile" ] || sudo stat -c '(%U:%G %a)' "$nsfile")"
  for p in $(pgrep -u "$U"); do
    n="$(sudo readlink "/proc/$p/ns/net" 2>/dev/null || true)"
    if [ -n "$n" ] && [ "$n" != "$hostnet" ]; then npids="$npids $p"; echo "  $U's pid $p ($(ps -o comm= -p "$p")) is in net ns $n"; fi
  done
  # Control: root in that netns reaches the stand-in (so a process of the test user's that joins it would too).
  if [ -n "$nsfile" ]; then
    echo "  control, root in Docker's container netns -> $PUB: $(sudo nsenter --net="$nsfile" python3 "$t/probe.py" "$PUB" "$PORT" 2>&1 || true)"
  fi
  sudo systemd-run --wait --pipe --quiet --collect --uid="$U" --gid="$U" --slice=worklane-test.slice -p RuntimeMaxSec=60 \
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
  as_ exec "$id" 60 -- "$cmd" < /dev/null > "$t/join-$tag-run.out" 2> "$t/join-$tag-run.err" || true
  sed 's/^/  run: /' "$t/join-$tag-run.out"
  as_ wipe "$id" > /dev/null
  grep -q '^own netns: ' "$t/join-$tag-run.out" || { cat "$t/join-$tag-run.err" >&2; fail "the run's probe didn't run"; }
  [ "$(sed -n "s/^own netns: -> $PUB: //p" "$t/join-$tag-run.out")" != OK ] || fail "the run reached $PUB from its own namespace"
  JOIN_INFO="Host net ns $hostnet; dockerd pid $dpid in net ns $(sudo readlink "/proc/$dpid/ns/net"); containers' netns file: ${nsfile:-none}; other test-user pids in a non-host netns:${npids:- none}."
}
# The attempts in join probe output $1 that reached the stand-in, by what was tried (a pid's number left out: it
# changes when Docker restarts), sorted.
opened() { { grep -- "-> $PUB: OK\$" "$1" || true; } | sed -E 's/ \(pid [0-9]+\)/ (pid)/; s/: .*//' | sort -u; }

echo "== join (measured, not asserted): can a test run join the Docker daemon's user+net namespaces?"
join_probe default
summary "### #543: can a test run join the Docker daemon's namespaces? (measured on this runner)"
summary "$JOIN_INFO"
while IFS= read -r l; do summary "- from a run (the helper's real exec sandbox): $l"; done < "$t/join-default-run.out"
while IFS= read -r l; do summary "- from a plain test-user unit (no run sandbox): $l"; done < "$t/join-default-plain.out"
if grep -q ": joined; -> $PUB: OK$" "$t/join-default-run.out"; then
  summary "ANSWER: a test run CAN get out through Docker's namespaces: $(grep ": joined; -> $PUB: OK$" "$t/join-default-run.out" | head -n 1)."
else
  summary "ANSWER: a test run can NOT get out through Docker's namespaces here (each attempt above was refused or reached nothing)."
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
join_probe old
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
# No grep -q here: an early exit could fail systemctl with SIGPIPE, and pipefail would hide the match.
if systemctl cat "$DU" | grep '^NFTSet='; then fail "after the upgrade $DU has NFTSet= again"; fi
grep -q '^# No NFTSet=: the host egress rule' "/etc/systemd/system/$DU" || fail "test-user.sh install didn't say why $DU has no NFTSet="
sudo nft list table inet worklane_egress | tee "$t/new-table"
if grep -Eq 'socket cgroupv2|egress_ok' "$t/new-table"; then fail "after the upgrade the rule has a cgroup exception"; fi
if pull 90 2> /dev/null; then fail "after the upgrade Docker pulled: the route the pre-#543 opt-in had closed is open"; fi
echo "  after: Docker's pull was dropped"
join_probe new
summary "### #543 upgrade: an install that covered test users before #543 keeps dropping their Docker (asserted)"
summary "Before: $PRE543's apply --with-test-users, Docker's unit without NFTSet=. After: the new test-user.sh install and apply. Both: no cgroup exception, Docker's pull dropped. $JOIN_INFO"
for w in run plain; do
  while IFS= read -r l; do summary "- before, from a $w: $l"; done < "$t/join-old-$w.out"
  while IFS= read -r l; do summary "- after, from a $w: $l"; done < "$t/join-new-$w.out"
  newly="$(comm -13 <(opened "$t/join-old-$w.out") <(opened "$t/join-new-$w.out"))"
  [ -z "$newly" ] || fail "upgrade: from a $w, what the pre-#543 opt-in blocked now reaches $PUB: $newly"
  if grep -q -- "-> $PUB: OK\$" "$t/join-new-$w.out"; then fail "upgrade: from a $w, a join still reaches $PUB: $(opened "$t/join-new-$w.out")"; fi
done
grep -q "^the containers' netns (pid [0-9]*): joined; " "$t/join-new-run.out" || fail "after the upgrade the run couldn't join Docker's containers' netns at all: this probe can't tell whether that route is dropped"
sudo bash "$EF" check > "$t/check-upgrade.log" || { cat "$t/check-upgrade.log"; fail "check fails after the upgrade"; }
cat "$t/check-upgrade.log"
echo "OK: test users covered by default on real systemd; Docker's pull the one exception, kept across reloads and restarts; an install that covered test users before #543 keeps dropping their Docker"
