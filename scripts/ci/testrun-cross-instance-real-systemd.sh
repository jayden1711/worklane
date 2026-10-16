#!/bin/bash
# CI only (the "test-run sandbox (real systemd)" job of .github/workflows/ci-slow.yml), as root's caller with sudo:
# one instance's wipe never stops another's units or containers. Instance <a> is a prefix of instance <v> (<v> is
# <a>-<rest>), so a helper that named units <cli>-test-<name>-<id>-<pid> and wiped "<cli>-test-<a>-<id>-*" stopped <v>'s
# Docker unit (wipe <rest>) and <v>'s runs (wipe <rest>-<id>) when <a>'s coordinator asked. Both instances are
# installed (scripts/setup/test-user.sh) and each is called through its own coordinator user's sudoers rule.
#
#   bash testrun-cross-instance-real-systemd.sh <instance v> <instance a, a prefix of v> <database image@sha256:...>
set -euo pipefail
V="${1:?usage: <instance v> <instance a> <image>}" A="${2:?usage: <instance v> <instance a> <image>}" IMG="${3:?usage: <instance v> <instance a> <image>}"
[[ "$V" == "$A"-* ]] || { echo "$A must be a prefix of $V" >&2; exit 2; }
rest="${V#"$A"-}"
H=/usr/local/libexec/worklane-testrun
asV() { sudo -u "wl-$V" sudo -n "$H" "$V" "$@"; }
asA() { sudo -u "wl-$A" sudo -n "$H" "$A" "$@"; }
dockerV() { sudo -u "wl-test-$V" env HOME="/var/lib/worklane-test/$V/docker-home" DOCKER_HOST="unix:///run/worklane-test-$V-docker/docker.sock" /opt/worklane-test/docker/docker "$@"; }
active() { systemctl is-active -q "$1"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# Instance v's run x1: a workspace, its database, and a command still running.
id=x1
r="$(mktemp -d)"
trap 'rm -rf "$r"' EXIT
g=(-c user.email=ci@example.com -c user.name=ci -c commit.gpgsign=false)
git init -q "$r/repo" && date > "$r/repo/f" && git -C "$r/repo" add f && git -C "$r/repo" "${g[@]}" commit -q -m probe
for x in head base; do git -C "$r/repo" update-ref "refs/worklane/test-run/$id/$x" HEAD; done
git -C "$r/repo" bundle create --quiet "$r/b" "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base"
sha="$(git -C "$r/repo" rev-parse HEAD)"
asV create "$id" main "refs/worklane/test-run/$id/head" "refs/worklane/test-run/$id/base" "$sha" "$sha" < "$r/b" > /dev/null
asV db-start "$id" "$IMG" test 60 100 > /dev/null
c="worklane-test-$V-$id"
asV exec "$id" 300 -- 'sleep 300' < /dev/null > "$r/exec.log" 2>&1 &
pid=$!
u=
for _ in $(seq 100); do
  u="$(systemctl list-units --plain --no-legend "worklane-test-${V}_${id}_*" | awk '{print $1}')"
  [ -n "$u" ] && active "$u" && break
  sleep 0.2
done
[ -n "$u" ] || fail "$V's run $id has no unit"
echo "$V's run $id: unit $u, container $c"
# Units an older helper named <cli>-test-<name>-<id>-<pid>, as an update leaves them, the same shape for both: v's run
# x1 and a's run <rest>-x1. Only User= tells them apart.
oldV="worklane-test-$V-$id-4242.service" oldA="worklane-test-$A-$rest-$id-4243.service"
sudo systemd-run --quiet --unit="$oldV" --uid="wl-test-$V" --gid="wl-test-$V" --slice=worklane-test.slice sleep 300
sudo systemd-run --quiet --unit="$oldA" --uid="wl-test-$A" --gid="wl-test-$A" --slice=worklane-test.slice sleep 300

# Instance a's coordinator wipes the two ids whose old pattern reached v: <rest> (v's Docker, every run) and <rest>-x1.
asA wipe "$rest"
asA wipe "$rest-$id"
active "worklane-test-$V-docker.service" || fail "$A's wipe stopped $V's Docker"
active "$u" || fail "$A's wipe stopped $V's run unit $u"
active "$oldV" || fail "$A's wipe stopped $V's old-named unit $oldV"
[ "$(dockerV inspect -f '{{.State.Running}}' "$c")" = true ] || fail "$A's wipe stopped $V's container $c"
! active "$oldA" || fail "$A's wipe left its own old-named unit $oldA"
echo "PASS $A's wipe of $rest and $rest-$id left $V's Docker, run unit, old-named unit and container running, and stopped its own old-named unit"

# Instance v's own wipe: its unit by either name and its container, all gone.
asV wipe "$id"
wait "$pid" || true
for x in "$u" "$oldV"; do ! active "$x" || fail "$V's wipe left $x"; done
[ -z "$(dockerV ps -aq --filter "label=worklane.test-run=$V-$id")" ] || fail "$V's wipe left its container"
echo "PASS $V's wipe of $id stopped its unit (new name and old) and removed its container"
