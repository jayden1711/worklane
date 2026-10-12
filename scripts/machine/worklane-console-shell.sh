#!/bin/bash
# The dashboard's owner terminal, installed root:root 0755 as /usr/local/libexec/worklane-console-shell by
# scripts/setup/console-shell.sh. The hub's viewer user may run exactly two commands with it, as the admin
# user only (sudoers, no other arguments):
#   check   prints "password-required" when `sudo -n true` fails as this user (sudo will ask for the
#           password), else "passwordless" and exits 3. The hub opens the terminal only on the first.
#   shell   checks the same, refuses on passwordless sudo, forgets any cached sudo credential (sudo -k),
#           then starts a login shell. sudo inside it asks for the admin's password every time.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin
passwordless() { sudo -n true >/dev/null 2>&1; }
case "${1:-}" in
  check)
    if passwordless; then echo passwordless; exit 3; fi
    echo password-required
    ;;
  shell)
    if passwordless; then
      echo "refusing: sudo -n true succeeds as $(id -un) (passwordless sudo, or a cached timestamp); this terminal would be root without a password" >&2
      exit 3
    fi
    sudo -k
    cd "$HOME" 2>/dev/null || cd /
    exec /bin/bash --login -i
    ;;
  *)
    echo "usage: worklane-console-shell check|shell" >&2
    exit 2
    ;;
esac
