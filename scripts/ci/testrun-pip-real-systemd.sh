#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml, the test-run sandbox job, after the network step): the pip fetch
# (docs/test-runs.md "Network") against real systemd, the real helper and its real sudoers rule, slirp4netns and pip.
# An index on a public stand-in ($PUB, TEST-NET-3: in a network namespace of its own behind a veth, so not one of this
# host's addresses) serves the fixtures (scripts/ci/testrun-pip-fixtures.py) as a simple index over HTTP; root's
# /etc/pip.conf names it (the machine's own pip config, which no repo can set). Its request log is the record: the
# fixtures' canaries (the repo's in-tree build backend, an sdist's) send GET /canary-repo or /canary-evil to it when
# they run, and write what they got beside themselves.
#   fetch:        the wheels of requirements.txt's pin and of the repo's build requirement land in the cache, with no
#                 grant; the index saw the fetch ask for both and never a canary: no code of the repo's ran.
#   install:      in the same run, pip install --no-index -r requirements.txt (its -e . line) with no network: the
#                 repo is built from the cache alone; its canary ran there and couldn't connect; the index saw nothing.
#   sdist:        a pin with only an sdist: the fetch fails, naming why; the index saw it look, never evil's canary.
#   planted:      a run's command plants in the cache a wheel standin 1.0+evil that needs evil @ file://<the cache's
#                 evil sdist, planted too>: the fetch never reads the cache, so it takes the index's standin and evil's
#                 canary never runs. The helper of this PR's first commit ($OLD: the cache was a find-links source)
#                 built evil there (fail-without).
#   direct:       a pin whose wheel needs evil @ <its sdist's URL on the index>: refused before pip sees it, evil's
#                 canary never runs; $OLD's fetch built it (fail-without).
#   fail-without: the old way, a setup step root grants the network running pip download: the index saw the repo's
#                 canary (pip download -r requirements.txt builds -e ., even with --only-binary=:all:) and evil's
#                 (without it), so this probe can tell.
# Usage: bash scripts/ci/testrun-pip-real-systemd.sh   (as the runner user, with sudo; after test-user.sh install ci)
set -euo pipefail
H=/usr/local/libexec/worklane-testrun
OLD=a51a0d01ba547bcfa2cf42d5262fcdec2f55d05e
PUB=203.0.113.7
PORT=8080
t="$(mktemp -d)"
chmod 0755 "$t"
conf_was=0
if [ -e /etc/pip.conf ]; then sudo cp /etc/pip.conf "$t/pip.conf.was"; conf_was=1; fi
etc_was=0; [ -d /etc/worklane ] && etc_was=1
cleanup() {
  sudo pkill -f "http.server $PORT --bind $PUB" 2>/dev/null || true
  sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"
  if [ "$conf_was" = 1 ]; then sudo cp "$t/pip.conf.was" /etc/pip.conf; else sudo rm -f /etc/pip.conf; fi
  sudo rm -f /etc/worklane/testrun-network.json
  [ "$etc_was" = 1 ] || sudo rmdir /etc/worklane 2>/dev/null || true
  sudo ip netns del wlpip 2>/dev/null || true
  sudo ip link del wlq0 2>/dev/null || true
  rm -rf "$t"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== the index: the fixtures on $PUB:$PORT, named in root's /etc/pip.conf"
python3 -I scripts/ci/testrun-pip-fixtures.py "$t/fx" --canary "$PUB:$PORT" --direct-url "http://$PUB:$PORT/simple/evil/evil-1.0.tar.gz" > /dev/null
chmod -R a+rX "$t/fx"
sudo ip netns add wlpip
sudo ip link add wlq0 type veth peer name wlq1
sudo ip link set wlq1 netns wlpip
sudo ip addr add 203.0.113.1/24 dev wlq0
sudo ip link set wlq0 up
sudo ip netns exec wlpip ip addr add "$PUB/24" dev wlq1
sudo ip netns exec wlpip ip link set wlq1 up
sudo ip netns exec wlpip ip link set lo up
# Its log (each request's line) is this script's file; the server runs as nobody.
sudo ip netns exec wlpip runuser -u nobody -- python3 -m http.server "$PORT" --bind "$PUB" --directory "$t/fx" > "$t/http.log" 2>&1 &
for _ in $(seq 50); do curl -fsS -o /dev/null "http://$PUB:$PORT/simple/" 2>/dev/null && break; sleep 0.2; done
curl -fsS "http://$PUB:$PORT/simple/standin/" | grep -q 'standin-1.0-py3-none-any.whl' || fail "the index didn't start"
printf '[global]\nindex-url = http://%s:%s/simple/\ntrusted-host = %s\n' "$PUB" "$PORT" "$PUB" | sudo tee /etc/pip.conf > /dev/null
sudo chmod 0644 /etc/pip.conf
# The python3 a run's commands find (the helper's PATH), with pip.
env -i PATH=/usr/local/bin:/usr/bin:/bin bash -c 'command -v python3 && python3 -I -m pip --version' || fail "no python3 with pip on the test user's PATH (/usr/local/bin:/usr/bin:/bin)"
# What the index saw since mark <n>: each path asked, once, space-separated.
mark() { wc -l < "$t/http.log"; }
since() { tail -n +"$(($1 + 1))" "$t/http.log" | sed -n 's/.*"GET \([^ ]*\) HTTP.*/\1/p' | sort -u | tr '\n' ' '; }

as_() { local i="$1"; shift; sudo -u "wl-$i" sudo -n "$H" "$i" "$@"; }
# A run of instance $1 with id $2, its commit holding the files in directory $3.
mkrun() {
  local i="$1" id="$2" files="$3" r id_=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
  r="$(mktemp -d)"
  git init -q "$r"
  cp -r "$files"/. "$r/"
  git -C "$r" add -A && git -C "$r" "${id_[@]}" commit -q -m probe
  for x in head base; do git -C "$r" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
  git -C "$r" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
  as_ "$i" create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$(git -C "$r" rev-parse HEAD)" "$(git -C "$r" rev-parse HEAD)" < "$r/b" > /dev/null
  rm -rf "$r"
}
newkey() { printf '%s' "$1" | sha256sum | cut -c1-32; }

echo "== fetch: the pin's and the build requirement's wheels, with no grant; no code of the repo's runs"
sudo rm -f /etc/worklane/testrun-network.json
mkrun ci pip-fetch "$t/fx/repo"
key="$(newkey pip-fetch)"
dir="$(as_ ci cache pip "$key")"
m="$(mark)"
as_ ci fetch pip-fetch pip pip "$key" 300 requirements.txt < /dev/null > "$t/fetch.out" 2>&1 || { cat "$t/fetch.out" >&2; fail "the fetch failed"; }
sed 's/^/  fetch: /' "$t/fetch.out"
head -n 1 "$t/fetch.out" | grep -qx "worklane-testrun: fetch pip (no script run; public addresses and the machine's DNS only)" || fail "the fetch line"
grep -qx 'fetch: 1 pinned in requirements.txt; build requirements: standin-backend>=1' "$t/fetch.out" || fail "the fetch's summary"
got="$(sudo ls "$dir" | sort | tr '\n' ' ')"
[ "$got" = "standin-1.0-py3-none-any.whl standin_backend-1.0-py3-none-any.whl " ] || fail "the cache holds: $got"
s="$(since "$m")"
echo "  the index saw: $s"
case "$s" in *canary*) fail "a canary reached the index during the fetch: $s" ;; esac
[[ "$s" == *"/simple/standin/ "* && "$s" == *"/simple/standin-backend/ "* ]] || fail "the fetch didn't ask the index for both: $s"

echo "== install: pip install --no-index builds the repo (-e .) from the cache, with no network; the repo's build runs here"
m="$(mark)"
printf 'PIP_FIND_LINKS=%s\0' "$dir" | as_ ci exec pip-fetch 300 -- 'python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install --no-index -r requirements.txt && .venv/bin/python -c "import standin, standin_repo; print(standin.X + standin_repo.Y)" && cat canary.txt' > "$t/install.out" 2> "$t/install.err" || { cat "$t/install.out" "$t/install.err" >&2; fail "the install failed"; }
sed 's/^/  install: /' "$t/install.out"
grep -qx 3 "$t/install.out" || fail "the installed packages didn't import"
c="$(grep '^repo ' "$t/install.out" || true)"
[ -n "$c" ] || fail "the repo's build backend didn't run in the install step"
if grep -qx 'repo reached' <<< "$c"; then fail "the repo's build reached the index from the install step"; fi
[ -z "$(since "$m")" ] || fail "the index saw $(since "$m") during the install"
as_ ci wipe pip-fetch > /dev/null

echo "== sdist only: the fetch fails, naming why; evil's build never runs"
mkrun ci pip-sdist "$t/fx/repo"
key="$(newkey pip-sdist)"
as_ ci cache pip "$key" > /dev/null
m="$(mark)"
if as_ ci fetch pip-sdist pip pip "$key" 300 requirements-sdist.txt < /dev/null > "$t/sdist.out" 2>&1; then cat "$t/sdist.out" >&2; fail "the fetch of an sdist-only pin passed"; fi
grep -q '^fetch: pip download failed: the fetch takes wheels only (building an sdist runs its code)' "$t/sdist.out" || { cat "$t/sdist.out" >&2; fail "the sdist's refusal"; }
s="$(since "$m")"
echo "  the index saw: $s"
[[ "$s" == *"/simple/evil/ "* ]] || fail "the fetch didn't look for evil: $s"
case "$s" in *canary*) fail "a canary reached the index: $s" ;; esac
as_ ci wipe pip-sdist > /dev/null

# A run of <id> (the fixtures' repo, with a planted/ directory holding standin 1.0+evil, needing evil @ file://<its
# cache's evil sdist>, and that sdist), and its cache, which the run's own command fills from planted/ as an attacker's
# would. Prints the cache's directory.
planted_run() {
  local id="$1" k c
  k="$(newkey "$id")"
  c="$(as_ ci cache pip "$k")"
  rm -rf "$t/repo-$id" "$t/fx-$id"
  cp -r "$t/fx/repo" "$t/repo-$id"
  python3 -I scripts/ci/testrun-pip-fixtures.py "$t/fx-$id" --canary "$PUB:$PORT" --planted-url "file://$c/evil-1.0.tar.gz" > /dev/null
  mkdir "$t/repo-$id/planted"
  cp "$t/fx-$id/planted/standin-1.0+evil-py3-none-any.whl" "$t/fx/index/evil-1.0.tar.gz" "$t/repo-$id/planted/"
  mkrun ci "$id" "$t/repo-$id"
  printf 'PIP_FIND_LINKS=%s\0' "$c" | as_ ci exec "$id" 60 -- 'cp planted/* "$PIP_FIND_LINKS"/ && ls "$PIP_FIND_LINKS"' > "$t/$id.plant" 2>&1 || { cat "$t/$id.plant" >&2; fail "$id: planting the cache"; }
  grep -qx 'standin-1.0+evil-py3-none-any.whl' "$t/$id.plant" || { cat "$t/$id.plant" >&2; fail "$id: the planted wheel isn't in the cache"; }
  printf '%s\n' "$c"
}

echo "== planted: a run plants standin 1.0+evil (needing evil @ file://<the cache's sdist>) in the cache; the fetch never reads it"
c="$(planted_run pip-planted)"
m="$(mark)"
as_ ci fetch pip-planted pip pip "$(newkey pip-planted)" 300 requirements.txt < /dev/null > "$t/planted.out" 2>&1 || { cat "$t/planted.out" >&2; fail "the fetch with a planted cache failed"; }
s="$(since "$m")"
echo "  the index saw: $s"
case "$s" in *canary*) fail "a canary reached the index during the fetch: $s" ;; esac
sudo cmp -s "$c/standin-1.0-py3-none-any.whl" "$t/fx/index/standin-1.0-py3-none-any.whl" || fail "the cache's standin isn't the index's"
as_ ci wipe pip-planted > /dev/null

echo "== direct: a pin whose wheel needs evil @ <the index's sdist URL>: refused before pip sees it"
mkrun ci pip-direct "$t/fx/repo"
key="$(newkey pip-direct)"
as_ ci cache pip "$key" > /dev/null
m="$(mark)"
if as_ ci fetch pip-direct pip pip "$key" 300 requirements-direct.txt < /dev/null > "$t/direct.out" 2>&1; then cat "$t/direct.out" >&2; fail "the fetch of a direct reference passed"; fi
grep -q "^fetch: standin_direct-1.0-py3-none-any.whl depends on evil @ http://$PUB:$PORT/simple/evil/evil-1.0.tar.gz: a direct reference" "$t/direct.out" || { cat "$t/direct.out" >&2; fail "the direct reference's refusal"; }
s="$(since "$m")"
echo "  the index saw: $s"
case "$s" in *canary*|*evil-1.0.tar.gz*) fail "the fetch went on to evil: $s" ;; esac
as_ ci wipe pip-direct > /dev/null

echo "== fail-without: the helper of this PR's first commit ($OLD) built evil in both"
git fetch -q --depth=1 origin "$OLD"
git show "$OLD:scripts/machine/worklane-testrun.sh" > "$t/helper-old.sh"
sudo install -o root -g root -m 0755 "$t/helper-old.sh" "$H"
c="$(planted_run pip-planted-old)"
m="$(mark)"
as_ ci fetch pip-planted-old pip pip "$(newkey pip-planted-old)" 300 requirements.txt < /dev/null > "$t/planted-old.out" 2>&1 || true
s="$(since "$m")"
echo "  planted, the index saw: $s"
[[ "$s" == *"/canary-evil "* ]] || { cat "$t/planted-old.out" >&2; fail "the old helper's fetch didn't build the planted evil: this probe can't tell ($s)"; }
as_ ci wipe pip-planted-old > /dev/null
mkrun ci pip-direct-old "$t/fx/repo"
key="$(newkey pip-direct-old)"
as_ ci cache pip "$key" > /dev/null
m="$(mark)"
as_ ci fetch pip-direct-old pip pip "$key" 300 requirements-direct.txt < /dev/null > "$t/direct-old.out" 2>&1 || true
s="$(since "$m")"
echo "  direct, the index saw: $s"
[[ "$s" == *"/canary-evil "* ]] || { cat "$t/direct-old.out" >&2; fail "the old helper's fetch didn't build the direct reference: this probe can't tell ($s)"; }
as_ ci wipe pip-direct-old > /dev/null
sudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"

echo "== fail-without: the old way, a setup step granted the network, running pip download: the builds reach the index"
sudo bash scripts/setup/testrun-network.sh enable ci --tiers setup > /dev/null
mkrun ci pip-old "$t/fx/repo"
m="$(mark)"
as_ ci exec pip-old 300 --network setup -- 'python3 -I -m pip download --only-binary=:all: --no-cache-dir -d dl -r requirements.txt; python3 -I -m pip download --no-cache-dir -d dl evil==1.0' < /dev/null > "$t/old.out" 2>&1 || true
s="$(since "$m")"
echo "  the index saw: $s"
[[ "$s" == *"/canary-repo "* && "$s" == *"/canary-evil "* ]] || { cat "$t/old.out" >&2; fail "the old way's builds didn't reach the index: this probe can't tell ($s)"; }
as_ ci wipe pip-old > /dev/null
sudo bash scripts/setup/testrun-network.sh disable ci > /dev/null

cleanup
trap - EXIT
sudo bash scripts/setup/test-user.sh check ci | tail -n 1 | grep -qx 'OK: all checks passed' || { sudo bash scripts/setup/test-user.sh check ci | grep FAIL >&2; fail "test-user.sh check ci fails after this step"; }
echo "OK: the pip fetch on real systemd: wheels only, no repo code with network; the install builds the repo offline"
