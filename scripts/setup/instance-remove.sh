#!/usr/bin/env bash
# Remove one instance from this machine, as root, at the machine's own terminal (review it first). Nothing else can
# start it: no sudoers rule and no machine helper command names it, and the dashboard has no button for it.
#
#   sudo bash scripts/setup/instance-remove.sh <name> --print     every user, unit, file and record it would remove
#   sudo bash scripts/setup/instance-remove.sh <name>             asks for the name to be typed back first
#   sudo bash scripts/setup/instance-remove.sh <name> --yes       no question (a script's, or a rerun's)
#
# It refuses, changing nothing, while the instance has anything in flight: its coordinator service active (stop it
# first, once its runs are done: sudo systemctl stop worklane-<name>.service), any process of its users (an agent, a
# test run, an experiment job) outside its dashboard and its test Docker daemon, or a test run's directory. And it
# refuses a name whose users would be another instance's (wl-test-<x> is instance test-<x>'s coordinator, too).
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
usage="usage: instance-remove.sh <name> [--print | --yes]"
name="" print="" yes=""
for a in "$@"; do
  case "$a" in
    --print) print=1 ;;
    --yes) yes=1 ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "$usage" >&2; exit 2; }; name="$a" ;;
  esac
done
[ -n "$name" ] && { [ -z "$print" ] || [ -z "$yes" ]; } || { echo "$usage" >&2; exit 2; }
# The shape every instance name has had (instance.sh's); dash is the hub's viewer, never an instance.
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ && "$name" != dash ]] || { echo "instance name $name: lowercase letters, digits and dashes, starting with a letter, at most 21; not dash" >&2; exit 2; }
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
    IFS=$'\t' read -r k w when <<<"$line"
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

if [ -n "$print" ]; then
  show_plan
  busy="$(instance_in_flight "$name")"
  [ -z "$busy" ] || { echo; echo "it would refuse now, while:"; printf '%s\n' "$busy" | sed 's/^/  /'; }
  exit 0
fi

# One at a time with add-project and instance-rename: they rewrite the same machine-wide rules.
exec 9> "$ADD_PROJECT_LOCK"
flock -n 9 || refuse "an add-project, instance-remove or instance-rename is running on this machine; wait for it to finish"
busy="$(instance_in_flight "$name")"
if [ -n "$busy" ]; then
  echo "refused: $name has work in flight; nothing changed:" >&2
  printf '%s\n' "$busy" | sed 's/^/  /' >&2
  exit 1
fi

show_plan
if [ -z "$yes" ]; then
  [ -t 0 ] || refuse "this asks for the instance's name to be typed back: run it in a terminal, or pass --yes"
  read -r -p "Type the instance's name ($name) to remove it, anything else to stop: " typed
  [ "$typed" = "$name" ] || { echo "not removed: nothing changed"; exit 1; }
fi

# --- export first: never skipped while the state is there

install -d -o root -g root -m 0700 "$ARCHIVE"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="" kept="$ARCHIVE/$name-$stamp.records.json"
if [ -n "$state_dir" ] && [ -f "$state_dir/instance.yaml" ]; then
  say "export $name's history"
  [ -x "$ENGINE_CLI" ] || refuse "no $ENGINE_CLI to export with: install the engine (engine.sh), then run this again"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  chown "$coord" "$work" && chmod 0700 "$work"
  run_as "$coord" '"$1" export --instance "$2" --out "$3"' "$ENGINE_CLI" "$name" "$work/export.bundle" || refuse "the export failed (above): nothing removed"
  bundle="$ARCHIVE/$name-$stamp.bundle"
  install -o root -g root -m 0600 "$work/export.bundle" "$bundle"
  rm -rf "$work"
  echo "exported $name's history: $bundle (root's, 0600; worklane import reads it)"
else
  echo "no state of $name left to export$(ls -1 "$ARCHIVE" 2>/dev/null | grep -q "^$name-.*\.bundle$" && echo " (exported earlier: $(ls -1t "$ARCHIVE"/"$name"-*.bundle | head -1))")"
fi

# --- the registry's items, in its order

say "remove $name"
# The shared files' records first, all at once, while every one of them is still there (the GPU grant too, which
# testrun-gpu.sh then takes out): what each held is kept in the archive before anything changes.
records remove "$name" "$kept"
chmod 0600 "$kept"
echo "kept what the shared files held for $name: $kept"
mlog() { printf '{"at":%s,"by":%s,"what":"instance.removed","from":%s,"to":""}\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(json_str "${SUDO_USER:-root}")" "$(json_str "$1")" >> "$MACHINE_CHANGES"; chmod 0644 "$MACHINE_CHANGES"; }
for line in "${ITEMS[@]}"; do
  IFS=$'\t' read -r k w when <<<"$line"
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
    user)
      user_exists "$w" || continue
      uh="$(home_of "$w")" uid="$(id -u "$w")"
      # Its systemd user manager (lingering keeps one for the coordinator): stopped, so userdel finds no process of its.
      loginctl disable-linger "$w" 2>/dev/null || true
      systemctl stop "user@$uid.service" 2>/dev/null || true
      userdel -r "$w" 2>/dev/null || userdel "$w"
      # Its home goes with it whatever userdel said (a mail spool it couldn't find): it held the state and the keys.
      # Only a home that is that user's own: absolute, not /, owned by its uid, and no other user's home.
      if [[ "$uh" == /?* && "$uh" != / && -d "$uh" && "$(stat -c %u "$uh")" = "$uid" ]] && ! getent passwd | cut -d: -f6 | grep -qx "$uh"; then
        rm -rf --one-file-system -- "$uh"
      fi
      echo "removed user $w${uh:+ and its home $uh}"
      ;;
    group) exists group "$w" && groupdel "$w" && echo "removed group $w" ;;
  esac
done
systemctl daemon-reload

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
if [ "${planned:-0}" -gt 0 ] || [ -n "$bundle" ]; then mlog "$name"; fi
echo
echo "removed $name. Its history: ${bundle:-exported by an earlier run (in $ARCHIVE)}; what the shared files held: $kept"
github_steps
