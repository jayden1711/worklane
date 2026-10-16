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

# Whether a sudoers file install_sudoers wrote is there.
sudoers_installed() { [ -e "/etc/sudoers.d/$1" ]; }

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

# The sudoers rule for the machine helper: each coordinator user named may run exactly the 34
# allowed commands (set-slots 1..16, set-updates on, set-updates off, set-test-slots 1..8, claude-account status,
# claude-account switch, install-updater, set-update-channel release, tailscale install, tailscale up, tailscale serve,
# tailscale public-url) as root, and nothing else.
# Listed one by one, no wildcards or patterns. Never for the dashboard viewer (wl-dash).
#
# And `add-project <name> <owner/repo>`, the one command whose arguments can't be listed: a fixed pattern of exactly
# two arguments of those shapes (sudo's anchored regular expression, sudo 1.9.10 or later; an older sudo matches it
# literally, so never), which the helper checks again, strictly, before it runs add-project.sh.
#
# And `stage-update-signer <principal> ssh-ed25519 <public key>` (and `discard-update-signer`, the same arguments), the
# same way: one principal of an email's shape and one ed25519 public key in its fixed encoding (68 base64 characters
# after the type), which the helper checks again (it decodes the key). Staging writes only the helper's pending list:
# no rule here lets a coordinator write the updater's allowed signers file, or follow main instead of releases.
#
# And the agents' Claude account profiles (issue #464): `claude-account profile-add|remove <profile>` and
# `claude-account use <profile>`, the relayed sign-in `claude-account login <profile>`, and `claude-account failover
# <order|off> back|stay`: six anchored patterns, each one profile's name (lowercase letters, digits and dashes), or
# an order (names joined by +: never a comma, which sudoers reads as the end of a command), and nothing else. No
# pattern takes an instance: each step is for the asking coordinator's own instance,
# which the helper takes from SUDO_USER, so a coordinator can never name another instance, or every instance.
# Those, the two signer rules and add-project are written only when this machine's sudo reads them as patterns (sudo_regex_ok): an
# older sudo would take a pattern as literal text, so they are left out there, the rule says so in a comment, and
# machine-helper.sh records it in HELPER_RULES for the dashboard (which then shows the root command instead).
HELPER_RULES=/etc/worklane/helper-rules.json
MACHINE_HELPER=/usr/local/libexec/worklane-machine
MACHINE_SUDOERS=/etc/sudoers.d/worklane-machine   # what install_sudoers worklane-machine writes
ADD_PROJECT_SUDOERS_ARGS='^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
SIGNER_SUDOERS_ARGS='[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$'
# Whether this machine's sudo is 1.9.10 or later, the first that reads a command's arguments written ^...$ as a regular
# expression (from `sudo -V`'s first line, "Sudo version X.Y.Z[pN]"). Unknown is no.
PROFILE_SUDOERS_ARGS=(
  '^claude-account profile-add [a-z][a-z0-9-]*$'
  '^claude-account remove [a-z][a-z0-9-]*$'
  '^claude-account use [a-z][a-z0-9-]*$'
  '^claude-account login [a-z][a-z0-9-]*$'
  '^claude-account failover [a-z][a-z0-9+-]* back$'
  '^claude-account failover [a-z][a-z0-9+-]* stay$'
)
SUDO_REGEX_MIN=1.9.10
sudo_version() { sudo -V 2>/dev/null | sed -n 's/^Sudo version \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1; }
sudo_regex_ok() {
  local v a b c
  v="$(sudo_version)"
  [ -n "$v" ] || return 1
  IFS=. read -r a b c <<< "$v"
  (( a > 1 || (a == 1 && (b > 9 || (b == 9 && c >= 10))) ))
}

machine_sudoers() {
  local u n cmds=() signer_rules=1
  [ "$#" -ge 1 ] || { echo "machine_sudoers: no users" >&2; return 1; }
  for u in "$@"; do
    [[ "$u" =~ ^wl-[a-z][a-z0-9-]{0,20}$ && "$u" != wl-dash ]] || { echo "machine_sudoers: $u is not a coordinator user" >&2; return 1; }
  done
  for n in $(seq 1 16); do cmds+=("$MACHINE_HELPER set-slots $n"); done
  cmds+=("$MACHINE_HELPER set-updates on" "$MACHINE_HELPER set-updates off")
  for n in $(seq 1 8); do cmds+=("$MACHINE_HELPER set-test-slots $n"); done
  cmds+=("$MACHINE_HELPER claude-account status" "$MACHINE_HELPER claude-account switch")
  cmds+=("$MACHINE_HELPER install-updater" "$MACHINE_HELPER set-update-channel release")
  # Tailscale (tailscale.sh): four fixed commands. sudo matches a listed command's arguments exactly, so none takes an
  # auth key, a flag, a URL or a port.
  cmds+=("$MACHINE_HELPER tailscale install" "$MACHINE_HELPER tailscale up" "$MACHINE_HELPER tailscale serve" "$MACHINE_HELPER tailscale public-url")
  if sudo_regex_ok; then
    cmds+=("$MACHINE_HELPER ^stage-update-signer $SIGNER_SUDOERS_ARGS" "$MACHINE_HELPER ^discard-update-signer $SIGNER_SUDOERS_ARGS")
    for n in "${PROFILE_SUDOERS_ARGS[@]}"; do cmds+=("$MACHINE_HELPER $n"); done
    cmds+=("$MACHINE_HELPER $ADD_PROJECT_SUDOERS_ARGS")
  else
    signer_rules=0
  fi
  printf '# Coordinators may change the machine slot caps and the update switch, switch the agents'"'"' Claude account, put the machine on Tailscale, add a project, and set the engine updater up (install it, follow releases, stage a release signer for an admin to confirm), through one validating helper.\n'
  [ "$signer_rules" = 1 ] || printf '# Not here: add-project, stage-update-signer and discard-update-signer. This sudo (%s) is older than %s and would read their patterns as literal text.\n' "$(sudo_version || true)" "$SUDO_REGEX_MIN"
  [ "$signer_rules" = 1 ] || printf '# Not here either, for the same reason: the claude-account profile commands (profile-add, use, remove, login, failover).\n'
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

# Tailscale for the dashboard hub (tailscale.sh). The install is pinned: Tailscale's own apt repository for this
# distribution, every package checked by apt against the one signing key whose fingerprint is here, and this version.
# Change the version and the fingerprint only in a reviewed commit, the fingerprint only to one Tailscale publishes.
#   fingerprint: the primary key of https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg ("Tailscale Inc. (Package
#   repository signing key)"), as fetched 2026-10-13: the same key file (sha256
#   3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39) for ubuntu jammy and noble and debian bookworm.
#   version: the newest in that repository's Packages index (dists/noble/main/binary-amd64) on the same day.
TAILSCALE_VERSION=1.104.1
TAILSCALE_SIGNER_FPR=2596A99EAAB33821893C0A79458CA832957F5868
TAILSCALE_REPO=https://pkgs.tailscale.com/stable
TAILSCALE_KEYRING=/usr/share/keyrings/tailscale-archive-keyring.gpg
TAILSCALE_LIST=/etc/apt/sources.list.d/tailscale.list
TAILSCALE_BIN=/usr/bin/tailscale
OS_RELEASE=/etc/os-release
# What the steps leave for the dashboard: steps.jsonl (root's, 0644: one JSON line per step change, never a link or a
# key) and, while `up` waits, login-url (0400, the asking coordinator's user alone: the dashboard shows it to a machine
# owner and to nobody else).
TAILSCALE_DIR=/var/lib/worklane/tailscale
TAILSCALE_LOCK=/run/lock/worklane-tailscale.lock
# The hub's sign-in port, the only one tailscale serve may forward to (dashboards.sh; never 4398, the break-glass).
HUB_PORT=4399
BREAK_GLASS_PORT=4398
# The hub's Siri gateway (dashboards.sh --siri), and the tailnet HTTPS port tailscale.sh serve-siri publishes it on.
SIRI_GATEWAY_PORT=4397
SIRI_TAILNET_PORT=8443
# How long `tailscale up` waits for the owner to log in, and `tailscale serve` for tailscaled, in seconds.
TAILSCALE_UP_SECONDS=600 TAILSCALE_SERVE_SECONDS=30
# The login link `tailscale up` prints, strictly: Tailscale's own login host and a short id. Anything else is not
# relayed (and a key is not a link: one is never asked for, taken or printed).
tailscale_login_url_ok() { [[ "$1" =~ ^https://login\.tailscale\.com/a/[A-Za-z0-9]{6,64}$ ]]; }
# A line of tailscale's output with every link and key taken out, for the journal and steps.jsonl.
tailscale_redact() { sed -E -e 's#https?://[^[:space:]"]+#[a link, not logged]#g' -e 's#tskey-[A-Za-z0-9_-]+#[a key, not logged]#g'; }
# stdin to a file of this owner, group and mode: a dotted temp name next to it, made empty with that owner and mode
# first, then moved into place.
put_file() {
  local owner="$1" group="$2" mode="$3" file="$4" tmp
  tmp="$(dirname "$file")/.$(basename "$file").tmp"
  rm -f "$tmp"
  install -o "$owner" -g "$group" -m "$mode" /dev/null "$tmp"
  cat > "$tmp"
  mv -f "$tmp" "$file"
}

# The dashboard hub's unit, as dashboards.sh writes it, and one option of its ExecStart (nothing when it has none).
HUB_UNIT=/etc/systemd/system/worklane-dashboard-hub.service
hub_option() {
  [ -f "$HUB_UNIT" ] || return 0
  sed -n 's/^ExecStart=.* '"$1"' \([^ ]*\).*$/\1/p' "$HUB_UNIT" | head -1
}
# The instances the hub serves (its --hub <name>=<state>,...), one per line.
hub_instances() { hub_option --hub | tr ',' '\n' | sed 's/=.*$//' | grep -E '^[a-z][a-z0-9-]{0,20}$' || true; }

# The hub's own settings, to run dashboards.sh again with another list of instances and nothing else changed: one word
# a line (its sign-in App's client id, its URL, the owner terminal's user and devices, and --siri when it has the gateway).
hub_keep_args() {
  local v
  printf '%s\n' --client-id "$(hub_option --client-id)" --public-url "$(hub_option --public-url)"
  v="$(hub_option --console-user)"; [ -z "$v" ] || printf '%s\n' --console-user "$v"
  v="$(hub_option --console-devices)"; [ -z "$v" ] || printf '%s\n' --console-devices "$v"
  [ -z "$(hub_option --siri-port)" ] || printf '%s\n' --siri
}

# What an instance has in flight, one line each; nothing when it has none (instance-remove.sh and instance-rename.sh
# refuse while it has any): its coordinator service not inactive, any process of its users (the registry's, in
# instance-records.cjs) outside its dashboard, its test Docker daemon and its own user manager, or a test run's directory.
instance_in_flight() {
  local name="$1" st k u uids=() pid uid cg comm
  st="$(systemctl show -p ActiveState --value "worklane-$name.service" 2>/dev/null || true)"
  case "$st" in active | activating | deactivating | reloading) echo "its coordinator, worklane-$name.service, is $st: let its runs finish, then: sudo systemctl stop worklane-$name.service" ;; esac
  while IFS=$'\t' read -r k u _; do
    [ "$k" = user ] && user_exists "$u" && uids+=("$(id -u "$u")")
  done < <("$(command -v node)" "$(dirname "${BASH_SOURCE[0]}")/instance-records.cjs" items "$name")
  if [ "${#uids[@]}" -gt 0 ]; then
    for pid in /proc/[0-9]*; do
      uid="$(stat -c %u "$pid" 2>/dev/null)" || continue
      [[ " ${uids[*]} " == *" $uid "* ]] || continue
      cg="$(sed -n 's/^0:://p' "$pid/cgroup" 2>/dev/null || true)"
      case "$cg" in */worklane-dashboard-"$name".service | */worklane-test-"$name"-docker.service | */worklane-test-"$name"-docker.service/* | */user@"$uid".service | */user@"$uid".service/*) continue ;; esac
      comm="$(cat "$pid/comm" 2>/dev/null || true)"
      echo "process ${pid#/proc/} ($comm) as $(id -nu "$uid" 2>/dev/null || echo "$uid"), in ${cg##*/}"
    done
  fi
  if [ -n "$(ls -A "/var/lib/worklane-test/$name/runs" 2>/dev/null)" ]; then
    echo "test runs in progress: $(ls -1 "/var/lib/worklane-test/$name/runs" | tr '\n' ' ')(let them finish, or wipe them with the sandbox helper)"
  fi
  return 0
}

# Where the instances' checkouts live (instance.sh makes $SRV_ROOT/<name>), and the engine's command.
SRV_ROOT=/srv/worklane
ENGINE_CLI=/usr/local/bin/worklane
# add-project's wait for a repo's setup PR to merge: how often it checks, and (empty: its --timeout) for how long.
SETUP_POLL_SECONDS=20 SETUP_WAIT_SECONDS=""
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

# Every user an instance's agents or evals run as (each coordinator's instance.yaml run_as), one per line: never
# a GPU lock's holder (testrun-gpu.sh) or a member of the GPU's device group (gpu-devices.sh).
run_as_users() {
  local u h f
  while IFS=: read -r u _ _ _ _ h _; do
    [[ "$u" == wl-* && -n "$h" && "$h" != / ]] || continue
    for f in "$h"/.local/state/worklane/instances/*/instance.yaml; do
      [ -f "$f" ] || continue
      sed -n -e 's/^  agent_user: *//p' -e 's/^  eval_user: *//p' "$f" | tr -d "\"'" | sed 's/[[:space:]]*$//'
    done
  done < <(getent passwd)
}
# Why a name can't be an instance's (printed; nothing when it can): lowercase letters, digits and dashes, at most 21,
# and never a name whose users, group or units are already another's (wl-test-<x> is instance x's test user, wl-ci-<x>
# a CI runner's, wl-<x>-agent instance x's agent, wl-dash the viewer; worklane-dashboard-<x>.service x's dashboard).
# The same rules, word for word: src/instance-name.ts, the machine helper's instanceName and the testrun helper's copy
# of this function (test/instance-name.test.ts holds them equal).
instance_name_problem() {
  local n="$1"
  if [[ ! "$n" =~ ^[a-z][a-z0-9-]{0,20}$ ]]; then echo "lowercase letters, digits and dashes, starting with a letter, at most 21"
  elif [ "$n" = dash ]; then echo "wl-dash is the dashboard viewer"
  elif [ "$n" = hub ] || [ "$n" = hub-setup ]; then echo "worklane-dashboard-$n.service is the dashboard hub's"
  elif [ "$n" = update ] || [ "$n" = tailscale ] || [ "$n" = claude-account ]; then echo "worklane-$n.service is the machine's own"
  elif [ "$n" = agent ] || [ "$n" = eval ] || [ "$n" = work ]; then echo "its test user wl-test-$n would be instance test's $n name, and wl-ci-$n the $n name of instance ci"
  elif [[ "$n" == test-* ]]; then echo "wl-$n is the test user of instance ${n#test-}"
  elif [[ "$n" == ci-* ]]; then echo "wl-$n is the user of CI runner ${n#ci-}"
  elif [[ "$n" == dashboard-* ]]; then echo "worklane-$n.service is the dashboard of instance ${n#dashboard-}"
  elif [[ "$n" =~ ^(.+)-(agent|eval|work)$ ]]; then echo "wl-$n is instance ${BASH_REMATCH[1]}'s ${BASH_REMATCH[2]} name"
  fi
}
instance_name_ok() { [ -z "$(instance_name_problem "$1")" ]; }
# Refuse a name that can't be an instance's, saying why: `need_instance_name <name> [<what it is>]`.
need_instance_name() { local why; why="$(instance_name_problem "$1")"; [ -z "$why" ] || { echo "${2:-instance name} ${1:-(none)}: $why" >&2; exit 2; }; }
# Why a name can't be a CI runner's (ci-runner.sh --name; nothing when it can): an instance's shape, never agent, eval
# or work (wl-ci-<x> is then instance ci's), nor ending in -docker or -reset (another runner's units). As
# src/instance-name.ts ciRunnerNameProblem.
ci_runner_name_problem() {
  local n="$1"
  if [[ ! "$n" =~ ^[a-z][a-z0-9-]{0,20}$ ]]; then echo "lowercase letters, digits and dashes, starting with a letter, at most 21"
  elif [ "$n" = agent ] || [ "$n" = eval ] || [ "$n" = work ]; then echo "wl-ci-$n is instance ci's $n name"
  elif [[ "$n" =~ ^(.+)-(docker|reset)$ ]]; then echo "worklane-ci-$n@.service is CI runner ${BASH_REMATCH[1]}'s ${BASH_REMATCH[2]} unit"
  fi
}
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
# The same for a new account profile's token (claude-account.sh profile-add --token-from): stored by the dashboard
# before it asks, read once by the script as root, and deleted.
CLAUDE_PROFILE_CREDENTIAL=claude-profile-token
# The one-time code a relayed sign-in (claude-account.sh login) takes: pasted by a machine owner in the asking
# instance's dashboard, stored for its coordinator user only (0400), read once by the script as root, and deleted.
CLAUDE_LOGIN_CREDENTIAL=claude-login-code
# The machine change log (the machine helper's, root's 0644): the watchdog posts what it finds there to the ops channel.
MACHINE_CHANGES=/var/lib/worklane/machine-changes.jsonl
# A token from `claude setup-token`, strictly: install_claude_token's check, and src/claude-account.ts's.
# (The length apart: a repeat bound over 255 is no regular expression to every libc.)
claude_token_ok() { [[ "${#1}" -le 513 && "$1" =~ ^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}$ ]]; }
# claude auth status --json as this user (with a Claude config dir: on that login, an account profile's); nothing when
# claude isn't installed or doesn't answer within a minute.
#   claude_status_json <user> [<claude config dir>]
claude_status_json() {
  command -v claude >/dev/null 2>&1 || return 0
  (cd / && sudo -H -u "$1" timeout 60 ${2:+env "CLAUDE_CONFIG_DIR=$2"} claude auth status --json 2>/dev/null) || true
}
# Whether the API takes this user's Claude login (issue #463: claude auth status says a credential is configured, not
# that it works): one minimal real call as that user, the cheapest model, a one-word answer, one turn, a hard budget
# cap. A refused call costs nothing; an answered one about one short Haiku turn. Prints nothing and succeeds when
# Claude answered; else prints Claude's message (token-shaped strings redacted, 500 characters at most) and fails.
# With a Claude config dir: the call on that login (an account profile's).
#   claude_api_check <user> [<claude config dir>]
CLAUDE_PROOF_ARGS=(-p "Reply with the single word: ok" --model haiku --max-turns 1 --max-budget-usd 0.05 --output-format json)
claude_api_check() {
  command -v claude >/dev/null 2>&1 || { echo "claude is not installed"; return 1; }
  local out
  out="$( (cd / && sudo -H -u "$1" timeout 120 ${2:+env "CLAUDE_CONFIG_DIR=$2"} claude "${CLAUDE_PROOF_ARGS[@]}" 2>&1) || true)"
  printf '%s' "$out" | "$(command -v node)" -e '
const text = require("node:fs").readFileSync(0, "utf8");
let j = null;
for (const l of text.trim().split("\n").reverse()) {
  try {
    const o = JSON.parse(l);
    if (o && typeof o === "object" && o.type === "result") { j = o; break; }
  } catch {}
}
if (j && ((j.subtype === "success" && !j.is_error) || j.subtype === "error_max_budget_usd")) process.exit(0);
const said = `${j && j.api_error_status ? `HTTP ${j.api_error_status}: ` : ""}${(j && j.result) || text.trim() || "claude gave no answer"}`;
const clean = said.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]").replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{20,}=*/g, "$1 [REDACTED]").replace(/\s+/g, " ").trim();
process.stdout.write(clean.slice(0, 500));
process.exit(1);
'
}
# One user's Claude credentials file put back as it was (a switch's rollback): the content on stdin, written as that
# user, 0600, by a rename; empty stdin: there was none, so the file is removed. Never an argument or a log line.
#   restore_claude_credentials <user> <claude config dir>
restore_claude_credentials() {
  (cd / && sudo -H -u "$1" "$(command -v node)" -e '
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[1];
if (!dir || !dir.startsWith("/")) process.exit(2);
const file = join(dir, ".credentials.json");
const prev = readFileSync(0, "utf8");
if (!prev.trim()) {
  if (existsSync(file)) rmSync(file);
  process.exit(0);
}
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, prev, { mode: 0o600 });
renameSync(tmp, file);
' "$2")
}
# Whether a path is a plain file (not a link) that this user owns.
file_owned_by() { [ -f "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -maxdepth 0 -type f -user "$2" 2>/dev/null)" ]; }
# Pause an instance: SIGTERM to its coordinator's main process only. It starts no more runs, lets the ones it has
# going finish, then exits on its own; a clean exit isn't restarted (Restart=on-failure). Its unit's own stop
# (unit_stop, `systemctl stop`) would end those runs after TimeoutStopSec: used only once the wait has timed out.
unit_drain() { systemctl kill --kill-whom=main --signal=SIGTERM "$1"; }
unit_stop() { systemctl stop "$1"; }
unit_start() { systemctl start "$1"; }

# The engine repo's checks on main, one name per element (names hold commas, so never a joined string): the fast
# ones every push to main runs (ci.yml, gitleaks.yml) and the slow ones (ci-slow.yml: bootstrap on each OS, the real
# systemd and real users jobs, the wizard end to end), which run on main in batches, on the newest commit, one batch at a time
# (ci-batch.yml). A pull request needn't run the slow ones, so main is where they gate, and only a batched commit
# can be installed. Pull-request-only checks (dco) are left out: they're always "skipped" on main, and the updater
# refuses a skipped required check. A test derives this list from the workflows.
UPDATE_DEFAULT_CHECKS=("Claude sign-in probe (real users)" "add-project (real systemd)" "agentshield" "bootstrap (macos-latest)" "bootstrap (ubuntu-latest)" "bootstrap (windows-wsl)" "denylist" "desktop" "push-gate" "scan" "test (ubuntu-latest, 22)" "test (ubuntu-latest, 24)" "test-run sandbox (real systemd)" "wizard end to end (real systemd)")

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
