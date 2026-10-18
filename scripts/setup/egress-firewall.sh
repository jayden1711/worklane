#!/usr/bin/env bash
# As root (review it first): the host's egress rule for the sandbox users, the second network layer under each step's
# own PrivateNetwork=yes (docs/experiments.md, docs/test-runs.md). Every experiment job user (wl-exp-*), scorer user
# (wl-score-*) and test-run user (wl-test-*) on this machine may send nothing but loopback: an nftables rule matching
# the socket's owner (meta skuid) drops the rest. The coordinator, the dashboard, the agents and every other user are
# not covered; the controller stays outside the sandbox.
#
#   bash scripts/setup/egress-firewall.sh apply [--with-test-users]   write, validate, load; and at every boot (exit 3:
#                                                                      loaded, but check found something to fix)
#   bash scripts/setup/egress-firewall.sh check                        the rule is loaded, covers every such user, and blocks
#   bash scripts/setup/egress-firewall.sh revert                       remove it (the rule, the boot unit, the file)
#   bash scripts/setup/egress-firewall.sh --print [--with-test-users]  the rule it would load (changes nothing)
#
# The one exception (#543): a socket in the cgroup of a unit in the set egress_ok may send out, whoever owns it. A unit
# joins the set by NFTSet=cgroup:inet:worklane_egress:egress_ok, which systemd keeps up to date (adds the unit's cgroup
# when it starts, removes it when it stops). Only test-user.sh's rootless Docker unit has it: Docker pulls a run's
# database image (pinned by digest) as the test user, through its own slirp4netns in that unit. A test run's own units
# don't, and their processes can't move into Docker's cgroup: its parent, worklane-test.slice, is root's. The egress CI
# job asserts that a plain test-user unit's write of its own pid there is refused; a run's own /sys/fs/cgroup is
# read-only too (ProtectControlGroups=; inferred, not run). They do share Docker's uid, though, and so can drive its
# processes: docs/test-runs.md, "Known gap".
# WHY test users only with --with-test-users on a systemd older than 255: NFTSet= came in 255, so there nothing fills
# the set and Docker couldn't pull; apply says so. With the flag they're covered there anyway, and Docker can't pull.
# WHY no exception where this install's rule already covered test users without one (apply --with-test-users before
# #543, or on a systemd older than 255): there all of their Docker's traffic was dropped, and the exception would reopen
# the routes out through Docker that this closed. The record (/etc/worklane/egress.users, root's) says so with
# "# docker: dropped", and every later apply keeps it, whatever its flags, until revert (lib.sh egress_docker_mode).
# Re-run apply after adding an instance (experiments.sh install does, with the flags it was applied with): the rule
# names users by uid.
source "$(dirname "$0")/lib.sh"
all_args=("$@")
usage="usage: egress-firewall.sh [--print] apply [--with-test-users] | check | revert"
print="" tests=""
pos=()
for a in "$@"; do
  case "$a" in
    --print) print=1 ;;
    --with-test-users) tests=1 ;;
    -*) echo "unknown option $a" >&2; echo "$usage" >&2; exit 2 ;;
    *) pos+=("$a") ;;
  esac
done
cmd="${pos[0]:-}"
[ -n "$print" ] && cmd=apply
case "$cmd" in apply | check | revert) [ "${#pos[@]}" -le 1 ] || { echo "$usage" >&2; exit 2; } ;; *) echo "$usage" >&2; exit 2 ;; esac

TABLE="$EGRESS_TABLE"
SET="$EGRESS_SET"
RULES=/etc/worklane/egress.nft
UNIT=/etc/systemd/system/worklane-egress.service
MARK="$EGRESS_RECORD"
# --print changes nothing, so a test may point it at a record of its own.
[ -z "$print" ] || MARK="${EGRESS_RECORD_PRINT:-$MARK}"
# WHY level 3 (measured on real systemd 255, #543's CI spike): systemd nests a dashed slice under its prefix, so a unit
# in worklane-test.slice is /worklane.slice/worklane-test.slice/<unit>, level 3. Its subgroups (Docker's daemon, each
# container) are below it, so the unit is still their level-3 ancestor. Level 2 is the slice, which NFTSet= never adds.
LEVEL=3

# This run's mode, with_tests and nftset, from the record ($MARK), --with-test-users ($tests) and systemd's version ($sysd).
#   mode:       exempt, or dropped (test users' Docker gets no exception, ever: lib.sh egress_docker_mode).
#   with_tests: test users are covered: systemd 255 or later, --with-test-users, or a record that says dropped (it
#               covered them: a later apply without the flag doesn't uncover them).
#   nftset:     the set and its accept are in the rule: systemd 255 or later (NFTSet= can fill it) and not dropped.
# A rule that covers test users with no exception drops all of their Docker's traffic: from then on the mode is dropped.
decide() {
  mode="$(egress_docker_mode "$MARK")"
  nftset="" with_tests="$tests"
  [ "$mode" != dropped ] || with_tests=1
  if [ "$sysd" -ge "$EGRESS_NFTSET_SYSTEMD" ]; then
    with_tests=1
    [ "$mode" = dropped ] || nftset=1
  fi
  [ -z "$with_tests" ] || [ -n "$nftset" ] || mode=dropped
}
sysd="$(systemd_major)"
decide
# Said on every apply and --print where there's no exception: why test users aren't covered, or what covering them costs.
why_not_tests() {
  local v="$sysd"
  [ -z "$nftset" ] || return 0
  if [ "$sysd" -ge "$EGRESS_NFTSET_SYSTEMD" ]; then
    echo "note: test users (wl-test-*) are covered, and their Docker gets no exception, so it can't pull images (a run's database image must already be there): this install's rule covered them before with all of their Docker's traffic dropped (its record, $MARK), and the exception would reopen routes out through Docker that it had closed (docs/test-runs.md, \"Known gap\"). That stays so until revert" >&2
    return 0
  fi
  [ "$v" != 0 ] || v="unknown"
  if [ -z "$with_tests" ]; then
    echo "note: test users (wl-test-*) are not covered: this machine's systemd is $v, and the exception for their Docker's image pulls (NFTSet=) needs $EGRESS_NFTSET_SYSTEMD or later. --with-test-users covers them anyway, and their Docker then can't pull images" >&2
  else
    echo "note: test users (wl-test-*) are covered ($([ -n "$tests" ] && echo "--with-test-users" || echo "this install's rule covered them: its record, $MARK")), and with systemd $v (NFTSet= needs $EGRESS_NFTSET_SYSTEMD) their Docker can't pull images: a run's database image must already be there" >&2
  fi
}

# The covered users' uids, one a line: wl-exp-*, wl-score-*, and wl-test-* (on systemd 255 or later, or with
# --with-test-users).
covered() {
  local pat='^wl-(exp|score)-[a-z][a-z0-9-]{0,20}$'
  [ -z "$with_tests" ] || pat='^wl-(exp|score|test)-[a-z][a-z0-9-]{0,20}$'
  getent passwd | awk -F: -v p="$pat" '$1 ~ p { print $3 }' | sort -n
}

# The rule file, loaded in one transaction: the table, the set and the chain made if they aren't there, the chain's
# rules flushed, then this rule. Loading it twice leaves one copy.
# WHY never `delete table`: the set holds the cgroups systemd added as each exempt unit started. Deleting the table
# (as this file did before #543) empties it, and those units could send nothing until they restarted.
rules() {
  local uids chain='type filter hook output priority 0; policy accept;'
  uids="$(covered | paste -sd, - | sed 's/,/, /g')"
  printf 'table inet %s {\n' "$TABLE"
  [ -z "$nftset" ] || printf '  set %s {\n    type cgroupsv2\n  }\n' "$SET"
  printf '  chain out {\n    %s\n  }\n}\nflush chain inet %s out\ntable inet %s {\n  chain out {\n    %s\n' "$chain" "$TABLE" "$TABLE" "$chain"
  [ -z "$nftset" ] || printf '    socket cgroupv2 level %s @%s accept\n' "$LEVEL" "$SET"
  [ -z "$uids" ] || printf '    meta skuid { %s } oifname != "lo" counter drop\n' "$uids"
  printf '  }\n}\n'
}

unit() {
  cat <<EOF
[Unit]
Description=worklane: no egress for the sandbox users (experiment jobs, scorers, test runs)
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $RULES
ExecStop=/usr/sbin/nft delete table inet $TABLE

[Install]
WantedBy=multi-user.target
EOF
}

if [ -n "$print" ]; then why_not_tests; rules; exit 0; fi
as_root "${all_args[@]}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
command -v nft >/dev/null 2>&1 || { echo "no nft on this machine: apt-get install -y nftables, then run this again" >&2; exit 1; }

# Whether unit $1's NFTSet= names the set (one of the space-separated entries of any NFTSet= line in its unit file,
# drop-ins or transient file). WHY systemctl cat, not show: systemd 255's `systemctl show -p NFTSet` prints
# "[unprintable]" (measured on ubuntu-latest).
in_set_by_unit() {
  local sets
  sets="$(systemctl cat "$1" 2>/dev/null | sed -n 's/^NFTSet=//p' | tr ' ' '\n' || true)"
  grep -qxF "cgroup:inet:$TABLE:$SET" <<<"$sets"
}

# The running test users' Docker units (worklane-test-<name>-docker.service, test-user.sh's) whose NFTSet= names the
# set, one a line. WHY only those: they're the one unit the design lets join, so no other unit's text (a continuation
# line, a key in the wrong section that systemd itself ignores) can put a cgroup in the set.
exempt_units() {
  local u
  while read -r u _; do
    [[ "$u" =~ ^worklane-test-[a-z][a-z0-9-]*-docker\.service$ ]] || continue
    if in_set_by_unit "$u"; then echo "$u"; fi
  done < <(systemctl list-units --type=service --state=active,activating,reloading --plain --no-legend 'worklane-test-*-docker.service' 2>/dev/null || true)
}

# Each running unit with NFTSet= naming the set, put in it as systemd would have: one that started before the set
# existed (test-user.sh install before the first apply) found no set to join, and would otherwise send nothing until it
# restarted.
join_running() {
  local u cg
  for u in $(exempt_units); do
    cg="$(systemctl show -p ControlGroup --value "$u" 2>/dev/null || true)"
    [ -n "$cg" ] || continue
    if nft add element inet "$TABLE" "$SET" "{ \"${cg#/}\" }"; then echo "exempt: $u (NFTSet=): its cgroup $cg may send out"
    else echo "couldn't add $u's cgroup $cg to the set: restart it (systemctl restart $u) and systemd adds it" >&2; fi
  done
}

apply_cmd() {
  local tmp
  why_not_tests
  [ -n "$(covered)" ] || echo "note: no sandbox user exists yet; the rule is loaded empty until you run this again after experiments.sh install"
  install -d -o root -g root -m 0755 /etc/worklane
  # A dotted temp file, validated by nft itself, then moved into place and loaded.
  tmp="/etc/worklane/.egress.nft.tmp"
  rules > "$tmp"; chmod 0644 "$tmp"
  nft -c -f "$tmp" || { rm -f "$tmp"; echo "the rule doesn't validate; nothing changed" >&2; exit 1; }
  # The record before the rule: a mode of dropped is kept even if loading fails after this.
  record > "/etc/worklane/.egress.users.tmp"; chmod 0644 "/etc/worklane/.egress.users.tmp"
  mv -f "/etc/worklane/.egress.users.tmp" "$MARK"
  mv -f "$tmp" "$RULES"
  nft -f "$RULES"
  echo "loaded $RULES: $(covered | wc -l) user(s) may send nothing but loopback"
  [ -z "$nftset" ] || join_running
  unit > "/etc/systemd/system/.worklane-egress.service.tmp"; chmod 0644 "/etc/systemd/system/.worklane-egress.service.tmp"
  mv -f "/etc/systemd/system/.worklane-egress.service.tmp" "$UNIT"
  systemctl daemon-reload
  systemctl enable -q worklane-egress.service
  # Exit 3: the rule is loaded, but check found something to fix (its FAIL lines say what).
  check_cmd || exit 3
}

# The record apply writes ($MARK): the flag it was given, whether test users' Docker may be exempt (exempt or dropped,
# lib.sh egress_docker_mode), and the covered uids, one a line.
record() {
  [ -z "$tests" ] || echo "# --with-test-users"
  echo "# docker: $mode"
  covered
}

# Each test user's running Docker unit may send out: its NFTSet= names the set, and its cgroup is in it.
docker_check() {
  local fail=0 u cg name
  while read -r u _; do
    [ -n "$u" ] || continue
    name="${u#worklane-test-}"; name="${name%-docker.service}"
    cg="$(systemctl show -p ControlGroup --value "$u" 2>/dev/null || true)"
    if ! in_set_by_unit "$u"; then
      echo "FAIL $u has no NFTSet=cgroup:inet:$TABLE:$SET (an older test-user.sh install), so its image pulls are dropped: run test-user.sh install $name again, with the options it was installed with"; fail=1
    elif [ -n "$cg" ] && grep -qF "\"${cg#/}\"" <<<"$1"; then
      echo "PASS $u may pull images (its cgroup is in the set $SET)"
    else
      echo "FAIL $u's cgroup ${cg:-(none)} isn't in the set $SET: run apply again, or restart it"; fail=1
    fi
  done < <(systemctl list-units --type=service --state=active --plain --no-legend 'worklane-test-*-docker.service' 2>/dev/null || true)
  return "$fail"
}

# PASS when the table is loaded, names every covered user, and each one's connection out is refused or never answered;
# and where the set is in it, each test user's Docker is exempt.
check_cmd() {
  local fail=0 uid u loaded
  loaded="$(nft list table inet "$TABLE" 2>/dev/null || true)"
  if [ -n "$loaded" ]; then echo "PASS table inet $TABLE is loaded"; else echo "FAIL table inet $TABLE is not loaded"; return 1; fi
  # The users apply covered (its own record), else every one this machine's rule should cover now.
  local uids
  # || true: a record with no user (the last instance's sandbox users removed) is no user to check, not a failure.
  if [ -f "$MARK" ]; then uids="$(grep -v '^#' "$MARK" || true)"; else uids="$(covered)"; fi
  for uid in $uids; do
    u="$(getent passwd "$uid" | cut -d: -f1)"
    if grep -Eq "skuid \\{[^}]*\\b$uid\\b" <<<"$loaded" || grep -Eq "skuid $uid\\b" <<<"$loaded"; then echo "PASS $u ($uid) is covered"; else echo "FAIL $u ($uid) is not covered: run apply again"; fail=1; continue; fi
    if runuser -u "$u" -- timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo "FAIL $u reached 1.1.1.1:443"; fail=1; else echo "PASS $u can't reach 1.1.1.1:443"; fi
  done
  if [ -n "$nftset" ]; then
    if grep -q "socket cgroupv2 level $LEVEL @$SET accept" <<<"$loaded"; then
      echo "PASS the exception: a unit's cgroup in the set $SET (NFTSet=) may send out"
      docker_check "$loaded" || fail=1
    else
      echo "FAIL the exception for the set $SET isn't loaded, so test users' Docker can't pull images: run apply again"; fail=1
    fi
  elif grep -q 'socket cgroupv2' <<<"$loaded"; then
    echo "FAIL a cgroup exception is loaded, but this rule has none (test users' Docker traffic is $mode here): run apply again"; fail=1
  elif [ "$mode" = dropped ] && [ "$sysd" -ge "$EGRESS_NFTSET_SYSTEMD" ]; then
    echo "PASS no exception: test users' Docker may send nothing out either, as this install's rule had it before (its record, $MARK)"
  fi
  systemctl is-enabled -q worklane-egress.service 2>/dev/null && echo "PASS loaded at boot (worklane-egress.service)" || { echo "FAIL not loaded at boot"; fail=1; }
  [ "$fail" -eq 0 ] && echo OK || echo FAILED
  return "$fail"
}

revert_cmd() {
  systemctl disable -q --now worklane-egress.service 2>/dev/null || true
  nft delete table inet "$TABLE" 2>/dev/null || true
  rm -f "$UNIT" "$RULES" "$MARK"
  systemctl daemon-reload
  echo "removed: the sandbox users' egress is up to PrivateNetwork=yes alone"
}

case "$cmd" in
  apply) apply_cmd ;;
  check) check_cmd ;;
  revert) revert_cmd ;;
esac
