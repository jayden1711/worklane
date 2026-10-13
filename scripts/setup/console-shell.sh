#!/usr/bin/env bash
# Once per machine, as root, and only if you want the dashboard's owner terminal (review it first). The
# terminal is a login shell as your admin user, opened from the hub by the signed-in owner; sudo in it
# asks for your password every time.
#
#   bash scripts/setup/console-shell.sh <admin user>
#
#   - Installs the console shell as /usr/local/libexec/worklane-console-shell (root:root 0755). `check` says
#     whether `sudo -n true` succeeds as the admin; `shell` refuses if it does, runs `sudo -k`, then starts a
#     login shell.
#   - Lets the hub's viewer user (wl-dash) run exactly that shell's `check` and `shell` as <admin user>, and
#     nothing else (one sudoers line, validated with visudo -cf before it's moved into place). Never as root.
#   - Refuses an admin user whose sudo needs no password (NOPASSWD): the terminal would be root without one.
# Then set console_user when you run dashboards.sh (--console-user <admin user>).
# To remove it: rm "$CONSOLE_SUDOERS" "$CONSOLE_SHELL" (both named in lib.sh)
source "$(dirname "$0")/lib.sh"
as_root "$@"
admin="${1:?usage: console-shell.sh <admin user>}"
viewer=wl-dash
[[ "$admin" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "admin user: a login name" >&2; exit 2; }
[ "$admin" != root ] || { echo "the terminal never runs as root; name your admin user" >&2; exit 2; }
[[ "$admin" != wl-* ]] || { echo "$admin is a service user (wl-*), not your admin user" >&2; exit 2; }
id -u "$admin" >/dev/null 2>&1 || { echo "no user $admin" >&2; exit 1; }
id -u "$viewer" >/dev/null 2>&1 || { echo "no $viewer; run dashboards.sh first" >&2; exit 1; }

say "$admin's sudo must ask for a password"
if sudo -n -l -U "$admin" 2>/dev/null | grep -q 'NOPASSWD'; then
  echo "refusing: $admin has a NOPASSWD sudo rule (sudo -l -U $admin); the terminal would be root without a password" >&2
  exit 1
fi

say "the console shell, root-owned"
src="$(dirname "$0")/../machine/worklane-console-shell.sh"
tmp="$(dirname "$CONSOLE_SHELL")/.worklane-console-shell.tmp"
install -d -o root -g root -m 0755 "$(dirname "$CONSOLE_SHELL")"
install -o root -g root -m 0755 "$src" "$tmp"
bash -n "$tmp" || { rm -f "$tmp"; echo "the console shell doesn't parse; nothing installed" >&2; exit 1; }
mv -f "$tmp" "$CONSOLE_SHELL"
echo "installed $CONSOLE_SHELL"

say "sudoers: $viewer may run exactly the console shell's check and shell, as $admin"
install_sudoers worklane-console "$(console_sudoers "$viewer" "$admin")"
cat "$CONSOLE_SUDOERS"

say "check"
sudo -n -l -U "$viewer" -u "$admin" "$CONSOLE_SHELL" shell >/dev/null || { echo "FAIL: $viewer can't start the console shell as $admin" >&2; exit 1; }
if sudo -n -l -U "$viewer" -u "$admin" /bin/bash >/dev/null 2>&1; then echo "FAIL: $viewer may run bash as $admin" >&2; exit 1; fi
if sudo -n -l -U "$viewer" -u root "$CONSOLE_SHELL" shell >/dev/null 2>&1; then echo "FAIL: $viewer may run the console shell as root" >&2; exit 1; fi
out="$(cd / && sudo -n -u "$viewer" sudo -n -u "$admin" "$CONSOLE_SHELL" check || true)"
[ "$out" = password-required ] || { echo "FAIL: the console shell's check as $admin says '$out', not password-required" >&2; exit 1; }
echo "OK: $viewer may start only the console shell as $admin, and sudo there asks for $admin's password"
