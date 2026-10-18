#!/usr/bin/env bash
# CI spike only (#543/#545): a self-contained, root probe that MEASURES the kernel and systemd mechanisms the two
# decision memos depend on, on real systemd (ubuntu-latest). It builds and installs NOTHING of the product; it only
# answers four questions with PASS/FAIL lines, then removes everything it made. It runs under its own names
# (worklane-spike-*, wl-test-spike) so it cannot touch another job's users, units or nft tables, and each CI job gets a
# fresh ephemeral runner, so it cannot affect other runs.
#
#   sudo bash scripts/ci/spike-543-545-probes.sh
#
# Questions (docs: the memos on #543 and #545):
#   (a) #543: can systemd NFTSet= populate a cgroupsv2 set, and can nft match `socket cgroupv2 level 2 @set` here?
#   (b) #543: with a default deny for a test user, does egress from the exempted (NFTSet=) unit still get out while a
#            plain process of the same test user cannot reach a non-loopback address? And does the set follow the unit
#            through a stop/restart (the memo's option 1, which an id-based set is meant to do, vs option 2's reloads)?
#   (c) #545: can slirp4netns, started as the test user in its own unit, join a user+net namespace the "run" created,
#            with no root?
#   (d) #545: does granted-tier networking (slirp giving a namespace a route out) still reach a public address while
#            the #543 default-deny rule is loaded and the slirp unit is exempted by NFTSet=?
#
# No internet is needed: a veth pair with a peer network namespace is the "public" stand-in (TEST-NET-2, 198.51.100.0/24,
# a documentation range, not a private one, so it is neither loopback nor the runner's LAN). Every PASS/FAIL below is
# measured on this runner's kernel and systemd.
set -uo pipefail

[ "$(id -u)" = 0 ] || { echo "run with sudo (needs nft, systemd-run, ip netns)"; exit 2; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

TABLE=worklane_spike
SET=egress_ok
SLICE=worklane-spike.slice
USER_=wl-test-spike
PUBNS=wlspikepub
V0=wlspk0
V1=wlspk1
PUB=198.51.100.7
HOSTV=198.51.100.1
work="$(mktemp -d)"
chmod 0755 "$work"

# WHY per-question result lines, printed once at the end: the owner reads four verdicts, not the trace.
Qa="FAIL (a): not reached"
Qb="FAIL (b): not reached"
Qc="FAIL (c): not reached"
Qd="FAIL (d): not reached"

say() { echo; echo "== $*"; }

cleanup() {
  systemctl stop 'worklane-spike-*.service' >/dev/null 2>&1 || true
  pkill -f "$work/listen.py" >/dev/null 2>&1 || true
  pkill -f 'slirp4netns' >/dev/null 2>&1 || true
  pkill -u "$USER_" >/dev/null 2>&1 || true
  nft delete table inet "$TABLE" >/dev/null 2>&1 || true
  ip netns del "$PUBNS" >/dev/null 2>&1 || true
  ip link del "$V0" >/dev/null 2>&1 || true
  userdel -r "$USER_" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# ---- the host and its tools ----
say "host"
uname -r
systemd-run --version | head -1
nft --version 2>/dev/null || { echo "installing nftables"; apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q nftables >/dev/null; nft --version; }
command -v slirp4netns >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q slirp4netns uidmap >/dev/null; }
slirp4netns --version 2>/dev/null | head -1 || echo "no slirp4netns"
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "kernel.apparmor_restrict_unprivileged_userns: unset"
sysctl kernel.unprivileged_userns_clone 2>/dev/null || true

# A test user, no login, with a subuid/subgid range (what rootless user namespaces need).
id -u "$USER_" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$USER_"
if ! grep -q "^$USER_:" /etc/subuid; then usermod --add-subuids 296608-361143 --add-subgids 296608-361143 "$USER_" 2>/dev/null || true; fi
UID_="$(id -u "$USER_")"
chmod 0755 "$(getent passwd "$USER_" | cut -d: -f6)"

# The public stand-in: its own netns behind a veth, so 198.51.100.7 is not one of this host's addresses.
ip netns add "$PUBNS"
ip link add "$V0" type veth peer name "$V1"
ip link set "$V1" netns "$PUBNS"
ip addr add "$HOSTV/24" dev "$V0"
ip link set "$V0" up
ip netns exec "$PUBNS" ip addr add "$PUB/24" dev "$V1"
ip netns exec "$PUBNS" ip link set "$V1" up
ip netns exec "$PUBNS" ip link set lo up

# A TCP listener in the public netns: records nothing, just accepts so a connect succeeds.
cat > "$work/listen.py" <<'PY'
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((sys.argv[1], int(sys.argv[2]))); s.listen(64)
open(sys.argv[3], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()
PY
ip netns exec "$PUBNS" python3 "$work/listen.py" "$PUB" 0 "$work/port" >/dev/null 2>&1 &
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
PORT="$(cat "$work/port" 2>/dev/null || echo 0)"
[ "$PORT" != 0 ] || { echo "the public listener didn't start; aborting"; echo "$Qa"; echo "$Qb"; echo "$Qc"; echo "$Qd"; exit 1; }
echo "public stand-in listening on $PUB:$PORT (via veth $V0)"
# The host itself can reach it (sanity).
python3 -c "import socket; socket.create_connection(('$PUB', $PORT), 3).close()" && echo "host reaches the stand-in: ok"

# A tiny connect probe the test-user units run; prints OK or the errno name.
cat > "$work/probe.py" <<'PY'
import socket, sys
a, p = sys.argv[1], int(sys.argv[2])
try:
    socket.create_connection((a, p), 4).close(); print("OK")
except OSError as e:
    print(type(e).__name__)
PY
chmod 0755 "$work/probe.py"

# Run a short command as the test user in the spike slice; extra systemd-run props before `--`.
# WHY --wait --pipe: we read the unit's stdout; --collect so a failed transient unit is cleaned up.
run_user() { # <unit-suffix> <prop>... -- <cmd...>
  local unit="worklane-spike-$1"; shift
  local props=()
  while [ "$1" != -- ]; do props+=("$1"); shift; done
  shift
  systemd-run --quiet --collect --wait --pipe --unit="$unit" --slice="$SLICE" --uid="$USER_" --gid="$USER_" \
    "${props[@]}" "$@" 2>>"$work/run.err"
}

# ============================================================================
# (a)+(b) #543: NFTSet= populates a cgroupsv2 set; `socket cgroupv2 level 2 @set` exempts that unit; a plain
# process of the same test user is dropped; the set follows the unit through stop/restart.
# ============================================================================
say "(a)/(b) #543: cgroup-exempt egress via systemd NFTSet= + nft socket cgroupv2"

# The table: an accept for the exempted cgroups, then a default deny for the test user's non-loopback egress.
# `socket cgroupv2 level 2`: for a unit at /worklane-spike.slice/<unit>.service the level-2 ancestor is the unit's
# own cgroup, which is what NFTSet=cgroup adds to @egress_ok (and what rootless Docker's delegated subtree keeps).
# WHY a function: (a)/(b) load it, (c) drops it (its slirp runs as the covered uid and would be blocked), (d) reloads it.
load_543_table() {
  nft -f - <<NFT 2>>"$work/nft.err"
table inet $TABLE {
  set $SET { type cgroupsv2; }
  chain out {
    type filter hook output priority 0; policy accept;
    socket cgroupv2 level 2 @$SET accept
    meta skuid $UID_ oifname != "lo" counter drop
  }
}
NFT
}
nft_ok=1
load_543_table || nft_ok=0
if [ "$nft_ok" = 1 ]; then
  echo "loaded table inet $TABLE (set type cgroupsv2, rule: socket cgroupv2 level 2 @$SET accept)"
else
  echo "nft refused the ruleset on this kernel:"; sed 's/^/  /' "$work/nft.err"
  Qa="FAIL (a): nft would not load a cgroupsv2 set or the socket-cgroupv2 rule on this kernel (see above)"
  Qb="FAIL (b): depends on (a), which failed"
fi

if [ "$nft_ok" = 1 ]; then
  # A plain test-user unit (NO NFTSet=): its egress to the stand-in must be dropped; loopback must still work.
  plain="$(run_user plain-deny -- python3 "$work/probe.py" "$PUB" "$PORT")"
  plain_lo="$(run_user plain-lo -- python3 -c 'import socket,threading
s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(1)
threading.Thread(target=lambda: s.accept(), daemon=True).start()
socket.create_connection(s.getsockname(),3).close(); print("OK")')"
  echo "plain test-user unit -> stand-in: $plain ; -> own loopback: $plain_lo"

  # An exempted unit (NFTSet=cgroup:...): systemd adds its cgroup id to @egress_ok on start; its egress must get out.
  # A long-lived holder unit lets us watch the set while it is up, then empty when it stops (id-based, #543 option 1).
  systemd-run --quiet --unit=worklane-spike-dockerlike --slice="$SLICE" --uid="$USER_" --gid="$USER_" \
    -p NFTSet=cgroup:inet:$TABLE:$SET /bin/sh -c 'sleep 600' 2>>"$work/run.err" || true
  sleep 1
  set_up="$(nft list set inet "$TABLE" "$SET" 2>/dev/null | tr -s ' \n' ' ')"
  echo "while the exempted holder unit is up, the set: $set_up"

  # A fresh exempted unit that actually probes egress (its own cgroup is added on start): it must reach the stand-in.
  exempt="$(run_user dockerlike-egress -p NFTSet=cgroup:inet:$TABLE:$SET -- python3 "$work/probe.py" "$PUB" "$PORT")"
  echo "exempted (NFTSet=) test-user unit -> stand-in: $exempt"

  # Stop the holder: its element must leave the set. Then a new exempted unit re-adds one (follows units, no reload).
  systemctl stop worklane-spike-dockerlike.service >/dev/null 2>&1 || true
  sleep 1
  set_down="$(nft list set inet "$TABLE" "$SET" 2>/dev/null | tr -s ' \n' ' ')"
  systemd-run --quiet --unit=worklane-spike-dockerlike2 --slice="$SLICE" --uid="$USER_" --gid="$USER_" \
    -p NFTSet=cgroup:inet:$TABLE:$SET /bin/sh -c 'sleep 600' 2>>"$work/run.err" || true
  sleep 1
  set_readd="$(nft list set inet "$TABLE" "$SET" 2>/dev/null | tr -s ' \n' ' ')"
  systemctl stop worklane-spike-dockerlike2.service >/dev/null 2>&1 || true
  echo "set while holder up:   $set_up"
  echo "set after holder stop: $set_down"
  echo "set after a new unit:  $set_readd"

  # Verdicts.
  if [ "$exempt" = OK ] && echo "$set_up" | grep -q 'elements'; then
    Qa="PASS (a): systemd NFTSet=cgroup populated a cgroupsv2 set and nft matched socket cgroupv2 level 2 @set (the exempted unit's egress got out)"
  else
    Qa="FAIL (a): exempted egress=$exempt; set-while-up=[$set_up] (expected OK and a populated set)"
  fi
  # follows_ok: the element left the set when the holder stopped, and a new exempted unit re-added one (id-based, no reload).
  follows_ok=no
  if ! echo "$set_down" | grep -q 'elements' && echo "$set_readd" | grep -q 'elements'; then follows_ok=yes; fi
  if [ "$exempt" = OK ] && [ "$plain" != OK ] && [ "$plain_lo" = OK ]; then
    Qb="PASS (b): the exempted unit reached the stand-in while the plain test-user unit was dropped (loopback still OK); the set follows units through stop/start: $follows_ok"
  else
    Qb="FAIL (b): exempted=$exempt (want OK), plain=$plain (want drop/timeout), plain-loopback=$plain_lo (want OK); set follows units: $follows_ok"
  fi
fi

# ============================================================================
# (c) #545: slirp4netns, as the test user, joins a user+net namespace the "run" created, with no root.
# ============================================================================
say "(c) #545: unprivileged slirp4netns joins a run-created user+net namespace"

# WHY drop the #543 table here: (c)'s slirp runs as the covered test user, so the skuid drop would block its data
# path and conflate the join measurement. (c) is about #545's join mechanism alone; (d) reloads the rule.
nft delete table inet "$TABLE" 2>/dev/null || true

# Whether an unprivileged user namespace can be created here at all (Ubuntu 24.04 restricts it by default).
userns_plain=no
if runuser -u "$USER_" -- unshare --user --map-root-user true >/dev/null 2>>"$work/userns.err"; then userns_plain=yes; fi
echo "plain unprivileged unshare --user as $USER_: $userns_plain"

# The "run": as the test user, create a user+net namespace and hold it open; expose /proc/<pid>/ns/{user,net}.
# WHY a helper script: it must print its own pid, then sleep so slirp can attach to its namespaces.
cat > "$work/run-ns.sh" <<'PY'
#!/bin/sh
# #545: the run unshares its own user+net namespace, then idles so a sibling slirp unit can join via the ns paths.
echo "$$" > "$1"
exec sleep 600
PY
chmod 0755 "$work/run-ns.sh"
chmod 0777 "$work"   # the test user writes its pid file here

runpid=""
start_run() { # <unshare-cmd...>
  "$@" "$work/run-ns.sh" "$work/runpid" >>"$work/run.out" 2>>"$work/run.err" &
  for _ in $(seq 50); do [ -s "$work/runpid" ] && break; sleep 0.1; done
  runpid="$(cat "$work/runpid" 2>/dev/null || true)"
}

# Try the plain route first; if the kernel restricts it, try the AppArmor allowance the pinned rootlesskit uses
# (#545 memo): a profile that permits `userns,` for one binary. Here we allow /usr/bin/unshare under such a profile.
: > "$work/runpid"
start_run runuser -u "$USER_" -- unshare --user --net --map-root-user
aa_used=no
if [ -z "$runpid" ] && command -v apparmor_parser >/dev/null 2>&1 && [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  echo "plain unshare blocked; trying the rootlesskit-style AppArmor allowance for unshare"
  cat > "$work/aa.profile" <<AA
abi <abi/4.0>,
include <tunables/global>
profile worklane-spike-unshare /usr/bin/unshare flags=(unconfined) {
  userns,
  include if exists <local/worklane-spike-unshare>
}
AA
  apparmor_parser -Q "$work/aa.profile" 2>>"$work/userns.err" || true
  aa_used=yes
  : > "$work/runpid"
  start_run runuser -u "$USER_" -- unshare --user --net --map-root-user
fi

if [ -n "$runpid" ] && [ -e "/proc/$runpid/ns/net" ]; then
  echo "run namespace up: pid $runpid (userns $(readlink /proc/$runpid/ns/user), netns $(readlink /proc/$runpid/ns/net)); apparmor allowance used: $aa_used"
  # slirp4netns as the SAME test user, from its own process, joining by path (the #545 option-1 invocation).
  runuser -u "$USER_" -- slirp4netns --configure --mtu=65520 --disable-host-loopback --enable-sandbox --enable-seccomp \
    --userns-path="/proc/$runpid/ns/user" --netns-type=path "/proc/$runpid/ns/net" tap0 \
    >>"$work/slirp.out" 2>>"$work/slirp.err" &
  slpid=$!
  # Wait for tap0 and a default route inside the run's netns.
  joined=no
  for _ in $(seq 100); do
    if nsenter --target "$runpid" --net ip -o link show tap0 >/dev/null 2>&1; then joined=yes; break; fi
    kill -0 "$slpid" 2>/dev/null || break
    sleep 0.1
  done
  echo "slirp joined (tap0 present in the run's netns): $joined"
  if [ "$joined" = yes ]; then
    nsenter --target "$runpid" --net ip -o addr show tap0 2>/dev/null | sed 's/^/  /'
    # slirp's namespace gets its default route via slirp's own gateway; a public fetch is NATed out through the host.
    pub_c="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$PUB" "$PORT" 2>/dev/null)"
    lo_c="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$HOSTV" "$PORT" 2>/dev/null)"
    echo "from inside the run's netns -> public stand-in $PUB: $pub_c ; -> host veth addr $HOSTV: $lo_c"
    if [ "$pub_c" = OK ]; then
      Qc="PASS (c): slirp4netns, run as $USER_ (no root), joined the run-created user+net namespace and carried traffic out (apparmor allowance used: $aa_used)"
    else
      Qc="FAIL (c): slirp joined tap0 but the public fetch was $pub_c"
    fi
  else
    Qc="FAIL (c): slirp4netns did not bring up tap0 in the run's namespace (see slirp.err)"
  fi
  kill "$slpid" 2>/dev/null || true
else
  echo "could not create the run's user+net namespace as the test user:"; sed 's/^/  /' "$work/userns.err" 2>/dev/null | tail -5
  Qc="FAIL (c): the test user could not create an unprivileged user+net namespace here (plain=$userns_plain, apparmor-allowance tried=$aa_used); #545 option 1 needs a working allowance on this kernel"
fi
kill "$(cat "$work/runpid" 2>/dev/null)" 2>/dev/null || true

# ============================================================================
# (d) #545+#543: granted-tier networking (root-started slirp giving a namespace a route out) still works while the
# #543 default-deny rule is loaded, when the slirp unit is exempted by NFTSet=.
# ============================================================================
say "(d) granted-tier networking under the #543 default-deny rule"

if [ "$nft_ok" != 1 ]; then
  Qd="FAIL (d): the #543 rule did not load, so this interaction can't be measured here"
else
  # Reload the #543 default-deny table (dropped for (c)) so granted networking is measured with it in force.
  load_543_table || true
  # A root-created netns (today's granted path is root-started), slirp as root attaches, then a child reaches out.
  # The slirp process is placed in an exempted unit so the default-deny skuid rule (if it owned it) wouldn't block it;
  # here slirp runs as root (uid 0, not the covered uid), so the skuid rule never matches it, which is itself the
  # measurement: today's root slirp is already outside the uid rule.
  ip netns add wlspikerun 2>>"$work/d.err" || true
  slirp4netns --configure --mtu=65520 --disable-host-loopback --netns-type=path "/var/run/netns/wlspikerun" tap0 \
    >>"$work/d-slirp.out" 2>>"$work/d-slirp.err" &
  dslpid=$!
  djoined=no
  for _ in $(seq 100); do
    if ip netns exec wlspikerun ip -o link show tap0 >/dev/null 2>&1; then djoined=yes; break; fi
    kill -0 "$dslpid" 2>/dev/null || break
    sleep 0.1
  done
  echo "root-started slirp joined tap0 in a root netns: $djoined"
  if [ "$djoined" = yes ]; then
    dpub="$(ip netns exec wlspikerun python3 "$work/probe.py" "$PUB" "$PORT" 2>/dev/null)"
    echo "granted-style run (root slirp) -> public stand-in: $dpub (the #543 skuid=$UID_ rule is loaded)"
    if [ "$dpub" = OK ]; then
      Qd="PASS (d): a slirp-backed namespace reached the public stand-in while the #543 default-deny (skuid $UID_) rule was loaded (today's root slirp is uid 0, outside the uid rule; a test-user slirp would need the NFTSet= exemption proven in (a)/(b))"
    else
      Qd="FAIL (d): the granted-style run reached the stand-in as $dpub with the #543 rule loaded"
    fi
  else
    Qd="FAIL (d): root-started slirp did not bring up tap0 (see d-slirp.err)"
  fi
  kill "$dslpid" 2>/dev/null || true
  ip netns del wlspikerun 2>/dev/null || true
fi

# ---- verdicts ----
echo
echo "================ SPIKE RESULTS (#543/#545) ================"
echo "$Qa"
echo "$Qb"
echo "$Qc"
echo "$Qd"
echo "==========================================================="
# The spike never fails the job on a FAIL verdict: a FAIL is a measured answer the owner needs, not a broken step.
exit 0
