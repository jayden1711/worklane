#!/usr/bin/env bash
# Remove one instance from this machine, as root, at the machine's own terminal (review it first). Nothing else can
# start it: no sudoers rule and no machine helper command names it, and the dashboard has no button for it.
#
#   sudo bash scripts/setup/instance-remove.sh <name> --print     every user, unit, file and record it would remove
#   sudo bash scripts/setup/instance-remove.sh <name>             asks for the name to be typed back first
#   sudo bash scripts/setup/instance-remove.sh <name> --yes       no question (a script's, or a rerun's)
#
# It refuses, changing nothing, while the instance has anything in flight: its coordinator service or its dashboard
# active (stop them first, the coordinator once its runs are done: sudo systemctl stop worklane-<name>.service
# worklane-dashboard-<name>.service), any process of its users (an agent, a
# test run, an experiment job) outside its dashboard and its test Docker daemon, or a test run's directory. And it
# refuses a name whose users would be another instance's (wl-test-<x> is instance test-<x>'s coordinator, too), and while
# a filesystem is mounted inside what it removes.
#
# Then, in order, each step skipped when already done, so a rerun finishes a removal that stopped part way:
#   export    the instance's history (`worklane export`, as its coordinator: the event log and its state, never a
#             secret) to /var/lib/worklane/removed/<name>-<time>.bundle, root's 0600, and what the shared root files
#             hold for it to <name>-<time>.records.json beside it; both paths printed. Never skipped while its state
#             is there.
#   records   every item in scripts/setup/instance-records.cjs, the registry of what holds an instance's name outside
#             its users' homes: its test user (test-user.sh remove), its GPU grant (testrun-gpu.sh disable), its
#             units (dashboard, coordinator, test Docker), its records in root's shared files (the agents' Claude
#             account profiles, status and paused list, the canary, its incidents, signers it staged), its Discord
#             claim, its init record, its sudoers files, /srv/worklane/<name>, its users (homes with them: the state,
#             the App key, the credentials) and its group.
#   machine   the machine helper's rule and the dashboard hub, rewritten with every other instance (the same way
#             add-project.sh keeps them), and never with this one. The last instance's removal leaves the hub as it
#             is (it shows that name as unreachable) and takes the helper's rule away.
# Another instance's records are never touched: every match is on the exact name.
# Not here: its GitHub App and its repo. They are GitHub's: it prints what to do there, and changes nothing on GitHub.
source "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
usage="usage: instance-remove.sh <name> [--print | --yes [--exported <bundle>]]"
name="" print="" yes="" exported=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print=1; shift ;;
    --yes) yes=1; shift ;;
    # instance-rename.sh --abort's: the history is in this bundle already (the old name's export, which the new name
    # only copied). One of the archive's own: root's 0600, a regular file there.
    --exported) exported="${2:-}"; shift 2 || { echo "$usage" >&2; exit 2; } ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "$usage" >&2; exit 2; }; name="$1"; shift ;;
  esac
done
[ -n "$name" ] && { [ -z "$print" ] || [ -z "$yes" ]; } && { [ -z "$exported" ] || [ -n "$yes" ]; } || { echo "$usage" >&2; exit 2; }
[ -z "$exported" ] || [[ "$exported" =~ ^/var/lib/worklane/removed/[a-z][a-z0-9-]{0,20}-[0-9]{8}T[0-9]{6}Z\.bundle$ ]] || { echo "--exported: a bundle in /var/lib/worklane/removed" >&2; exit 2; }
# The instance-name rules (lib.sh instance_name_problem). One exception: an instance made before those rules, under
# a name they now refuse, is still there to remove; then only the shape every name has had is needed, and its users
# must be its own (the overlap check below).
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ && "$name" != dash ]] || { echo "instance name $name: lowercase letters, digits and dashes, starting with a letter, at most 21; not dash" >&2; exit 2; }
name_note="$(instance_name_problem "$name")"
if [ -n "$name_note" ]; then
  user_exists "wl-$name" || { echo "instance name $name: $name_note" >&2; exit 2; }
  echo "note: $name is a name the instance-name rules refuse now ($name_note); it exists on this machine, so it can be removed" >&2
fi
as_root "$@"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Never through a coordinator's sudo, even one a rule might let through by mistake.
[[ "${SUDO_USER:-}" != wl-* ]] || { echo "instance-remove is an admin's, at the machine's terminal: not $SUDO_USER's" >&2; exit 1; }
NODE="$(command -v node)" || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
records() { "$NODE" "$here/instance-records.cjs" "$@"; }
ARCHIVE=/var/lib/worklane/removed
coord="wl-$name"
home="$(home_of "$coord" 2>/dev/null || true)"
state_dir="${home:+$home/.local/state/worklane/instances/$name}"

# --- what there is

exists() { # <kind> <what>: whether that item is on this machine
  case "$1" in
    user) user_exists "$2" ;;
    group) getent group "$2" >/dev/null 2>&1 ;;
    unit) [ -e "/etc/systemd/system/$2" ] || [ -e "/etc/systemd/system/$2.d" ] || systemctl is-enabled -q "$2" 2>/dev/null ;;
    sudoers) sudoers_installed "$2" ;;
    path) [ -e "$2" ] ;;
    glob) compgen -G "$2*" >/dev/null ;;
    shared) printf '%s\n' "$shared_plan" | cut -f1 | grep -qx "$2" ;;
    via) local w; for w in $3; do exists "${w%%:*}" "${w#*:}" && return 0; done; return 1 ;;
    *) return 1 ;;
  esac
}
shared_plan="$(records plan "$name")"
mapfile -t ITEMS < <(records items "$name")

# The other instances on this machine (the helper's rule, the hub, their checkouts' roots), and their users.
others() { { helper_instances; hub_instances; ls -1 "$SRV_ROOT" 2>/dev/null; } | grep -E '^[a-z][a-z0-9-]{0,20}$' | grep -vx "$name" | sort -u || true; }
other_users() { local m; for m in $(others); do printf '%s\n' "wl-$m" "wl-$m-agent" "wl-$m-eval" "wl-$m-work" "wl-test-$m"; done; }
remaining_helper() { local m; for m in $(helper_instances | grep -vx "$name" || true); do user_exists "wl-$m" && echo "$m"; done; return 0; }
remaining_hub() { local m; for m in $(hub_instances | grep -vx "$name" || true); do [ -d "$(home_of "wl-$m" 2>/dev/null || echo /nonexistent)/.local/state/worklane/instances/$m/state" ] && echo "$m"; done; return 0; }

# --- refusals: nothing changes before these pass

refuse() { echo "refused: $*" >&2; exit 1; }
# A user of this instance that is another instance's (an older machine, before instance names were guarded).
collide="$(for line in "${ITEMS[@]}"; do IFS=$'\t' read -r k w _ <<<"$line"; [[ "$k" == user || "$k" == group ]] && echo "$w"; done | grep -Fxf <(other_users) || true)"
[ -z "$collide" ] || refuse "$(echo "$collide" | tr '\n' ' ')is also another instance's user or group on this machine (instance names that overlap): remove it by hand"

# --- the plan

show_plan() {
  local line k w when n=0
  echo "instance $name: what $([ -n "$print" ] && echo would go || echo goes)"
  if [ -n "$state_dir" ] && [ -d "$state_dir" ]; then echo "  export   $state_dir (its history) -> $ARCHIVE/$name-<time>.bundle, root's 0600"; fi
  for line in "${ITEMS[@]}"; do
    IFS=$'\t' read -r k w when _ <<<"$line"
    exists "$k" "$w" "$when" || continue
    n=$((n + 1))
    case "$k" in
      shared) printf '  %-8s %s\n' record "$(printf '%s\n' "$shared_plan" | awk -F'\t' -v id="$w" '$1 == id { print id " in " $2 ": " substr($3, 1, 300) }')" ;;
      via) printf '  %-8s %s\n' run "$w" ;;
      user) printf '  %-8s %s (and its home %s)\n' user "$w" "$(home_of "$w")" ;;
      *) printf '  %-8s %s\n' "$k" "$w" ;;
    esac
  done
  planned="$n"
  local em; for em in $(engine_mounts); do echo "  unmount  $em (an experiment job's output volume, its job cut off)"; n=$((n + 1)); done
  [ "$n" -gt 0 ] || echo "  nothing: no user, unit, file or record of $name is left"
  local h; h="$(remaining_helper | tr '\n' ' ')"
  if helper_instances | grep -qx "$name"; then
    if [ -n "$h" ]; then echo "  machine  the machine helper's rule, rewritten for: $h"; else echo "  machine  the machine helper's rule ($MACHINE_SUDOERS) removed: no other instance"; fi
  fi
  h="$(remaining_hub | tr '\n' ' ')"
  if hub_instances | grep -qx "$name"; then
    if [ -n "$h" ]; then echo "  machine  the dashboard hub, rewritten to serve: $h"; else echo "  machine  the dashboard hub: left as it is (no other instance to serve; it shows $name as unreachable until the next add-project)"; fi
  fi
  local agent_user
  agent_user="$( [ -n "$state_dir" ] && sed -n 's/^  agent_user: *//p' "$state_dir/instance.yaml" 2>/dev/null | tr -d "\"'" | head -1 || true)"
  if [ -n "$agent_user" ] && [ "$agent_user" != "wl-$name-agent" ]; then echo "  kept     $agent_user: instance.yaml names it as the agent user, but it isn't one instance.sh made; remove it yourself if it is no one else's"; fi
  echo "  kept     its GitHub App and its repo (GitHub's: see the end)"
}

github_steps() {
  echo
  echo "On GitHub (nothing here touched it):"
  echo "  - its App (made as $name-worklane, unless GitHub's form changed the name): uninstall it from the repo, or delete it, in the owner's GitHub settings (Developer settings > GitHub Apps)"
  echo "  - its claim refs (refs/worklane/claims/issue-<n>, lease instance $name) expire by themselves within 3 hours; another instance on the repo takes an issue over once its lease has expired"
  echo "  - its repo, issues, PRs and labels are as they were"
}

# A mount the engine made and can name (an experiment job's output volume) is unmounted; any other refuses it.
mounted() { local m; m="$(instance_mounts "$name" | awk -F'\t' '$2 == "other" { print $1 }')"; [ -z "$m" ] || printf 'a filesystem is mounted at %s, inside what goes, and it is not one the engine made: unmount it first\n' $m; }
engine_mounts() { instance_mounts "$name" | awk -F'\t' '$2 == "engine" { print $1 }'; }
if [ -n "$print" ]; then
  show_plan
  busy="$(instance_in_flight "$name"; mounted)"
  [ -z "$busy" ] || { echo; echo "it would refuse now, while:"; printf '%s\n' "$busy" | sed 's/^/  /'; }
  exit 0
fi

# One at a time with add-project and instance-rename: they rewrite the same machine-wide rules.
exec 9> "$ADD_PROJECT_LOCK"
flock -n 9 || refuse "an add-project, instance-remove or instance-rename is running on this machine; wait for it to finish"
busy="$(instance_in_flight "$name"; mounted)"
if [ -n "$busy" ]; then
  echo "refused: $name has work in flight; nothing changed:" >&2
  printf '%s\n' "$busy" | sed 's/^/  /' >&2
  exit 1
fi

# The updater waits for the whole run (an agent slot held with this run's pid: busy to its quiet check), so no update
# restarts the services mid-removal; let go on every exit, a failure's too. Refused when the updater would still call
# the machine quiet.
on_exit=()
cleanup() { local c; for c in "${on_exit[@]}"; do eval "$c"; done; }
trap cleanup EXIT
held_slot="$(records hold-slot x "$$" "$name")" || refuse "couldn't hold the updater off (above): nothing changed"
on_exit+=("records release-slot x '$held_slot' $$")
echo "the engine updater waits while this runs ($held_slot, this run's pid $$)"

show_plan
if [ -z "$yes" ]; then
  [ -t 0 ] || refuse "this asks for the instance's name to be typed back: run it in a terminal, or pass --yes"
  read -r -p "Type the instance's name ($name) to remove it, anything else to stop: " typed
  [ "$typed" = "$name" ] || { echo "not removed: nothing changed"; exit 1; }
fi

# --- export first: never skipped while the state is there

install -d -o root -g root -m 0700 "$ARCHIVE"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="" exp_kept="" kept="$ARCHIVE/$name-$stamp.records.json"
if [ -n "$exported" ]; then
  [ -f "$exported" ] && [ ! -L "$exported" ] && [ "$(stat -c '%u %a' "$exported")" = "0 600" ] || refuse "--exported $exported: not a root-owned 0600 bundle; nothing removed"
  bundle="$exported"
  echo "$name's history is in $bundle already: not exported again"
elif [ -n "$state_dir" ] && [ -f "$state_dir/instance.yaml" ]; then
  say "export $name's history"
  [ -x "$ENGINE_CLI" ] || refuse "no $ENGINE_CLI to export with: install the engine (engine.sh), then run this again"
  # Its Siri device tokens revoked first, as its coordinator: none works again, and the export records it.
  run_as "$coord" '"$1" instance siri-revoke-all "$2" --why "$3"' "$ENGINE_CLI" "$name" "instance removed" || refuse "revoking $name's Siri device tokens failed (above): nothing removed"
  work="$(mktemp -d)"
  on_exit+=("rm -rf '$work'")
  chown -h "$coord" "$work" && chmod 0700 "$work"
  run_as "$coord" '"$1" export --instance "$2" --out "$3"' "$ENGINE_CLI" "$name" "$work/export.bundle" || refuse "the export failed (above): nothing removed"
  bundle="$ARCHIVE/$name-$stamp.bundle"
  install -o root -g root -m 0600 "$work/export.bundle" "$bundle"
  rm -rf "$work"
  echo "exported $name's history: $bundle (root's, 0600; worklane import reads it)"
else
  echo "no state of $name left to export$(ls -1 "$ARCHIVE" 2>/dev/null | grep -q "^$name-.*\.bundle$" && echo " (exported earlier: $(ls -1t "$ARCHIVE"/"$name"-*.bundle | head -1))")"
fi

# No process of its users left, before anything else goes: their accounts locked, their user slice and every engine
# unit running as them stopped (cgroup and all), then whatever is left killed by uid until none is. Any survivor
# refuses the removal, named, before any user is deleted or any file walked.
say "stop every process of $name's users"
my_users="$(for line in "${ITEMS[@]}"; do IFS=$'\t' read -r k w _ <<<"$line"; [ "$k" = user ] && user_exists "$w" && echo "$w"; done; true)"
if [ -n "$my_users" ]; then
  # shellcheck disable=SC2086 # one user a word
  if ! survivors="$(stop_uids "$name" $my_users)"; then
    echo "refused: processes of $name's users are still running (pid, uid, command); nothing more is removed:" >&2
    printf '%s\n' "$survivors" | sed 's/^/  /' >&2
    echo "their accounts are locked (usermod -L, expired, nologin); end those processes, then run this again" >&2
    exit 1
  fi
  echo "no process of $(echo $my_users | tr ' ' ',') is left: $(for u in $my_users; do printf '%s=%s ' "$u" "$(pgrep -u "$(id -u "$u")" | wc -l | tr -d ' ')"; done)"
fi

# Its experiments' history (root's): each job's record and root's file for it, kept beside the export.
if [ -d "/var/lib/worklane-exp/$name" ] || [ -f "/etc/worklane/experiments/$name.json" ]; then
  exp_kept="$ARCHIVE/$name-$stamp.experiments.tar"
  { find "/var/lib/worklane-exp/$name/jobs" -mindepth 2 -maxdepth 2 -name record.json -type f 2>/dev/null; [ ! -f "/etc/worklane/experiments/$name.json" ] || echo "/etc/worklane/experiments/$name.json"; } \
    | sed 's#^/##' | (cd / && tar --no-recursion -cf "$exp_kept" -T -)
  chmod 0600 "$exp_kept"
  echo "kept $name's experiment records: $exp_kept"
fi

# --- the registry's items, in its order

say "remove $name"
# The shared files' records first, all at once, while every one of them is still there (the GPU grant too, which
# testrun-gpu.sh then takes out): what each held is kept in the archive before anything changes.
records remove "$name" "$kept"
chmod 0600 "$kept"
echo "kept what the shared files held for $name: $kept"
# The engine's own mounts inside what goes (a cut-off job's output volume): unmounted, its loop device freed.
for em in $(engine_mounts); do
  src="$(findmnt -rn -o SOURCE --mountpoint "$em" | head -1)"
  umount "$em"
  if losetup "$src" >/dev/null 2>&1 && [ "$(losetup -n -O BACK-FILE "$src" | sed 's/[[:space:]]*$//')" = "${em%/vol}/vol.img" ]; then losetup -d "$src"; fi
  echo "unmounted $em (an experiment job's output volume)"
done

mlog() { printf '{"at":%s,"by":%s,"what":"instance.removed","from":%s,"to":""}\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(json_str "${SUDO_USER:-root}")" "$(json_str "$1")" >> "$MACHINE_CHANGES"; chmod 0644 "$MACHINE_CHANGES"; }
# Its users' uids, for what they leave behind in the machine's shared places once they're gone (below).
removed_homes=""
# Its auto_merge id (root's pointer goes with the items below; the id's switches at the end, when no name points at it).
rm_id="$(instance_id_of "$name")"
# Kept in the archive until the removal ends, so a rerun after its users are gone still knows their uids.
uids_file="$ARCHIVE/$name.uids"
my_uids="$(for line in "${ITEMS[@]}"; do IFS=$'\t' read -r k w _ <<<"$line"; [ "$k" = user ] && user_exists "$w" && id -u "$w"; done; true)"
if [ -n "$my_uids" ]; then { printf '%s\n' $my_uids; cat "$uids_file" 2>/dev/null || true; } | sort -u > "$uids_file.tmp"; mv -f "$uids_file.tmp" "$uids_file"; chmod 0600 "$uids_file"; fi
[ ! -f "$uids_file" ] || my_uids="$(cat "$uids_file")"
# And their groups' gids (each user's own, and the registry's groups), kept the same way.
gids_file="$ARCHIVE/$name.gids"
my_gids="$(for line in "${ITEMS[@]}"; do IFS=$'\t' read -r k w _ <<<"$line"; case "$k" in user) user_exists "$w" && id -g "$w" ;; group) getent group "$w" | cut -d: -f3 ;; esac; done; true)"
if [ -n "$my_gids" ]; then { printf '%s\n' $my_gids; cat "$gids_file" 2>/dev/null || true; } | grep -E '^[0-9]+$' | sort -u > "$gids_file.tmp"; mv -f "$gids_file.tmp" "$gids_file"; chmod 0600 "$gids_file"; fi
for line in "${ITEMS[@]}"; do
  IFS=$'\t' read -r k w when _ <<<"$line"
  case "$k" in
    via)
      exists via "$w" "$when" || continue
      # shellcheck disable=SC2086 # the registry's command: a script and its plain-word arguments
      set -- $w
      bash "$here/$1" "${@:2}"
      ;;
    unit)
      exists unit "$w" || continue
      systemctl disable --now "$w" 2>/dev/null || systemctl stop "$w" 2>/dev/null || true
      rm -rf "/etc/systemd/system/$w" "/etc/systemd/system/$w.d"
      systemctl reset-failed "$w" 2>/dev/null || true
      echo "removed unit $w"
      ;;
    shared) ;; # taken out above, all at once
    sudoers) exists sudoers "$w" && remove_sudoers "$w" && echo "removed the sudoers file $w" ;;
    path) exists path "$w" && rm -rf --one-file-system -- "$w" && echo "removed $w" ;;
    glob) exists glob "$w" && rm -f -- "$w"* && echo "removed $w*" ;;
    user)
      user_exists "$w" || continue
      uh="$(home_of "$w")" uid="$(id -u "$w")"
      # Its systemd user manager (lingering keeps one for the coordinator): stopped, so userdel finds no process of its.
      loginctl disable-linger "$w" 2>/dev/null || true
      systemctl stop "user@$uid.service" 2>/dev/null || true
      # userdel -r can delete the user and still fail on its home (exit 12): the home is seen to below. Only a user it
      # left in place is deleted again, without -r.
      userdel -r "$w" 2>/dev/null || ! user_exists "$w" || userdel "$w"
      # Its home goes with it whatever userdel said (a mail spool it couldn't find): it held the state and the keys.
      # Only a home that is that user's own: absolute, not /, owned by its uid, and no other user's home.
      if [[ "$uh" == /?* && "$uh" != / && -d "$uh" && "$(stat -c %u "$uh")" = "$uid" ]] && ! getent passwd | cut -d: -f6 | grep -qx "$uh"; then
        rm -rf --one-file-system -- "$uh"
      fi
      removed_homes="$removed_homes $uh"
      echo "removed user $w${uh:+ and its home $uh}"
      ;;
    group) exists group "$w" && groupdel "$w" && echo "removed group $w" ;;
  esac
done
systemctl daemon-reload

# What its users last wrote in the engine's own places (the incident store, a slot's lock, the engine's lock files):
# root:root now, mode kept, links never followed, so nothing there is owned by a uid no user has (a later user given
# the same uid would own it); in a shared engine group (agent-slots) a file loses group write, a directory keeps it
# (lib.sh rechown_orphans says why). Each listed, and kept in the archive. What they own anywhere else is left as it
# is, and listed for an admin.
if [ -n "$my_uids" ]; then
  say "what $name's users left in the engine's own places, and anywhere else"
  trees="$(records engine-places x | awk -F'\t' '$1 == "tree" { print $2 }' | paste -sd: -)"
  IFS=$'\t' read -r _ lockdir lockname < <(records engine-places x | grep $'^locks\t')
  rechowned="$ARCHIVE/$name-$stamp.rechowned.txt" left="$ARCHIVE/$name-$stamp.left-owned.txt"
  # shellcheck disable=SC2086 # one uid a word
  rechown_ok=1; rechown_orphans "$rechowned" "$trees" "$lockdir" "$lockname" "$(paste -sd, "$gids_file" 2>/dev/null || true)" $my_uids || rechown_ok=""
  chmod 0600 "$rechowned"
  if [ -s "$rechowned" ]; then echo "given to root (and to group root when the group was $name's), setuid and setgid off, and group write off in a shared group (a directory's kept, with why), in $rechowned:"; sed 's/^/  /' "$rechowned"; fi
  # shellcheck disable=SC2086
  left_owned "$left" / "$(printf '%s:' $removed_homes)" $my_uids
  chmod 0600 "$left"
  if [ -s "$left" ]; then echo "still owned by $name's removed users, left as they are (in $left):"; sed 's/^/  /' "$left"; fi
  [ -n "$rechown_ok" ] || refuse "chown refused some of the files above (FAILED): fix them, then run this again"
fi
rm -f "$uids_file" "$gids_file"

# The egress rule names users by uid: when it names one no user has now (this instance's sandbox and test users), it
# is applied again, rebuilt from the users there are, with the flags it was applied with. No live user's entry changes.
EGRESS_USERS=/etc/worklane/egress.users
# A uid it names that is no one's now (a rerun finds the same): its users went, and nothing else changed.
stale_uids="$( [ -f "$EGRESS_USERS" ] && grep -vx '#.*' "$EGRESS_USERS" | while read -r u; do getent passwd "$u" >/dev/null || echo "$u"; done; true)"
if [ -n "$stale_uids" ]; then
  say "the egress rule, without $name's users"
  if grep -qx '# --with-test-users' "$EGRESS_USERS"; then bash "$here/egress-firewall.sh" apply --with-test-users; else bash "$here/egress-firewall.sh" apply; fi
fi

say "the machine's helper rule and hub, without $name"
helper_now="$(remaining_helper | tr '\n' ' ')"
if helper_instances | grep -qx "$name"; then
  if [ -n "$helper_now" ]; then
    # shellcheck disable=SC2086 # one word per instance name
    bash "$here/machine-helper.sh" $helper_now
  else
    remove_sudoers worklane-machine
    echo "removed $MACHINE_SUDOERS: no instance is left to run the machine helper"
  fi
fi
if hub_instances | grep -qx "$name"; then
  hub_now="$(remaining_hub | tr '\n' ' ')"
  if [ -n "$hub_now" ]; then
    mapfile -t args < <(hub_keep_args)
    # shellcheck disable=SC2086 # one word per instance name
    bash "$here/dashboards.sh" "${args[@]}" $hub_now
  else
    echo "the hub served $name alone: left as it is (it shows $name as unreachable); the next add-project rewrites it"
  fi
fi
# Last: its id's kill switches, once no name points at that id (its pointer went with the registry's items, after its
# users). A rename's other name still points at it, so they stay that name's (#726 round 9).
if [ -n "$rm_id" ] && ! id_in_use "$rm_id" && [ -e "$POLICY_ROOT_DIR/by_id/$rm_id" ]; then
  rm -rf --one-file-system -- "$POLICY_ROOT_DIR/by_id/$rm_id"
  echo "removed $POLICY_ROOT_DIR/by_id/$rm_id ($name's auto_merge switches; no name points at them now)"
fi
if [ "${planned:-0}" -gt 0 ] || [ -n "$bundle" ]; then mlog "$name"; fi
echo
echo "removed $name. Its history: ${bundle:-exported by an earlier run (in $ARCHIVE)}; what the shared files held: $kept${exp_kept:+; its experiment records: $exp_kept}"
github_steps
