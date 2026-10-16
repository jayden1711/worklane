#!/usr/bin/env bash
# As root (review it first): the host's egress rule for the sandbox users, the second network layer under each step's
# own PrivateNetwork=yes (docs/experiments.md). Every experiment job user (wl-exp-*) and scorer user (wl-score-*) on
# this machine, and with --with-test-users every test-run user (wl-test-*), may send nothing but loopback: an nftables
# rule matching the socket's owner (meta skuid) drops the rest. The coordinator, the dashboard, the agents and every
# other user are not covered; the controller stays outside the sandbox.
#
#   bash scripts/setup/egress-firewall.sh apply [--with-test-users]   write, validate, load; and at every boot
#   bash scripts/setup/egress-firewall.sh check                        the rule is loaded, covers every such user, and blocks
#   bash scripts/setup/egress-firewall.sh revert                       remove it (the rule, the boot unit, the file)
#   bash scripts/setup/egress-firewall.sh --print [--with-test-users]  the rule it would load (changes nothing)
#
# WHY test users only on request: a test run's own setup (its database image, pulled by rootless Docker as the test
# user) and any tier a root policy opts into the network need egress; a test user is covered only where none does.
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

TABLE=worklane_egress
RULES=/etc/worklane/egress.nft
UNIT=/etc/systemd/system/worklane-egress.service
MARK=/etc/worklane/egress.users

# The covered users' uids, one a line: wl-exp-*, wl-score-* (and wl-test-* with --with-test-users).
covered() {
  local pat='^wl-(exp|score)-[a-z][a-z0-9-]{0,20}$'
  [ -z "$tests" ] || pat='^wl-(exp|score|test)-[a-z][a-z0-9-]{0,20}$'
  getent passwd | awk -F: -v p="$pat" '$1 ~ p { print $3 }' | sort -n
}

# The rule file: replaces the table whole (create, delete, create), so loading it twice leaves one copy.
rules() {
  local uids
  uids="$(covered | paste -sd, - | sed 's/,/, /g')"
  printf 'table inet %s\ndelete table inet %s\ntable inet %s {\n  chain out {\n    type filter hook output priority 0; policy accept;\n' "$TABLE" "$TABLE" "$TABLE"
  [ -z "$uids" ] || printf '    meta skuid { %s } oifname != "lo" counter drop\n' "$uids"
  printf '  }\n}\n'
}

unit() {
  cat <<EOF
[Unit]
Description=worklane: no egress for the sandbox users (experiment jobs, scorers)
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

if [ -n "$print" ]; then rules; exit 0; fi
as_root "${all_args[@]}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
command -v nft >/dev/null 2>&1 || { echo "no nft on this machine: apt-get install -y nftables, then run this again" >&2; exit 1; }

apply_cmd() {
  local tmp
  [ -n "$(covered)" ] || echo "note: no sandbox user exists yet; the rule is loaded empty until you run this again after experiments.sh install"
  install -d -o root -g root -m 0755 /etc/worklane
  # A dotted temp file, validated by nft itself, then moved into place and loaded.
  tmp="/etc/worklane/.egress.nft.tmp"
  rules > "$tmp"; chmod 0644 "$tmp"
  nft -c -f "$tmp" || { rm -f "$tmp"; echo "the rule doesn't validate; nothing changed" >&2; exit 1; }
  mv -f "$tmp" "$RULES"
  nft -f "$RULES"
  echo "loaded $RULES: $(covered | wc -l) user(s) may send nothing but loopback"
  unit > "/etc/systemd/system/.worklane-egress.service.tmp"; chmod 0644 "/etc/systemd/system/.worklane-egress.service.tmp"
  mv -f "/etc/systemd/system/.worklane-egress.service.tmp" "$UNIT"
  systemctl daemon-reload
  systemctl enable -q worklane-egress.service
  { [ -z "$tests" ] || echo "# --with-test-users"; covered; } > "$MARK"; chmod 0644 "$MARK"
  check_cmd
}

# PASS when the table is loaded, names every covered user, and each one's connection out is refused or never answered.
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
