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
#   (a) #543: can systemd NFTSet= populate a cgroupsv2 set, and can nft match `socket cgroupv2 level N @set` here?
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
  [ -f "$work/aa.profile" ] && apparmor_parser -R "$work/aa.profile" >/dev/null 2>&1
  rm -f /usr/local/libexec/worklane-spike-unshare
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
# A host listener on every address (its loopback and its LAN address): what a slirp-backed run must NOT reach.
python3 "$work/listen.py" 0.0.0.0 0 "$work/hport" >/dev/null 2>&1 &
for _ in $(seq 50); do [ -s "$work/hport" ] && break; sleep 0.1; done
HP="$(cat "$work/hport" 2>/dev/null || echo 0)"
LAN="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
# slirp's alias for the host's loopback (its gateway), built from its first octet: the denylist refuses a literal
# private address, and this is slirp's fixed one, not a LAN's.
SLIRP_GW="$(printf '%s.0.2.2' 10)"
echo "host listener on 0.0.0.0:$HP; LAN address $LAN; slirp gateway $SLIRP_GW"

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
# (a)+(b) #543: NFTSet= populates a cgroupsv2 set; `socket cgroupv2 level N @set` exempts that unit; a plain
# process of the same test user is dropped; the set follows the unit through stop/restart.
# ============================================================================
say "(a)/(b) #543: cgroup-exempt egress via systemd NFTSet= + nft socket cgroupv2"

# The table: an accept for the exempted cgroups, then a default deny for the test user's non-loopback egress.
# WHY level 3, not the memo's 2 (#543, measured in this spike's first run): systemd nests a dashed slice under its
# prefix, so worklane-spike.slice is /worklane.slice/worklane-spike.slice and a unit in it sits at level 3. Level 2 is
# the slice itself, which NFTSet= never adds, so a level-2 rule matched nothing and the exempted unit was dropped.
# The real worklane-test.slice nests the same way (/worklane.slice/worklane-test.slice/<unit>).
LEVEL=3
# WHY a function: (a)/(b) load it, (c) runs without it, (d) loads it again.
load_543_table() {
  nft -f - <<NFT 2>>"$work/nft.err"
table inet $TABLE {
  set $SET { type cgroupsv2; }
  chain out {
    type filter hook output priority 0; policy accept;
    socket cgroupv2 level $LEVEL @$SET accept
    meta skuid $UID_ oifname != "lo" counter drop
  }
}
NFT
}
nft_ok=1
load_543_table || nft_ok=0
if [ "$nft_ok" = 1 ]; then
  echo "loaded table inet $TABLE (set type cgroupsv2, rule: socket cgroupv2 level $LEVEL @$SET accept)"
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
  echo "the holder unit's cgroup: $(systemctl show -p ControlGroup --value worklane-spike-dockerlike.service)"

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
    Qa="PASS (a): systemd NFTSet=cgroup populated a cgroupsv2 set and nft matched socket cgroupv2 level $LEVEL @set (the exempted unit's egress got out)"
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

# WHY no #543 table during (c): its slirp runs as the covered test user, so the skuid drop would block the data path
# and blur the join measurement. (d) measures the two together.
nft delete table inet "$TABLE" 2>/dev/null || true

# The "run": it writes its own pid, then idles so a sibling slirp unit can join its namespaces by path (#545).
cat > "$work/run-ns.sh" <<'SH'
#!/bin/sh
echo "$$" > "$1"
exec sleep 600
SH
chmod 0755 "$work/run-ns.sh"
chmod 0777 "$work"   # the test user's run writes its pid file here
journal() { journalctl --no-pager -o cat -n 6 -u "$1" 2>/dev/null | sed 's/^/    /'; tail -n 3 "$work/run.err" 2>/dev/null | sed 's/^/    systemd-run: /'; }

# start_run <unshare binary>: the run as the test user in its own unit, sandboxed as a real run is on the points that
# bear on this (PrivateNetwork=yes, NoNewPrivileges=yes), unsharing a user+net namespace of its own. Sets runpid.
runpid=""
start_run() {
  runpid=""
  # WHY rm, not truncate: a root-made file is not the test user's to write, so the run could not record its pid.
  rm -f "$work/runpid"
  systemctl stop worklane-spike-run.service >/dev/null 2>&1 || true
  systemd-run --quiet --collect --unit=worklane-spike-run --slice="$SLICE" --uid="$USER_" --gid="$USER_" \
    -p PrivateNetwork=yes -p NoNewPrivileges=yes \
    "$1" --user --net --map-root-user "$work/run-ns.sh" "$work/runpid" 2>>"$work/run.err" || true
  for _ in $(seq 50); do [ -s "$work/runpid" ] && break; sleep 0.1; done
  runpid="$(cat "$work/runpid" 2>/dev/null || true)"
  [ -n "$runpid" ] && [ -e "/proc/$runpid/ns/net" ]
}

# slirp_case <label> <extra systemd-run props...>: slirp4netns as the test user in a unit of its own, joining the run's
# namespaces by path, with no capability today's root slirp unit keeps; its IPAddressDeny= refuses the host's loopback,
# its LAN address and the host's veth address. Then, from inside the run's netns: the public stand-in, slirp's
# gateway (the host's loopback), the LAN address and the veth address. Sets CJ CPUB CGW CLAN CHV.
# The variant slirp_case runs (set by slirp_pick): SL_CAPS, the unit's capability props (today's root unit's caps
# dropped, or the default bounding set kept); SL_FLAGS, slirp's own sandbox flags.
SL_DROP=(-p "CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SETPCAP CAP_NET_BIND_SERVICE")
SL_CAPS=("${SL_DROP[@]}")
SL_FLAGS=(--enable-sandbox --enable-seccomp)
slirp_case() {
  local label="$1" i; shift
  CJ=no CPUB=- CGW=- CLAN=- CHV=-
  systemd-run --quiet --collect --unit="worklane-spike-slirp-$label" --slice="$SLICE" --uid="$USER_" --gid="$USER_" \
    -p NoNewPrivileges=yes ${SL_CAPS[@]+"${SL_CAPS[@]}"} \
    -p "IPAddressDeny=127.0.0.0/8 ::1/128 $LAN/32 $HOSTV/32" "$@" \
    /usr/bin/slirp4netns --configure --mtu=65520 --disable-host-loopback ${SL_FLAGS[@]+"${SL_FLAGS[@]}"} \
    --userns-path="/proc/$runpid/ns/user" --netns-type=path "/proc/$runpid/ns/net" tap0 2>>"$work/slirp.err" || true
  for i in $(seq 100); do
    if nsenter --target "$runpid" --net ip -o link show tap0 >/dev/null 2>&1; then CJ=yes; break; fi
    systemctl is-active -q "worklane-spike-slirp-$label.service" || break
    sleep 0.1
  done
  if [ "$CJ" = yes ]; then
    sleep 0.5
    CPUB="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$PUB" "$PORT" 2>/dev/null)"
    CGW="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$SLIRP_GW" "$HP" 2>/dev/null)"
    CLAN="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$LAN" "$HP" 2>/dev/null)"
    CHV="$(nsenter --target "$runpid" --net python3 "$work/probe.py" "$HOSTV" "$HP" 2>/dev/null)"
  else
    echo "  slirp unit $label never brought up tap0; its journal (banner lines left out):"
    journalctl --no-pager -o cat -n 40 -u "worklane-spike-slirp-$label.service" 2>/dev/null | grep -v '^\* \|^ *\* \|^Started \|^sent tapfd\|^received tapfd' | tail -n 12 | sed 's/^/    /'
  fi
  echo "  [$label] joined=$CJ public=$CPUB host-loopback-via-gateway=$CGW LAN=$CLAN host-veth=$CHV"
  systemctl stop "worklane-spike-slirp-$label.service" >/dev/null 2>&1 || true
  for i in $(seq 50); do nsenter --target "$runpid" --net ip -o link show tap0 >/dev/null 2>&1 || break; sleep 0.1; done
}

restricted="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
userns_how=""
unshare_bin=/usr/bin/unshare
if start_run /usr/bin/unshare; then
  userns_how="plain /usr/bin/unshare"
else
  echo "plain /usr/bin/unshare in the run unit: refused; its journal:"; journal worklane-spike-run.service
  if [ "$restricted" = 1 ] && command -v apparmor_parser >/dev/null 2>&1; then
    # #545 memo: the allowance the pinned rootlesskit has, for one fixed wrapper instead: a root-owned copy of unshare
    # with a profile granting `userns,`, loaded for real (-r; -Q only parses). The system's own unshare is untouched.
    install -d -o root -g root -m 0755 /usr/local/libexec
    install -o root -g root -m 0755 /usr/bin/unshare /usr/local/libexec/worklane-spike-unshare
    cat > "$work/aa.profile" <<AA
abi <abi/4.0>,
include <tunables/global>

profile worklane-spike-unshare /usr/local/libexec/worklane-spike-unshare flags=(unconfined) {
  userns,
}
AA
    if apparmor_parser -r "$work/aa.profile" 2>>"$work/userns.err"; then
      echo "loaded AppArmor profile worklane-spike-unshare for /usr/local/libexec/worklane-spike-unshare"
      unshare_bin=/usr/local/libexec/worklane-spike-unshare
      if start_run "$unshare_bin"; then userns_how="a wrapper with an AppArmor userns allowance"
      else echo "the wrapper under its profile was refused too; its journal:"; journal worklane-spike-run.service; fi
    else
      echo "apparmor_parser refused the profile:"; sed 's/^/    /' "$work/userns.err"
    fi
  fi
fi

if [ -n "$userns_how" ]; then
  echo "run namespace up via $userns_how (NoNewPrivileges=yes, PrivateNetwork=yes): pid $runpid"
  # Variants, strictest first; the first that joins is the one (c) reports and (d) reuses. WHY a matrix: if the
  # strictest fails, which of slirp's own sandbox or the dropped bounding set is the cause decides the build.
  c_variant="" n=0
  for v in "sandbox+seccomp, today's caps dropped" "sandbox+seccomp, default caps" "seccomp only, today's caps dropped" "seccomp only, default caps"; do
    case "$v" in *dropped) SL_CAPS=("${SL_DROP[@]}") ;; *) SL_CAPS=() ;; esac
    case "$v" in sandbox*) SL_FLAGS=(--enable-sandbox --enable-seccomp) ;; *) SL_FLAGS=(--enable-seccomp) ;; esac
    n=$((n + 1))
    echo "  variant c$n: $v"
    slirp_case "c$n"
    if [ "$CJ" = yes ]; then c_variant="$v"; break; fi
  done
  if [ -n "$c_variant" ] && [ "$CPUB" = OK ] && [ "$CGW" != OK ] && [ "$CLAN" != OK ] && [ "$CHV" != OK ]; then
    Qc="PASS (c): slirp4netns as $USER_ in its own unit (no root; $c_variant) joined the run's user+net namespace (made via $userns_how): public OK; host loopback, LAN and host address refused"
  elif [ -n "$c_variant" ]; then
    Qc="FAIL (c): joined with $c_variant (userns via $userns_how) but public=$CPUB (want OK) gateway=$CGW LAN=$CLAN host=$CHV (want refused)"
  else
    Qc="FAIL (c): the run's namespace was made (via $userns_how) but slirp4netns as $USER_ joined it in no variant (see each variant's journal above)"
  fi
else
  Qc="FAIL (c): the test user's run unit could not create a user+net namespace (restriction=$restricted; plain unshare and the AppArmor-allowed wrapper both refused; see above)"
fi

# ============================================================================
# (d) #545+#543: granted-tier networking (root-started slirp giving a namespace a route out) still works while the
# #543 default-deny rule is loaded, when the slirp unit is exempted by NFTSet=.
# ============================================================================
say "(d) granted-tier networking under the #543 default-deny rule"

if [ "$nft_ok" != 1 ]; then
  Qd="FAIL (d): the #543 rule did not load, so this interaction can't be measured here"
else
  load_543_table || true
  # 1. The #545 design under #543: the test user's slirp unit, without and with NFTSet= (the memos' combined plan).
  d545="not measured: (c) had no test-user slirp that joined"
  if [ -n "$userns_how" ] && [ -n "${c_variant:-}" ] && start_run "$unshare_bin"; then
    echo "  (slirp variant from (c): $c_variant)"
    slirp_case d-plain
    d_plain_pub="$CPUB"
    slirp_case d-exempt -p "NFTSet=cgroup:inet:$TABLE:$SET"
    d_ex_pub="$CPUB" d_ex_gw="$CGW" d_ex_lan="$CLAN" d_ex_hv="$CHV"
    if [ "$d_ex_pub" = OK ] && [ "$d_plain_pub" != OK ] && [ "$d_ex_gw" != OK ] && [ "$d_ex_lan" != OK ] && [ "$d_ex_hv" != OK ]; then
      d545="ok (test-user slirp without NFTSet= blocked: $d_plain_pub; with NFTSet=: public OK, host loopback/LAN/host refused)"
    else
      d545="NOT ok (without NFTSet= public=$d_plain_pub, want blocked; with NFTSet= public=$d_ex_pub want OK, gateway=$d_ex_gw LAN=$d_ex_lan host=$d_ex_hv want refused)"
    fi
  fi
  systemctl stop worklane-spike-run.service >/dev/null 2>&1 || true
  echo "#545 design under the #543 rule: $d545"
  # 2. Today's granted path: slirp started by root (uid 0, outside the uid rule) for a root-made netns.
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
  else
    dpub="no tap0"
  fi
  case "$d545" in
    ok*) if [ "$dpub" = OK ]; then Qd="PASS (d): granted networking works under the #543 rule both ways: #545 design $d545; today's root slirp: public $dpub"
         else Qd="FAIL (d): #545 design $d545, but today's root slirp: $dpub"; fi ;;
    *) Qd="FAIL (d): #545 design $d545; today's root slirp under the #543 rule: public $dpub" ;;
  esac
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
