#!/usr/bin/env bash
# See which Claude account each agent on this machine has, or remove what the removed account profiles left. As root
# (review it first).
#
#   sudo bash scripts/setup/claude-account.sh status [--json] [<instance>...]
#   sudo bash scripts/setup/claude-account.sh uninstall
#
# The engine manages no Claude account (issue #736): one person signs an instance's agent user in to the unmodified
# `claude` themselves, as that user, through Anthropic's own flow (sudo -u <agent user> -i claude auth login), or the
# instance uses an API key (credentials.sh <name> api-key). The switch of every agent to a pasted token, the account
# profiles (profile-add, confirm-profile, use, remove) and failover between them were removed: each is refused here
# like any unknown command, before anything runs.
#
# No command takes a Claude credential, and each run removes, unread, any file an earlier version had a dashboard
# store for this script (a switch's token, a profile's token, a sign-in's code, add-project's token) from every
# secrets dir in each coordinator user's ~/.config (*-secrets), as that user (issue #711).
#
# status: each agent user's account (as claude auth status names it), whether it is signed in, whether the API takes
# the login (one minimal real call as that user, for each one signed in), which token (the first 8 hex digits of its
# sha256: the same login shows the same id) and when that expires. With instances named (add-project
# and credentials.sh name theirs once its token is in, before the machine helper lists it), only their records are
# found again; status.json keeps every other instance's as it was.
#
# uninstall: what the removed commands left, which the engine ignores (an instance whose runs were on another profile
# doesn't start until it is gone: src/claude-accounts-retired.ts). Each agent and eval user's ~/.claude-profiles, as
# that user (never as root: the dir is the user's, and a link there is removed as a link, never followed), then
# profiles.json, profile-ops.jsonl, switch.jsonl and paused from the claude-account dir. status.json (status's) and
# every user's own login stay. If a user's dir can't be removed, the files stay too, and it exits 1. A root admin's
# only: no machine helper command or sudoers rule reaches it.
#
# Output: plain lines, or with --json one JSON object (status). What status found goes to status.json, root's 0644,
# for the dashboard. Exit 0 when every user is signed in (status), or everything was removed (uninstall).
source "$(dirname "$0")/lib.sh"
as_root "$@"
usage="usage: claude-account.sh status [--json] [<instance>...] | uninstall"
# Root's tools wherever this is started from (sudo, a systemd unit): sbin included.
PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

cmd="${1:-}"
[ "$#" -ge 1 ] && shift
json="" names=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json=1; shift ;;
    # --for (what the machine helper passed for a dashboard's step) and --token-from (a credential a dashboard stored)
    # are no options: refused here as any unknown one is (issues #711, #736).
    -*) echo "$usage" >&2; exit 2 ;;
    *) names+=("$1"); shift ;;
  esac
done
# switch, profile-add, confirm-profile, use, remove and failover (#736), and login (#711), are no commands any more.
case "$cmd" in status | uninstall) ;; *) echo "$usage" >&2; exit 2 ;; esac
if [ "$cmd" = uninstall ] && { [ "${#names[@]}" -gt 0 ] || [ -n "$json" ]; }; then echo "$usage" >&2; exit 2; fi
for n in ${names[@]+"${names[@]}"}; do instance_name_ok "$n" || { echo "instance name $n: lowercase letters, digits and dashes" >&2; exit 2; }; done

# Issue #711: what an earlier version had a dashboard store for this script to read once (a switch's token, a new
# profile's token, a relayed sign-in's code, add-project's token) is removed, unread, on every run: a step that
# stopped before reading one left it there. From every secrets dir in each coordinator user's ~/.config
# (~wl-<n>/.config/*-secrets/), not only its own instance's: add-project's token went to the asking coordinator's
# ~/.config/<new instance>-secrets/. Only those four names, only regular files: find, as that coordinator user (the
# dirs are its own: root never follows a path it could have changed), follows no link, a *-secrets dir that is one
# included, and goes no deeper. And the sign-in link root kept for it.
drop_pasted_credentials() {
  local n cfg f
  { helper_instances; hub_instances; } 2>/dev/null | sort -u | while read -r n; do
    instance_name_ok "$n" && user_exists "wl-$n" || continue
    cfg="$(home_of "wl-$n")/.config"
    # Names only (the four all start claude-): no sudo at all when there is nothing of the kind.
    compgen -G "$cfg/*-secrets/claude-*" >/dev/null || continue
    (cd / && sudo -H -u "wl-$n" find -P "$cfg" -mindepth 2 -maxdepth 2 -path "$cfg/*-secrets/*" -type f \
      \( -name "$CLAUDE_ACCOUNT_CREDENTIAL" -o -name "$CLAUDE_PROFILE_CREDENTIAL" -o -name "$CLAUDE_LOGIN_CREDENTIAL" -o -name claude-token \) \
      -delete -print 2>/dev/null) | while IFS= read -r f; do
      echo "removed $f, unread: a dashboard no longer takes a Claude credential" >&2
    done || true # no ~/.config, or a dir find can't open: nothing of these left there
  done
  rm -f -- "$CLAUDE_ACCOUNT_DIR/login-url"
  return 0
}
drop_pasted_credentials

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

if [ "$cmd" = uninstall ]; then
  # A coordinator user never runs this, even through sudo of its own.
  if [[ "${SUDO_USER:-}" =~ ^wl- ]]; then echo "uninstall is a root admin's: not $SUDO_USER's" >&2; exit 2; fi
  did="" bad=""
  for n in $(instances); do
    while read -r kind user cfg; do
      [ -n "$user" ] || continue
      d="$(home_of "$user")/.claude-profiles"
      [ -e "$d" ] || [ -L "$d" ] || continue
      # As that user: its own dir; rm never follows a link it removes.
      if (cd / && sudo -H -u "$user" rm -rf -- "$d"); then echo "removed $d ($n, $kind user)"; did=1; else echo "couldn't remove $d ($n, $kind user): remove it as that user (sudo -u $user rm -rf -- $d), then run this again" >&2; bad=1; fi
    done < <(users_of "$n")
  done
  if [ -n "$bad" ]; then
    echo "nothing else removed: an instance whose runs were on another profile stays refused until every dir above is gone" >&2
    exit 1
  fi
  for f in profiles.json profile-ops.jsonl switch.jsonl paused; do
    if [ -e "$CLAUDE_ACCOUNT_DIR/$f" ] || [ -L "$CLAUDE_ACCOUNT_DIR/$f" ]; then rm -f -- "$CLAUDE_ACCOUNT_DIR/$f"; echo "removed $CLAUDE_ACCOUNT_DIR/$f"; did=1; fi
  done
  if [ -n "$did" ]; then echo "done: each instance's runs use its agent user's own login (sign one in, if it isn't: sudo -u <agent user> -i claude auth login)"; else echo "nothing left of account profiles, failover or the switch"; fi
  exit 0
fi

# --- status

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
api_result() { local said; if said="$(claude_api_check "$1")"; then echo ok; else echo "${said:-the API call failed}"; fi; }
# Every agent user's record, as a JSON array; written to status.json (root's, 0644) for the dashboard. Each user claude
# auth status calls signed in is also checked with one minimal real call.
collect_status() {
  local n kind user cfg recs="" rec auth api
  for n in $(instances); do
    while read -r kind user cfg; do
      [ -n "$user" ] || continue
      auth="$(claude_status_json "$user")" api=""
      if printf '%s' "$auth" | grep -q '"loggedIn": *true'; then api="$(api_result "$user")"; fi
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

recs="$(collect_status)"
if [ "${#names[@]}" -gt 0 ]; then save_status "$(merge_status "$recs" "${names[@]}")"; else save_status "$recs"; fi
if [ -n "$json" ]; then printf '{"users":%s}\n' "$recs"; else show_status "$recs"; fi
# Exit 1 when any user isn't signed in, or the API refused its login.
if printf '%s' "$recs" | grep -q '"logged_in":false\|"api_ok":false'; then exit 1; fi
exit 0
