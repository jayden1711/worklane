#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after test-user.sh install and the database image
# step): test-run networking (docs/test-runs.md "Network") against real systemd, the real helper and its real sudoers
# rule, Docker and npm. No internet: one listener on this host takes every connection, and says which of the host's
# addresses each came to: 127.0.0.1 (its loopback services), its LAN address (the route's source), and a stand-in
# "public" address, 198.51.100.7 (TEST-NET-2, on a dummy interface made here and removed after).
#   none:    a run that asks for nothing, and one whose tier asks (tests.yaml network: true) with no root grant:
#            reaches none of the three, nor DNS; its own loopback works. The helper before this change (main at $OLD)
#            reaches the public one from the same probe (fail-without).
#   granted: root's script grants ci's e2e: that tier reaches the public address only (not the LAN); another tier of
#            ci, and the other instance's e2e, get none.
#   fetch:   npm fetches from the public address only, never the host's loopback or LAN, with no grant.
#   db:      the run's Postgres container reaches nothing (--network none); the helper before reached the public one.
# Usage: bash scripts/ci/testrun-network-real-systemd.sh <other instance>   (as the runner user, with sudo; DB_IMAGE set)
set -euo pipefail
I2="${1:?the other instance}"
: "${DB_IMAGE:?the pinned database image}"
H=/usr/local/libexec/worklane-testrun
OLD=213b99dd61982fc1c7ac3f5133dbc10f222e8697
PUB=198.51.100.7
t="$(mktemp -d)"
chmod 0755 "$t"
etc_was=0; [ -d /etc/worklane ] && etc_was=1
listener=""
cleanup() {
  [ -z "$listener" ] || kill "$listener" 2>/dev/null || true
  sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
  sudo rm -f /etc/worklane/testrun-network.json
  [ "$etc_was" = 1 ] || sudo rmdir /etc/worklane 2>/dev/null || true
  sudo ip link del wlnet0 2>/dev/null || true
  rm -rf "$t"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

lan="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[[ "$lan" =~ ^(10|172|192)\. ]] || fail "this runner's LAN address ($lan) is not a private one"
sudo ip link add wlnet0 type dummy
sudo ip addr add "$PUB/32" dev wlnet0
sudo ip link set wlnet0 up
# The listener: every connection's destination address, one a line, in $t/seen.
cat > "$t/listen.py" <<'EOF'
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 0)); s.listen(64)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept()
    with open(sys.argv[2], "a") as f: f.write(c.getsockname()[0] + "\n")
    c.close()
EOF
: > "$t/seen"
python3 "$t/listen.py" "$t/port" "$t/seen" &
listener=$!
for _ in $(seq 50); do [ -s "$t/port" ] && break; sleep 0.1; done
P="$(cat "$t/port")"
echo "listener on port $P; LAN $lan; public stand-in $PUB"
for a in 127.0.0.1 "$lan" "$PUB"; do python3 -c "import socket; socket.create_connection(('$a', $P), 3).close()"; done
[ "$(sort "$t/seen" | tr '\n' ' ')" = "$(printf '%s\n' 127.0.0.1 "$lan" "$PUB" | sort | tr '\n' ' ')" ] || fail "the host itself didn't reach all three: $(cat "$t/seen")"
: > "$t/seen"
seen() { sort -u "$t/seen" | tr '\n' ' '; }

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
# What a run reaches: each address "<addr> OK|<errno>", then its own loopback, then DNS. No ${...}: systemd expands those.
probe_py='import socket, sys, threading
port = int(sys.argv[1])
for a in sys.argv[2:]:
    try:
        socket.create_connection((a, port), 3).close(); print(a, "OK")
    except OSError as e:
        print(a, type(e).__name__)
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
threading.Thread(target=lambda: s.accept(), daemon=True).start()
try:
    socket.create_connection(s.getsockname(), 3).close(); print("own-loopback OK")
except OSError as e:
    print("own-loopback", type(e).__name__)
try:
    socket.getaddrinfo("example.com", 443); print("dns OK")
except OSError as e:
    print("dns", type(e).__name__)'
probe="printf %s $(printf %s "$probe_py" | base64 -w0) | base64 -d > \"\$TMPDIR/p.py\" && python3 \"\$TMPDIR/p.py\" $P 127.0.0.1 $lan $PUB"
# exec of run <id> of instance <i> with the probe; its stdout in $t/<id>.out, stderr in $t/<id>.err.
ex() {
  local i="$1" id="$2"; shift 2
  mkrun "$i" "$id"
  : > "$t/seen"
  as_ "$i" exec "$id" 60 "$@" -- "$probe" < /dev/null > "$t/$id.out" 2> "$t/$id.err" || { cat "$t/$id.err" >&2; fail "$id exited non-zero"; }
  sed "s/^/  $id: /" "$t/$id.out"
  as_ "$i" wipe "$id" > /dev/null
}
got() { awk -v a="$2" '$1 == a { print $2 }' "$t/$1.out"; }
none_reached() { # <id>: no address, no DNS; its own loopback works; the listener saw nothing
  local id="$1" a
  for a in 127.0.0.1 "$lan" "$PUB"; do [ "$(got "$id" "$a")" != OK ] || fail "$id reached $a"; done
  [ "$(got "$id" dns)" != OK ] || fail "$id resolved a name"
  [ "$(got "$id" own-loopback)" = OK ] || fail "$id: its own loopback doesn't work"
  [ -z "$(seen)" ] || fail "$id: the listener saw $(seen)"
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
[ "$(got net-old "$PUB")" = OK ] || fail "the old helper's run didn't reach $PUB: this probe can't tell"
echo "  the old helper's run reached: $(seen)"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"

echo "== granted: root's script grants ci's e2e"
sudo bash scripts/setup/testrun-network.sh enable ci --tiers e2e
[ "$(stat -c '%U:%G %a' /etc/worklane/testrun-network.json)" = 'root:root 644' ] || fail "the root file isn't root:root 0644"
ex ci net-granted --network e2e
grep -qx "worklane-testrun: network granted (e2e; public addresses and the machine's DNS only)" "$t/net-granted.err" || { cat "$t/net-granted.err" >&2; fail "the granted line"; }
[ "$(got net-granted "$PUB")" = OK ] || fail "the granted tier didn't reach $PUB"
[ "$(got net-granted "$lan")" != OK ] || fail "the granted tier reached the LAN address $lan"
[ "$(got net-granted own-loopback)" = OK ] || fail "the granted tier's own loopback"
[ "$(seen)" = "$PUB " ] || fail "the listener saw $(seen), not $PUB alone"
ex ci net-othertier --network unit
none_reached net-othertier
grep -q '^worklane-testrun: network none (tier unit of ci is not granted the network in ' "$t/net-othertier.err" || fail "another tier's line"
ex "$I2" net-otherinst --network e2e
none_reached net-otherinst
grep -q "^worklane-testrun: network none (tier e2e of $I2 is not granted the network in " "$t/net-otherinst.err" || fail "the other instance's line"
sudo bash scripts/setup/testrun-network.sh disable ci > /dev/null

echo "== fetch: public addresses only, never the host's loopback or LAN, with no grant"
command -v npm > /dev/null && [ -x /usr/local/bin/npm ] || fail "no npm in /usr/local/bin for the test user (PATH=/usr/local/bin:/usr/bin:/bin)"
fetch_from() { # <id> <address>: a lockfile pinning one tarball at https://<address>:$P/; the fetch fails (no TLS there)
  local id="$1" a="$2" d="$t/files-$1" rc=0
  mkdir -p "$d"
  printf '{"name":"p","version":"1.0.0","dependencies":{"x":"1.0.0"}}\n' > "$d/package.json"
  printf '{"name":"p","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"p","version":"1.0.0","dependencies":{"x":"1.0.0"}},"node_modules/x":{"version":"1.0.0","resolved":"https://%s:%s/x-1.0.0.tgz","integrity":"sha512-AAAA"}}}\n' "$a" "$P" > "$d/package-lock.json"
  mkrun ci "$id" "$d"
  key="$(printf '%s' "$id" | sha256sum | cut -c1-32)"
  as_ ci cache npm "$key" > /dev/null
  : > "$t/seen"
  as_ ci fetch "$id" npm npm "$key" 300 < /dev/null > "$t/$id.out" 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "$id: the fetch passed with no tarball there"
  head -n 1 "$t/$id.out" | grep -qx "worklane-testrun: fetch npm (no script run; public addresses and the machine's DNS only)" || { cat "$t/$id.out" >&2; fail "$id: the fetch line"; }
  as_ ci wipe "$id" > /dev/null
  echo "  $id (https://$a): exit $rc; the listener saw: $(seen)"
}
fetch_from net-fetch-loop 127.0.0.1
[ -z "$(seen)" ] || fail "the fetch reached the host's loopback"
fetch_from net-fetch-lan "$lan"
[ -z "$(seen)" ] || fail "the fetch reached the host's LAN address"
fetch_from net-fetch-pub "$PUB"
[ "$(seen)" = "$PUB " ] || { cat "$t/net-fetch-pub.out" >&2; fail "the fetch didn't reach the public stand-in"; }

echo "== db: the run's Postgres container reaches nothing; the helper before let it out"
dk() { sudo -u wl-test-ci env HOME=/var/lib/worklane-test/ci/docker-home DOCKER_HOST=unix:///run/worklane-test-ci-docker/docker.sock /opt/worklane-test/docker/docker "$@"; }
db_probe() { # <id>: start its database with the installed helper, then psql from inside the container to $PUB
  local id="$1"
  mkrun ci "$id"
  as_ ci db-start "$id" "$DB_IMAGE" test 90 50 > /dev/null
  : > "$t/seen"
  dk exec "worklane-test-ci-$id" psql "host=$PUB port=$P user=x dbname=x connect_timeout=3" -c 'select 1' > "$t/$id.out" 2>&1 || true
  sleep 0.5
  echo "  $id: $(tail -n 1 "$t/$id.out"); the listener saw: $(seen)"
  as_ ci wipe "$id" > /dev/null
}
sudo install -o root -g root -m 0755 "$t/helper-old.sh" "$H"
db_probe net-db-old
[ "$(seen)" = "$PUB " ] || fail "the old helper's database didn't reach $PUB: this probe can't tell"
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
db_probe net-db
[ -z "$(seen)" ] || fail "the database container reached $(seen)"

cleanup
trap - EXIT
sudo bash scripts/setup/test-user.sh check ci | tail -n 1 | grep -qx 'OK: all checks passed' || { sudo bash scripts/setup/test-user.sh check ci | grep FAIL >&2; fail "test-user.sh check ci fails after this step"; }
echo "OK: test-run networking on real systemd: none by default, granted only by root's file, fetch and database as designed"
