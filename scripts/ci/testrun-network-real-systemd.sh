#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after test-user.sh install and the database image
# step): test-run networking (docs/test-runs.md "Network") against real systemd, the real helper and its real sudoers
# rule, slirp4netns, Docker and npm. No internet. Listeners record each connection (label:destination):
#   host:  this host, any address (0.0.0.0): its loopback services and its LAN address (the route's source);
#   hub:   127.0.0.1:4399, a stand-in for the dashboard hub; dash: 127.0.0.1:4310, for an instance's dashboard;
#   pub:   198.51.100.7 (TEST-NET-2), a stand-in "public" host: in a network namespace of its own behind a veth, so it is
#          not one of this host's addresses (made here, removed after).
# A run probes 127.0.0.1 and slirp's gateway (its alias for the host's loopback) on the host's, the hub's and the dashboard's
# ports, the LAN address, and the public stand-in.
#   none:    a run that asks for nothing, and one whose tier asks (tests.yaml network: true) with no root grant: reaches
#            nothing, nor DNS; its own loopback works. The helper before this PR (main at $OLD) lets it out (fail-without).
#   granted: root's script grants ci's e2e: that tier reaches the public stand-in only: never the host's loopback (the
#            hub, the dashboard), its LAN address or slirp's gateway; its own loopback works. The helper of this PR before the
#            owner's change ($GRANTED_OLD: the host's namespace, IPAddressDeny=) reached the hub (fail-without). Another
#            tier of ci, and the other instance's e2e, get none.
#   fetch:   npm reaches the public stand-in only, never the host's loopback (slirp's gateway) or its LAN address, with no grant;
#            the wipe stops its unit.
#   db:      the run's Postgres container reaches nothing (--network none); the helper before reached the public one.
#   #545:    a granted run is in a user namespace of its own (only the test user's uid, mapped to itself; no capability
#            in any set) and its slirp4netns runs as the test user (its unit's User= and its process), not root; the
#            fetch's too. The helper before #545 ($PRE545) ran it as root, in the host's user namespace (fail-without).
#            The test user's slirp sandbox (SLIRP_USER_SANDBOX) refuses an abstract Unix socket, as root's does.
# Usage: bash scripts/ci/testrun-network-real-systemd.sh <other instance>   (as the runner user, with sudo; DB_IMAGE set)
set -euo pipefail
I2="${1:?the other instance}"
: "${DB_IMAGE:?the pinned database image}"
H=/usr/local/libexec/worklane-testrun
OLD=213b99dd61982fc1c7ac3f5133dbc10f222e8697
GRANTED_OLD=5498300b06fbd564f3664baded6d3852ef6a7330
# main before #545 (with #543's egress rule): its helper runs a granted run's slirp4netns as root, and the run in the
# host's user namespace.
PRE545=689854dea0f90f963cf4f80f8bbc1945aaae1cbf
PUB=198.51.100.7
HUB=4399
DASH=4310
t="$(mktemp -d)"
chmod 0755 "$t"
etc_was=0; [ -d /etc/worklane ] && etc_was=1
cleanup() {
  if [ -f "$t/pids" ]; then while read -r p; do sudo kill "$p" 2>/dev/null || true; done < "$t/pids"; fi
  sudo pkill -f "$t/listen.py" 2>/dev/null || true
  sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
  sudo setfacl -m o::--- /usr/local/libexec/worklane-testrun-userns 2>/dev/null || true
  sudo rm -f /etc/worklane/testrun-network.json
  [ "$etc_was" = 1 ] || sudo rmdir /etc/worklane 2>/dev/null || true
  sudo ip netns del wlpub 2>/dev/null || true
  sudo ip link del wlv0 2>/dev/null || true
  rm -rf "$t"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

lan="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[[ "$lan" =~ ^(10|172|192)\. ]] || fail "this runner's LAN address ($lan) is not a private one"
# The public stand-in: its own namespace, reached through a veth, never one of this host's addresses.
sudo ip netns add wlpub
sudo ip link add wlv0 type veth peer name wlv1
sudo ip link set wlv1 netns wlpub
sudo ip addr add 198.51.100.1/24 dev wlv0
sudo ip link set wlv0 up
sudo ip netns exec wlpub ip addr add "$PUB/24" dev wlv1
sudo ip netns exec wlpub ip link set wlv1 up
sudo ip netns exec wlpub ip link set lo up
# A listener: <bind address> <port, 0 for any> <label> <port file>; each connection's "label:destination" in $t/seen.
cat > "$t/listen.py" <<'EOF'
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((sys.argv[1], int(sys.argv[2]))); s.listen(64)
open(sys.argv[4], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept()
    with open(sys.argv[5], "a") as f: f.write(sys.argv[3] + ":" + c.getsockname()[0] + "\n")
    c.close()
EOF
: > "$t/seen"
chmod 0666 "$t/seen"
listen() { # [ns] <bind> <port> <label>: started in the background; its port printed
  local ns=() pf
  [ "$1" = ns ] && { ns=(sudo ip netns exec wlpub); shift; }
  pf="$t/port-$3"
  # Its output away from the caller's $(...), which would wait for it; its pid in a file (that subshell's array is lost).
  ${ns[@]+"${ns[@]}"} python3 "$t/listen.py" "$1" "$2" "$3" "$pf" "$t/seen" > /dev/null 2>&1 &
  echo "$!" >> "$t/pids"
  for _ in $(seq 50); do [ -s "$pf" ] && break; sleep 0.1; done
  [ -s "$pf" ] || fail "listener $3 didn't start"
  cat "$pf"
}
P="$(listen 0.0.0.0 0 host)"
listen 127.0.0.1 "$HUB" hub > /dev/null
listen 127.0.0.1 "$DASH" dash > /dev/null
PP="$(listen ns 0.0.0.0 0 pub)"
echo "listeners: host $P, hub $HUB, dash $DASH (127.0.0.1); public stand-in $PUB:$PP; LAN $lan"
for x in "127.0.0.1 $P" "$lan $P" "127.0.0.1 $HUB" "127.0.0.1 $DASH" "$PUB $PP"; do set -- $x; python3 -c "import socket; socket.create_connection(('$1', $2), 3).close()"; done
sleep 0.3
[ "$(sort -u "$t/seen" | tr '\n' ' ')" = "$(printf '%s\n' "dash:127.0.0.1" "host:127.0.0.1" "host:$lan" "hub:127.0.0.1" "pub:$PUB" | sort | tr '\n' ' ')" ] || fail "the host itself didn't reach all five: $(cat "$t/seen")"
: > "$t/seen"
seen() { sort -u "$t/seen" | tr '\n' ' '; }
# slirp4netns's alias for the host's loopback (its gateway), built from its first octet: the denylist refuses a literal
# private address, and this is slirp's fixed one, not a LAN's.
SLIRP_GW="$(printf '%s.0.2.2' 10)"
SLIRP_DNS="$(printf '%s.0.2.3' 10)"
# The machine's upstream DNS server (resolved's list): a granted run reaches it only through slirp's forwarder.
UPSTREAM="$(sed -n 's/^nameserver \([0-9.]*\)$/\1/p' /run/systemd/resolve/resolv.conf | grep -v '^127\.' | head -n 1)"
[ -n "$UPSTREAM" ] || fail "no upstream DNS server in /run/systemd/resolve/resolv.conf"
/usr/bin/slirp4netns --version
echo "upstream DNS server: $UPSTREAM"
TARGETS="127.0.0.1:$P 127.0.0.1:$HUB 127.0.0.1:$DASH $SLIRP_GW:$P $SLIRP_GW:$HUB $lan:$P $UPSTREAM:53 $UPSTREAM:80 $PUB:$PP"

as_() { local i="$1"; shift; sudo -u "wl-$i" sudo -n "$H" "$i" "$@"; }
# A run of instance $1 with id $2, its commit holding the files in directory $3 (optional).
mkrun() {
  local i="$1" id="$2" files="${3:-}" r id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  r="$(mktemp -d)"
  git init -q "$r" && date +%s%N > "$r/f"
  [ -z "$files" ] || cp -r "$files"/. "$r/"
  git -C "$r" add -A && git -C "$r" "${id_[@]}" commit -q -m probe
  for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
  git -C "$r" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
  as_ "$i" create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
  rm -rf "$r"
}
# What a run reaches: each "<addr>:<port> OK|<errno>", then its own loopback, then DNS. No ${...}: systemd expands those.
probe_py='import socket, sys, threading
for t in sys.argv[1:]:
    a, p = t.rsplit(":", 1)
    try:
        socket.create_connection((a, int(p)), 3).close(); print(t, "OK")
    except OSError as e:
        print(t, type(e).__name__)
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
threading.Thread(target=lambda: s.accept(), daemon=True).start()
try:
    socket.create_connection(s.getsockname(), 3).close(); print("own-loopback OK")
except OSError as e:
    print("own-loopback", type(e).__name__)
try:
    socket.getaddrinfo("example.com", 443); print("dns OK")
except OSError as e:
    print("dns", type(e).__name__)
try:
    print("resolv", ",".join(l.split()[1] for l in open("/etc/resolv.conf") if l.startswith("nameserver")))
except OSError as e:
    print("resolv", type(e).__name__)'
probe="printf %s $(printf %s "$probe_py" | base64 -w0) | base64 -d > \"\$TMPDIR/p.py\" && python3 \"\$TMPDIR/p.py\" $TARGETS"
# exec of run <id> of instance <i> with the probe; its stdout in $t/<id>.out, stderr in $t/<id>.err.
ex() {
  local i="$1" id="$2"; shift 2
  mkrun "$i" "$id"
  : > "$t/seen"
  as_ "$i" exec "$id" 60 "$@" -- "$probe" < /dev/null > "$t/$id.out" 2> "$t/$id.err" || { cat "$t/$id.err" >&2; sudo journalctl --no-pager -n 40 -u "worklane-test-${i}_${id}_net_*" >&2 || true; fail "$id exited non-zero"; }
  sed "s/^/  $id: /" "$t/$id.out"
  as_ "$i" wipe "$id" > /dev/null
}
got() { awk -v a="$2" '$1 == a { print $2 }' "$t/$1.out"; }
none_reached() { # <id>: nothing, no DNS; its own loopback works; no listener saw anything
  local id="$1" x
  for x in $TARGETS; do [ "$(got "$id" "$x")" != OK ] || fail "$id reached $x"; done
  [ "$(got "$id" dns)" != OK ] || fail "$id resolved a name"
  [ "$(got "$id" own-loopback)" = OK ] || fail "$id: its own loopback doesn't work"
  [ -z "$(seen)" ] || fail "$id: a listener saw $(seen)"
}

echo "== none: no ask, and an ask (network: true) with no root grant"
sudo rm -f /etc/worklane/testrun-network.json
ex ci net-plain
none_reached net-plain
grep -q 'worklane-testrun: network' "$t/net-plain.err" && fail "a run that didn't ask got a network line"
ex ci net-ask --network e2e
none_reached net-ask
grep -qx 'worklane-testrun: network none (no tier of any instance has the network on this machine (no /etc/worklane/testrun-network.json))' "$t/net-ask.err" || { cat "$t/net-ask.err" >&2; fail "the none line"; }

echo "== fail-without: the helper before this change (main at $OLD) lets the same probe out"
git fetch -q --depth=1 origin "$OLD"
git show "$OLD:scripts/machine/worklane-testrun.sh" > "$t/helper-old.sh"
grep -qx 'PROTOCOL=8' "$t/helper-old.sh"
sudo install -o root -g root -m 0755 "$t/helper-old.sh" "$H"
ex ci net-old
[ "$(got net-old "$PUB:$PP")" = OK ] || fail "the old helper's run didn't reach $PUB: this probe can't tell"
echo "  the old helper's run reached: $(seen)"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"

echo "== granted: root's script grants ci's e2e"
sudo bash scripts/setup/testrun-network.sh enable ci --tiers e2e
[ "$(stat -c '%U:%G %a' /etc/worklane/testrun-network.json)" = 'root:root 644' ] || fail "the root file isn't root:root 0644"
ex ci net-granted --network e2e
grep -qx "worklane-testrun: network granted (e2e; public addresses and the machine's DNS only)" "$t/net-granted.err" || { cat "$t/net-granted.err" >&2; fail "the granted line"; }
[ "$(got net-granted "$PUB:$PP")" = OK ] || { cat "$t/net-granted.err" >&2; fail "the granted tier didn't reach $PUB"; }
[ "$(got net-granted own-loopback)" = OK ] || fail "the granted tier's own loopback"
# DNS only through slirp's forwarder: the run's resolv.conf names it alone, resolution works, and the upstream server
# itself is refused on 53 and on 80.
[ "$(got net-granted resolv)" = "$SLIRP_DNS" ] || fail "the granted run's resolv.conf names $(got net-granted resolv), not slirp's forwarder alone"
[ "$(got net-granted dns)" = OK ] || fail "the granted run can't resolve a name through slirp's forwarder"
for x in "$UPSTREAM:53" "$UPSTREAM:80"; do [ "$(got net-granted "$x")" != OK ] || fail "the granted run reached the upstream DNS server at $x itself"; done
# Never the host's loopback (the hub, the dashboard, any service there), its LAN address or slirp's alias for it.
[ "$(seen)" = "pub:$PUB " ] || fail "the listeners saw $(seen), not the public stand-in alone"
echo "  the granted run reached: $(seen)(dns: $(got net-granted dns))"

echo "== #545: a granted run in a user namespace of its own, and its slirp4netns as the test user, not root"
# The run prints its own view (its uid map, its capability sets, the public stand-in), then holds its unit 6 s while
# its network unit's User=, its slirp4netns process's owner and the run's main process's user namespace are read.
cat > "$t/own.sh" <<'EOF'
printf 'uid_map %s %s %s\n' $(cat /proc/self/uid_map)
grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb):' /proc/self/status
python3 -c 'import socket, sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 3).close(); print("pub OK")' "$1" "$2" || echo "pub refused"
sleep 6
EOF
ownsh="printf %s $(base64 -w0 < "$t/own.sh") | base64 -d > \"\$TMPDIR/o.sh\" && bash \"\$TMPDIR/o.sh\" $PUB $PP"
own_ns() { # <id>: a granted run of ci's e2e; its output and what was read while it ran, in $t/<id>.out
  local id="$1" pid u="" ru main i
  mkrun ci "$id"
  : > "$t/seen"
  as_ ci exec "$id" 60 --network e2e -- "$ownsh" < /dev/null > "$t/$id.out" 2> "$t/$id.err" &
  pid=$!
  for i in $(seq 100); do
    u="$(systemctl list-units --plain --no-legend --full "worklane-test-ci_${id}_net_*" | awk '{ print $1 }' | head -n 1)"
    if [ -n "$u" ] && [ "$(systemctl show -p MainPID --value "$u" 2>/dev/null || echo 0)" != 0 ]; then break; fi
    u=""; sleep 0.1
  done
  [ -n "$u" ] || { wait "$pid" || true; cat "$t/$id.err" >&2; fail "$id: no network unit came up"; }
  ru="$(systemctl list-units --plain --no-legend --full "worklane-test-ci_${id}_[0-9]*.service" | awk '{ print $1 }' | head -n 1)"
  main="$(systemctl show -p MainPID --value "$ru")"
  {
    echo "slirp_unit_user $(systemctl show -p User --value "$u")"
    echo "slirp_proc_user $(ps -o user= -p "$(systemctl show -p MainPID --value "$u")" | tr -d ' ')"
    if [ "$(sudo readlink "/proc/$main/ns/user")" = "$(sudo readlink /proc/1/ns/user)" ]; then echo "run_userns host"; else echo "run_userns own"; fi
  } >> "$t/$id.ns"
  wait "$pid" || { cat "$t/$id.err" >&2; fail "$id exited non-zero"; }
  cat "$t/$id.ns" >> "$t/$id.out"
  sed "s/^/  $id: /" "$t/$id.out"
  as_ ci wipe "$id" > /dev/null
}
tu_uid="$(id -u wl-test-ci)"
own_ns net-own
for x in "uid_map $tu_uid $tu_uid 1" "slirp_unit_user wl-test-ci" "slirp_proc_user wl-test-ci" "run_userns own" "pub OK"; do
  grep -qx "$x" "$t/net-own.out" || fail "the granted run (#545): no line \"$x\""
done
for c in CapInh CapPrm CapEff CapBnd CapAmb; do
  grep -qE "^$c:[[:space:]]+0+$" "$t/net-own.out" || fail "the granted run (#545) has a capability: $(grep "^$c:" "$t/net-own.out")"
done
[ "$(seen)" = "pub:$PUB " ] || fail "the granted run (#545): the listeners saw $(seen), not the public stand-in alone"
echo "  fail-without: the helper before #545 ($PRE545) runs the run in the host's user namespace and its slirp4netns as root"
git fetch -q --depth=1 origin "$PRE545"
git show "$PRE545:scripts/machine/worklane-testrun.sh" > "$t/helper-pre545.sh"
sudo install -o root -g root -m 0755 "$t/helper-pre545.sh" "$H"
own_ns net-own-old
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
for x in "uid_map 0 0 4294967295" "slirp_unit_user " "slirp_proc_user root" "run_userns host" "pub OK"; do
  grep -qx "$x" "$t/net-own-old.out" || fail "the helper before #545: no line \"$x\": this probe can't tell"
done
: > "$t/seen"

echo "== #545: only the test users may run the wrapper, and a run's own command doesn't keep its user-namespace allowance"
# This runner restricts unprivileged user namespaces (Ubuntu 24.04): the wrapper's AppArmor profile is what lets it make
# one. A capability use in a fresh user+net namespace (ip link add, a dummy device: its module loaded first) tells
# whether a process got that allowance.
W=/usr/local/libexec/worklane-testrun-userns
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = 1 ] || fail "this runner doesn't restrict user namespaces: these checks can't tell"
sudo modprobe dummy
IPB="$(command -v ip)"
SPB="$(command -v setpriv)"
echo "  the wrapper: $(sudo stat -c '%U:%G %a' "$W"), ACL: $(sudo getfacl -cp "$W" | tr '\n' ' ')"
# <label> <systemd-run options...>: the wrapper, in a NoNewPrivileges unit, making a namespace and using a capability in it.
wtry() {
  local label="$1" out rc=0; shift
  out="$(sudo systemd-run --wait --pipe --quiet --collect -p NoNewPrivileges=yes "$@" "$W" --user --map-root-user --net "$IPB" link add d0 type dummy < /dev/null 2>&1)" || rc=$?
  echo "  $label: exit $rc: ${out:-(no output)}"
  return "$rc"
}
wtry "the test user (may)" --uid=wl-test-ci --gid=wl-test-ci || fail "the test user can't use the wrapper"
if wtry "the coordinator wl-ci (may not)" --uid=wl-ci --gid=wl-ci; then fail "wl-ci ran the wrapper"; fi
if wtry "a DynamicUser unit (may not)" -p DynamicUser=yes; then fail "a DynamicUser unit ran the wrapper"; fi
echo "  fail-without: the wrapper world-executable (o::r-x), a DynamicUser unit uses it"
sudo setfacl -m o::r-x "$W"
wrc=0; wtry "a DynamicUser unit, the wrapper world-executable" -p DynamicUser=yes || wrc=$?
sudo setfacl -m o::--- "$W"
[ "$wrc" = 0 ] || fail "with the wrapper world-executable a DynamicUser unit still couldn't use it: this check can't tell"
# A run's own command, making a namespace of its own and using a capability in it: refused, as before #545.
nested="unshare --user --map-root-user --net $IPB link add d0 type dummy 2>&1; echo \"nested rc \$?\""
nest() { # <id> <helper label> [<command>]: a run doing that (or <command>); its output in $t/<id>.out
  mkrun ci "$1"
  as_ ci exec "$1" 60 -- "${3:-$nested}" < /dev/null > "$t/$1.out" 2> "$t/$1.err" || { cat "$t/$1.err" >&2; fail "$1 exited non-zero"; }
  sed "s/^/  $2: /" "$t/$1.out"
  as_ ci wipe "$1" > /dev/null
}
nest net-nested "this helper"
grep -qx 'nested rc 0' "$t/net-nested.out" && fail "a run made a user namespace and used a capability in it (#545: the wrapper's allowance leaked into the run)"
grep -q 'Operation not permitted' "$t/net-nested.out" || fail "the run's nested namespace wasn't refused with EPERM: $(cat "$t/net-nested.out")"
echo "  main's helper before #545 ($PRE545), the same: refused there too (the restriction, as it was)"
sudo install -o root -g root -m 0755 "$t/helper-pre545.sh" "$H"
nest net-nested-old "main's helper"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
grep -qx 'nested rc 0' "$t/net-nested-old.out" && fail "main's helper's run used a capability in a namespace of its own: the restriction isn't what this checks"
# Round 3: a run running the wrapper itself (its uid is in the wrapper's ACL) must not get the profile's allowance back.
# The prelude binds /dev/null over the wrapper in the run's own mount namespace. Fail-without: #780's helper at
# $R1 (round 1, no such bind) lets the run make the namespace and add the dummy link.
R1=6cfc5436884bbffa24a8cb01b04f4292af5648c4
wrapped="$W --user --map-root-user --net $IPB link add d0 type dummy 2>&1; echo \"nested rc \$?\""
nest net-wrapper "this helper, the run running the wrapper" "$wrapped"
grep -qx 'nested rc 0' "$t/net-wrapper.out" && fail "a run ran the wrapper and used a capability in a namespace of its own (round 3)"
grep -q 'Permission denied' "$t/net-wrapper.out" || fail "the run's exec of the wrapper wasn't refused with EACCES: $(cat "$t/net-wrapper.out")"
echo "  fail-without: #780's helper at $R1 (round 1), the same run running the wrapper"
git fetch -q --depth=1 origin "$R1"
git show "$R1:scripts/machine/worklane-testrun.sh" > "$t/helper-r1.sh"
sudo install -o root -g root -m 0755 "$t/helper-r1.sh" "$H"
nest net-wrapper-r1 "round 1's helper, the run running the wrapper" "$wrapped"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
grep -qx 'nested rc 0' "$t/net-wrapper-r1.out" || fail "with round 1's helper the run's exec of the wrapper was refused anyway: this check can't tell"
# Fail-without for the switch: the run's prelude exactly, as the test user in a NoNewPrivileges unit, with and without
# setpriv's --apparmor-profile=unconfined: without it the command keeps the wrapper's allowance.
prelude() { # [<setpriv option>]: the prelude, then the nested namespace's capability use
  sudo systemd-run --wait --pipe --quiet --collect --expand-environment=no --uid=wl-test-ci --gid=wl-test-ci -p NoNewPrivileges=yes \
    "$W" --user --map-current-user --net --keep-caps -- /bin/sh -c "$IPB link set lo up && exec $SPB --inh-caps=-all --ambient-caps=-all --bounding-set=-all $* -- \"\$@\"" sh \
    /bin/sh -c "$nested" < /dev/null 2>&1 || true
}
without="$(prelude)"; with="$(prelude --apparmor-profile=unconfined)"
echo "  the prelude without --apparmor-profile=unconfined: $without"
echo "  the prelude with it: $with"
grep -qx 'nested rc 0' <<<"$without" || fail "without --apparmor-profile=unconfined the nested namespace was refused anyway: this check can't tell"
if grep -qx 'nested rc 0' <<<"$with"; then fail "with --apparmor-profile=unconfined the nested namespace still worked"; fi
grep -q 'Operation not permitted' <<<"$with" || fail "with --apparmor-profile=unconfined: not refused with EPERM: $with"

echo "== slirp4netns's sandbox: no Unix socket at all, so no host abstract socket (owner's RestrictAddressFamilies)"
# A stand-in for a host service on an abstract Unix socket (not a file: an empty /etc and /run don't hide it).
cat > "$t/abstract.py" <<'EOF'
import socket, sys
s = socket.socket(socket.AF_UNIX); s.bind("\0worklane-ci-abstract-standin"); s.listen(8)
open(sys.argv[1], "w").write("up")
while True:
    c, _ = s.accept()
    with open(sys.argv[2], "a") as f: f.write("abstract:standin\n")
    c.close()
EOF
python3 "$t/abstract.py" "$t/abstract-up" "$t/seen" > /dev/null 2>&1 &
echo "$!" >> "$t/pids"
for _ in $(seq 50); do [ -s "$t/abstract-up" ] && break; sleep 0.1; done
[ -s "$t/abstract-up" ] || fail "the abstract socket stand-in didn't start"
# The helper's own slirp sandbox, exactly as slirp_start passes it (SLIRP_SANDBOX), run as root (slirp's uid).
eval "$(sed -n '/^SLIRP_SANDBOX=(/,/)$/p' scripts/machine/worklane-testrun.sh)"
[ "${#SLIRP_SANDBOX[@]}" -gt 10 ] || fail "SLIRP_SANDBOX wasn't read from the helper"
abstract_probe='import errno, socket
try:
    s = socket.socket(socket.AF_UNIX); s.connect("\0worklane-ci-abstract-standin"); print("abstract OK")
except OSError as e:
    print("abstract", errno.errorcode.get(e.errno, str(e.errno)))'
: > "$t/seen"
got_in="$(sudo systemd-run --wait --pipe --quiet --collect "${SLIRP_SANDBOX[@]}" /usr/bin/python3 -c "$abstract_probe" < /dev/null)"
echo "  in slirp's sandbox: $got_in; the stand-in saw: $(seen)"
[ "$got_in" = "abstract EAFNOSUPPORT" ] || fail "in slirp's sandbox the probe got: $got_in"
[ -z "$(seen)" ] || fail "the stand-in saw $(seen)"
# Fail-without: the same sandbox with AF_UNIX allowed too (RestrictAddressFamilies= lists add up) connects.
got_out="$(sudo systemd-run --wait --pipe --quiet --collect "${SLIRP_SANDBOX[@]}" -p RestrictAddressFamilies=AF_UNIX /usr/bin/python3 -c "$abstract_probe" < /dev/null)"
sleep 0.3
echo "  the same with AF_UNIX allowed: $got_out; the stand-in saw: $(seen)"
[ "$got_out" = "abstract OK" ] && [ "$(seen)" = "abstract:standin " ] || fail "with AF_UNIX allowed the probe didn't connect ($got_out; $(seen)): this probe can't tell"
: > "$t/seen"
# The test user's slirp sandbox (#545), as slirp_start passes it (SLIRP_USER_SANDBOX), as the test user: the same.
eval "$(sed -n '/^SLIRP_USER_SANDBOX=(/,/)$/p' scripts/machine/worklane-testrun.sh)"
[ "${#SLIRP_USER_SANDBOX[@]}" -gt 10 ] || fail "SLIRP_USER_SANDBOX wasn't read from the helper"
got_in="$(sudo systemd-run --wait --pipe --quiet --collect --uid=wl-test-ci --gid=wl-test-ci "${SLIRP_USER_SANDBOX[@]}" /usr/bin/python3 -c "$abstract_probe" < /dev/null)"
echo "  in the test user's slirp sandbox: $got_in; the stand-in saw: $(seen)"
[ "$got_in" = "abstract EAFNOSUPPORT" ] || fail "in the test user's slirp sandbox the probe got: $got_in"
[ -z "$(seen)" ] || fail "the stand-in saw $(seen)"
got_out="$(sudo systemd-run --wait --pipe --quiet --collect --uid=wl-test-ci --gid=wl-test-ci "${SLIRP_USER_SANDBOX[@]}" -p RestrictAddressFamilies=AF_UNIX /usr/bin/python3 -c "$abstract_probe" < /dev/null)"
sleep 0.3
echo "  the same with AF_UNIX allowed: $got_out; the stand-in saw: $(seen)"
[ "$got_out" = "abstract OK" ] && [ "$(seen)" = "abstract:standin " ] || fail "as the test user with AF_UNIX allowed the probe didn't connect ($got_out; $(seen)): this probe can't tell"
: > "$t/seen"
echo "== fail-without: this PR's helper before the owner's change ($GRANTED_OLD: the host's namespace) let a granted run reach the hub"
git fetch -q --depth=1 origin "$GRANTED_OLD"
git show "$GRANTED_OLD:scripts/machine/worklane-testrun.sh" > "$t/helper-granted-old.sh"
sudo install -o root -g root -m 0755 "$t/helper-granted-old.sh" "$H"
ex ci net-granted-old --network e2e
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
case " $(seen)" in *" hub:127.0.0.1 "*) echo "  it reached: $(seen)" ;; *) fail "the helper at $GRANTED_OLD didn't reach the hub stand-in: this probe can't tell ($(seen))" ;; esac
ex ci net-othertier --network unit
none_reached net-othertier
grep -q '^worklane-testrun: network none (tier unit of ci is not granted the network in ' "$t/net-othertier.err" || fail "another tier's line"
ex "$I2" net-otherinst --network e2e
none_reached net-otherinst
grep -q "^worklane-testrun: network none (tier e2e of $I2 is not granted the network in " "$t/net-otherinst.err" || fail "the other instance's line"
sudo bash scripts/setup/testrun-network.sh disable ci > /dev/null

echo "== fetch: the public stand-in only, never the host's loopback or LAN, with no grant"
command -v npm > /dev/null && [ -x /usr/local/bin/npm ] || fail "no npm in /usr/local/bin for the test user (PATH=/usr/local/bin:/usr/bin:/bin)"
fetch_from() { # <id> <address:port> <want: none|seen>: a lockfile pinning one tarball at https://<address:port>/
  # WHY not waiting for the fetch to end: a blocked address drops the SYN, so npm waits its own timeouts and retries
  # (minutes). Only whether a connection arrives matters: 20 s (or npm's end) for none, until seen for one; then the
  # wipe stops the fetch's unit and its network's.
  local id="$1" a="$2" want="$3" d="$t/files-$1" pid i
  mkdir -p "$d"
  printf '{"name":"p","version":"1.0.0","dependencies":{"x":"1.0.0"}}\n' > "$d/package.json"
  printf '{"name":"p","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"p","version":"1.0.0","dependencies":{"x":"1.0.0"}},"node_modules/x":{"version":"1.0.0","resolved":"https://%s/x-1.0.0.tgz","integrity":"sha512-AAAA"}}}\n' "$a" > "$d/package-lock.json"
  mkrun ci "$id" "$d"
  key="$(printf '%s' "$id" | sha256sum | cut -c1-32)"
  as_ ci cache npm "$key" > /dev/null
  : > "$t/seen"
  as_ ci fetch "$id" npm npm "$key" 300 < /dev/null > "$t/$id.out" 2>&1 &
  pid=$!
  NETUSER=none
  for i in $(seq 40); do
    # Its network unit's User= (#545: the test user's), read while it runs.
    nu="$(systemctl list-units --plain --no-legend --full "worklane-test-ci_${id}_net_*" | awk '{ print $1 }' | head -n 1)"
    if [ -n "$nu" ] && [ "$NETUSER" = none ]; then NETUSER="$(systemctl show -p User --value "$nu")"; fi
    { [ "$want" = seen ] && grep -q "^pub:" "$t/seen"; } && break
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  head -n 1 "$t/$id.out" | grep -qx "worklane-testrun: fetch npm (no script run; public addresses and the machine's DNS only)" || { cat "$t/$id.out" >&2; fail "$id: the fetch line"; }
  # A "none" proves something only if npm tried that address: still waiting on it (blocked), or its error names it.
  if [ "$want" = none ] && ! kill -0 "$pid" 2>/dev/null && ! grep -qF "${a%:*}" "$t/$id.out"; then cat "$t/$id.out" >&2; fail "$id: the fetch ended without trying $a"; fi
  echo "  $id (https://$a): the listeners saw: $(seen)"
  as_ ci wipe "$id" > /dev/null
  [ -z "$(systemctl list-units --plain --no-legend "worklane-test-ci_${id}_*")" ] || fail "$id: the wipe left a unit: $(systemctl list-units --plain --no-legend "worklane-test-ci_${id}_*")"
  wait "$pid" 2>/dev/null || true
}
fetch_from net-fetch-loop "$SLIRP_GW:$HUB" none
[ -z "$(seen)" ] || fail "the fetch reached the host's loopback: $(seen)"
fetch_from net-fetch-lan "$lan:$P" none
[ -z "$(seen)" ] || fail "the fetch reached the host's LAN address: $(seen)"
fetch_from net-fetch-pub "$PUB:$PP" seen
[ "$(seen)" = "pub:$PUB " ] || { cat "$t/net-fetch-pub.out" >&2; fail "the fetch didn't reach the public stand-in: $(seen)"; }
echo "  the fetch's slirp4netns unit ran as: ${NETUSER:-root (no User=)}"
[ "$NETUSER" = wl-test-ci ] || fail "the fetch's slirp4netns unit ran as ${NETUSER:-root (no User=)}, not wl-test-ci (#545)"

echo "== db: the run's Postgres container reaches nothing; the helper before let it out"
dk() { sudo -u wl-test-ci env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker "$@"; }
db_probe() { # <id>: start its database with the installed helper, then psql from inside the container to $PUB
  local id="$1"
  mkrun ci "$id"
  as_ ci db-start "$id" "$DB_IMAGE" test 90 50 > /dev/null
  : > "$t/seen"
  dk exec "worklane-test-ci-$id" psql "host=$PUB port=$PP user=x dbname=x connect_timeout=3" -c 'select 1' > "$t/$id.out" 2>&1 || true
  sleep 0.5
  echo "  $id: $(tail -n 1 "$t/$id.out"); the listener saw: $(seen)"
  as_ ci wipe "$id" > /dev/null
}
sudo install -o root -g root -m 0755 "$t/helper-old.sh" "$H"
db_probe net-db-old
[ "$(seen)" = "pub:$PUB " ] || fail "the old helper's database didn't reach $PUB: this probe can't tell"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
db_probe net-db
[ -z "$(seen)" ] || fail "the database container reached $(seen)"

cleanup
trap - EXIT
sudo bash scripts/setup/test-user.sh check ci | tail -n 1 | grep -qx 'OK: all checks passed' || { sudo bash scripts/setup/test-user.sh check ci | grep FAIL >&2; fail "test-user.sh check ci fails after this step"; }
echo "OK: test-run networking on real systemd: none by default, granted only by root's file, fetch and database as designed"
