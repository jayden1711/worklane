#!/usr/bin/env bash
# Add a project to this machine in one go, as root (review it first): every setup step for one instance, in order.
#
#   sudo bash scripts/setup/add-project.sh <name> <owner/repo> [--public-url https://<host>] [--client-id <id>] [--timeout <minutes>] [--replace-sudoers=<pin>]
#
# --replace-sudoers is root's alone, at a root shell: the machine helper (a coordinator's add-project) passes exactly
# the name and repo, never a flag.
#
# The steps (each skipped, as "done", when it is done already, so a rerun picks up where an earlier one stopped):
#   instance        instance.sh <name>, and the instance home as engine.sh makes it
#   app             the agent's GitHub App, through GitHub's manifest flow only (`worklane app-manifest`, through the
#                   dashboard hub: two clicks on GitHub, as a machine owner): its key, client secret and webhook
#                   secret go straight to wl-<name>'s own 0400 files, never to a URL, a log, an argument or an event.
#                   It never asks for an App made by hand; one already set up (credentials.sh) counts as done.
#                   On a machine's first project there is no hub yet: this step starts it alone first
#                   (dashboards.sh --no-instances), with the sign-in App the hub's setup mode stored
#                   (dashboards.sh --setup); without one it stops, naming that command.
#   claude-token    the agent's Claude login: the token `claude setup-token` prints, pasted at the hidden prompt of a
#                   root shell on this machine (or on root's stdin, for automation), stored for wl-<name>-agent only,
#                   never echoed or logged. With none (the machine helper, for a dashboard, gives no stdin) the step
#                   waits (exit 3) for root to install the login (credentials.sh <name> claude): a dashboard never
#                   takes a Claude credential (issue #711).
#   checkout        checkout.sh <name> <owner/repo>; a repo with no config gets auto-config's setup PR (through the App)
#   policy          the default policy, auto_merge off, $20/day, 2 workers, shown for you to change; made root's (0644,
#                   the coordinator reads it and never writes it; an earlier install's on a rerun, its content kept)
#   service         service.sh <name>, once the checkout has its config: for a setup PR, it waits (up to --timeout
#                   minutes) for the PR to merge, then brings the checkout up to it; still open then, it stops as
#                   "waiting" (exit 3), saying for what, and a rerun picks up here
#   test-user      test-user.sh install <name>, when the repo's tests.yaml has test_run
#   machine-helper  machine-helper.sh with every instance on the machine (the ones it lists now, the hub's, and this);
#                   done only while its sudoers rule is byte for byte what that writes for them. Otherwise it reruns
#                   on its own only when the installed rule is in the engine's own shape and the rerun only drops
#                   whole commands or users (it adds a user only for an instance being created: instance.sh made
#                   its coordinator, and no machine-helper.sh run has named it in the rule since).
#                   Anything else waits (exit 3), showing the difference, for root's --replace-sudoers (#898)
#   dashboards      dashboards.sh with every instance, keeping the hub's settings (its unit has them); the first
#                   project on a machine gives --client-id and --public-url instead
#
# Output: stdout is one JSON line per step change, and nothing else:
#   {"step":"checkout","state":"started|done|failed|ask|waiting","detail":"...","ask":{...},"retry":"..."}
# "ask" lines carry what the step waits for (a GitHub link to approve); a "failed" line names the
# exact retry; a "waiting" line what it waits for that only time or someone else settles (the setup PR's merge). The
# steps' own output goes to stderr. It stops at the first failure, exit 1, or at a step still waiting, exit 3.
#
# The machine helper runs this (`worklane-machine add-project <name> <owner/repo>`) for the dashboard's Add project.
source "$(dirname "$0")/lib.sh"
as_root "$@"
here="$(cd "$(dirname "$0")" && pwd)"
usage="usage: add-project.sh <name> <owner/repo> [--public-url https://<host>] [--client-id <sign-in App client id>] [--timeout <minutes>] [--replace-sudoers=<pin>]"
[ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
name="$1" repo="$2"
shift 2
public_url="" client_id="" timeout=15 replace_sudoers=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-url) public_url="${2:-}"; shift 2 ;;
    --client-id) client_id="${2:-}"; shift 2 ;;
    --timeout) timeout="${2:-}"; shift 2 ;;
    # The pin of the rule a waiting run showed (#902 round 6); a bare flag would install whatever the rule is by then.
    --replace-sudoers=*) replace_sudoers="${1#*=}"; [[ "$replace_sudoers" =~ ^[0-9a-f]{64}$ ]] || { echo "$usage" >&2; exit 2; }; shift ;;
    --replace-sudoers) echo "--replace-sudoers takes the pin of the rule you were shown: --replace-sudoers=<sha256>, as the waiting run printed it" >&2; exit 2 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
need_instance_name "$name"
repo_ok "$repo" || { echo "repo $repo: a GitHub owner/name" >&2; exit 2; }
[ -z "$public_url" ] || [[ "$public_url" =~ ^https://[a-z0-9.-]+$ ]] || { echo "--public-url: the hub's https origin" >&2; exit 2; }
[ -z "$client_id" ] || [[ "$client_id" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "--client-id: the sign-in App's client id" >&2; exit 2; }
[[ "$timeout" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--timeout: minutes, 1 to 999" >&2; exit 2; }

# stdout carries the JSON lines only: everything else goes to stderr.
exec 3>&1 1>&2

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
  # 3: the step waits for something that isn't a failure (the service: the repo's setup PR not merged yet). It stops
  # here too, as "waiting", saying what for; a rerun picks up at this step.
  if [ "$rc" -eq 3 ]; then
    why="$(sed -n 's/^waiting: //p' "$log" | tail -n 1 | cut -c1-400)"
    emit "$step" waiting "${why:-waiting}" "" "$again, once that is done (it skips the steps already done)"
    exit 3
  fi
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
# instance.sh puts a coordinator it makes on root's list of instances being created (lib.sh ADD_PROJECT_NEW, #898).
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
  # How it was made, as its setup recorded it beside the key (the manifest flow, or credentials.sh by hand).
  local how
  case "$(cat "$(dirname "$(app_key)")/made-by" 2>/dev/null || true)" in
    manifest) how="made through the manifest flow" ;;
    by-hand) how="made by hand (credentials.sh github-app)" ;;
    *) how="how it was made is not recorded" ;;
  esac
  echo "the instance's GitHub App is set up (credentials.yaml github: kind app), $how"
}
start_first_hub() {
  local signin args
  signin="$(home_of wl-dash 2>/dev/null || true)/.config/dashboard-signin"
  [ -s "$signin/client-secret" ] || { echo "no dashboard hub on this machine yet, and no sign-in App for one (the App is made through GitHub's manifest flow, which comes back to the hub): make the sign-in App first with sudo bash $here/dashboards.sh --setup --public-url https://<machine>.<tailnet>.ts.net (open the page it prints), then add the project again"; return 1; }
  args="$(dash_args)" || { echo "$args"; return 1; }
  echo "no dashboard hub on this machine yet: starting it, with no instance, for the App's manifest flow"
  # shellcheck disable=SC2086 # one word per option, none with spaces
  bash "$here/dashboards.sh" --no-instances $args
}
do_app() {
  local hub_token line rc
  hub_token="$(home_of wl-dash 2>/dev/null || true)/.local/state/worklane/dashboard-hub/dashboard-token"
  # A machine's first project: no hub yet for GitHub to send the browser back to, and the hub's own step is the last
  # one (its instance dashboard needs the checkout, which needs this App). So the hub alone starts here, with the
  # sign-in App the hub's setup mode stored (dashboards.sh --setup); the dashboards step adds the instance at the end.
  if [ ! -s "$hub_token" ] && [ ! -f "$HUB_UNIT" ]; then start_first_hub; fi
  [ -s "$hub_token" ] || { echo "no dashboard hub on this machine yet (no $hub_token): the App is made through GitHub's manifest flow, which comes back to the hub; set the hub up with dashboards.sh first, then add the project again"; return 1; }
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
alone_app() { echo "sudo $ENGINE_CLI app-manifest $name $repo"; }

# --- claude-token
done_claude_token() {
  local f
  f="$(home_of "$agent")/.claude/.credentials.json"
  [ -f "$f" ] && grep -q '"accessToken"' "$f" || return 1
  echo "$agent has a Claude login"
}
do_claude_token() {
  local token=""
  # Issue #711: the token comes only from root on this machine: the hidden prompt at a root shell, or stdin from root's
  # own automation. Never from a dashboard: the machine helper gives this script no stdin, and the coordinator writes
  # none. With none, the step waits for root to install the login, and a rerun picks up here.
  if [ -t 0 ]; then
    read -rsp "Paste the token from claude setup-token, then Enter (it is not shown): " token || true
    echo
  else
    IFS= read -r token || true
  fi
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  if [ -z "$token" ]; then
    echo "waiting: the agents' Claude login, which only root installs, on this machine: sudo bash $here/credentials.sh $name claude (it asks for the token claude setup-token prints, not shown), or sign in as $agent there (sudo -u $agent -i claude auth login)"
    exit 3
  fi
  printf '%s' "$token" | install_claude_token "$agent"
  token=""
  claude_login_ok "$agent" || { echo "claude auth status, as $agent, says it isn't signed in with that token"; return 1; }
  # What the first-run step reads (claude-account's status.json): this instance's agent users, as claude auth status
  # finds each now. Never the token: its id (a hash prefix) and whether it is signed in. A later switch rewrites it.
  bash "$here/claude-account.sh" status "$name" >/dev/null 2>&1 || true
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
  # Root's kill switch says off, whatever policy.yaml says (src/policy-kill.ts).
  if auto_merge_killed "$name"; then am="off (root's kill switch)"; fi
  # The dashboard's route is root's helper's set-policy, whose sudoers rule a sudo older than 1.9.10 leaves out (lib.sh).
  if sudo_regex_ok; then
    echo "auto_merge $am, \$${usd:-?}/day, ${w:-?} workers: change them in the dashboard's Settings (through root's helper), or as root with $ENGINE_CLI policy set $name <key> <value>; turning auto_merge on is root's alone"
  else
    echo "auto_merge $am, \$${usd:-?}/day, ${w:-?} workers: change them as root with $ENGINE_CLI policy set $name <key> <value> (this machine's sudo is older than 1.9.10, so the dashboard only turns auto_merge off, land_mode to pr and main_watch to auto)"
  fi
}
# Done only once the policy is root's (issue #726): an earlier install's, which its coordinator user could rewrite, is
# made root's on a rerun, its content kept, and its isolation and merge keys shown.
done_policy() {
  policy_root_ok "$name" "$(policy_file)" || return 1
  policy_text
}
do_policy() {
  run_as "$coord" 'umask 077; [ -f "$1" ] || printf "%s\n" "version: 1" "budget: { daily_usd: 20 }" "agents: { max_workers: 2 }" "land_mode: pr" "auto_merge: false" > "$1"' "$(policy_file)"
  own_policy "$name"
}
detail_policy() { policy_text; }

# --- service
done_service() {
  unit_active "worklane-$name.service" || return 1
  echo "worklane-$name.service is running"
}
do_service() {
  wait_for_config
  bash "$here/service.sh" "$name"
}
# One field of a JSON line, through node (no jq on a fresh server).
json_field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }
# The coordinator needs the repo's config on its checkout. A repo without one has auto-config's setup PR (the checkout
# step drafted it): wait for it to merge, up to --timeout minutes, checking every SETUP_POLL_SECONDS (auto-config
# itself, as the coordinator: it fetches the default branch and asks GitHub about the PR); once merged, bring the
# checkout up to it. Still open at the timeout: exit 3, "waiting", never a failure.
wait_for_config() {
  local line kind detail pr msg shown="" deadline
  deadline=$(( $(date +%s) + ${SETUP_WAIT_SECONDS:-$(( timeout * 60 ))} ))
  while [ ! -d "$checkout/.worklane" ]; do
    line="$(run_as "$coord" 'umask 0002; "$2" instance auto-config "$1"' "$name" "$ENGINE_CLI" || true)"
    kind="$(printf '%s' "$line" | json_field kind)"; detail="$(printf '%s' "$line" | json_field detail)"; pr="$(printf '%s' "$line" | json_field pr)"
    case "$kind" in
      merged)
        echo "the setup PR merged: bringing the checkout up to it"
        bash "$here/checkout.sh" "$name" "$repo"
        [ -d "$checkout/.worklane" ] || { echo "the config merged, but $checkout still has no .worklane/"; return 1; }
        return 0 ;;
      proposed) msg="waiting for the setup PR ${pr:-(no link)} to merge: review it, merge it, and the coordinator starts" ;;
      questions) msg="waiting for answers to the repo config's questions: $detail" ;;
      *) echo "auto-config: ${detail:-no answer}"; return 1 ;;
    esac
    if [ "$msg" != "$shown" ]; then emit service waiting "$msg"; shown="$msg"; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "waiting: $msg (still so after $timeout minutes)"; return 3; fi
    sleep "$SETUP_POLL_SECONDS"
  done
}
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
# Done only when a rerun would change nothing: the helper's bytes, this instance in its rule, and the rule byte for byte
# what machine-helper.sh writes for these instances (#898). The updater keeps the helper's bytes in step but never
# sudoers, so after an upgrade the bytes match while the rule is an older engine's (or was written for an older sudo, or
# edited). That reruns machine-helper.sh, the one writer of the rule, so the rule only ever ends up equal to its output.
# The rerun happens on its own only when it narrows (do_machine_helper).
done_machine_helper() {
  local names
  [ -f "$MACHINE_HELPER" ] && cmp -s "$MACHINE_HELPER" "$here/../machine/worklane-machine.cjs" || return 1
  helper_instances | grep -qx "$name" || return 1
  names="$(helper_names 2>/dev/null)"
  # shellcheck disable=SC2086 # one word per instance name
  machine_sudoers_current $names || return 1
  echo "the machine helper is installed, lists $coord, and its sudoers rule is what machine-helper.sh writes for $(printf '%s\n' "$names" | one_line)"
}
# The owner's rule (#898), failing closed (lib.sh sudoers_only_narrows): on its own, the rewrite only drops whole
# commands or users from a rule in the engine's own shape. The one user it may add is the coordinator of an instance
# being created: on root's list (lib.sh ADD_PROJECT_NEW) from instance.sh making its user until a machine-helper.sh run
# names it in the rule. A user named in the rule before, which root then took out say, or a hub-only instance's,
# counts as a widening.
# So does a newer engine's command, a sudo that now reads patterns, or any line outside that shape. Each waits (exit 3),
# showing the unified diff and the command with --replace-sudoers=<pin>, the pin of the rule it showed. That flag is
# root's, at a root shell: the machine helper runs this script with exactly a name and a repo.
# This check is for the step's own waiting output. The one check that counts is machine-helper.sh's, at write time,
# under its lock: this step passes it only --may-add for the one user it may add (#902 round 6), never its trust.
do_machine_helper() {
  local names n users=() allow=() rule pin rc
  names="$(helper_names)"
  for n in $names; do users+=("wl-$n"); done
  if new_instance_marked "$name"; then allow=("$coord"); fi
  rule="$(machine_sudoers "${users[@]}")"
  pin="$(sudoers_pin "$rule")"
  if [ -n "$replace_sudoers" ]; then
    # What it installs, shown before anything is written (#902 round 5), and only the rule the pin was printed for.
    sudoers_unified_diff "$MACHINE_SUDOERS" "$rule"
    if [ "$pin" != "$replace_sudoers" ]; then
      echo "the engine's rule (above) is not the one --replace-sudoers=$replace_sudoers was printed for; nothing written"
      echo "rerun as root with --replace-sudoers to install the engine's rule: $again --replace-sudoers=$pin"
      echo "waiting: rerun as root with --replace-sudoers to install the engine's rule: $again --replace-sudoers=$pin"
      exit 3
    fi
    echo "--replace-sudoers: the machine helper's rule becomes the engine's rule above"
  elif sudoers_only_narrows "$MACHINE_SUDOERS" "$rule" "${allow[@]}"; then
    sudoers_unified_diff "$MACHINE_SUDOERS" "$rule"
    if [ -e "$MACHINE_SUDOERS" ] || [ -L "$MACHINE_SUDOERS" ]; then
      echo "the machine helper's rule, for $(printf '%s\n' "$names" | one_line): it grants nothing the installed one doesn't${allow[*]:+ but ${allow[*]}}"
    else
      echo "the machine helper's first rule, for $(printf '%s\n' "$names" | one_line): this machine never had the helper set up"
    fi
  else
    sudoers_unified_diff "$MACHINE_SUDOERS" "$rule"
    echo "rerun as root with --replace-sudoers to install the engine's rule: $again --replace-sudoers=$pin"
    echo "waiting: rerun as root with --replace-sudoers to install the engine's rule: $again --replace-sudoers=$pin"
    exit 3
  fi
  rc=0
  # shellcheck disable=SC2086 # one word per instance name
  bash "$here/machine-helper.sh" ${replace_sudoers:+--replace-sudoers=$replace_sudoers} "--may-add=${allow[*]:+$name}" $names || rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "waiting: machine-helper.sh's own check refused at write time (above): the rule changed while this ran, or needs root; rerun $again"
    exit 3
  fi
  return "$rc"
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
  local id url devices
  # The machine devices: an older unit's --console-devices is the same list (#742); its --console-user is dropped.
  id="$(hub_option --client-id)"; url="$(hub_option --public-url)"; devices="$(hub_machine_devices)"
  id="${id:-$client_id}" url="${url:-$public_url}"
  # Else what the hub's setup mode stored with the sign-in App (dashboards.sh --setup), wl-dash's own files.
  local signin; signin="$(home_of wl-dash 2>/dev/null || true)/.config/dashboard-signin"
  if [ -z "$id" ] && [ -s "$signin/client-id" ]; then id="$(cat "$signin/client-id")"; fi
  if [ -z "$url" ] && [ -s "$signin/public-url" ]; then url="$(cat "$signin/public-url")"; fi
  [ -n "$id" ] && [ -n "$url" ] || { echo "no dashboard hub yet to take its settings from: make the sign-in App with dashboards.sh --setup, or give add-project.sh --client-id <sign-in App client id> --public-url https://<host> (after credentials.sh dashboard-signin)"; return 1; }
  printf '%s\n' --client-id "$id" --public-url "$url"
  [ -z "$devices" ] || printf '%s\n' --machine-devices "$devices"
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
# The rule names this instance now: it is no longer one being created (#898).
if helper_instances | grep -qx "$name"; then new_instance_clear "$name"; fi
run_step dashboards
echo "added $name ($repo)"
