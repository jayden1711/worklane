#!/bin/bash
# The removed owner terminal's console shell, now a stub that refuses everything (#742). Nothing installs it.
# It is here only so that an older engine updater, which keeps every root helper the machine already has in step
# with the new engine (scripts/machine/worklane-update.cjs syncHelpers: same path, the installed file's owner and
# mode kept, sudoers never touched), replaces a live /usr/local/libexec/worklane-console-shell with this file on the
# first upgrade, with no root step. The sudoers rule that let the hub's viewer user run it as the admin user then
# reaches only this stub. Rerunning dashboards.sh as root deletes this file and that rule.
# It runs nothing, reads nothing and prints nothing on stdout: every subcommand (check, shell, anything else, none)
# is refused with exit 3. The old hub opened its terminal only on `check` printing "password-required".
echo "refusing: the owner terminal is removed (#742). As root, rerun dashboards.sh once to remove this file and its sudoers rule: sudo bash /opt/worklane/current/scripts/setup/dashboards.sh --machine-devices <the hub unit's --console-devices> --client-id <id> --public-url <url> <instance>... For a shell, use ssh." >&2
exit 3
