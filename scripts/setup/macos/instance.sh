#!/usr/bin/env bash
# Users, groups and directories for one instance on macOS (review it first): a coordinator user that holds
# the credentials, an agent user that holds nothing, and optionally an eval user for lanes that run as
# eval. The same model as ../instance.sh, with Directory Services accounts.
#   bash scripts/setup/macos/instance.sh <name> [--eval]
#
#   - wl-<name>, wl-<name>-agent (and wl-<name>-eval): hidden accounts with no password and no login shell,
#     each with its own primary group and a private home (0700) in /Users.
#   - The wl-<name>-work group (all of the instance's users), and agent-slots for the coordinator.
#   - The checkout directory <checkouts>/<name>: owned by the coordinator, group wl-<name>-work, 3770.
#     Sticky: agents may add files there but never rename or remove what the coordinator owns, such as
#     tasks/. (New files take the directory's group on macOS without the setgid bit; it's set anyway.)
#   - sudoers: the coordinator may switch to its own agent user(s), and nothing else. The coordinator's
#     launchd daemon runs without a login session, so nothing like loginctl enable-linger is needed.
source "$(dirname "$0")/lib.sh"
require_macos
as_root "$@"
name="${1:?usage: instance.sh <name> [--eval]}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "instance name: lowercase letters, digits and dashes" >&2; exit 1; }
[ "$name" != dash ] || { echo "wl-dash is the dashboard viewer; pick another instance name" >&2; exit 1; }
[ -d /etc/worklane ] || { echo "no /etc/worklane; run macos/machine.sh first" >&2; exit 1; }
eval_user=""
[ "${2:-}" = --eval ] && eval_user="wl-$name-eval"
coord="wl-$name" agent="wl-$name-agent" work="wl-$name-work"

say "users"
ensure_user "$coord"
ensure_user "$agent"
[ -n "$eval_user" ] && ensure_user "$eval_user"

say "groups"
ensure_group "$work"
for u in "$coord" "$agent" $eval_user; do ensure_member "$u" "$work"; done
ensure_group agent-slots
ensure_member "$coord" agent-slots

say "checkout directory (group-writable, sticky)"
install -d -o "$coord" -g "$work" -m 3770 "$(checkouts_root)/$name"
chmod 3770 "$(checkouts_root)/$name"

say "sudoers: $coord may switch to its own agent user(s), and nothing else"
runas="$agent"; [ -n "$eval_user" ] && runas="$agent, $eval_user"
rules="Defaults:$coord !use_pty
Defaults>$agent umask=0002, umask_override"
[ -n "$eval_user" ] && rules="$rules
Defaults>$eval_user umask=0002, umask_override"
rules="$rules
$coord ALL=($runas) NOPASSWD: ALL"
install_sudoers "worklane-$name" "$rules"
