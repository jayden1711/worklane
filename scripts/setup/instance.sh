#!/usr/bin/env bash
# Users, groups and directories for one instance: a coordinator user that
# holds the credentials, an agent user that holds nothing, and optionally an
# eval user for lanes that run as eval.
#   bash scripts/setup/instance.sh <name> [--eval]
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: instance.sh <name> [--eval]}"
need_instance_name "$name"
eval_user=""
[ "${2:-}" = --eval ] && eval_user="wl-$name-eval"
coord="wl-$name" agent="wl-$name-agent" work="wl-$name-work"

say "users"
# A coordinator made here, now, for an instance nothing of which is on this machine yet, is a new instance's: on root's
# list until the machine helper's rule names it, so its first add puts it in that rule without --replace-sudoers,
# whichever way it is added (#898). Anything of one already there (a user, its checkout root, a hub entry, a place in
# the rule) means it isn't (lib.sh new_instance_mark_if_new).
new_instance_mark_if_new "$name"
ensure_user "$coord"
ensure_user "$agent"
[ -n "$eval_user" ] && ensure_user "$eval_user"

say "groups"
ensure_group "$work"
for u in "$coord" "$agent" $eval_user; do ensure_member "$u" "$work"; done
ensure_group agent-slots
ensure_member "$coord" agent-slots

say "checkout directory (group-writable, new files keep the group)"
# Sticky: agents (group $work) may add here but never rename or remove what the coordinator owns, such as
# tasks/, the task files their guard reads.
install -d -o "$coord" -g "$work" -m 3770 "/srv/worklane/$name"

say "keep the coordinator's service running without a login session"
loginctl enable-linger "$coord"

say "sudoers: $coord may switch to its own agent user(s), and nothing else"
runas="$agent"; [ -n "$eval_user" ] && runas="$agent, $eval_user"
rules="Defaults:$coord !use_pty
Defaults>$agent umask=0002, umask_override"
[ -n "$eval_user" ] && rules="$rules
Defaults>$eval_user umask=0002, umask_override"
rules="$rules
$coord ALL=($runas) NOPASSWD: ALL"
install_sudoers "worklane-$name" "$rules"
