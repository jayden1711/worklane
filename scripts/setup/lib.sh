# Shared helpers for the setup scripts. Sourced, not run.
set -euo pipefail

# Re-run as root through sudo when started as an ordinary admin user.
as_root() {
  if [ "$(id -u)" -ne 0 ]; then exec sudo -- bash "$0" "$@"; fi
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
  chmod 0700 "/home/$1"
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
