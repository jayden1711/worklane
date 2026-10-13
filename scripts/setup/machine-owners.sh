#!/usr/bin/env bash
# The machine owners (src/machine-owners.ts): the GitHub logins that may change the machine itself from the
# dashboard (the slot caps, engine updates, adding a project). Root's file, /etc/worklane/machine-owners.json,
# root:root 0644.
#
#   sudo bash scripts/setup/machine-owners.sh --first <login>
#       the first install (bootstrap.sh --hardened): <login> becomes the machine's first owner. A list that is
#       already there is kept as it is, so a rerun never drops anyone; change it with dashboards.sh --machine-owner.
source "$(dirname "$0")/lib.sh"
as_root "$@"
[ "${1:-}" = --first ] && [ "$#" -eq 2 ] || { echo "usage: machine-owners.sh --first <GitHub login>" >&2; exit 2; }
login="$2"
github_login_ok "$login" || { echo "$login isn't a GitHub login (letters, digits and single dashes, at most 39)" >&2; exit 2; }
if [ -s "$MACHINE_OWNERS" ]; then
  echo "machine owners already set, kept as they are ($MACHINE_OWNERS): $(cat "$MACHINE_OWNERS")"
  echo "  to change them: dashboards.sh --machine-owner <login>[,<login>...]"
  exit 0
fi
install_machine_owners "$login"
