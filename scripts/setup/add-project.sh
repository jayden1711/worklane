#!/usr/bin/env bash
# Add a project to this machine in one go, as root (review it first): every setup step for one instance, in order.
#
#   sudo bash scripts/setup/add-project.sh <name> <owner/repo> [--public-url https://<host>] [--client-id <id>] [--timeout <minutes>]
#
# The steps (each skipped, as "done", when it is done already, so a rerun picks up where an earlier one stopped):
#   instance        instance.sh <name>, and the instance home as engine.sh makes it
#   app             the agent's GitHub App, through the manifest flow (`worklane app-manifest`, through the dashboard
#                   hub: two clicks on GitHub, as a machine owner). credentials.sh <name> github-app stays the
#                   manual way; once it has run, this step is done.
#   claude-token    the agent's Claude login: the token `claude setup-token` prints, pasted (or on stdin), stored for
#                   wl-<name>-agent only. Never echoed or logged.
#   checkout        checkout.sh <name> <owner/repo>
#   policy          the default policy, auto_merge off, $20/day, 2 workers, shown for you to change
#   service         service.sh <name>
#   test-user       test-user.sh install <name>, when the repo's tests.yaml has test_run
#   machine-helper  machine-helper.sh with every instance on the machine (the ones it lists now, the hub's, and this)
#   dashboards      dashboards.sh with every instance, keeping the hub's settings (its unit has them); the first
#                   project on a machine gives --client-id and --public-url instead
#
# Output: stdout is one JSON line per step change, and nothing else:
#   {"step":"checkout","state":"started|done|failed|ask","detail":"...","ask":{...},"retry":"..."}
# "ask" lines carry what the step waits for (a GitHub link to approve, the Claude token); a "failed" line names the
# exact retry. The steps' own output goes to stderr. It stops at the first failure, exit 1.
#
# The machine helper runs this (`worklane-machine add-project <name> <owner/repo>`) for the dashboard's Add project.
source "$(dirname "$0")/lib.sh"
as_root "$@"
here="$(cd "$(dirname "$0")" && pwd)"
usage="usage: add-project.sh <name> <owner/repo> [--public-url https://<host>] [--client-id <sign-in App client id>] [--timeout <minutes>]"
[ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
name="$1" repo="$2"
shift 2
public_url="" client_id="" timeout=15
while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-url) public_url="${2:-}"; shift 2 ;;
    --client-id) client_id="${2:-}"; shift 2 ;;
    --timeout) timeout="${2:-}"; shift 2 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
instance_name_ok "$name" || { echo "instance name $name: lowercase letters, digits and dashes, starting with a letter, at most 21; not dash, and not ending in -agent, -eval or -work" >&2; exit 2; }
repo_ok "$repo" || { echo "repo $repo: a GitHub owner/name" >&2; exit 2; }
[ -z "$public_url" ] || [[ "$public_url" =~ ^https://[a-z0-9.-]+$ ]] || { echo "--public-url: the hub's https origin" >&2; exit 2; }
[ -z "$client_id" ] || [[ "$client_id" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "--client-id: the sign-in App's client id" >&2; exit 2; }
[[ "$timeout" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--timeout: minutes, 1 to 999" >&2; exit 2; }

# stdout carries the JSON lines only: everything else goes to stderr.
exec 3>&1 1>&2

# A JSON string: backslashes and quotes escaped, newlines as \n, other control characters dropped.
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/ }"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}
# One progress line: emit <step> <state> <detail> [<ask json>] [<retry>]
emit() {
  local line
  line="{\"step\":$(json_str "$1"),\"state\":$(json_str "$2"),\"detail\":$(json_str "$3")"
  [ -z "${4:-}" ] || line="$line,\"ask\":$4"
  [ -z "${5:-}" ] || line="$line,\"retry\":$(json_str "$5")"
  printf '%s}\n' "$line" >&3
}

coord="wl-$name" agent="wl-$name-agent"
checkout="$SRV_ROOT/$name/${repo#*/}"
again="sudo bash $here/add-project.sh $name $repo"
inst_dir() { echo "$(home_of "$coord")/.local/state/worklane/instances/$name"; }
log="$(mktemp)"; trap 'rm -f "$log"' EXIT

# run_step <step>: skipped when done_<step> succeeds (it prints what is done); otherwise do_<step> runs, with errexit,
# its output to stderr; a failure stops everything here, naming the retry (alone_<step>: the step by itself).
run_step() {
  local step="$1" fn="${1//-/_}" what rc why alone
  emit "$step" started ""
  if what="$("done_$fn" 2>/dev/null)"; then
    emit "$step" done "${what:-done already}"
    return 0
  fi
  : > "$log"
  set +e
  ( set -e; "do_$fn" ) 2>&1 | tee "$log" >&2
  rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne 0 ]; then
    why="$(grep -v '^[[:space:]]*$' "$log" | tail -n 1 | cut -c1-400)"
    alone="$("alone_$fn" 2>/dev/null || true)"
    emit "$step" failed "${why:-exit $rc}" "" "$again (it skips the steps already done)${alone:+; or this step alone: $alone}"
    exit 1
  fi
  emit "$step" done "$("detail_$fn" 2>/dev/null || echo done)"
}

# --- instance
done_instance() {
  user_exists "$coord" && user_exists "$agent" && [ -d "$SRV_ROOT/$name" ] && [ -f "$(inst_dir)/instance.yaml" ] || return 1
  echo "users $coord and $agent, $SRV_ROOT/$name and the instance home are there"
}
do_instance() {
  bash "$here/instance.sh" "$name"
  ensure_instance_home "$name" "$repo"
}
detail_instance() { done_instance; }
alone_instance() { echo "sudo bash $here/instance.sh $name"; }

# --- app
creds() { echo "$(inst_dir)/credentials.yaml"; }
app_key() { echo "$(home_of "$coord")/.config/$name-app/private-key.pem"; }
done_app() {
  [ -f "$(creds)" ] && grep -Eq '^github: *\{ *kind: *app|^  kind: *app' "$(creds)" && [ -s "$(app_key)" ] || return 1
  echo "the instance's GitHub App is set up (credentials.yaml github: kind app)"
}
do_app() {
  local hub_token line rc
  hub_token="$(home_of wl-dash 2>/dev/null || true)/.local/state/worklane/dashboard-hub/dashboard-token"
  [ -s "$hub_token" ] || { echo "no dashboard hub on this machine yet (no $hub_token): set it up with dashboards.sh, or make the App by hand: credentials.sh $name github-app <app-id> <installation-id> <key.pem> $repo"; return 1; }
  # The CLI prints each GitHub click as "ask: {json}": passed on as this step's asks; the rest is its log.
  set +e
  "$ENGINE_CLI" app-manifest "$name" "$repo" --ask-lines --timeout "$timeout" ${public_url:+--public-url "$public_url"} 2>&1 | while IFS= read -r line; do
    case "$line" in
      'ask: {'*) emit app ask "$(printf '%s' "${line#ask: }" | sed -n 's/.*"title":"\([^"]*\)".*/\1/p')" "${line#ask: }" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
  rc="${PIPESTATUS[0]}"
  set -e
  return "$rc"
}
detail_app() { done_app; }
alone_app() { echo "sudo $ENGINE_CLI app-manifest $name $repo; or by hand: sudo bash $here/credentials.sh $name github-app <app-id> <installation-id> <key.pem> $repo"; }

# --- claude-token
done_claude_token() {
  local f
  f="$(home_of "$agent")/.claude/.credentials.json"
  [ -f "$f" ] && grep -q '"accessToken"' "$f" || return 1
  echo "$agent has a Claude login"
}
do_claude_token() {
  local token="" title="The Claude login for $name's agents"
  local detail="On a machine signed in to the Claude account the agents should use, run claude setup-token and paste the token it prints. It is stored for $agent only, never shown or logged."
  emit claude-token ask "$title" "{\"kind\":\"paste_secret\",\"credential\":\"claude-token\",\"title\":$(json_str "$title"),\"detail\":$(json_str "$detail")}"
  if [ -t 0 ]; then
    read -rsp "Paste the token from claude setup-token, then Enter (it is not shown): " token || true
    echo
  else
    IFS= read -r token || true
  fi
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  [ -n "$token" ] || { echo "no token came (run claude setup-token and paste what it prints)"; return 1; }
  printf '%s' "$token" | install_claude_token "$agent"
  token=""
  claude_login_ok "$agent" || { echo "claude auth status, as $agent, says it isn't signed in with that token"; return 1; }
}
detail_claude_token() { echo "stored for $agent only"; }

# --- checkout
done_checkout() {
  [ -d "$checkout/.git" ] || return 1
  echo "$checkout is cloned"
}
do_checkout() { bash "$here/checkout.sh" "$name" "$repo"; }
detail_checkout() { done_checkout; }
alone_checkout() { echo "sudo bash $here/checkout.sh $name $repo"; }

# --- policy
policy_file() { echo "$(inst_dir)/policy.yaml"; }
policy_text() {
  local f am usd w
  f="$(policy_file)"
  am="$(sed -n 's/^auto_merge: *\([a-z]*\).*/\1/p' "$f" | head -1)"
  usd="$(sed -n 's/.*daily_usd: *\([0-9.]*\).*/\1/p' "$f" | head -1)"
  w="$(sed -n 's/.*max_workers: *\([0-9]*\).*/\1/p' "$f" | head -1)"
  [ "$am" = true ] && am=on || am=off
  echo "auto_merge $am, \$${usd:-?}/day, ${w:-?} workers: change them in the dashboard's Settings, or in $f"
}
done_policy() {
  [ -f "$(policy_file)" ] || return 1
  policy_text
}
do_policy() {
  run_as "$coord" 'umask 077; [ -f "$1" ] || printf "%s\n" "version: 1" "budget: { daily_usd: 20 }" "agents: { max_workers: 2 }" "land_mode: pr" "auto_merge: false" > "$1"' "$(policy_file)"
}
detail_policy() { policy_text; }

# --- service
done_service() {
  unit_active "worklane-$name.service" || return 1
  echo "worklane-$name.service is running"
}
do_service() { bash "$here/service.sh" "$name"; }
detail_service() { done_service; }
alone_service() { echo "sudo bash $here/service.sh $name"; }

# --- test-user
wants_test_run() { [ -f "$checkout/.worklane/tests.yaml" ] && grep -Eq '^test_run:' "$checkout/.worklane/tests.yaml"; }
done_test_user() {
  if ! wants_test_run; then echo "not needed: the repo's tests.yaml has no test_run"; return 0; fi
  user_exists "wl-test-$name" && unit_active "worklane-test-$name-docker.service" || return 1
  echo "wl-test-$name and its sandbox are in place"
}
do_test_user() { bash "$here/test-user.sh" install "$name"; }
detail_test_user() { done_test_user; }
alone_test_user() { echo "sudo bash $here/test-user.sh install $name"; }

# --- machine-helper and dashboards: with every instance on the machine, so a rerun drops none
all_instances() { { helper_instances; hub_instances; echo "$name"; } | grep -E '^[a-z][a-z0-9-]{0,20}$' | sort -u; }
helper_names() {
  local n
  for n in $(all_instances); do
    if user_exists "wl-$n"; then echo "$n"; else echo "note: $n is named, but there is no wl-$n; left out" >&2; fi
  done
}
one_line() { tr '\n' ' ' | sed 's/ $//'; }
done_machine_helper() {
  [ -f "$MACHINE_HELPER" ] && cmp -s "$MACHINE_HELPER" "$here/../machine/worklane-machine.cjs" || return 1
  helper_instances | grep -qx "$name" || return 1
  echo "the machine helper is installed and lists $coord"
}
do_machine_helper() {
  # shellcheck disable=SC2046 # one word per instance name
  bash "$here/machine-helper.sh" $(helper_names)
}
detail_machine_helper() { echo "the machine helper lists $(helper_names 2>/dev/null | one_line)"; }
alone_machine_helper() { echo "sudo bash $here/machine-helper.sh $(helper_names 2>/dev/null | one_line)"; }

state_of() { echo "$(home_of "wl-$1")/.local/state/worklane/instances/$1/state"; }
dash_names() {
  local n
  for n in $(all_instances); do
    if [ -d "$(state_of "$n")" ]; then echo "$n"; else echo "note: $n has no instance state at $(state_of "$n"); left out of the dashboards" >&2; fi
  done
}
# The hub's settings, from its unit (or this run's --client-id and --public-url for a machine's first hub), one word a line.
dash_args() {
  local id url user devices
  id="$(hub_option --client-id)"; url="$(hub_option --public-url)"; user="$(hub_option --console-user)"; devices="$(hub_option --console-devices)"
  id="${id:-$client_id}" url="${url:-$public_url}"
  [ -n "$id" ] && [ -n "$url" ] || { echo "no dashboard hub yet to take its settings from: give add-project.sh --client-id <sign-in App client id> --public-url https://<host> (after credentials.sh dashboard-signin)"; return 1; }
  printf '%s\n' --client-id "$id" --public-url "$url"
  [ -z "$user" ] || printf '%s\n' --console-user "$user"
  [ -z "$devices" ] || printf '%s\n' --console-devices "$devices"
}
done_dashboards() {
  hub_instances | grep -qx "$name" && unit_active "worklane-dashboard-$name.service" || return 1
  echo "the hub serves $name"
}
do_dashboards() {
  local args
  args="$(dash_args)" || { echo "$args"; return 1; }
  # shellcheck disable=SC2046,SC2086 # one word per option and instance name, none with spaces
  bash "$here/dashboards.sh" $args $(dash_names)
}
detail_dashboards() { echo "the hub serves $(dash_names 2>/dev/null | one_line)"; }
alone_dashboards() { echo "sudo bash $here/dashboards.sh $(dash_args 2>/dev/null | one_line) $(dash_names 2>/dev/null | one_line)"; }

# One add-project at a time on a machine: they rewrite the same machine-wide rules.
if command -v flock >/dev/null 2>&1; then
  exec 9> "$ADD_PROJECT_LOCK"
  flock -n 9 || { emit instance failed "another add-project is running on this machine; wait for it to finish" "" "$again"; exit 1; }
fi

# An instance by this name for another repo is another project: never reuse it.
if [ -f "$(inst_dir)/instance.yaml" ] && ! grep -Eq "^ *repo: *$repo *$" "$(inst_dir)/instance.yaml"; then
  emit instance failed "instance $name already exists for another repo ($(sed -n 's/^ *repo: *//p' "$(inst_dir)/instance.yaml" | head -1)); choose another name" "" "sudo bash $here/add-project.sh <another name> $repo"
  exit 1
fi

run_step instance
run_step app
run_step claude-token
run_step checkout
run_step policy
run_step service
run_step test-user
run_step machine-helper
run_step dashboards
echo "added $name ($repo)"
