# Shared helpers for the setup scripts. Sourced, not run.
set -euo pipefail

# Re-run as root through sudo when started as an ordinary admin user.
as_root() {
  if [ "$(id -u)" -ne 0 ]; then exec sudo -- bash "$0" "$@"; fi
}

# A user's home directory, from the passwd database: never assumed to be /home/<user>.
home_of() { getent passwd "$1" | cut -d: -f6; }

# A JSON string (for the scripts that print JSON lines): backslashes and quotes escaped, newlines as \n, other control characters dropped.
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/ }"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}

# Run a bash script as another user, its arguments passed through intact.
# Never `sudo -i ... -c`: -i re-quotes the command for a login shell, which
# mangles multi-line scripts. From / so the user needn't reach our cwd.
run_as() {
  local user="$1" script="$2"; shift 2
  # GIT_TERMINAL_PROMPT=0: a setup step's git never asks for a username or password; it fails instead.
  (cd / && sudo -H -u "$user" env GIT_TERMINAL_PROMPT=0 bash -euo pipefail -c "$script" _ "$@")
}

say() { printf '\n== %s\n' "$*"; }

# Create a user with a private home, if it doesn't exist yet.
ensure_user() {
  if id -u "$1" >/dev/null 2>&1; then echo "user $1 exists"; else useradd --create-home --shell /bin/bash "$1"; echo "created user $1"; fi
  chmod 0700 "$(home_of "$1")"
}

ensure_group() { groupadd -f "$1"; }
ensure_member() { usermod -aG "$2" "$1"; }

# Install a sudoers file safely: write a dotted temp name (sudo ignores
# names with a dot), validate it, and only then move it into place.
install_sudoers() {
  local name="$1" content="$2" tmp="/etc/sudoers.d/.$1.tmp"
  printf '%s\n' "$content" > "$tmp"
  chmod 0440 "$tmp"
  if ! visudo -cf "$tmp"; then rm -f "$tmp"; echo "sudoers $name is invalid; nothing installed" >&2; exit 1; fi
  mv -f "$tmp" "/etc/sudoers.d/$name"
  echo "installed /etc/sudoers.d/$name"
}

# Remove a sudoers file installed by install_sudoers (absent: nothing to do).
remove_sudoers() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "remove_sudoers: bad name $1" >&2; return 1; }
  rm -f "/etc/sudoers.d/$1"
}

# PASS when <user> can't read, write or (a directory) enter each existing path named, else FAIL; non-zero if
# any FAIL. Each probe runs as that user and must itself answer "denied": a probe that can't run (sudo
# refused, no such user) is a FAIL, never a pass.
deny_check() {
  local user="$1" p out fail=0
  shift
  for p in "$@"; do
    [ -e "$p" ] || continue
    out="$(cd / && sudo -n -u "$user" sh -c 'if [ -r "$1" ] || [ -w "$1" ] || { [ -d "$1" ] && [ -x "$1" ]; }; then echo open; else echo denied; fi' _ "$p" 2>/dev/null || true)"
    if [ "$out" = denied ]; then echo "PASS $user can't read, write or enter $p"; else echo "FAIL $user can reach $p (${out:-the probe did not run})"; fail=1; fi
  done
  return "$fail"
}

# Everything under a directory that anyone outside its owner and group can read, write or enter.
open_to_others() { find "$1" \( -perm -o=r -o -perm -o=w -o -perm -o=x \) -print 2>/dev/null; }

# Fail, naming the files, when anything under an instance's state is open to others.
refuse_if_open() {
  local state="$1" why="$2" open
  open="$(open_to_others "$state")"
  [ -z "$open" ] && return 0
  echo "refusing to $why: these under $state are open to other users:" >&2
  printf '  %s\n' $open >&2
  echo "close them (chmod -R o-rwx $state), make sure the coordinator runs an engine that keeps them closed, then run this again" >&2
  exit 1
}

# The sudoers rule for the machine helper: each coordinator user named may run exactly the 28
# allowed commands (set-slots 1..16, set-updates on, set-updates off, set-test-slots 1..8, claude-account status,
# claude-account switch) as root, and nothing else.
# Listed one by one, no wildcards or patterns. Never for the dashboard viewer (wl-dash).
#
# And `add-project <name> <owner/repo>`, the one command whose arguments can't be listed: a fixed pattern of exactly
# two arguments of those shapes (sudo's anchored regular expression, sudo 1.9.10 or later; an older sudo matches it
# literally, so never), which the helper checks again, strictly, before it runs add-project.sh.
MACHINE_HELPER=/usr/local/libexec/worklane-machine
MACHINE_SUDOERS=/etc/sudoers.d/worklane-machine   # what install_sudoers worklane-machine writes
ADD_PROJECT_SUDOERS_ARGS='^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
machine_sudoers() {
  local u n cmds=()
  [ "$#" -ge 1 ] || { echo "machine_sudoers: no users" >&2; return 1; }
  for u in "$@"; do
    [[ "$u" =~ ^wl-[a-z][a-z0-9-]{0,20}$ && "$u" != wl-dash ]] || { echo "machine_sudoers: $u is not a coordinator user" >&2; return 1; }
  done
  for n in $(seq 1 16); do cmds+=("$MACHINE_HELPER set-slots $n"); done
  cmds+=("$MACHINE_HELPER set-updates on" "$MACHINE_HELPER set-updates off")
  for n in $(seq 1 8); do cmds+=("$MACHINE_HELPER set-test-slots $n"); done
  cmds+=("$MACHINE_HELPER claude-account status" "$MACHINE_HELPER claude-account switch")
  cmds+=("$MACHINE_HELPER $ADD_PROJECT_SUDOERS_ARGS")
  printf '# Coordinators may change the machine slot caps and the update switch, switch the agents'"'"' Claude account, and add a project, through one validating helper.\n'
  printf 'Cmnd_Alias WORKLANE_MACHINE = %s' "${cmds[0]}"
  for n in "${cmds[@]:1}"; do printf ', \\\n    %s' "$n"; done
  local users="$1"; shift
  for u in "$@"; do users="$users, $u"; done
  printf '\n%s ALL=(root) NOPASSWD: WORKLANE_MACHINE\n' "$users"
}

# The instances the installed machine helper rule names (wl-<name> -> <name>), one per line.
helper_instances() {
  [ -f "$MACHINE_SUDOERS" ] || return 0
  sed -n 's/^\(wl-[-a-z0-9, ]*\) ALL=(root) NOPASSWD: WORKLANE_MACHINE$/\1/p' "$MACHINE_SUDOERS" | tr ',' '\n' | sed -e 's/^ *wl-//' -e 's/ *$//' | grep -E '^[a-z][a-z0-9-]{0,20}$' || true
}

# The dashboard hub's unit, as dashboards.sh writes it, and one option of its ExecStart (nothing when it has none).
HUB_UNIT=/etc/systemd/system/worklane-dashboard-hub.service
hub_option() {
  [ -f "$HUB_UNIT" ] || return 0
  sed -n 's/^ExecStart=.* '"$1"' \([^ ]*\).*$/\1/p' "$HUB_UNIT" | head -1
}
# The instances the hub serves (its --hub <name>=<state>,...), one per line.
hub_instances() { hub_option --hub | tr ',' '\n' | sed 's/=.*$//' | grep -E '^[a-z][a-z0-9-]{0,20}$' || true; }

# Where the instances' checkouts live (instance.sh makes $SRV_ROOT/<name>), and the engine's command.
SRV_ROOT=/srv/worklane
ENGINE_CLI=/usr/local/bin/worklane
ADD_PROJECT_LOCK=/run/lock/worklane-add-project.lock
user_exists() { id -u "$1" >/dev/null 2>&1; }
unit_active() { systemctl is-active -q "$1"; }

# An instance's home, as its coordinator: `worklane instance init` the first time; an existing one is pointed at its
# agent user (one made earlier, or by hand, may name another).
ensure_instance_home() {
  local name="$1" repo="$2"
  run_as "wl-$name" '
    agent="wl-$1-agent" agent_home="$4"
    [ -n "$agent_home" ] || { echo "no home for $agent in the user database; run instance.sh $1 first" >&2; exit 1; }
    if worklane instance list | grep -qx "$1"; then
      f="$HOME/.local/state/worklane/instances/$1/instance.yaml"
      if grep -qx "  agent_user: $agent" "$f"; then echo "instance $1 exists; agents run as $agent"; exit 0; fi
      sed -e "s|^  agent_user: .*|  agent_user: $agent|" -e "s|^  agent_home: .*|  agent_home: $agent_home|" "$f" > "$f.new"
      cat "$f.new" > "$f" && rm -f "$f.new"
      grep -qx "  agent_user: $agent" "$f" || { echo "could not set run_as in $f; edit it by hand" >&2; exit 1; }
      echo "instance $1 exists; run_as now $agent"
      exit 0
    fi
    worklane instance init "$1" --repo "$2" --github "$3" --agent-user "$agent" --agent-home "$agent_home"
  ' "$name" "$SRV_ROOT/$name/${repo#*/}" "$repo" "$(home_of "wl-$name-agent")"
}

# An instance name add-project takes: instance.sh's shape, never one whose users would collide with another's
# (wl-dash is the viewer; wl-<x>-agent, -eval and -work belong to instance <x>). The helper checks the same.
instance_name_ok() { [[ "$1" =~ ^[a-z][a-z0-9-]{0,20}$ && "$1" != dash && ! "$1" =~ -(agent|eval|work)$ ]]; }
# A GitHub repo, owner/name, strictly: the owner a GitHub login, the name letters, digits, '.', '_' and '-'.
repo_ok() {
  local owner="${1%%/*}" rest="${1#*/}"
  [[ "$1" == */* && "$rest" != */* ]] && github_login_ok "$owner" && [[ "${#rest}" -le 100 && "$rest" =~ ^[A-Za-z0-9_.-]+$ && "$rest" != . && "$rest" != .. ]]
}

# The agent's Claude login, from `claude setup-token`'s token on stdin, written as that user's own Claude
# credentials (~/.claude/.credentials.json, 0600 in its 0700 ~/.claude; or <dir>/.credentials.json when an instance
# names its agent's claude_config_dir), keeping the file's other entries. The token goes from stdin to that file and
# nowhere else: never an argument, an environment variable or a log line.
#   install_claude_token <user> [<claude config dir>]
install_claude_token() {
  (cd / && sudo -H -u "$1" "$(command -v node)" --input-type=module -e '
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const token = readFileSync(0, "utf8").trim();
if (!/^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/.test(token)) {
  console.error("that is not a token from claude setup-token (sk-ant-oat01-...); nothing installed");
  process.exit(1);
}
const dir = process.argv[1] || join(homedir(), ".claude");
if (!dir.startsWith("/")) {
  console.error("the Claude config dir must be an absolute path; nothing installed");
  process.exit(1);
}
const file = join(dir, ".credentials.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
let c = {};
try {
  c = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
} catch {
  c = {};
}
// A setup-token login: a year long, inference only, nothing to refresh.
c.claudeAiOauth = { accessToken: token, refreshToken: null, expiresAt: Date.now() + 365 * 24 * 3600 * 1000, scopes: ["user:inference"], subscriptionType: null };
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(c)}\n`, { mode: 0o600 });
renameSync(tmp, file);
console.log(`installed ${file} (0600, this user only)`);
' "${2:-}")
}
# Whether claude, as this user, says it is signed in (no claude on this machine yet: nothing to ask, so yes).
claude_login_ok() {
  command -v claude >/dev/null 2>&1 || return 0
  (cd / && sudo -H -u "$1" claude auth status --json) | grep -q '"loggedIn": *true'
}

# The Claude account switch (claude-account.sh): what it last found for each agent user (status.json), the last
# switch's progress (switch.jsonl, one JSON line per step change), and the instances a switch stopped and hasn't
# started again (paused). Root's, 0644: account names and expiry dates, never a token.
CLAUDE_ACCOUNT_DIR=/var/lib/worklane/claude-account
CLAUDE_ACCOUNT_LOCK=/run/lock/worklane-claude-account.lock
# The token a dashboard switch takes: pasted by a machine owner into the asking instance's dashboard, which stores it
# for its coordinator user only (src/console/secrets.ts); claude-account.sh reads it once, as root, and deletes it.
CLAUDE_ACCOUNT_CREDENTIAL=claude-account-token
# A token from `claude setup-token`, strictly: install_claude_token's check, and src/claude-account.ts's.
# (The length apart: a repeat bound over 255 is no regular expression to every libc.)
claude_token_ok() { [[ "${#1}" -le 513 && "$1" =~ ^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}$ ]]; }
# claude auth status --json as this user; nothing when claude isn't installed or doesn't answer within a minute.
claude_status_json() {
  command -v claude >/dev/null 2>&1 || return 0
  (cd / && sudo -H -u "$1" timeout 60 claude auth status --json 2>/dev/null) || true
}
# Whether a path is a plain file (not a link) that this user owns.
file_owned_by() { [ -f "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -maxdepth 0 -type f -user "$2" 2>/dev/null)" ]; }
# Pause an instance: SIGTERM to its coordinator's main process only. It starts no more runs, lets the ones it has
# going finish, then exits on its own; a clean exit isn't restarted (Restart=on-failure). Its unit's own stop
# (unit_stop, `systemctl stop`) would end those runs after TimeoutStopSec: used only once the wait has timed out.
unit_drain() { systemctl kill --kill-whom=main --signal=SIGTERM "$1"; }
unit_stop() { systemctl stop "$1"; }
unit_start() { systemctl start "$1"; }

# The engine repo's checks that run on a push to main, one name per element (names hold commas, so never a
# joined string). Pull-request-only checks (dco) are left out: they're always "skipped" on main, and the
# updater refuses a skipped required check. "bootstrap (macos-latest)" is left out on purpose: it gates a
# merge, but engine updates on servers must not wait on the macOS run. A test derives this list from the
# workflows, minus that named exclusion.
UPDATE_DEFAULT_CHECKS=("add-project (real systemd)" "agentshield" "bootstrap (ubuntu-latest)" "denylist" "desktop" "push-gate" "scan" "test (ubuntu-latest, 22)" "test (ubuntu-latest, 24)" "test-run sandbox (real systemd)")

# updates.json for the engine updater, off: the repo to follow, then each required check as its own argument.
updates_config_json() {
  # A new install follows signed release tags; an existing updates.json (no channel) keeps following main.
  node -e 'const [repo, ...checks] = process.argv.slice(1); process.stdout.write(JSON.stringify({ enabled: false, channel: "release", allowed_signers: "/etc/worklane/allowed_signers", repo_url: repo, branch: "main", required_checks: checks.filter((s) => s.trim()) }, null, 2) + "\n")' "$@"
}

# The sudoers rule for the dashboard's owner terminal: the hub's viewer user may run the console shell as the
# admin user, with exactly `check` or `shell`, and nothing else; never as root. sudo inside that shell still
# asks for the admin's password (the rule is NOPASSWD only for the console shell itself).
CONSOLE_SHELL=/usr/local/libexec/worklane-console-shell
CONSOLE_SUDOERS=/etc/sudoers.d/worklane-console   # what install_sudoers worklane-console writes
console_sudoers() {
  local viewer="$1" admin="$2"
  [[ "$viewer" =~ ^wl-[a-z][a-z0-9-]{0,20}$ ]] || { echo "console_sudoers: $viewer is not a viewer user" >&2; return 1; }
  [[ "$admin" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$admin" != root && "$admin" != "$viewer" ]] || { echo "console_sudoers: $admin can't be the console user" >&2; return 1; }
  printf '# The dashboard hub (%s) may start the owner terminal as %s: the console shell, exactly check or shell.\n' "$viewer" "$admin"
  printf '%s ALL=(%s) NOPASSWD: %s check, %s shell\n' "$viewer" "$admin" "$CONSOLE_SHELL" "$CONSOLE_SHELL"
}

# The machine owners (src/machine-owners.ts): the GitHub logins that may change the machine from the dashboard
# (slot caps, engine updates), as opposed to an instance's owners. Root's file; every instance user reads it.
MACHINE_OWNERS=/etc/worklane/machine-owners.json
# A GitHub login, strictly: letters, digits and single dashes inside, at most 39 characters.
github_login_ok() { [[ "${#1}" -le 39 && "$1" =~ ^[A-Za-z0-9](-?[A-Za-z0-9])*$ ]]; }
# {"owners":[...]} from a comma-separated list of logins; refuses an empty list, an empty entry, a bad login or a repeat.
machine_owners_json() {
  local csv="$1" l low out="" seen="," logins
  [[ -n "$csv" && "$csv" != *, && "$csv" != ,* && "$csv" != *,,* ]] || { echo "--machine-owner: GitHub logins, comma-separated, at least one, no empty ones" >&2; return 2; }
  IFS=, read -ra logins <<< "$csv"
  for l in "${logins[@]}"; do
    github_login_ok "$l" || { echo "--machine-owner: $l isn't a GitHub login (letters, digits and single dashes, at most 39)" >&2; return 2; }
    low="$(printf '%s' "$l" | tr '[:upper:]' '[:lower:]')"
    [[ "$seen" != *",$low,"* ]] || { echo "--machine-owner: $l is listed twice" >&2; return 2; }
    seen="$seen$low,"
    out="${out:+$out,}\"$l\""
  done
  printf '{"owners":[%s]}\n' "$out"
}
# Write the machine owners file, root:root 0644: a dotted temp name next to it, then moved into place.
install_machine_owners() {
  local csv="$1" file="${2:-$MACHINE_OWNERS}" json tmp
  json="$(machine_owners_json "$csv")" || return 2
  [ -d "$(dirname "$file")" ] || { echo "no $(dirname "$file"); run machine.sh first" >&2; return 1; }
  tmp="$(dirname "$file")/.$(basename "$file").tmp"
  rm -f "$tmp"
  printf '%s\n' "$json" > "$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  echo "machine owners ($file): $json"
}
