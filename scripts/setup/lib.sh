# Shared helpers for the setup scripts. Sourced, not run.
set -euo pipefail

# The setup scripts are for Linux with systemd (users, groups, sudoers, systemd units). Elsewhere they stop here,
# before anything changes. Arguments (tests): the kernel name and the systemd runtime directory.
require_linux_systemd() {
  local kernel="${1:-$(uname -s)}" runtime="${2:-/run/systemd/system}"
  if [ "$kernel" != Linux ]; then
    echo "these setup scripts need Linux with systemd; this is $kernel. On macOS run the engine as your own user (see docs/separate-users.md); on Windows use WSL2 with systemd on." >&2
    return 1
  fi
  if [ ! -d "$runtime" ]; then
    echo "these setup scripts need systemd as the init system (no $runtime here). In WSL2, turn it on in /etc/wsl.conf ([boot] systemd=true) and restart WSL." >&2
    return 1
  fi
}

# Re-run as root through sudo when started as an ordinary admin user.
as_root() {
  require_linux_systemd || exit 1
  if [ "$(id -u)" -ne 0 ]; then exec sudo -- bash "$0" "$@"; fi
}

# A user's home directory, from the passwd database: never assumed to be /home/<user>.
home_of() { getent passwd "$1" | cut -d: -f6; }

# Machine-wide settings machine.sh records in /etc/worklane/machine.json (root-owned): `checkouts`, the root the
# instances' checkouts live under, and `max_cap`, the highest agent slot cap the machine helper allows.
#   machine_conf <key> <default> [file]
machine_conf() {
  local v
  # No file yet (machine.sh not run, or run before it existed): the default, never an exit under set -e.
  v="$(sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "${3:-/etc/worklane/machine.json}" 2>/dev/null | head -n1 || true)"
  printf '%s\n' "${v:-$2}"
}
checkouts_root() { machine_conf checkouts /srv/worklane "$@"; }
# The default ceiling; src/machine.ts and the helper (scripts/machine/worklane-machine.cjs) use the same one.
DEFAULT_MAX_CAP=16
max_cap() { machine_conf max_cap "$DEFAULT_MAX_CAP" "$@"; }

# The package manager here, found on PATH: apt-get, dnf, zypper, pacman or apk. With none, say what was found.
#   pkg_manager [os-release file]
pkg_manager() {
  local m
  for m in apt-get dnf zypper pacman apk; do command -v "$m" >/dev/null 2>&1 && { echo "$m"; return 0; }; done
  local id; id="$(sed -n 's/^ID=//p' "${1:-/etc/os-release}" 2>/dev/null | tr -d '"' || true)"
  echo "no supported package manager (apt-get, dnf, zypper, pacman, apk) on this machine (${id:-unknown distribution}); install the packages by hand" >&2
  return 1
}

# A package's name under a package manager: most are the same everywhere; gh is github-cli on Arch and Alpine.
#   pkg_name <manager> <package>
pkg_name() {
  case "$1:$2" in
    pacman:gh | apk:gh) echo github-cli ;;
    *) echo "$2" ;;
  esac
}

# The install command for packages under a package manager (printed, one word per line, for pkg_install and tests).
#   pkg_command <manager> <package>...
pkg_command() {
  local m="$1"; shift
  local names=() p
  for p in "$@"; do names+=("$(pkg_name "$m" "$p")"); done
  case "$m" in
    apt-get) printf '%s\n' apt-get install -y "${names[@]}" ;;
    dnf) printf '%s\n' dnf install -y "${names[@]}" ;;
    zypper) printf '%s\n' zypper --non-interactive install "${names[@]}" ;;
    pacman) printf '%s\n' pacman -S --needed --noconfirm "${names[@]}" ;;
    apk) printf '%s\n' apk add "${names[@]}" ;;
    *) echo "pkg_command: unknown package manager $m" >&2; return 1 ;;
  esac
}

# Install packages with whatever package manager the machine has.
pkg_install() {
  local m cmd=()
  m="$(pkg_manager)" || exit 1
  mapfile -t cmd < <(pkg_command "$m" "$@")
  "${cmd[@]}"
}

# Run a bash script as another user, its arguments passed through intact.
# Never `sudo -i ... -c`: -i re-quotes the command for a login shell, which
# mangles multi-line scripts. From / so the user needn't reach our cwd.
run_as() {
  local user="$1" script="$2"; shift 2
  (cd / && sudo -H -u "$user" bash -euo pipefail -c "$script" _ "$@")
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

# The sudoers rule for the machine helper: each coordinator user named may run exactly the allowed
# commands (set-slots 1..max_cap, set-updates on, set-updates off) as root, and nothing else.
# Listed one by one, no wildcards or patterns. Never for the dashboard viewer (wl-dash).
# The ceiling is machine.json's max_cap (MAX_CAP overrides it, for tests).
MACHINE_HELPER=/usr/local/libexec/worklane-machine
machine_sudoers() {
  local u n cmds=()
  [ "$#" -ge 1 ] || { echo "machine_sudoers: no users" >&2; return 1; }
  for u in "$@"; do
    [[ "$u" =~ ^wl-[a-z][a-z0-9-]{0,20}$ && "$u" != wl-dash ]] || { echo "machine_sudoers: $u is not a coordinator user" >&2; return 1; }
  done
  local cap="${MAX_CAP:-$(max_cap)}"
  [[ "$cap" =~ ^[1-9][0-9]?$ ]] || { echo "machine_sudoers: max_cap $cap is not 1..99" >&2; return 1; }
  for n in $(seq 1 "$cap"); do cmds+=("$MACHINE_HELPER set-slots $n"); done
  cmds+=("$MACHINE_HELPER set-updates on" "$MACHINE_HELPER set-updates off")
  printf '# Coordinators may change the machine slot cap and the update switch, through one validating helper.\n'
  printf 'Cmnd_Alias WORKLANE_MACHINE = %s' "${cmds[0]}"
  for n in "${cmds[@]:1}"; do printf ', \\\n    %s' "$n"; done
  local users="$1"; shift
  for u in "$@"; do users="$users, $u"; done
  printf '\n%s ALL=(root) NOPASSWD: WORKLANE_MACHINE\n' "$users"
}

# The helper's setup commands (onboarding a project), as scripts/machine/worklane-machine.cjs names them; a test
# keeps the two lists equal. Those taking no argument are listed with "" (sudo: no arguments at all); the rest
# take arguments the helper checks one by one against their exact shapes, so sudoers passes them through (*).
SETUP_COMMANDS=(setup-machine add-instance install-engine install-app-key checkout install-service install-dashboards install-api-key install-discord-token set-budget claude-status instance-doctor tailscale-serve)
SETUP_NO_ARGS=" setup-machine "
# The sudoers rule for the one setup user (the owner's own account, which runs `worklane add` and the setup
# console): exactly the helper's setup commands. Never a coordinator, the dashboard viewer or root.
setup_sudoers() {
  local u="${1:-}" c cmds=()
  [[ "$u" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$u" != root && ! "$u" =~ ^wl- ]] || { echo "setup_sudoers: $u can't be the setup user (an ordinary login, not root or a wl- user)" >&2; return 1; }
  for c in "${SETUP_COMMANDS[@]}"; do
    if [[ "$SETUP_NO_ARGS" == *" $c "* ]]; then cmds+=("$MACHINE_HELPER $c \"\""); else cmds+=("$MACHINE_HELPER $c *"); fi
  done
  printf '# The setup user may onboard projects through the helper'"'"'s setup commands; the helper checks every argument.\n'
  printf 'Cmnd_Alias WORKLANE_SETUP = %s' "${cmds[0]}"
  for c in "${cmds[@]:1}"; do printf ', \\\n    %s' "$c"; done
  printf '\n%s ALL=(root) NOPASSWD: WORKLANE_SETUP\n' "$u"
}

# The engine repo's checks that run on a push to main, one name per element (names hold commas, so never a
# joined string). Pull-request-only checks (dco) are left out: they're always "skipped" on main, and the
# updater refuses a skipped required check. A test derives this list from the workflows.
UPDATE_DEFAULT_CHECKS=("agentshield" "denylist" "desktop" "push-gate" "scan" "test (macos-latest, 22)" "test (macos-latest, 24)" "test (ubuntu-latest, 22)" "test (ubuntu-latest, 24)" "test (windows-latest, 22)" "test (windows-latest, 24)")

# updates.json for the engine updater, off: the repo to follow, then each required check as its own argument.
updates_config_json() {
  node -e 'const [repo, ...checks] = process.argv.slice(1); process.stdout.write(JSON.stringify({ enabled: false, repo_url: repo, branch: "main", required_checks: checks.filter((s) => s.trim()) }, null, 2) + "\n")' "$@"
}
