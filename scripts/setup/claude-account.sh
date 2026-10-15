#!/usr/bin/env bash
# Switch every agent on this machine to another Claude account, or see which account each one has. As root
# (review it first).
#
#   sudo bash scripts/setup/claude-account.sh switch [--timeout <minutes>] [--json] [<instance>...]
#   sudo bash scripts/setup/claude-account.sh status [--json] [<instance>...]
#   sudo bash scripts/setup/claude-account.sh profile-add <profile> [--json]
#   sudo bash scripts/setup/claude-account.sh use <profile> [<instance>] [--json]
#   sudo bash scripts/setup/claude-account.sh remove <profile> [--json]
#   sudo bash scripts/setup/claude-account.sh failover <profile+profile+...|off> back|stay [<instance>]
#
# switch, for every instance on the machine (the machine helper's and the dashboard hub's), or the ones named:
#   pause    each instance's coordinator is asked to stop starting runs (SIGTERM to its main process: the runs it has
#            going finish, then it exits). An instance that wasn't running is left as it is, and left stopped after.
#   token    the token `claude setup-token` prints, pasted once (not shown) or on stdin. From the dashboard, a machine
#            owner pastes it in the asking instance's dashboard instead (--token-from, which the machine helper passes).
#   wait     until each paused instance's runs have finished, or --timeout (30 minutes): then it is stopped, and the
#            runs still going are requeued when it starts again.
#   install  the token, for every agent user of every instance (its agent user, and its eval user if it has one;
#            channel chat runs as the agent user), in that user's own ~/.claude/.credentials.json, 0600. Never echoed,
#            never an argument, never in a log.
#   check    `claude auth status`, as each of those users, and one minimal real call to the API as each of them (the
#            cheapest model, a one-word answer, one turn, a hard budget cap: issue #463, where a login claude auth
#            status called fine was refused by the API with a 401 on every run). If the API refuses the new login
#            for any user, the switch is refused: every agent user is put back on the login it had before (its
#            credentials file as it was), Claude's message is shown, and the instances resume on their old login.
#   resume   each instance it paused whose users all passed is started again. One whose check failed is not: it stays
#            stopped, named, until a rerun passes. Safe to rerun: it remembers the instances it paused.
# Without a token (none pasted, or not one from claude setup-token) nothing is installed: each paused instance is
# checked on its current login (claude auth status and the real call) and resumed if that passes.
#
# status: each agent user's account (as claude auth status names it), whether it is signed in, whether the API takes
# the login (one minimal real call as that user, for each one signed in), which token (the first 8 hex digits of its
# sha256: the same login shows the same id) and when that expires. With instances named (add-project
# and credentials.sh name theirs once its token is in, before the machine helper lists it), only their records are
# found again; status.json keeps every other instance's as it was.
#
# Account profiles (issue #464): several Claude accounts side by side for each instance's agent user, each in its own
# CLAUDE_CONFIG_DIR, <agent home>/.claude-profiles/<profile> (0700, that user's own). The agent user's login as it was
# (~/.claude, or instance.yaml's claude_config_dir) is the profile named default. Which profile each instance's runs
# use is profiles.json's "active" (root's, 0644: names, accounts and check results, never a token); the engine reads
# it when each run starts, so a switch needs no pause and a run already going finishes on the login it started on.
#   profile-add  a token from `claude setup-token` (stdin, or the asking instance's dashboard: --token-from), installed
#                as every agent user in that profile's dir, then one minimal real call as each user on it. If the API
#                refuses it for any user, nothing is kept: every user's new profile dir is removed.
#   use          one minimal real call as each agent user (of the instance named, or every instance) on that profile;
#                only when every one is answered does profiles.json name it active for them. Otherwise nothing
#                changes: the previous profile stays active. `use default` goes back to the login each user had.
#   remove       each agent user's dir of that profile, removed as that user (never as root: the dir is the user's);
#                refused while any instance has it active.
#   failover     auto-failover on a usage limit (off by default): the order of profiles to move through, and whether
#                to move back once the limit resets (back) or not (stay); machine-wide, or for one instance (which
#                then goes by its own, off included). Only written to profiles.json: the coordinator moves, each move a
#                `use`, so each is proven by a real call first. Never on an auth failure (issue #463 holds those).
# Every file step under an agent user's home is done as that user. Each step is a JSON line in profile-ops.jsonl.
#
# Output: plain lines, or with --json one JSON line per step change (switch) or one JSON object (status). Either way
# the switch's lines go to $CLAUDE_ACCOUNT_DIR/switch.jsonl and what status found to status.json, root's 0644, for the
# dashboard. Exit 0 when every instance it paused was resumed (switch) or every user is signed in (status).
source "$(dirname "$0")/lib.sh"
as_root "$@"
here="$(cd "$(dirname "$0")" && pwd)"
usage="usage: claude-account.sh switch [--timeout <minutes>] [--json] [<instance>...] | status [--json] [<instance>...] | profile-add <profile> [--token-from <instance>] [--json] | use <profile> [<instance>] [--for <instance>] [--json] | remove <profile> [--for <instance>] [--json] | failover <profile+profile+...|off> back|stay [<instance>]"
# Root's tools wherever this is started from (sudo, a systemd unit): sbin included.
PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
: "${MINUTE:=60}" "${SWITCH_POLL:=5}"

cmd="${1:-}"
[ "$#" -ge 1 ] && shift
timeout=30 token_timeout=30 token_from="" for_inst="" json="" names=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --timeout) timeout="${2:-}"; shift 2 ;;
    --token-timeout) token_timeout="${2:-}"; shift 2 ;;
    --token-from) token_from="${2:-}"; shift 2 ;;
    --for) for_inst="${2:-}"; shift 2 ;;
    --json) json=1; shift ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) names+=("$1"); shift ;;
  esac
done
case "$cmd" in switch | status | profile-add | use | remove | failover) ;; *) echo "$usage" >&2; exit 2 ;; esac
if [ "$cmd" = failover ]; then
  order="${names[0]:-}" back="${names[1]:-}" inst="${names[2]:-}"
  [ "${#names[@]}" -le 3 ] && [[ "$back" == back || "$back" == stay ]] || { echo "$usage" >&2; exit 2; }
  [ -z "$inst" ] || instance_name_ok "$inst" || { echo "instance name $inst: lowercase letters, digits and dashes" >&2; exit 2; }
  if [ "$order" != off ]; then
    [[ "$order" =~ ^[a-z][a-z0-9-]{0,20}(\+[a-z][a-z0-9-]{0,20}){1,7}$ ]] || { echo "failover: an order of 2 to 8 profiles, joined by + (or off)" >&2; exit 2; }
  fi
  install -d -m 0755 "$CLAUDE_ACCOUNT_DIR"
  "$(command -v node)" -e '
const fs = require("node:fs");
const [file, order, back, inst] = process.argv.slice(1);
let p = {};
try { p = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
p.version = 1;
p.profiles = p.profiles && typeof p.profiles === "object" ? p.profiles : {};
const list = order === "off" ? [] : order.split("+");
if (new Set(list).size !== list.length) { console.error("failover: a profile named twice in the order"); process.exit(2); }
const missing = list.filter((n) => n !== "default" && !(p.profiles[n] && p.profiles[n].kind !== "existing"));
if (missing.length) { console.error(`failover: no profile ${missing.join(", ")} on this machine: add it first`); process.exit(1); }
const f = (p.failover = p.failover && typeof p.failover === "object" ? p.failover : {});
const v = { order: list, back: back === "back" };
if (inst) (f.instances = f.instances && typeof f.instances === "object" ? f.instances : {})[inst] = v;
else f.machine = v;
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(p) + "\n", { mode: 0o644 });
fs.chmodSync(tmp, 0o644);
fs.renameSync(tmp, file);
console.log(list.length ? `failover ${inst ? `for ${inst}` : "machine-wide"}: ${list.join(" > ")}, ${back === "back" ? "moving back after the reset" : "staying after the reset"}` : `failover off ${inst ? `for ${inst}` : "machine-wide"}`);
' "$CLAUDE_ACCOUNT_DIR/profiles.json" "$order" "$back" "$inst"
  exit $?
fi
# A profile's name: lowercase letters, digits and dashes (default: the login each agent user had, never added or removed).
profile=""
if [[ "$cmd" == profile-add || "$cmd" == use || "$cmd" == remove ]]; then
  profile="${names[0]:-}"
  names=(${names[@]+"${names[@]:1}"})
  [[ "$profile" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "a profile's name: lowercase letters, digits and dashes, starting with a letter, at most 21" >&2; exit 2; }
  if [ "$cmd" != use ] && [ "$profile" = default ]; then echo "default is the login each agent user already has: it can't be added or removed" >&2; exit 2; fi
  if [ "$cmd" = use ]; then [ "${#names[@]}" -le 1 ] || { echo "$usage" >&2; exit 2; }; else [ "${#names[@]}" -eq 0 ] || { echo "$usage" >&2; exit 2; }; fi
fi
[ -z "$for_inst" ] || instance_name_ok "$for_inst" || { echo "--for: an instance name" >&2; exit 2; }
[[ "$timeout" =~ ^[0-9]{1,3}$ ]] || { echo "--timeout: minutes, 0 to 999" >&2; exit 2; }
[[ "$token_timeout" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--token-timeout: minutes, 1 to 999" >&2; exit 2; }
[ -z "$token_from" ] || instance_name_ok "$token_from" || { echo "--token-from: an instance name" >&2; exit 2; }
for n in ${names[@]+"${names[@]}"}; do instance_name_ok "$n" || { echo "instance name $n: lowercase letters, digits and dashes" >&2; exit 2; }; done

# --- the instances and their agent users

inst_file() { echo "$(home_of "wl-$1")/.local/state/worklane/instances/$1/instance.yaml"; }
# Every instance on the machine (as add-project.sh counts them: the machine helper's rule and the hub), or the ones
# named; each must have its coordinator user.
instances() {
  local n
  if [ "${#names[@]}" -gt 0 ]; then printf '%s\n' "${names[@]}"; else { helper_instances; hub_instances; } | sort -u; fi | while read -r n; do
    instance_name_ok "$n" || continue
    if user_exists "wl-$n"; then echo "$n"; else echo "note: $n is named, but there is no wl-$n; left out" >&2; fi
  done
}
# One value of instance.yaml's run_as (two-space indent, as the engine writes it), quotes taken off.
run_as_value() {
  local f
  f="$(inst_file "$1")"
  [ -f "$f" ] || return 0
  sed -n "s/^  $2: *//p" "$f" | head -1 | tr -d "\"'" | sed 's/[[:space:]]*$//'
}
# "<kind> <user> <claude config dir>" for each agent user of an instance: its agent user, then its eval user.
users_of() {
  local n="$1" agent ev cfg
  agent="$(run_as_value "$n" agent_user)"; agent="${agent:-wl-$n-agent}"
  cfg="$(run_as_value "$n" claude_config_dir)"
  [[ -z "$cfg" || "$cfg" =~ ^/[A-Za-z0-9._/-]+$ ]] || cfg=""
  [[ "$agent" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && user_exists "$agent" && echo "agent $agent ${cfg:-$(home_of "$agent")/.claude}"
  ev="$(run_as_value "$n" eval_user)"; ev="${ev:-wl-$n-eval}"
  if [[ "$ev" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && user_exists "$ev"; then echo "eval $ev $(home_of "$ev")/.claude"; fi
  return 0
}

# One user's record: its stored login (read as root: which token, by id; when it expires) and claude auth status as
# that user. Never the token itself.
account_record() { # <instance> <kind> <user> <credentials file> <claude auth status output> [<the real call: ok, or Claude's message>]
  "$(command -v node)" -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const [instance, kind, user, file, auth, api = ""] = process.argv.slice(1);
const r = { instance, kind, user, stored: false, logged_in: false, auth_method: null, account: null, org: null, subscription: null, token_id: null, expires_at: null, installed_at: null, error: null, api_ok: null, api_error: null };
try {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "NOTFILE" });
  const o = (JSON.parse(fs.readFileSync(file, "utf8")) || {}).claudeAiOauth;
  if (o && typeof o.accessToken === "string" && o.accessToken) {
    r.stored = true;
    r.token_id = crypto.createHash("sha256").update(o.accessToken).digest("hex").slice(0, 8);
    if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)) r.expires_at = new Date(o.expiresAt).toISOString();
    r.installed_at = st.mtime.toISOString();
  }
} catch (e) {
  r.error = e.code === "ENOENT" ? "no Claude login stored" : "its Claude credentials file can not be read";
}
let a = null;
try {
  a = JSON.parse(auth);
} catch {}
if (!a || typeof a !== "object") r.error = r.error || (auth.trim() ? "claude auth status did not answer in JSON" : "claude auth status gave no answer (is claude installed?)");
else {
  r.logged_in = a.loggedIn === true;
  for (const [k, from] of [["auth_method", "authMethod"], ["account", "email"], ["org", "orgName"], ["subscription", "subscriptionType"]]) if (typeof a[from] === "string") r[k] = a[from].slice(0, 200);
  if (!r.logged_in) r.error = r.error || "claude auth status says it is not logged in";
}
// The real call (#463), when one was made: whether the API took the login, and what Claude said when it did not.
if (api) {
  r.api_ok = api === "ok";
  if (!r.api_ok) {
    r.api_error = api.slice(0, 500);
    r.error = r.error || `the API refused the login: ${r.api_error}`;
  }
}
process.stdout.write(JSON.stringify(r));
' "$@"
}
# The real call as this user, as account_record takes it: ok, or Claude's message.
api_result() { local said; if said="$(claude_api_check "$1" "${2:-}")"; then echo ok; else echo "${said:-the API call failed}"; fi; }
# Every agent user's record, as a JSON array; written to status.json (root's, 0644) for the dashboard. With `api`, each
# user claude auth status calls signed in is also checked with one minimal real call (a switch's end has just made it).
collect_status() {
  local n kind user cfg recs="" rec auth api
  for n in $(instances); do
    while read -r kind user cfg; do
      [ -n "$user" ] || continue
      auth="$(claude_status_json "$user")" api=""
      if [ "${1:-}" = api ] && printf '%s' "$auth" | grep -q '"loggedIn": *true'; then api="$(api_result "$user")"; fi
      rec="$(account_record "$n" "$kind" "$user" "$cfg/.credentials.json" "$auth" "$api")"
      recs="${recs:+$recs,}$rec"
    done < <(users_of "$n")
  done
  printf '[%s]' "$recs"
}
write_file() { # <name> <content>: into CLAUDE_ACCOUNT_DIR, root's 0644, by a rename
  install -d -m 0755 "$CLAUDE_ACCOUNT_DIR"
  printf '%s\n' "$2" > "$CLAUDE_ACCOUNT_DIR/.$1.tmp"
  chmod 0644 "$CLAUDE_ACCOUNT_DIR/.$1.tmp"
  mv -f "$CLAUDE_ACCOUNT_DIR/.$1.tmp" "$CLAUDE_ACCOUNT_DIR/$1"
}
save_status() { write_file status.json "{\"at\":$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"users\":$1}"; }
# status.json with these instances' records replaced by the ones given (a JSON array), every other record kept.
merge_status() { # <records json> <instance>...
  local recs="$1"
  shift
  "$(command -v node)" -e '
const fs = require("node:fs");
const [file, fresh, ...named] = process.argv.slice(1);
let old = [];
try {
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(o.users)) old = o.users;
} catch {}
process.stdout.write(JSON.stringify([...old.filter((u) => !u || !named.includes(u.instance)), ...JSON.parse(fresh)]));
' "$CLAUDE_ACCOUNT_DIR/status.json" "$recs" "$@"
}
show_status() { # <records json>: one line per user
  "$(command -v node)" -e '
const rows = JSON.parse(process.argv[1]);
if (!rows.length) console.log("no agent users found (no instances on this machine, or none named)");
for (const r of rows) {
  const who = r.account ? `${r.account}${r.org ? ` (${r.org})` : ""}` : r.auth_method || "-";
  const until = r.expires_at ? r.expires_at.slice(0, 10) : "-";
  console.log(`${r.instance.padEnd(14)} ${r.user.padEnd(24)} ${(r.logged_in ? "signed in" : "NOT signed in").padEnd(14)} ${who.padEnd(32)} token ${r.token_id || "-"}  expires ${until}${r.error ? `  (${r.error})` : ""}`);
}
' "$1"
}

if [ "$cmd" = status ]; then
  recs="$(collect_status api)"
  if [ "${#names[@]}" -gt 0 ]; then save_status "$(merge_status "$recs" "${names[@]}")"; else save_status "$recs"; fi
  if [ -n "$json" ]; then printf '{"users":%s}\n' "$recs"; else show_status "$recs"; fi
  # Exit 1 when any user isn't signed in, or the API refused its login.
  if printf '%s' "$recs" | grep -q '"logged_in":false\|"api_ok":false'; then exit 1; fi
  exit 0
fi

# --- account profiles (issue #464)

if [ -n "$profile" ]; then
  exec 3>&1
  [ -z "$json" ] || exec 1>&2
  install -d -m 0755 "$CLAUDE_ACCOUNT_DIR"
  ops="$CLAUDE_ACCOUNT_DIR/profile-ops.jsonl" pfile="$CLAUDE_ACCOUNT_DIR/profiles.json"
  op_id="op-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  # One progress line: pemit <step> <state> <instance or ""> <user or ""> <detail> [<"from": JSON object>]. To
  # profile-ops.jsonl, and to stdout: JSON with --json, else as text.
  pemit() {
    local line
    line="{\"at\":$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"id\":$(json_str "$op_id"),\"op\":$(json_str "$cmd"),\"profile\":$(json_str "$profile"),\"step\":$(json_str "$1"),\"state\":$(json_str "$2")"
    [ -z "$3" ] || line="$line,\"instance\":$(json_str "$3")"
    [ -z "$4" ] || line="$line,\"user\":$(json_str "$4")"
    [ -z "$for_inst$token_from" ] || line="$line,\"for\":$(json_str "${for_inst:-$token_from}")"
    [ -z "${6:-}" ] || line="$line,\"from\":$6"
    line="$line,\"detail\":$(json_str "$5")}"
    printf '%s\n' "$line" >> "$ops"
    chmod 0644 "$ops"
    if [ -n "$json" ]; then printf '%s\n' "$line" >&3; else printf '%-8s %-8s %-14s %s\n' "$1" "$2" "${3:--}" "$5${4:+ ($4)}" >&3; fi
  }
  # profiles.json, read and written whole by node (root's, 0644, by a rename): pedit <action> <args...>
  #   add <kind> <records>       this profile, with each user's check record (a JSON array)
  #   checked <records>          each user's latest check on this profile
  #   use <at> <instance>...     this profile active for these instances (default: the entry taken out)
  #   remove                     this profile's entry
  #   users-of                   prints the instances that have this profile active, one a line
  #   has                        exits 0 when this profile has been added
  #   active-json <instance>...  prints each one's active profile, as a JSON object
  pedit() {
    "$(command -v node)" -e '
const fs = require("node:fs");
const [file, profile, action, ...a] = process.argv.slice(1);
let p = {};
try { p = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
p.version = 1;
p.profiles = p.profiles && typeof p.profiles === "object" ? p.profiles : {};
p.active = p.active && typeof p.active === "object" ? p.active : {};
const recs = (s) => Object.fromEntries(JSON.parse(s).map((r) => [r.user, r]));
if (action === "active-json") {
  process.stdout.write(JSON.stringify(Object.fromEntries(a.map((i) => [i, (p.active[i] && p.active[i].profile) || "default"]))));
  process.exit(0);
}
if (action === "has") process.exit(p.profiles[profile] && p.profiles[profile].kind !== "existing" ? 0 : 1);
if (action === "users-of") {
  for (const [i, x] of Object.entries(p.active)) if (x && x.profile === profile) console.log(i);
  process.exit(0);
}
if (action === "add") p.profiles[profile] = { kind: a[0], added_at: new Date().toISOString(), users: recs(a[1]) };
else if (action === "checked") {
  const e = (p.profiles[profile] ||= { kind: profile === "default" ? "existing" : "unknown", added_at: null, users: {} });
  Object.assign((e.users ||= {}), recs(a[0]));
} else if (action === "use") {
  for (const i of a.slice(1)) {
    if (profile === "default") delete p.active[i];
    else p.active[i] = { profile, since: a[0] };
  }
  p.switched_at = { ...(p.switched_at || {}), ...Object.fromEntries(a.slice(1).map((i) => [i, a[0]])) };
} else if (action === "remove") delete p.profiles[profile];
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(p) + "\n", { mode: 0o644 });
fs.chmodSync(tmp, 0o644);
fs.renameSync(tmp, file);
' "$pfile" "$profile" "$@"
  }
  # The agent user of each instance (never the eval user: its lane keeps its own login), as "<instance> <user> <default dir>".
  agents() {
    local n kind user cfg
    for n in $(instances); do
      while read -r kind user cfg; do
        [ "$kind" = agent ] && [ -n "$user" ] && echo "$n $user $cfg"
      done < <(users_of "$n")
    done
    return 0
  }
  # This profile's dir for a user (default: the dir its login was always in).
  pdir() { if [ "$profile" = default ]; then echo "$2"; else echo "$(home_of "$1")/.claude-profiles/$profile"; fi; }
  # One user's check on this profile: claude auth status and one minimal real call, both on that dir, as that user.
  # Prints the record (account and plan as Claude names them, whether the API answered, Claude's words when it didn't).
  pcheck() { # <instance> <user> <dir>
    local auth api=""
    auth="$(claude_status_json "$2" "$3")"
    if printf '%s' "$auth" | grep -q '"loggedIn": *true'; then api="$(api_result "$2" "$3")"; else api="claude auth status says it is not signed in on this profile"; fi
    "$(command -v node)" -e '
const [instance, user, auth, api] = process.argv.slice(1);
let a = {};
try { a = JSON.parse(auth) || {}; } catch {}
const s = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
process.stdout.write(JSON.stringify({ instance, user, account: s(a.email), org: s(a.orgName), subscription: s(a.subscriptionType), auth_method: s(a.authMethod), api_ok: api === "ok", api_error: api === "ok" ? null : api.slice(0, 500), checked_at: new Date().toISOString() }));
' "$1" "$2" "$auth" "$api"
  }
  if command -v flock >/dev/null 2>&1; then
    install -d -m 0755 "$(dirname "$CLAUDE_ACCOUNT_LOCK")"
    exec 9> "$CLAUDE_ACCOUNT_LOCK"
    flock -n 9 || { echo "another Claude account switch or profile change is running on this machine; wait for it to finish" >&2; exit 1; }
  fi
  rows=()
  while read -r n user cfg; do rows+=("$n $user $cfg"); done < <(agents)
  pemit "$cmd" started "" "" "profile $profile, ${#rows[@]} agent user(s)${for_inst:+, asked from the dashboard of $for_inst}${token_from:+, the token from the dashboard of $token_from}"
  [ "${#rows[@]}" -gt 0 ] || { pemit "$cmd" failed "" "" "no agent users found (no instances on this machine, or none of those named)"; exit 1; }

  if [ "$cmd" = profile-add ]; then
    if pedit has; then pemit profile-add failed "" "" "there is a profile $profile already: remove it first, or add this one under another name"; exit 1; fi
    # The token: on stdin, or from the asking instance's dashboard, which stored it before it asked (read once, deleted).
    token=""
    if [ -n "$token_from" ]; then
      f="$(home_of "wl-$token_from")/.config/$token_from-secrets/$CLAUDE_PROFILE_CREDENTIAL"
      if [ -e "$f" ]; then
        if file_owned_by "$f" "wl-$token_from"; then IFS= read -r token < "$f" || true; fi
        rm -f "$f"
      fi
    elif [ -t 0 ]; then
      read -rsp "Paste the token from claude setup-token for profile $profile, then Enter (it is not shown): " token || true
      echo >&2
    else
      IFS= read -r token || true
    fi
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    if ! claude_token_ok "$token"; then
      token=""
      pemit profile-add failed "" "" "no token from claude setup-token (sk-ant-oat01-...) came: nothing added"
      exit 1
    fi
    pemit token done "" "" "received; stored nowhere but each agent user's own profile dir"
    recs="" bad="" added=()
    for row in "${rows[@]}"; do
      read -r n user cfg <<< "$row"
      d="$(pdir "$user" "$cfg")"
      if printf '%s' "$token" | install_claude_token "$user" "$d" >/dev/null 2>&1; then
        added+=("$user $d")
        pemit install done "$n" "$user" "stored in $d, 0600, that user's own"
      else
        pemit install failed "$n" "$user" "couldn't store the token in $d"
        bad="${bad:-could not store the token for $user}"
        continue
      fi
      rec="$(pcheck "$n" "$user" "$d")"
      recs="${recs:+$recs,}$rec"
      if printf '%s' "$rec" | grep -q '"api_ok":true'; then
        pemit check done "$n" "$user" "the API answered a minimal call on this profile"
      else
        said="$(printf '%s' "$rec" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).api_error||"")')"
        pemit check failed "$n" "$user" "the API refused it: $said"
        bad="${bad:-$said}"
      fi
    done
    token=""
    if [ -n "$bad" ]; then
      # Nothing half-added: each user's new profile dir goes, as that user.
      for a in ${added[@]+"${added[@]}"}; do
        read -r user d <<< "$a"
        (cd / && sudo -H -u "$user" rm -rf -- "$d") || true
      done
      pemit profile-add failed "" "" "refused: $bad. Nothing was added; every agent user is on the login it had"
      exit 1
    fi
    pedit add setup-token "[$recs]"
    pemit profile-add done "" "" "profile $profile added for ${#rows[@]} agent user(s); no instance uses it until it is chosen"
    exit 0
  fi

  if [ "$cmd" = use ]; then
    [ "$profile" = default ] || pedit has || { pemit use failed "" "" "there is no profile $profile on this machine: add it first"; exit 1; }
    recs="" bad="" targets=()
    for row in "${rows[@]}"; do
      read -r n user cfg <<< "$row"
      targets+=("$n")
      d="$(pdir "$user" "$cfg")"
      rec="$(pcheck "$n" "$user" "$d")"
      recs="${recs:+$recs,}$rec"
      if printf '%s' "$rec" | grep -q '"api_ok":true'; then
        pemit check done "$n" "$user" "the API answered a minimal call on profile $profile"
      else
        said="$(printf '%s' "$rec" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).api_error||"")')"
        pemit check failed "$n" "$user" "the API refused profile $profile: $said"
        bad="${bad:-$user: $said}"
      fi
    done
    pedit checked "[$recs]"
    was="$(pedit active-json "${targets[@]}")"
    if [ -n "$bad" ]; then
      pemit use failed "" "" "refused: $bad. Nothing changed: each instance stays on the profile it had" "$was"
      exit 1
    fi
    pedit use "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${targets[@]}"
    pemit use done "" "" "${targets[*]} on profile $profile; each run from now on starts on it" "$was"
    exit 0
  fi

  # remove
  inuse="$(pedit users-of | tr '\n' ' ')"
  if [ -n "${inuse// /}" ]; then pemit remove failed "" "" "refused: ${inuse% } use profile $profile; choose another profile for them first"; exit 1; fi
  for row in "${rows[@]}"; do
    read -r n user cfg <<< "$row"
    d="$(pdir "$user" "$cfg")"
    if (cd / && sudo -H -u "$user" rm -rf -- "$d"); then pemit remove done "$n" "$user" "removed $d"; else pemit remove failed "$n" "$user" "couldn't remove $d"; fi
  done
  pedit remove
  pemit remove done "" "" "profile $profile removed"
  exit 0
fi

# --- switch

exec 3>&1
[ -z "$json" ] || exec 1>&2
install -d -m 0755 "$CLAUDE_ACCOUNT_DIR"
progress="$CLAUDE_ACCOUNT_DIR/switch.jsonl" paused_file="$CLAUDE_ACCOUNT_DIR/paused"
again="sudo bash $here/claude-account.sh switch"
# One progress line: emit <step> <state> <instance or ""> <detail> [<user>]. To switch.jsonl, and to stdout: JSON with
# --json, else as text.
emit() {
  local line
  line="{\"at\":$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"step\":$(json_str "$1"),\"state\":$(json_str "$2")"
  [ -z "$3" ] || line="$line,\"instance\":$(json_str "$3")"
  [ -z "${5:-}" ] || line="$line,\"user\":$(json_str "$5")"
  line="$line,\"detail\":$(json_str "$4")}"
  printf '%s\n' "$line" >> "$progress"
  if [ -n "$json" ]; then printf '%s\n' "$line" >&3; else printf '%-8s %-8s %-14s %s\n' "$1" "$2" "${3:--}" "$4${5:+ ($5)}" >&3; fi
}

# One switch at a time on a machine.
if command -v flock >/dev/null 2>&1; then
  install -d -m 0755 "$(dirname "$CLAUDE_ACCOUNT_LOCK")"
  exec 9> "$CLAUDE_ACCOUNT_LOCK"
  flock -n 9 || { echo "another Claude account switch is running on this machine; wait for it to finish" >&2; exit 1; }
fi

: > "$progress"
chmod 0644 "$progress"
touch "$paused_file"
chmod 0644 "$paused_file"
all=()
while read -r n; do all+=("$n"); done < <(instances)
emit switch started "" "${#all[@]} instance(s): ${all[*]:-none}; the token from ${token_from:+the dashboard of }${token_from:-this terminal}"
[ "${#all[@]}" -gt 0 ] || { emit switch failed "" "no instances on this machine (or none of those named): nothing to switch"; exit 1; }

# 1. Pause: every running instance, recorded before anything else so a rerun after a crash knows them as its own.
ours=()
for n in "${all[@]}"; do
  unit="worklane-$n.service"
  if grep -qx "$n" "$paused_file"; then
    ours+=("$n")
    if unit_active "$unit"; then unit_drain "$unit"; fi
    emit pause done "$n" "paused by an earlier switch that didn't resume it; it is this switch's to resume"
  elif unit_active "$unit"; then
    echo "$n" >> "$paused_file"
    ours+=("$n")
    if unit_drain "$unit"; then
      emit pause done "$n" "starts no more runs; the ones it has going finish first"
    else
      emit pause failed "$n" "couldn't signal $unit; it is stopped once the wait is over"
    fi
  else
    emit pause skipped "$n" "it wasn't running before the switch, so it is left stopped after"
  fi
done

# 2. The token: pasted here (not shown), on stdin, or from the asking instance's dashboard.
token=""
if [ -n "$token_from" ]; then
  f="$(home_of "wl-$token_from")/.config/$token_from-secrets/$CLAUDE_ACCOUNT_CREDENTIAL"
  emit token ask "" "paste the token claude setup-token prints in $token_from's dashboard (Machine, Claude account); waiting up to $token_timeout min"
  until_t=$((SECONDS + token_timeout * MINUTE))
  while [ "$SECONDS" -lt "$until_t" ] && ! [ -e "$f" ]; do sleep "$SWITCH_POLL"; done
  if [ -e "$f" ]; then
    if file_owned_by "$f" "wl-$token_from"; then IFS= read -r token < "$f" || true; fi
    rm -f "$f"
  fi
else
  emit token ask "" "paste the token claude setup-token prints (on a machine signed in to the new account)"
  if [ -t 0 ]; then
    read -rsp "Paste the token from claude setup-token, then Enter (it is not shown): " token || true
    echo >&2
  else
    IFS= read -r token || true
  fi
fi
token="$(printf '%s' "$token" | tr -d '[:space:]')"
have_token=""
if [ -z "$token" ]; then
  emit token failed "" "no token came: nothing installed; each paused instance is checked on its current login"
elif ! claude_token_ok "$token"; then
  token=""
  emit token failed "" "that is not a token from claude setup-token (sk-ant-oat01-...): nothing installed; each paused instance is checked on its current login"
else
  have_token=1
  emit token done "" "received; not shown or stored anywhere but each agent user's own Claude login"
fi

# 3. Wait for each paused instance's runs to finish, or the timeout; then it is stopped for sure.
until_t=$((SECONDS + timeout * MINUTE))
for n in ${ours[@]+"${ours[@]}"}; do
  unit="worklane-$n.service"
  while unit_active "$unit" && [ "$SECONDS" -lt "$until_t" ]; do sleep "$SWITCH_POLL"; done
  if unit_active "$unit"; then
    unit_stop "$unit" || true
    emit wait done "$n" "still running after $timeout min: stopped; its runs still going are requeued when it starts"
  else
    emit wait done "$n" "its runs have finished; stopped"
  fi
done

# 4. Install the token for every agent user, then check each as that user: claude auth status, and one minimal real call.
failed=" " refused="" installed=() previous=()
for n in "${all[@]}"; do
  found=""
  while read -r kind user cfg; do
    [ -n "$user" ] || continue
    found=1
    if [ -n "$have_token" ]; then
      # The login it has now, kept in memory only (never a file, an argument or a log line): put back if the API
      # refuses the new one. An absent file is kept as empty. previous[i] is installed[i]'s.
      before=""
      if [ -f "$cfg/.credentials.json" ] && [ ! -L "$cfg/.credentials.json" ]; then before="$(cat "$cfg/.credentials.json"; printf x)"; before="${before%x}"; fi
      if printf '%s' "$token" | install_claude_token "$user" "$cfg" >/dev/null 2>&1; then
        installed+=("$n $user $cfg")
        previous+=("$before")
        before=""
        emit install done "$n" "stored in its own Claude login, 0600" "$user"
      else
        emit install failed "$n" "couldn't store the token in $cfg/.credentials.json" "$user"
        failed="$failed$n "
        continue
      fi
    fi
    rec="$(account_record "$n" "$kind" "$user" "$cfg/.credentials.json" "$(claude_status_json "$user")")"
    who="$(printf '%s' "$rec" | sed -n 's/.*"account":"\([^"]*\)".*/\1/p')"
    method="$(printf '%s' "$rec" | sed -n 's/.*"auth_method":"\([^"]*\)".*/\1/p')"
    if printf '%s' "$rec" | grep -q '"logged_in":true'; then
      # Signed in, as claude auth status says: now whether the API takes it (#463).
      if said="$(claude_api_check "$user")"; then
        emit check done "$n" "claude auth status: signed in${who:+ as $who}${method:+ ($method)}; the API answered a minimal call" "$user"
      else
        emit check failed "$n" "claude auth status says signed in${who:+ as $who}, but the API refused the login: ${said:-no answer}" "$user"
        failed="$failed$n "
        [ -z "$have_token" ] || refused="${refused:-${said:-no answer}}"
      fi
    else
      why="$(printf '%s' "$rec" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
      emit check failed "$n" "${why:-claude auth status says it is not logged in}" "$user"
      failed="$failed$n "
    fi
  done < <(users_of "$n")
  if [ -z "$found" ]; then
    emit check failed "$n" "no agent user found (wl-$n-agent, or instance.yaml's run_as)"
    failed="$failed$n "
  fi
done
token=""

# 4b. The API refused the new login: the switch is refused. Every agent user given the token is put back on the login
# it had before, and the instances resume on it, as they ran before the switch (a login refused before the switch is
# held at run time, src/claude-auth-failure.ts).
if [ -n "$refused" ]; then
  for ((i = 0; i < ${#installed[@]}; i++)); do
    read -r n user cfg <<< "${installed[$i]}"
    if printf '%s' "${previous[$i]}" | restore_claude_credentials "$user" "$cfg" >/dev/null 2>&1; then
      emit install failed "$n" "rolled back: the API refused the new login, so this user is on its previous login again" "$user"
    else
      emit install failed "$n" "the API refused the new login, and putting the previous one back failed: sign this user in again" "$user"
      left_broken="${left_broken:-} $n"
    fi
  done
  previous=()
  # Back on the old login: each instance resumes as it ran before, unless its rollback failed.
  failed=" ${left_broken:-} "
fi

# 5. Resume the instances this switch paused, unless their check failed.
left=()
for n in "${all[@]}"; do
  unit="worklane-$n.service"
  mine=""
  for o in ${ours[@]+"${ours[@]}"}; do [ "$o" = "$n" ] && mine=1; done
  if [ -z "$mine" ]; then
    emit resume skipped "$n" "left stopped, as it was before the switch"
  elif [[ "$failed" == *" $n "* ]]; then
    left+=("$n")
    emit resume failed "$n" "not resumed: its auth check failed. Fix it, then rerun: $again"
  elif unit_start "$unit" && unit_active "$unit"; then
    emit resume done "$n" "running again"
  else
    left+=("$n")
    emit resume failed "$n" "$unit didn't start: see journalctl -u $unit, then rerun: $again"
  fi
done
# Only the instances still waiting on a rerun stay in the paused list.
if [ "${#left[@]}" -gt 0 ]; then printf '%s\n' "${left[@]}" > "$paused_file"; else : > "$paused_file"; fi

save_status "$(collect_status)"
if [ -n "$refused" ]; then
  emit switch failed "" "refused: the API refused the new login (Claude said: $refused). Every agent user is back on its previous login${left[*]:+; not resumed: ${left[*]}}. Make a new token with claude setup-token on a machine signed in to the account, then rerun: $again"
  exit 1
fi
if [ "${#left[@]}" -gt 0 ]; then
  emit switch failed "" "not resumed: ${left[*]}; fix what each says, then rerun: $again"
  exit 1
fi
if [ -z "$have_token" ]; then
  emit switch failed "" "no token installed; every paused instance was resumed on its current login"
  exit 1
fi
emit switch done "" "every agent user is on the new login; ${#ours[@]} instance(s) resumed"
