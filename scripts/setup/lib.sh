# Shared helpers for the setup scripts. Sourced, not run.
set -euo pipefail

# Re-run as root through sudo when started as an ordinary admin user.
as_root() {
  if [ "$(id -u)" -ne 0 ]; then exec sudo -- bash "$0" "$@"; fi
}

# A user's home directory, from the passwd database: never assumed to be /home/<user>.
home_of() { getent passwd "$1" | cut -d: -f6; }

# The host's egress rule (egress-firewall.sh): its nftables table, and the set of cgroups exempt from it. A unit whose
# NFTSet= names the set (test-user.sh's Docker unit) has its cgroup added by systemd while it runs. Named once here, so
# the rule and the units that join it can't disagree.
EGRESS_TABLE=worklane_egress
EGRESS_SET=egress_ok
# NFTSet= is in systemd 255 and later; on an older one nothing can fill the set, so test users stay opt-in there.
EGRESS_NFTSET_SYSTEMD=255
# The rule's record: the uids it covers, its flags, and whether test users' Docker may be exempt. Root's: /etc/worklane
# is root's, 0755, and no sandbox user may enter it (test-user.sh denies it to the test user).
EGRESS_RECORD=/etc/worklane/egress.users
# Whether test users' Docker may be exempt from the host egress rule (the set, #543), from the rule's record $1:
# "exempt", or "dropped" once a rule this install loaded covered test users with no exception for their Docker.
#   - the record's "# docker: dropped" or "# docker: exempt" line (apply writes one; dropped wins);
#   - else a record from before #543: "# --with-test-users" in it means dropped; none, exempt (test users weren't covered);
#   - no record (no rule was ever applied, or revert removed it): exempt. A record it can't read: dropped.
# WHY: where a rule covered test users and their Docker had no exception (apply --with-test-users before #543, or on a
# systemd older than 255), all of Docker's traffic was dropped, and so was every route out through it: a run that joins
# Docker's namespaces got nowhere. The exception reopens that route (docs/test-runs.md, "Known gap"), and nothing may
# reopen a route an install had closed. Such an install keeps dropping Docker's traffic, whatever the flags, until revert.
egress_docker_mode() {
  local rec
  [ -e "$1" ] || { echo exempt; return 0; }
  rec="$(cat "$1" 2>/dev/null)" || { echo dropped; return 0; }
  if grep -qx '# docker: dropped' <<<"$rec"; then echo dropped
  elif grep -qx '# docker: exempt' <<<"$rec"; then echo exempt
  elif grep -qx '# --with-test-users' <<<"$rec"; then echo dropped
  else echo exempt; fi
}
# systemd's major version (systemctl's first line, "systemd 255 (...)"); 0 when it can't be read.
systemd_major() {
  local v
  v="$(systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p' || true)"
  echo "${v:-0}"
}

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

# How root runs a command as another user, as run_as does: sudo, never a login shell (a test stands in for it).
as_user_argv() { AS_USER=(sudo -H -u "$1" env GIT_TERMINAL_PROMPT=0); }
# Close every file descriptor above 2 this shell holds (#904): add-project's event stream (fd 3), its lock (fd 9),
# anything else inherited. For a subshell about to start what another user, or a parse of their bytes, runs: nothing
# of the caller's then depends on sudo's closefrom, or on a process that outlives the bound. With no /proc listing,
# every descriptor below the soft limit (ulimit -n; none above it can be opened), 65536 when that isn't a number.
close_fds() {
  local fd me="$BASHPID" max
  max="$(ulimit -n 2>/dev/null)" || true
  [[ "$max" =~ ^[0-9]+$ ]] || max=65536
  for fd in $(ls /proc/"$me"/fd 2>/dev/null || seq 3 "$((max - 1))"); do
    [ "$fd" -gt 2 ] 2>/dev/null && { eval "exec $fd>&-"; } 2>/dev/null
  done
  return 0
}
# run_as with a bound that user can't freeze (#904). The timeout is root's, outside sudo -u, so no process of that user
# can signal it; past the bound it sends SIGKILL to its whole process group, the user's processes started for this
# included, a stopped (SIGSTOP) one too. Of the caller's, that user's processes get only /dev/null as stdin, <out> (a
# file root made, or /dev/null) as stdout, and /dev/null as stderr: every other descriptor is closed first
# (close_fds), so one that escapes the group (setsid) or outlives the bound holds no pipe of the caller's and no lock.
# Exit 137 when cut off.
#   run_as_bounded <user> <seconds> <out> <script> [args...]
run_as_bounded() { run_as_bounded_input "$@" </dev/null; }
# run_as_bounded, but that user's stdin is the caller's (a secret piped in, a program on a heredoc), not /dev/null.
#   run_as_bounded_input <user> <seconds> <out> <script> [args...]
run_as_bounded_input() {
  local user="$1" secs="$2" out="$3" script="$4"; shift 4
  as_user_argv "$user"
  (close_fds; cd / && exec timeout -s KILL "$secs" "${AS_USER[@]}" bash -euo pipefail -c "$script" _ "$@") >"$out" 2>/dev/null
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

# The sudoers rule for the machine helper: each coordinator user named may run exactly the 36
# allowed commands (set-slots 1..16, set-updates on, set-updates off, set-test-slots 1..8, claude-account status,
# install-updater, set-update-channel release, tailscale install, tailscale up, tailscale serve, tailscale public-url,
# and set-policy's three tightenings below) as root, and nothing else.
# Listed one by one, no wildcards or patterns. Never for the dashboard viewer (wl-dash).
# No other claude-account command (#758): switch, profile-add and login took a Claude credential (#711, #749), and
# use, remove and failover managed the account profiles the engine no longer has (#736). The helper refuses each, and
# no rule names one, so an older rule that did is gone on the next machine-helper.sh run (install_sudoers replaces it).
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
# The plugin steps, set-policy, the two signer rules and add-project are written only when this machine's sudo reads them as patterns (sudo_regex_ok): an
# older sudo would take a pattern as literal text, so they are left out there, the rule says so in a comment, and
# machine-helper.sh records it in HELPER_RULES for the dashboard (which then shows the root command instead).
HELPER_RULES=/etc/worklane/helper-rules.json
MACHINE_HELPER=/usr/local/libexec/worklane-machine
MACHINE_SUDOERS=/etc/sudoers.d/worklane-machine   # what install_sudoers worklane-machine writes
ADD_PROJECT_SUDOERS_ARGS='^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
# One key of the asking coordinator's root policy.yaml (issue #726): a key and a value of these characters; the helper
# takes only its fixed keys, each in its exact shape, and never a loosening (src/policy-gate.ts). No instance.
POLICY_SUDOERS_ARGS='^set-policy [a-z][a-z_.]* [a-z0-9.+-]+$'
# Its three tightenings (the engine's HELPER_ONLY: test/policy-edit.test.ts holds them equal), each listed whole, so
# every sudo, however old, matches them exactly, as it does set-updates off: turning auto_merge off, land_mode back to
# pr and main_watch back to auto work from a dashboard on any sudo (#726).
POLICY_TIGHTEN_ARGS=('set-policy auto_merge off' 'set-policy land_mode pr' 'set-policy main_watch auto')
SIGNER_SUDOERS_ARGS='[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$'
# The plugin steps (src/plugins/, plugins.sh): an id, and for a fetch an https URL with a commit (and a subdirectory),
# for a stage a digest and roles. sudoers needs ':' escaped, so the patterns say '.' where the helper, which checks every
# argument exactly again, requires 'https:' and 'sha256:'. No instance: the helper takes the asking coordinator's from SUDO_USER.
PLUGIN_SUDOERS_ARGS=(
  '^plugin-fetch [a-z0-9][a-z0-9-]* https.//[A-Za-z0-9.-]+/[A-Za-z0-9._~/-]+ [0-9a-f]{40}$'
  '^plugin-fetch [a-z0-9][a-z0-9-]* https.//[A-Za-z0-9.-]+/[A-Za-z0-9._~/-]+ [0-9a-f]{40} [A-Za-z0-9._/-]+$'
  '^plugin-stage [a-z0-9][a-z0-9-]* sha256.[0-9a-f]{64} [a-z][a-z0-9+-]*$'
  '^plugin-withdraw [a-z0-9][a-z0-9-]*$'
  '^plugin-remove [a-z0-9][a-z0-9-]*$'
  '^mcp-fetch [a-z0-9][a-z0-9-]* [a-z0-9][a-z0-9._~-]* [0-9][0-9A-Za-z.-]*$'
  '^mcp-fetch [a-z0-9][a-z0-9-]* @[a-z0-9][a-z0-9._~-]*/[a-z0-9][a-z0-9._~-]* [0-9][0-9A-Za-z.-]*$'
  '^mcp-fetch [a-z0-9][a-z0-9-]* [a-z0-9][a-z0-9._~-]* [0-9][0-9A-Za-z.-]* [a-z0-9][a-z0-9-]*[.][a-z0-9.-]+$'
  '^mcp-fetch [a-z0-9][a-z0-9-]* @[a-z0-9][a-z0-9._~-]*/[a-z0-9][a-z0-9._~-]* [0-9][0-9A-Za-z.-]* [a-z0-9][a-z0-9-]*[.][a-z0-9.-]+$'
  '^mcp-preview [a-z0-9][a-z0-9-]* [a-z0-9][a-z0-9-]* [A-Za-z0-9_-]+$'
  '^mcp-snapshot [a-z0-9][a-z0-9-]*$'
  '^mcp-stage [a-z0-9][a-z0-9-]* sha256.[0-9a-f]{64} [a-z][a-z0-9+-]* [a-z0-9*.+-]+ [A-Za-z0-9_+]+$'
)
# Whether this machine's sudo is 1.9.10 or later, the first that reads a command's arguments written ^...$ as a regular
# expression (from `sudo -V`'s first line, "Sudo version X.Y.Z[pN]"). Unknown is no.
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
  cmds+=("$MACHINE_HELPER claude-account status")
  cmds+=("$MACHINE_HELPER install-updater" "$MACHINE_HELPER set-update-channel release")
  # Tailscale (tailscale.sh): four fixed commands. sudo matches a listed command's arguments exactly, so none takes an
  # auth key, a flag, a URL or a port.
  cmds+=("$MACHINE_HELPER tailscale install" "$MACHINE_HELPER tailscale up" "$MACHINE_HELPER tailscale serve" "$MACHINE_HELPER tailscale public-url")
  for n in "${POLICY_TIGHTEN_ARGS[@]}"; do cmds+=("$MACHINE_HELPER $n"); done
  if sudo_regex_ok; then
    cmds+=("$MACHINE_HELPER ^stage-update-signer $SIGNER_SUDOERS_ARGS" "$MACHINE_HELPER ^discard-update-signer $SIGNER_SUDOERS_ARGS")
    for n in "${PLUGIN_SUDOERS_ARGS[@]}"; do cmds+=("$MACHINE_HELPER $n"); done
    cmds+=("$MACHINE_HELPER $POLICY_SUDOERS_ARGS" "$MACHINE_HELPER $ADD_PROJECT_SUDOERS_ARGS")
  else
    signer_rules=0
  fi
  printf '# Coordinators may change the machine slot caps and the update switch, refresh the agents'"'"' Claude account status, put the machine on Tailscale, add a project, and set the engine updater up (install it, follow releases, stage a release signer for an admin to confirm), through one validating helper.\n'
  [ "$signer_rules" = 1 ] || printf '# Not here: add-project, stage-update-signer and discard-update-signer. This sudo (%s) is older than %s and would read their patterns as literal text.\n' "$(sudo_version || true)" "$SUDO_REGEX_MIN"
  [ "$signer_rules" = 1 ] || printf '# Nor the plugin steps (plugin-fetch, plugin-stage, plugin-withdraw, plugin-remove, mcp-fetch, mcp-preview, mcp-snapshot, mcp-stage): plugins.sh at a root shell instead.\n'
  [ "$signer_rules" = 1 ] || printf '# Nor set-policy: a root policy.yaml changes at a root shell instead (worklane policy set), but for its three tightenings, listed whole (auto_merge off, land_mode pr, main_watch auto).\n'
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
# The removed Siri gateway's loopback port, and the tailnet HTTPS port an older install forwarded to it (#743):
# tailscale.sh unserve-siri takes that forward away.
SIRI_GATEWAY_PORT=4397
SIRI_TAILNET_PORT=8443
# The hub's hooks gateway for webhook automations (dashboards.sh --hooks), and the tailnet HTTPS port tailscale.sh
# serve-hooks publishes it on.
HOOKS_GATEWAY_PORT=4396
HOOKS_TAILNET_PORT=8444
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
# The hub's machine devices: its --machine-devices, else an older unit's --console-devices, the same list (#742).
hub_machine_devices() { local v; v="$(hub_option --machine-devices)"; [ -n "$v" ] || v="$(hub_option --console-devices)"; printf '%s' "$v"; }
# The instances the hub serves (its --hub <name>=<state>,...), one per line.
hub_instances() { hub_option --hub | tr ',' '\n' | sed 's/=.*$//' | grep -E '^[a-z][a-z0-9-]{0,20}$' || true; }

# The hub's own settings, to run dashboards.sh again with another list of instances and nothing else changed: one word
# a line (its sign-in App's client id, its URL, its machine devices, --siri and --hooks when it has those gateways).
# An older unit's --console-devices (the removed owner terminal's list) is kept as the machine devices; its
# --console-user is dropped (#742).
hub_keep_args() {
  local v
  printf '%s\n' --client-id "$(hub_option --client-id)" --public-url "$(hub_option --public-url)"
  v="$(hub_machine_devices)"; [ -z "$v" ] || printf '%s\n' --machine-devices "$v"
  [ -z "$(hub_option --siri-port)" ] || printf '%s\n' --siri
  [ -z "$(hub_option --hooks-port)" ] || printf '%s\n' --hooks
}

# The mount points at or under what an instance's removal deletes (its users' homes, its paths in the registry), one
# a line, "<mount point>\t<engine|other>". engine: an experiment job's output volume the helper made and a cut-off job
# left mounted, known by both its place, exactly /var/lib/worklane-exp/<name>/jobs/<job>/vol, and its source, a loop
# device whose backing file is that job's vol.img; instance-remove.sh unmounts those. Anything else is other, and
# instance-remove.sh and instance-rename.sh refuse while there is any (rm --one-file-system would stop at each).
instance_mounts() {
  local name="$1" k w p m roots=()
  while IFS=$'\t' read -r k w _; do
    case "$k" in
      user) if user_exists "$w"; then roots+=("$(home_of "$w")"); fi ;;
      path) roots+=("$w") ;;
    esac
  done < <("$(command -v node)" "$(dirname "${BASH_SOURCE[0]}")/instance-records.cjs" items "$name")
  findmnt -rn -o TARGET 2>/dev/null | while read -r m; do
    for p in "${roots[@]}"; do
      if [[ -n "$p" && "$p" != / && ( "$m" == "$p" || "$m" == "$p"/* ) ]]; then
        if engine_volume "$name" "$m"; then printf '%s\tengine\n' "$m"; else printf '%s\tother\n' "$m"; fi
      fi
    done
  done | sort -u
  return 0
}
# Whether <mount point> is <name>'s experiment job output volume, positively: its exact place and a loop device backed
# by exactly that job's vol.img (worklane-exp.sh makes both: mount -o loop <job dir>/vol.img <job dir>/vol).
engine_volume() {
  local name="$1" m="$2" src back
  [[ "$m" =~ ^/var/lib/worklane-exp/${name}/jobs/[a-z][a-z0-9-]{0,47}/vol$ ]] || return 1
  src="$(findmnt -rn -o SOURCE --mountpoint "$m" 2>/dev/null | head -1)"
  [[ "$src" =~ ^/dev/loop[0-9]+$ ]] || return 1
  back="$(losetup -n -O BACK-FILE "$src" 2>/dev/null | sed 's/[[:space:]]*$//')"
  [ "$back" = "${m%/vol}/vol.img" ]
}

# Every directory directly in <dir> but state/ (an instance home's: git-hooks/ and any other), archived whole into
# <tar> (links kept as links, never followed) and listed in <list>, "<path>\t<size in bytes>" for each file (a link:
# "link"), sorted;
# both 0600. Prints the listing. Nothing to archive: neither is written, and it says so.
#   archive_dirs <dir> <tar> <list>
archive_dirs() {
  local dir="$1" tarf="$2" list="$3" x dirs=()
  for x in "$dir"/*/ "$dir"/.[!.]*/; do
    x="${x%/}"
    [ -d "$x" ] && [ ! -L "$x" ] || continue
    [ "${x##*/}" != state ] || continue
    dirs+=("${x##*/}")
  done
  if [ "${#dirs[@]}" -eq 0 ]; then echo "no directory in $dir but state/: nothing to archive"; return 0; fi
  (umask 077; tar -C "$dir" -cf "$tarf" -- "${dirs[@]}")
  # A link is listed as one (its target never read): "<path>\tlink".
  (umask 077; cd "$dir" && find "${dirs[@]}" \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r x; do
    if [ -L "$x" ]; then printf '%s\tlink\n' "$x"; else printf '%s\t%s\n' "$x" "$(wc -c < "$x" | tr -d ' ')"; fi
  done > "$list")
  chmod 0600 "$tarf" "$list"
  echo "archived ${dirs[*]} from $dir to $tarf; the files (path, bytes), also in $list:"
  sed 's/^/  /' "$list"
}

# Every process of instance <name>'s users <user>... gone, before they are deleted (userdel refuses a user with
# processes) and before what they owned is walked. Prints each process still left, "<pid> <uid> <command>" (or why it
# stopped), and exits 1 when there is any.
#   1. their accounts locked: no password, expired, no shell: nothing new starts as them (their linger goes in 3);
#   2. its coordinator and dashboard must be stopped already (instance-remove.sh refuses up front while either runs):
#      found active here (started since), it stops, naming the command, and touches nothing; never stopped by this;
#   3. every other engine unit whose User= is one of them (its test runs and Docker, experiment and score steps, MCP
#      broker, network helpers: worklane-*, User= checked first, so another instance's unit is never touched) and
#      their user slices (user-<uid>.slice, user@<uid>.service) killed and stopped: the cgroup takes the whole tree;
#   4. what is left outside those cgroups: pkill -KILL by uid (real and effective, never a name), pass after pass
#      until one finds none, at most STOP_PASSES (20) passes, 0.5 s apart;
#   5. the last check, failing closed (#614): STOP_RECHECKS (5) listings, 0.2 s apart, as $PROC_DIR names them. Every
#      pid any of them lists counts as left and refuses the removal, named with its command ("?" when it can't be
#      read). One gone before its command is read (it ended, or a fork loop moved on to a new pid, its next one born
#      after the scan) is named "(gone before its command could be read)", with a line saying a process was seen and
#      to run the removal again once the instance is stopped. Only when no listing lists any pid does it go on: a
#      single empty listing never passes by itself, since a scan can miss a process that forks and exits fast.
# INSTANCE_REMOVE_TEST_NO_KILL=1 (CI's proof that a process left refuses the removal): steps 3 and 4 are skipped, so
# the check only ever finds more; it never lets a removal go on.
#   stop_uids <name> <user>...
STOP_PASSES=20
STOP_RECHECKS=5
stop_uids() {
  local name="$1" u uid uids=() names=() unit owner pass left pid cmd round gone
  shift
  for u in "$@"; do user_exists "$u" && { names+=("$u"); uids+=("$(id -u "$u")"); }; done
  [ "${#uids[@]}" -gt 0 ] || return 0
  for u in "${names[@]}"; do usermod -L -e 1 -s /usr/sbin/nologin "$u" >/dev/null; done
  for unit in "worklane-$name.service" "worklane-dashboard-$name.service"; do
    if systemctl is-active -q "$unit"; then echo "$unit is running (it started since the check): stop it first: sudo systemctl stop $unit"; return 1; fi
  done
  if [ "${INSTANCE_REMOVE_TEST_NO_KILL:-}" != 1 ]; then
    for u in "${names[@]}"; do loginctl disable-linger "$u" 2>/dev/null || true; done
    for unit in $(systemctl list-units --all --plain --no-legend --full 'worklane-*' 2>/dev/null | awk '{print $1}'); do
      [ "$unit" != "worklane-$name.service" ] && [ "$unit" != "worklane-dashboard-$name.service" ] || continue
      owner="$(systemctl show -p User --value "$unit" 2>/dev/null || true)"
      [ -n "$owner" ] && printf '%s\n' "${names[@]}" | grep -qxF -- "$owner" || continue
      systemctl kill --signal=KILL "$unit" 2>/dev/null || true
      systemctl stop "$unit" 2>/dev/null || true
    done
    for uid in "${uids[@]}"; do
      systemctl kill --signal=KILL "user@$uid.service" "user-$uid.slice" 2>/dev/null || true
      systemctl stop "user@$uid.service" "user-$uid.slice" 2>/dev/null || true
    done
    # Right before the loop, again: no coordinator or dashboard process is ever killed by uid.
    for unit in "worklane-$name.service" "worklane-dashboard-$name.service"; do
      if systemctl is-active -q "$unit"; then echo "$unit is running (it started since the check): stop it first: sudo systemctl stop $unit"; return 1; fi
    done
    for ((pass = 0; pass < STOP_PASSES; pass++)); do
      left=""
      for uid in "${uids[@]}"; do
        pkill -KILL -U "$uid" 2>/dev/null || true
        pkill -KILL -u "$uid" 2>/dev/null || true
        if pgrep -U "$uid" >/dev/null 2>&1 || pgrep -u "$uid" >/dev/null 2>&1; then left=1; fi
      done
      [ -n "$left" ] || break
      sleep 0.5
    done
  fi
  for ((round = 0; round < STOP_RECHECKS; round++)); do
    [ "$round" -eq 0 ] || sleep 0.2
    left="" gone=""
    for uid in "${uids[@]}"; do
      while read -r pid; do
        [ -n "$pid" ] || continue
        # Every pid listed counts as left, whatever its read finds (#614, failing closed). The read only names it:
        # stderr is redirected before the input, so a vanished file's open says nothing, and no pipe hides the read's
        # status. A failed read with the /proc dir still there: "?"; with it gone: the process was seen, then ended.
        if ! cmd="$(tr '\0' ' ' 2>/dev/null < "$PROC_DIR/$pid/cmdline")"; then
          if [ -d "$PROC_DIR/$pid" ]; then
            cmd="?"
          else
            cmd="(gone before its command could be read)"
            [[ " $gone " == *" $uid "* ]] || gone="${gone:+$gone }$uid"
          fi
        fi
        printf '%s %s %s\n' "$pid" "$uid" "${cmd:0:200}"
        left=1
      done < <({ pgrep -U "$uid"; pgrep -u "$uid"; } 2>/dev/null | sort -un)
    done
    if [ -n "$left" ]; then
      [ -z "$gone" ] || echo "uid $gone: a process was seen, then was gone before its command could be read (it ended, or a fork loop moved on to a new pid): it counts as still running; stop the instance, then run the removal again"
      return 1
    fi
  done
  return 0
}

# Files the removed users <uid>... own in the engine's own places, given to root: in each <tree> (find -P, -xdev: a
# link is never followed, another mount never entered) and, in <lock dir>, only the files named <lock name>, directly
# in it. Each is changed by instance-records.cjs rechown, on ONE fd opened without following a link (O_NOFOLLOW): the
# slot directory is 2770 with no sticky bit, so another instance's coordinator can rename a link over a path between
# the walk and the change, and nothing a link points at is ever changed (a link itself: lchown, which never follows).
# The fd's own fstat decides: a file no removed uid owns now is left as it is; the owner becomes root, and the group
# root too when it is one of the removed instance's <gids> (comma-separated); another group is kept (the slot
# directory's files are group agent-slots, which every other instance's coordinator reads them through). A regular
# file also loses setuid and setgid, its other mode bits kept; in a shared engine group (one kept: not the instance's,
# not root) group write too: the engine never writes one of its files there in place, it puts a copy over it (renamed
# or linked: src/locks.ts, the incident store, the claims), which needs the directory's group write only. A directory
# there keeps its group write, listed with why: the group's members add and replace the engine's files in it. Each is
# listed in <listing>, "<owner>:<group> <old mode> -> <new mode> <path>[ (g+w kept: <why>)]", "left <path>: <why>", or
# "FAILED <path>: <why>" when a change was refused (never hidden); exit 1 then. Paths are bytes throughout (find
# -print0 to the fds), never decoded. Then the walk again: a file a removed uid still owns after the change (however
# it was missed) is listed "FAILED <path>: still a removed user's after the change", exit 1. Only once no process of
# theirs is left (stop_uids).
#   rechown_orphans <listing> <trees, colon-separated> <lock dir> <lock name> <gids, comma-separated> <uid>...
rechown_orphans() {
  local list="$1" trees="$2" lockdir="$3" lockname="$4" gids="$5" u t rc=0 node to_uid
  shift 5
  local -a tv=() uids=()
  IFS=: read -r -a tv <<<"$trees"
  _rechown_there=()
  for t in "${tv[@]}"; do [ -d "$t" ] && [ ! -L "$t" ] && _rechown_there+=("$t"); done
  for u in "$@"; do [[ "$u" =~ ^[0-9]+$ ]] && uids+=("$u"); done
  : > "$list"
  [ "${#uids[@]}" -gt 0 ] || return 0
  node="${NODE:-$(command -v node)}"
  local cjs; cjs="$(dirname "${BASH_SOURCE[0]}")/instance-records.cjs"
  { for u in "${uids[@]}"; do _rechown_walk "$lockdir" "$lockname" "$u"; done; true; } \
    | "$node" "$cjs" rechown x "$(IFS=,; echo "${uids[*]}")" "$gids" > "$list" || rc=1
  # The walk again, after the change: nothing of theirs may be left (a uid that is the one files are given to, a
  # test's stand-in for root, is theirs by design).
  to_uid="$("$node" "$cjs" root-ids x | cut -d: -f1)"
  for u in "${uids[@]}"; do
    [ "$u" != "$to_uid" ] || continue
    while IFS= read -r -d '' t; do
      printf "FAILED %s: still a removed user's after the change\n" "$t" >> "$list"; rc=1
    done < <(_rechown_walk "$lockdir" "$lockname" "$u")
  done
  return "$rc"
}
# rechown_orphans's walk for one uid, NUL-separated: the trees in _rechown_there, and <lock dir>'s <lock name> files.
_rechown_walk() {
  local lockdir="$1" lockname="$2" u="$3"
  [ "${#_rechown_there[@]}" -eq 0 ] || find -P "${_rechown_there[@]}" -xdev -uid "$u" -print0
  [ ! -d "$lockdir" ] || [ -L "$lockdir" ] || find -P "$lockdir" -xdev -maxdepth 1 -name "$lockname" -uid "$u" -print0
  return 0
}
# Everything else the removed users <uid>... still own on <root>'s filesystem (the removal's: /; read-only: find -P
# -xdev, /proc, /sys and each <skip> path pruned), one path a line, into <listing>: left as it is, for an admin.
#   left_owned <listing> <root> <skip paths, colon-separated> <uid>...
left_owned() {
  local list="$1" top="$2" skips="$3" u; shift 3
  local -a sv=() prune=(-path /proc -o -path /sys) match=()
  IFS=: read -r -a sv <<<"$skips"
  for u in "${sv[@]}"; do [ -z "$u" ] || prune+=(-o -path "$u"); done
  for u in "$@"; do [[ "$u" =~ ^[0-9]+$ ]] && match+=(${match[@]:+-o} -uid "$u"); done
  : > "$list"
  [ "${#match[@]}" -gt 0 ] || return 0
  find -P "$top" -xdev \( "${prune[@]}" \) -prune -o \( "${match[@]}" \) -print 2>/dev/null > "$list" || true
}

# What an instance has in flight, one line each; nothing when it has none (instance-remove.sh and instance-rename.sh
# refuse while it has any): its coordinator service not inactive, any process of its users (the registry's, in
# instance-records.cjs) outside its dashboard, its MCP broker, its test Docker daemon and its own user manager, or a test
# run's directory. PROC_DIR is the process table it (and stop_uids's last listing) reads (a test's stand-in).
PROC_DIR=/proc
instance_in_flight() {
  local name="$1" st k u uids=() pid uid cg comm
  st="$(systemctl show -p ActiveState --value "worklane-$name.service" 2>/dev/null || true)"
  case "$st" in active | activating | deactivating | reloading) echo "its coordinator, worklane-$name.service, is $st: let its runs finish, then: sudo systemctl stop worklane-$name.service" ;; esac
  st="$(systemctl show -p ActiveState --value "worklane-dashboard-$name.service" 2>/dev/null || true)"
  case "$st" in active | activating | deactivating | reloading) echo "its dashboard, worklane-dashboard-$name.service, is $st: sudo systemctl stop worklane-dashboard-$name.service" ;; esac
  while IFS=$'\t' read -r k u _; do
    [ "$k" = user ] && user_exists "$u" && uids+=("$(id -u "$u")")
  done < <("$(command -v node)" "$(dirname "${BASH_SOURCE[0]}")/instance-records.cjs" items "$name")
  if [ "${#uids[@]}" -gt 0 ]; then
    for pid in "$PROC_DIR"/[0-9]*; do
      uid="$(stat -c %u "$pid" 2>/dev/null)" || continue
      [[ " ${uids[*]} " == *" $uid "* ]] || continue
      # A read that fails because the process has exited since its uid was read (its /proc dir gone: a fork loop's
      # short-lived child) leaves nothing in flight; one that fails on a process still there is named all the same.
      cg="$(sed -n 's/^0:://p' "$pid/cgroup" 2>/dev/null)" || [ -d "$pid" ] || continue
      case "$cg" in */worklane-dashboard-"$name".service | */worklane-mcp@"$name".service | */worklane-mcp@"$name".service/* | */worklane-test-"$name"-docker.service | */worklane-test-"$name"-docker.service/* | */user@"$uid".service | */user@"$uid".service/*) continue ;; esac
      comm="$(cat "$pid/comm" 2>/dev/null)" || [ -d "$pid" ] || continue
      echo "process ${pid##*/} ($comm) as $(id -nu "$uid" 2>/dev/null || echo "$uid"), in ${cg##*/}"
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

# An instance's policy.yaml, root's (issue #726): the engine, as root, makes it root's 0644 with its content kept (read
# without following a link the coordinator could plant), records it in $POLICY_ROOT_DIR, and prints the isolation and
# merge keys for whoever runs setup to check. From then on the engine refuses it if it stops being root's.
POLICY_ROOT_DIR=/etc/worklane/policy-root
# Whether root's kill switch turns instance $1's auto_merge off, as the engine reads it (src/policy-kill.ts
# autoMergeKilled): its id pointer <name>.id names by_id/<id>/, and any auto-merge-off* there is off. Fail closed: a
# pointer that isn't a plain file or holds no id, an id directory missing or unlistable, or a taken-over instance (its
# record there) with no pointer, all count as off.
auto_merge_killed() {
  local p="$POLICY_ROOT_DIR/$1.id" id f
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then
    [ ! -e "$POLICY_ROOT_DIR" ] || ls -A -- "$POLICY_ROOT_DIR" >/dev/null 2>&1 || return 0
    [ -e "$POLICY_ROOT_DIR/$1" ] && return 0
    return 1
  fi
  [ -f "$p" ] && [ ! -L "$p" ] || return 0
  id="$(head -c 64 -- "$p" 2>/dev/null | tr -d '[:space:]')" || return 0
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || return 0
  ls -A -- "$POLICY_ROOT_DIR/by_id/$id" >/dev/null 2>&1 || return 0
  for f in "$POLICY_ROOT_DIR/by_id/$id"/auto-merge-off*; do
    if [ -e "$f" ] || [ -L "$f" ]; then return 0; fi
  done
  return 1
}
# A rename's start (instance-rename.sh): instance $2's id pointer holds $1's id (made, with its spare, if $1 had none),
# so the two names are one instance's switches: a rename never carries, forwards or moves one (#726 round 9).
instance_alias() { "$ENGINE_CLI" policy alias "$1" "$2"; }
# The id instance $1's pointer holds, or nothing (instance-remove.sh: its id directory goes once no pointer names it).
instance_id_of() { local id; id="$(head -c 64 -- "$POLICY_ROOT_DIR/$1.id" 2>/dev/null | tr -d '[:space:]')" || true; [[ "$id" =~ ^[0-9a-f]{32}$ ]] && echo "$id"; return 0; }
# Whether any instance's pointer still names id $1.
id_in_use() { local f; for f in "$POLICY_ROOT_DIR"/*.id; do [ -f "$f" ] && [ "$(head -c 64 -- "$f" | tr -d '[:space:]')" = "$1" ] && return 0; done; return 1; }
# Never with a flag: the machine helper reaches this as root (add-project's rerun), so it takes over only what the
# coordinator could have set itself, or what root wrote; anything else is an admin's, at a root shell, with one of
# policy own's flags, which no script here passes. test/policy-edit.test.ts holds this line, and that, as they are.
own_policy() { "$ENGINE_CLI" policy own "$1"; }
# A rename (instance-rename.sh): when the old name's policy.yaml was root's, the new name's is too, its content as
# carried. The old name's record goes under the new name first, so `policy own` takes the carried file as content root
# wrote (its sha256 is the record's), with no flag; one that changed since root wrote it is refused, the rename stops.
# Root's auto_merge kill switches need nothing here: both names share one id from the rename's start (instance_alias).
carry_policy_root() {
  [ -f "$POLICY_ROOT_DIR/$1" ] || return 0
  install -m 0644 "$POLICY_ROOT_DIR/$1" "$POLICY_ROOT_DIR/$2"
  own_policy "$2"
}
# Whether instance $1's policy.yaml ($2) is root's already, as recorded: a regular file root's, 0644, one name, and the
# engine's own gate would read it (`policy check`: the recorded file, with what root last wrote there). So the policy
# step is done exactly when the coordinator can start on it; an earlier root file put back runs the step again.
policy_root_ok() { [ -f "$POLICY_ROOT_DIR/$1" ] && [ ! -L "$2" ] && [ "$(stat -c '%u %a %h' -- "$2" 2>/dev/null)" = "0 644 1" ] && "$ENGINE_CLI" policy check "$1" >/dev/null 2>&1; }

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
  elif [ "$n" = update ] || [ "$n" = tailscale ] || [ "$n" = claude-account ] || [ "$n" = egress ]; then echo "worklane-$n.service is the machine's own"
  elif [ "$n" = agent ] || [ "$n" = eval ] || [ "$n" = work ] || [ "$n" = mcp ] || [ "$n" = mcpc ] || [ "$n" = mcpctl ]; then echo "its test user wl-test-$n would be instance test's $n name, and wl-ci-$n the $n name of instance ci"
  elif [[ "$n" == test-* ]]; then echo "wl-$n is the test user of instance ${n#test-}"
  elif [[ "$n" == ci-* ]]; then echo "wl-$n is the user of CI runner ${n#ci-}"
  elif [[ "$n" == exp-* ]]; then echo "wl-$n is the experiment job user of instance ${n#exp-}"
  elif [[ "$n" == score-* ]]; then echo "wl-$n is the experiment scorer user of instance ${n#score-}"
  elif [[ "$n" == dashboard-* ]]; then echo "worklane-$n.service is the dashboard of instance ${n#dashboard-}"
  elif [[ "$n" == plugin-fetch-* ]]; then echo "worklane-$n.service is the plugin fetch of instance ${n#plugin-fetch-}"
  elif [[ "$n" =~ ^(.+)-(agent|eval|work|mcp|mcpc|mcpctl)$ ]]; then echo "wl-$n is instance ${BASH_REMATCH[1]}'s ${BASH_REMATCH[2]} name"
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
  elif [ "$n" = agent ] || [ "$n" = eval ] || [ "$n" = work ] || [ "$n" = mcp ] || [ "$n" = mcpc ] || [ "$n" = mcpctl ]; then echo "wl-ci-$n is instance ci's $n name"
  elif [[ "$n" =~ ^(.+)-(docker|reset)$ ]]; then echo "worklane-ci-$n@.service is CI runner ${BASH_REMATCH[1]}'s ${BASH_REMATCH[2]} unit"
  fi
}
# A GitHub repo, owner/name, strictly: the owner a GitHub login, the name letters, digits, '.', '_' and '-'.
repo_ok() {
  local owner="${1%%/*}" rest="${1#*/}"
  [[ "$1" == */* && "$rest" != */* ]] && github_login_ok "$owner" && [[ "${#rest}" -le 100 && "$rest" =~ ^[A-Za-z0-9_.-]+$ && "$rest" != . && "$rest" != .. ]]
}

# The bounds of the agent-user steps on a Claude login (#613): the token install, then the login check. timeout -k: SIGTERM at the bound, then SIGKILL
# CLAUDE_KILL_AFTER_SECONDS later, since a process with a TERM handler (node has one) or blocked on a hung mount is
# only ended by SIGKILL. Plain assignments: never read from the environment.
CLAUDE_TOKEN_INSTALL_SECONDS=30
CLAUDE_LOGIN_SECONDS=60
CLAUDE_KILL_AFTER_SECONDS=5
# Whether a step's status is timeout cutting it off: 124 (ended by SIGTERM) or 137 (SIGKILL, -k).
cut_off_status() { [ "$1" -eq 124 ] || [ "$1" -eq 137 ]; }
# The agent's Claude login, from `claude setup-token`'s token on stdin, written as that user's own Claude
# credentials (~/.claude/.credentials.json, 0600 in its 0700 ~/.claude; or <dir>/.credentials.json when an instance
# names its agent's claude_config_dir), keeping the file's other entries. The token goes from stdin to that file and
# nowhere else: never an argument, an environment variable or a log line (timeout passes stdin through).
# Bounded (#613): a home on a hung FUSE or network mount must not hold root's setup step for ever.
# Cut off, it says so on stderr and fails (cut_off_status), which every caller reads as a failed install. A cut-off
# between its write and its rename can leave <file>.tmp-<pid> in that user's own 0700 dir (#667).
#   install_claude_token <user> [<claude config dir>]
install_claude_token() {
  local rc=0
  (cd / && sudo -H -u "$1" timeout -k "$CLAUDE_KILL_AFTER_SECONDS" "$CLAUDE_TOKEN_INSTALL_SECONDS" "$(command -v node)" --input-type=module -e '
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
' "${2:-}") || rc=$?
  if cut_off_status "$rc"; then echo "installing the Claude token as $1: cut off after $CLAUDE_TOKEN_INSTALL_SECONDS s (its home didn't answer)" >&2; fi
  return "$rc"
}
# Whether claude, as this user, says it is signed in (no claude on this machine yet: nothing to ask, so yes). Bounded
# (#613, CLAUDE_LOGIN_SECONDS): no answer within the limit is a no, with why on stderr.
claude_login_ok() {
  command -v claude >/dev/null 2>&1 || return 0
  local out rc=0
  out="$(cd / && sudo -H -u "$1" timeout -k "$CLAUDE_KILL_AFTER_SECONDS" "$CLAUDE_LOGIN_SECONDS" claude auth status --json)" || rc=$?
  if cut_off_status "$rc"; then
    echo "claude auth status, as $1, didn't answer within $CLAUDE_LOGIN_SECONDS s (its home may be on a hung mount)" >&2
    return 1
  fi
  [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"loggedIn": *true'
}

# claude-account.sh's dir: what status last found for each agent user (status.json), and what the removed account
# switch and profiles left (#736: switch.jsonl, paused, profiles.json, profile-ops.jsonl; its uninstall removes them).
# Root's, 0644: account names and expiry dates, never a token.
CLAUDE_ACCOUNT_DIR=/var/lib/worklane/claude-account
# What an earlier dashboard stored for claude-account.sh to read once (#711): a switch's token, a new profile's token
# and a relayed sign-in's code. Nothing stores one now; claude-account.sh removes any left behind, unread.
CLAUDE_ACCOUNT_CREDENTIAL=claude-account-token
CLAUDE_PROFILE_CREDENTIAL=claude-profile-token
CLAUDE_LOGIN_CREDENTIAL=claude-login-code
# The machine change log (the machine helper's, root's 0644): the watchdog posts what it finds there to the ops channel.
MACHINE_CHANGES=/var/lib/worklane/machine-changes.jsonl
# A token from `claude setup-token`, strictly: install_claude_token's check.
# (The length apart: a repeat bound over 255 is no regular expression to every libc.)
claude_token_ok() { [[ "${#1}" -le 513 && "$1" =~ ^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}$ ]]; }
# claude auth status --json as this user (with a Claude config dir: on that login); nothing when
# claude isn't installed or doesn't answer within a minute.
#   claude_status_json <user> [<claude config dir>]
claude_status_json() {
  command -v claude >/dev/null 2>&1 || return 0
  (cd / && sudo -H -u "$1" timeout 60 ${2:+env "CLAUDE_CONFIG_DIR=$2"} claude auth status --json 2>/dev/null) || true
}
# The logins an instance billed to an API key runs on (src/runner.ts RUNTIME_LOGINS.api_key; a test keeps the two the
# same), as claude auth status names them.
CLAUDE_API_KEY_LOGINS='api_key|api_key_helper'
# Whether claude, as this user, reports one of those (issue #897): signed in, through an API key. No claude, or no
# answer within AGENT_STATUS_SECONDS: no. Bounded by root (run_as_bounded, #904): add-project asks this under its
# machine-wide lock, and the user owns the process that answers. Its answer goes through a file of root's, never a pipe.
AGENT_STATUS_SECONDS=60
# claude-account.sh status for one instance, run by root under a bound of root's (credentials.sh api-key, #904): a
# status and one minimal real call per agent user, each bounded inside, all of it here.
ACCOUNT_STATUS_SECONDS=300
claude_api_key_login_ok() {
  local out tmp
  command -v claude >/dev/null 2>&1 || return 1
  tmp="$(mktemp)" || return 1
  run_as_bounded "$1" "$AGENT_STATUS_SECONDS" "$tmp" 'exec claude auth status --json' || true
  out="$(head -c 65536 -- "$tmp")"
  rm -f -- "$tmp"
  printf '%s' "$out" | grep -q '"loggedIn": *true' && printf '%s' "$out" | grep -Eq "\"authMethod\": *\"($CLAUDE_API_KEY_LOGINS)\""
}
# Whether a path is where credentials.sh <name> api-key installs an agent's key (#904): <agent home>/.config/
# <instance>-claude-key/api_key, and nothing else of that home (never ~/.ssh/id_ed25519 or the like, which the runner
# would send to the API as the key). Any instance name's directory: a rename keeps its old name (instance-records.cjs
# carry moves the agent's home, not the directory's name). As src/instance.ts isInstalledKeyPath.
#   agent_key_path_ok <agent home> <path>
agent_key_path_ok() { [[ "$2" =~ ^"$1"/\.config/[a-z][a-z0-9-]{0,20}-claude-key/api_key$ ]]; }
# Whether the agent user's own Claude settings name exactly that key file as their apiKeyHelper (`cat -- <path>`, as
# credentials.sh writes it), read as that user (#904): so the login claude reports is the one the runner gives runs
# (it passes `cat -- <agent_api_key>`). The settings only, never the key.
#   agent_key_helper_ok <agent user> <settings file> <path>
# Bounded by root (#904, run_as_bounded): the agent user owns what is checked and the processes checking it, so it
# could make a FIFO, put it on a mount that never answers, or stop (SIGSTOP) the check, while add-project holds the
# machine-wide lock; past AGENT_CHECK_SECONDS root kills them all. The settings are opened without following a link
# and without blocking (a FIFO opens at once), anything but a regular file of at most 64 KiB is refused, and the read
# is capped.
AGENT_CHECK_SECONDS=20
AGENT_KEY_HELPER_JS='const fs=require("fs"),c=fs.constants,MAX=65536;let ok=false;try{const fd=fs.openSync(process.argv[1],c.O_RDONLY|c.O_NONBLOCK|c.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(st.isFile()&&st.size<=MAX){const b=Buffer.alloc(MAX+1);let n=0,r=0;while(n<b.length&&(r=fs.readSync(fd,b,n,b.length-n,null))>0)n+=r;if(n<=MAX){const s=JSON.parse(b.subarray(0,n).toString("utf8"));ok=!!s&&typeof s==="object"&&!Array.isArray(s)&&s.apiKeyHelper===process.argv[2]}}}finally{fs.closeSync(fd)}}catch{}process.exit(ok?0:1)'
agent_key_helper_ok() { run_as_bounded "$1" "$AGENT_CHECK_SECONDS" /dev/null 'exec "$1" -e "$2" "$3" "$4"' "$(command -v node)" "$AGENT_KEY_HELPER_JS" "$2" "cat -- $3"; }
# Whether a path is this agent user's own API key file, as that user finds it (issue #897): a plain file (not a link),
# its own, not empty, with one link, and open to nobody else (no group or other read or write bit). Checked as that
# user, never as root, since the path comes from credentials.yaml, which the coordinator user writes; bounded as above
# (test and find only stat it: a FIFO is not a plain file). The key is never read.
#   agent_key_file_ok <agent user> <path>
AGENT_KEY_FILE_SH='[ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ -s "$1" ] && [ -n "$(find "$1" -maxdepth 0 -type f -links 1 ! -perm -g=r ! -perm -g=w ! -perm -o=r ! -perm -o=w -print)" ]'
agent_key_file_ok() { run_as_bounded "$1" "$AGENT_CHECK_SECONDS" /dev/null "$AGENT_KEY_FILE_SH" "$2"; }
# Whether the API takes this user's Claude login (issue #463: claude auth status says a credential is configured, not
# that it works): one minimal real call as that user, the cheapest model, a one-word answer, one turn, a hard budget
# cap. A refused call costs nothing; an answered one about one short Haiku turn. Prints nothing and succeeds when
# Claude answered; else prints Claude's message (token-shaped strings redacted, 500 characters at most) and fails.
# With a Claude config dir: the call on that login.
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
# Whether a path is a plain file (not a link) that this user owns.
file_owned_by() { [ -f "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -maxdepth 0 -type f -user "$2" 2>/dev/null)" ]; }

# The engine repo's checks on main, one name per element (names hold commas, so never a joined string): the fast
# ones every push to main runs (ci.yml, gitleaks.yml) and the slow ones (ci-slow.yml: bootstrap on each OS, the real
# systemd and real users jobs, the wizard end to end), which run on main in batches, on the newest commit, one batch at a time
# (ci-batch.yml). A pull request needn't run the slow ones, so main is where they gate, and only a batched commit
# can be installed. Pull-request-only checks (dco) are left out: they're always "skipped" on main, and the updater
# refuses a skipped required check. A test derives this list from the workflows.
UPDATE_DEFAULT_CHECKS=("Claude sign-in probe (real users)" "add-project (real systemd)" "agentshield" "bootstrap (macos-latest)" "bootstrap (ubuntu-latest)" "bootstrap (windows-wsl)" "denylist" "desktop" "egress firewall (real systemd)" "push-gate" "scan" "test (ubuntu-latest, 22)" "test (ubuntu-latest, 24)" "test-run sandbox (real systemd)" "wizard end to end (real systemd)")

# updates.json for the engine updater, off: the repo to follow, then each required check as its own argument.
updates_config_json() {
  # A new install follows signed release tags; an existing updates.json (no channel) keeps following main.
  node -e 'const [repo, ...checks] = process.argv.slice(1); process.stdout.write(JSON.stringify({ enabled: false, channel: "release", allowed_signers: "/etc/worklane/allowed_signers", repo_url: repo, branch: "main", required_checks: checks.filter((s) => s.trim()) }, null, 2) + "\n")' "$@"
}

# The removed owner terminal's root files (#742), which an older install has and dashboards.sh removes: its console
# shell, and the sudoers rule that let the hub's viewer user run it as the admin user. Nothing installs them now.
CONSOLE_SHELL=/usr/local/libexec/worklane-console-shell
CONSOLE_SUDOERS=/etc/sudoers.d/worklane-console

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

# Root's word on which instances' repos are managed apps, not the engine (src/managed-apps.ts, managed-apps.sh): for
# those, the self-modification locks on the engine's own source paths stand aside. Root's file; every instance user
# reads it; none can change it. Missing, malformed, or not naming an instance with its repo: every lock applies.
MANAGED_APPS=/etc/worklane/managed-apps.json
# What the engine updates from: the repo it names is the engine's, never a managed app.
UPDATES_JSON=/etc/worklane/updates.json
# The file's new text, {"version":1,"apps":{"<instance>":"<owner/repo>",...}} (names sorted), from the current one:
#   managed_apps_json <file> add <instance> <owner/repo> <updates.json> <engine package.json>
#   managed_apps_json <file> remove <instance>
# Refuses (exit 2), changing nothing: a current file that isn't in this form, a bad name or repo, adding the engine's
# own repo (the engine package.json's repository.url, or updates.json's repo_url), and adding anything when either of
# those can't be told (no updates.json, not JSON, or no GitHub repo named).
managed_apps_json() {
  case "${2:-}" in
    add) need_instance_name "${3:-}"; repo_ok "${4:-}" || { echo "repo ${4:-}: a GitHub owner/name" >&2; return 2; } ;;
    remove) need_instance_name "${3:-}" ;;
    *) echo "managed_apps_json: add or remove" >&2; return 2 ;;
  esac
  node -e '
    const fs = require("fs");
    const [file, op, inst, repo, updates, pkg] = process.argv.slice(1);
    const fail = (m) => { process.stderr.write(m + "\n"); process.exit(2); };
    let cur = { version: 1, apps: {} };
    if (fs.existsSync(file)) {
      try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(file + ": not JSON: fix it or remove it first"); }
      const ok = cur && typeof cur === "object" && Object.keys(cur).sort().join() === "apps,version" && cur.version === 1 && cur.apps && typeof cur.apps === "object" && !Array.isArray(cur.apps) && Object.values(cur.apps).every((r) => typeof r === "string");
      if (!ok) fail(file + ": not in the form managed-apps.sh writes: fix it or remove it first");
    }
    const apps = Object.assign(Object.create(null), cur.apps);
    if (op === "add") {
      // Which repo is the engine: the engine package.json repository.url and updates.json repo_url, both required
      // (src/managed-apps.ts engineRepos reads the same two). Either one missing or unreadable: refuse, never skip.
      const gh = (url) => { const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || "")); return m ? m[1].toLowerCase() : null; };
      let p;
      try { p = JSON.parse(fs.readFileSync(pkg, "utf8")); } catch { fail("the engine package.json (" + pkg + ") cannot be read, so which repo is the engine cannot be told: run this from the engine checkout"); }
      const own = gh(p && p.repository && (typeof p.repository === "string" ? p.repository : p.repository.url));
      if (!own) fail("the engine package.json (" + pkg + ") names no GitHub repository, so which repo is the engine cannot be told");
      if (!updates || !fs.existsSync(updates)) fail("no " + updates + ", so the repo the engine updates from cannot be told: set up updates.sh first");
      let u;
      try { u = JSON.parse(fs.readFileSync(updates, "utf8")); } catch { fail(updates + ": not JSON, so the engine repo it names cannot be told apart: fix it first"); }
      const followed = gh(u && u.repo_url);
      if (!followed) fail(updates + ": its repo_url names no GitHub repo, so the engine repo cannot be told apart: fix it first");
      if (repo.toLowerCase() === own) fail(repo + " is the engine own repo (" + pkg + " repository): the engine, never a managed app");
      if (repo.toLowerCase() === followed) fail(repo + " is the repo the engine on this machine updates from (" + updates + "): the engine, never a managed app");
      apps[inst] = repo;
    } else delete apps[inst];
    const sorted = {};
    for (const k of Object.keys(apps).sort()) sorted[k] = apps[k];
    process.stdout.write(JSON.stringify({ version: 1, apps: sorted }) + "\n");
  ' "$1" "$2" "$3" "${4:-}" "${5:-}" "${6:-}"
}
# Write the managed apps file, root:root 0644: a dotted temp name next to it, then moved into place.
#   install_managed_apps <file> add <instance> <owner/repo> <updates.json> <engine package.json>
#   install_managed_apps <file> remove <instance>
install_managed_apps() {
  local file="$1" json tmp
  json="$(managed_apps_json "$@")" || return 2
  [ -d "$(dirname "$file")" ] || { echo "no $(dirname "$file"); run machine.sh first" >&2; return 1; }
  tmp="$(dirname "$file")/.$(basename "$file").tmp"
  rm -f "$tmp"
  printf '%s\n' "$json" > "$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  echo "managed apps ($file): $json"
}
