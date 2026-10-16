#!/usr/bin/env bash
# As root, per machine: which tiers of which instances' test runs may have the network (docs/test-runs.md "Network").
# None unless this is run.
#
#   bash scripts/setup/testrun-network.sh status
#   bash scripts/setup/testrun-network.sh enable <name> --tiers <tier>[,<tier>...]
#   bash scripts/setup/testrun-network.sh disable <name>
#
# Writes /etc/worklane/testrun-network.json, root:root 0644: the one place the sandbox helper
# (/usr/local/libexec/worklane-testrun) reads whether a command may have the network. enable sets the instance's whole
# list (it replaces the one before). A tier still has to ask (tests.yaml test_run, `network: true`; the setup steps
# with `setup_network: true`, as the tier "setup"); the helper grants the network only to a tier this file lists for
# that instance, and then only public addresses and the machine's DNS (never the LAN, link-local or multicast).
# Nothing the coordinator, the dashboard or a repo can write changes it.
#
# WHY a separate file, never policy.yaml: the dashboard writes policy.yaml's settings, and this decides what a
# sandboxed run can reach. WHY none by default: a run's commands are the PR's code; with the network they can send
# anything they can read (the repo, the run's database) anywhere, or reach what the machine can.
source "$(dirname "$0")/lib.sh"

NET_FILE=/etc/worklane/testrun-network.json
usage="usage: testrun-network.sh status | enable <name> --tiers <tier>[,<tier>...] | disable <name>"

cmd="${1:-}"
[ -n "$cmd" ] || { echo "$usage" >&2; exit 2; }
shift
name="" tiers=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tiers) tiers="${2:?--tiers needs tier names, e.g. e2e or setup,e2e}"; shift 2 ;;
    -*) echo "unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "$usage" >&2; exit 2; }; name="$1"; shift ;;
  esac
done
case "$cmd" in
  status) [ -z "$name$tiers" ] || { echo "$usage" >&2; exit 2; } ;;
  enable)
    instance_name_ok "$name" || { echo "not an instance name: ${name:-(none)}" >&2; exit 2; }
    [ -n "$tiers" ] || { echo "enable needs --tiers" >&2; echo "$usage" >&2; exit 2; }
    [[ "$tiers" =~ ^[a-z][a-z0-9_-]{0,39}(,[a-z][a-z0-9_-]{0,39}){0,31}$ ]] || { echo "--tiers: tier names (lowercase letters, digits, _ or -, at most 40 each; at most 32), comma-separated, got $tiers" >&2; exit 2; }
    ;;
  disable) instance_name_ok "$name" && [ -z "$tiers" ] || { echo "$usage" >&2; exit 2; } ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
as_root "$cmd" ${name:+"$name"} ${tiers:+--tiers "$tiers"}

# The file as it is: NAMES[i] has TIERS[i] (", "-separated, each quoted). Exactly the form written below (the helper
# reads only that); anything else stops here, changing nothing.
NAMES=() TIERS=()
read_file() {
  local lines=() l n i
  [ -e "$NET_FILE" ] || return 0
  [ -f "$NET_FILE" ] && [ ! -L "$NET_FILE" ] || { echo "$NET_FILE is not a regular file; remove it, then run this again" >&2; exit 1; }
  while IFS= read -r l || [ -n "$l" ]; do lines+=("$l"); done < "$NET_FILE"
  n="${#lines[@]}"
  local bad="$NET_FILE is not in the form this script writes; remove it (sudo rm $NET_FILE), then run this again"
  [ "$n" -ge 4 ] && [ "${lines[0]}" = '{' ] && [ "${lines[1]}" = '  "version": 1,' ] && [ "${lines[$((n - 1))]}" = '}' ] || { echo "$bad" >&2; exit 1; }
  if [ "$n" -eq 4 ]; then [ "${lines[2]}" = '  "instances": {}' ] || { echo "$bad" >&2; exit 1; }; return 0; fi
  [ "${lines[2]}" = '  "instances": {' ] && [ "${lines[$((n - 2))]}" = '  }' ] || { echo "$bad" >&2; exit 1; }
  for ((i = 3; i < n - 2; i++)); do
    [[ "${lines[$i]}" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,20})\":\ \{\ \"tiers\":\ \[(\"[a-z][a-z0-9_-]{0,39}\"(,\ \"[a-z][a-z0-9_-]{0,39}\"){0,31})\]\ \}(,?)$ ]] || { echo "$bad" >&2; exit 1; }
    NAMES+=("${BASH_REMATCH[1]}"); TIERS+=("${BASH_REMATCH[2]}")
  done
}

# The file's text: one instance a line, sorted by name; the helper and src/testrun/network.ts read exactly this.
file_text() {
  local i n="${#NAMES[@]}" order k=0
  printf '{\n  "version": 1,\n'
  if [ "$n" -eq 0 ]; then printf '  "instances": {}\n}\n'; return 0; fi
  printf '  "instances": {\n'
  order="$(for i in "${!NAMES[@]}"; do printf '%s %s\n' "${NAMES[$i]}" "$i"; done | sort | cut -d' ' -f2)"
  for i in $order; do
    k=$((k + 1))
    printf '    "%s": { "tiers": [%s] }%s\n' "${NAMES[$i]}" "${TIERS[$i]}" "$([ "$k" -lt "$n" ] && echo , || true)"
  done
  printf '  }\n}\n'
}

show() {
  local i
  if [ ! -e "$NET_FILE" ]; then echo "Test-run network: none for any tier on this machine (no $NET_FILE)"; return 0; fi
  if [ "${#NAMES[@]}" -eq 0 ]; then echo "Test-run network: none for any tier"; return 0; fi
  echo "Test-run network: granted to these tiers only (public addresses and the machine's DNS; never the LAN):"
  for i in "${!NAMES[@]}"; do echo "  ${NAMES[$i]}: ${TIERS[$i]//\"/}"; done
}

remove() {
  local keep_n=() keep_t=() i
  for i in "${!NAMES[@]}"; do [ "${NAMES[$i]}" = "$1" ] || { keep_n+=("${NAMES[$i]}"); keep_t+=("${TIERS[$i]}"); }; done
  NAMES=(${keep_n[@]+"${keep_n[@]}"}); TIERS=(${keep_t[@]+"${keep_t[@]}"})
}

read_file
case "$cmd" in
  status) show; exit 0 ;;
  enable)
    id -u "wl-test-$name" >/dev/null 2>&1 || { echo "no test user wl-test-$name: set up $name's test runs first (scripts/setup/test-user.sh install $name)" >&2; exit 1; }
    want="$(printf '%s' "$tiers" | tr ',' '\n' | sort -u | sed 's/.*/"&"/' | paste -sd, - | sed 's/,/, /g')"
    remove "$name"
    NAMES+=("$name"); TIERS+=("$want")
    say "Test-run network for $name: tiers ${want//\"/} (public addresses and the machine's DNS only)"
    echo "These tiers run the PR's code with the network: it can send what the run can read anywhere it can reach."
    ;;
  disable)
    remove "$name"
    say "Test-run network off for every tier of $name"
    ;;
esac

# Made only when missing (scripts/setup/machine.sh makes it): an existing one keeps its mode and ACLs (test-user.sh
# denies each test user /etc/worklane by an ACL entry).
[ -d "$(dirname "$NET_FILE")" ] || install -d -o root -g root -m 0755 "$(dirname "$NET_FILE")"
file_text | put_file root root 0644 "$NET_FILE"
echo "wrote $NET_FILE"
show
