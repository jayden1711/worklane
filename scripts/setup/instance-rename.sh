#!/usr/bin/env bash
# Rename an instance on this machine, as root, at the machine's own terminal (review it first). Nothing else can start
# it: no sudoers rule and no machine helper command names it, and the dashboard has no button for it.
#
#   sudo bash scripts/setup/instance-rename.sh <old> <new> --print    every step, what it carries and what it changes
#   sudo bash scripts/setup/instance-rename.sh <old> <new>            asks for <new> to be typed back first
#   sudo bash scripts/setup/instance-rename.sh <old> <new> --yes      no question (a rerun resumes where it stopped)
#   sudo bash scripts/setup/instance-rename.sh <old> <new> --abort    undo a rename stopped before <new> started
#
# Built on what the machine already does: export, add (instance.sh, the instance home, checkout.sh, service.sh,
# test-user.sh, machine-helper.sh, dashboards.sh), import, and instance-remove.sh. The new name runs on the same repo
# with the same GitHub App (its key and installation carried, never made again) and the same agents' Claude logins.
#
# Refused, changing nothing: <new> isn't a name add-project takes, or is in use (any user, unit, file or record of it);
# <old> has work in flight (its coordinator active: stop it once its runs are done; a process of its users; a test
# run); another rename of <old> is under way. Old and new never run at once: <old>'s coordinator unit is parked (moved
# out of systemd's reach, so nothing, the engine updater included, can start it) before anything of <new> exists, and
# <new> starts only once <old>'s history is in it.
#
# The steps, each recorded in /var/lib/worklane/renames/<old>-to-<new> once done, so a rerun picks up after the last:
#   park      <old>'s coordinator unit moved aside (kept beside the record, to put back on --abort)
#   export    <old>'s history (worklane export, as its coordinator) to /var/lib/worklane/removed/<old>-<time>.bundle,
#             root's 0600
#   users     instance.sh <new> (--eval when <old> has an eval user)
#   home      <new>'s instance home, then <old>'s files carried into it (its instance.yaml, policy, credentials, ...),
#             every path and user in them moved to <new>'s (a file that would still name <old> stops it, carrying
#             nothing); <old>'s ~/.config/<old>-* (its App key and secrets, chat bot token, backup key) and the
#             agents' Claude logins and account profiles, copied to <new>'s users, each the new user's own
#   checkout  checkout.sh <new> <repo>: a fresh clone, through the same App
#   import    <old>'s history into <new>, as <new>'s coordinator (worklane import), then `worklane instance renamed`:
#             every Siri device token revoked (a token names its instance: make new ones on the dashboard), and each
#             console ask still open for <old> asked again for <new>
#   records   root's shared records of <old> become <new>'s: the agents' Claude profiles, status and paused list, the
#             canary, incidents, staged signers, the init record (instance-records.cjs rekey)
#   services  <new>'s test user when <old> had one, its GPU grant (testrun-gpu.sh disable <old>, enable <new>, the same
#             GPUs), its coordinator (service.sh, with <old>'s limits), the machine helper's rule and the hub with <new>
#   remove    instance-remove.sh <old> --yes: <old>'s users, units, files and anything left of its (it exports again)
# A failed step stops there, saying how to go on (rerun the same command) and, before `services`, how to undo it all
# (--abort: <new> removed, <old>'s records and unit put back; <old> left stopped). Once <new> has run, the way back is
# renaming it back.
#
# On GitHub nothing changes: the App keeps its name (<old>-worklane unless GitHub's form changed it); rename it in its
# settings if you like (the engine reads its name from GitHub each time). The open claim refs are <old>'s leases, now
# <new>'s history: <new> releases or renews each one by its exact commit (compare-and-swap), so there is never a second
# holder. The gardener's log issue (marked gardener-log:<old>) stays as it is; <new> opens its own.
source "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
usage="usage: instance-rename.sh <old> <new> [--print | --yes | --abort]"
old="" new="" print="" yes="" abort=""
for a in "$@"; do
  case "$a" in
    --print) print=1 ;;
    --yes) yes=1 ;;
    --abort) abort=1 ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) if [ -z "$old" ]; then old="$a"; elif [ -z "$new" ]; then new="$a"; else echo "$usage" >&2; exit 2; fi ;;
  esac
done
[ -n "$old" ] && [ -n "$new" ] && [ "$(( ${print:-0} + ${yes:-0} + ${abort:-0} ))" -le 1 ] || { echo "$usage" >&2; exit 2; }
[[ "$old" =~ ^[a-z][a-z0-9-]{0,20}$ && "$old" != dash ]] || { echo "instance name $old: lowercase letters, digits and dashes, starting with a letter, at most 21; not dash" >&2; exit 2; }
instance_name_ok "$new" || { echo "the new name $new: lowercase letters, digits and dashes, starting with a letter, at most 21; not dash, and not ending in -agent, -eval or -work" >&2; exit 2; }
[ "$old" != "$new" ] || { echo "the new name is the old one" >&2; exit 2; }
as_root "$@"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ "${SUDO_USER:-}" != wl-* ]] || { echo "instance-rename is an admin's, at the machine's terminal: not $SUDO_USER's" >&2; exit 1; }
NODE="$(command -v node)" || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
records() { "$NODE" "$here/instance-records.cjs" "$@"; }
refuse() { echo "refused: $*" >&2; exit 1; }

RENAMES=/var/lib/worklane/renames ARCHIVE=/var/lib/worklane/removed
progress="$RENAMES/$old-to-$new" parked="$RENAMES/$old-to-$new.unit"
done_step() { grep -qx "$1" "$progress" 2>/dev/null; }
mark() { echo "$1" >> "$progress"; }
inst_dir() { echo "$(home_of "wl-$1")/.local/state/worklane/instances/$1"; }
unit=/etc/systemd/system/worklane-$old.service
STEPS=(park export users home checkout import records services remove)

# --- what there is

old_home="$(home_of "wl-$old" 2>/dev/null || true)"
repo=""
[ -z "$old_home" ] || repo="$(sed -n 's/^ *repo: *\([^ ]*\) *$/\1/p' "$old_home/.local/state/worklane/instances/$old/instance.yaml" 2>/dev/null | head -1 || true)"
[ -n "$repo" ] || repo="$(sed -n 's/^repo=//p' "$progress" 2>/dev/null | head -1 || true)"
started=""; [ -f "$progress" ] && started=1
# Anything of <new>'s on this machine: its users, units, files and records (the registry), or a place in the lists.
new_in_use() {
  local line k w when
  while IFS= read -r line; do
    IFS=$'\t' read -r k w when _ <<<"$line"
    case "$k" in
      user) user_exists "$w" && echo "user $w" ;;
      group) getent group "$w" >/dev/null 2>&1 && echo "group $w" ;;
      unit) [ -e "/etc/systemd/system/$w" ] && echo "unit $w" ;;
      sudoers) sudoers_installed "$w" && echo "sudoers file $w" ;;
      path) [ -e "$w" ] && echo "$w" ;;
    esac
  done < <(records items "$new")
  records plan "$new" | cut -f1,2 | sed 's/^/record /'
  { helper_instances; hub_instances; } | grep -qx "$new" && echo "the machine helper's rule or the hub names $new"
  return 0
}

show_plan() {
  local s
  echo "rename $old to $new (repo ${repo:-unknown}):"
  for s in "${STEPS[@]}"; do
    if done_step "$s"; then printf '  done     %s\n' "$s"; continue; fi
    case "$s" in
      park) printf '  park     %s moved aside (nothing can start %s while this runs)\n' "$unit" "worklane-$old.service" ;;
      export) printf "  export   %s's history -> %s/%s-<time>.bundle, root's 0600\n" "$old" "$ARCHIVE" "$old" ;;
      users) printf '  users    wl-%s, wl-%s-agent%s, group wl-%s-work (instance.sh)\n' "$new" "$new" "$(user_exists "wl-$old-eval" && echo ", wl-$new-eval")" "$new" ;;
      home) printf "  home     %s's instance home, with %s's files (paths and users moved), its ~/.config/%s-* and the agents' Claude logins\n" "$new" "$old" "$old" ;;
      checkout) printf '  checkout %s/%s/%s, a fresh clone through the same App\n' "$SRV_ROOT" "$new" "${repo#*/}" ;;
      import) printf "  import   %s's history into %s; Siri device tokens revoked; open asks asked again for %s\n" "$old" "$new" "$new" ;;
      records) printf "  records  %s\n" "$(records plan "$old" | cut -f1 | grep -vx gpu | tr '\n' ' ')" ;;
      services) printf '  services %s%s, worklane-%s.service, the machine helper rule and the hub with %s\n' "$(user_exists "wl-test-$old" && echo "test user wl-test-$new, ")" "$(records plan "$old" | cut -f1 | grep -qx gpu && echo "the GPU grant, ")" "$new" "$new" ;;
      remove) printf '  remove   instance-remove.sh %s --yes\n' "$old" ;;
    esac
  done
  echo "  kept     the GitHub App (its name too) and the repo; claim refs are released or renewed by $new"
}

# --- checks: before anything changes, and again on each rerun

if done_step done; then echo "$old was renamed to $new already ($progress)"; exit 0; fi

if [ -n "$abort" ]; then
  [ -n "$started" ] || refuse "no rename of $old to $new under way ($progress)"
  done_step services && refuse "$new has started already: rename it back instead (instance-rename.sh $new $old)"
  exec 9> "$ADD_PROJECT_LOCK"
  flock -n 9 || refuse "an add-project, instance-remove or instance-rename is running on this machine; wait for it to finish"
  say "abort: $new goes, $old's records and unit come back"
  if done_step records; then records rekey "$new" "$old" "$ARCHIVE/$new-abort-$(date -u +%Y%m%dT%H%M%SZ).records.json"; [ ! -f "/var/lib/worklane/init/$old.json" ] || chgrp "wl-$old" "/var/lib/worklane/init/$old.json"; fi
  # <new> never ran: its history is <old>'s, exported already.
  if done_step users; then flock -u 9; bash "$here/instance-remove.sh" "$new" --yes --exported "$(sed -n 's/^bundle=//p' "$progress" | tail -1)"; flock -n 9 || refuse "lost the lock"; fi
  if [ -f "$parked" ]; then mv -f "$parked" "$unit"; systemctl daemon-reload; echo "put back $unit ($old stays stopped: sudo systemctl start worklane-$old.service)"; fi
  rm -f "$progress"
  echo "aborted: $old is as it was, stopped; $new is gone"
  exit 0
fi

if [ -z "$started" ]; then
  [ -n "$old_home" ] && [ -f "$(inst_dir "$old")/instance.yaml" ] || refuse "no instance $old on this machine (no $(inst_dir "$old" 2>/dev/null || echo "wl-$old")/instance.yaml)"
  [ -n "$repo" ] || refuse "$old's instance.yaml names no repo"
  other="$(ls -1 "$RENAMES" 2>/dev/null | grep -E "^$old-to-[a-z0-9-]+$|-to-$old$|^$new-to-|-to-$new$" | head -1 || true)"
  [ -z "$other" ] || refuse "another rename is under way: $other (finish it, or --abort it)"
  inuse="$(new_in_use)"
  [ -z "$inuse" ] || { echo "refused: $new is in use on this machine; nothing changed:" >&2; printf '%s\n' "$inuse" | sed 's/^/  /' >&2; exit 1; }
fi

# A filesystem mounted inside what the last step removes would stop it part way, once <new> runs: refused up front.
mounted() { local m; m="$(instance_mounts "$old")"; [ -z "$m" ] || printf 'a filesystem is mounted at %s, inside what the removal of %s takes: unmount it first\n' $m "$old"; }
if [ -n "$print" ]; then
  show_plan
  busy="$(instance_in_flight "$old"; mounted)"
  [ -z "$busy" ] || { echo; echo "it would refuse now, while:"; printf '%s\n' "$busy" | sed 's/^/  /'; }
  exit 0
fi

exec 9> "$ADD_PROJECT_LOCK"
flock -n 9 || refuse "an add-project, instance-remove or instance-rename is running on this machine; wait for it to finish"
if ! done_step remove; then
  busy="$(instance_in_flight "$old"; mounted)"
  [ -z "$busy" ] || { echo "refused: $old has work in flight; nothing changed:" >&2; printf '%s\n' "$busy" | sed 's/^/  /' >&2; exit 1; }
fi
show_plan
if [ -z "$yes" ] && [ -z "$started" ]; then
  [ -t 0 ] || refuse "this asks for the new name to be typed back: run it in a terminal, or pass --yes"
  read -r -p "Type the new name ($new) to rename $old to it, anything else to stop: " typed
  [ "$typed" = "$new" ] || { echo "not renamed: nothing changed"; exit 1; }
fi

install -d -o root -g root -m 0700 "$RENAMES" "$ARCHIVE"
[ -n "$started" ] || printf 'repo=%s\n' "$repo" > "$progress"
chmod 0600 "$progress"
step_failed() {
  local s="$1"
  echo >&2
  echo "the rename stopped at step $s (above). Go on, once that is fixed: sudo bash $here/instance-rename.sh $old $new --yes" >&2
  if ! done_step services; then echo "Or undo it all ($new removed, $old as it was, stopped): sudo bash $here/instance-rename.sh $old $new --abort" >&2
  else echo "$new runs already: to go back, rename it back once this one is done (instance-rename.sh $new $old)" >&2; fi
}
run_step() {
  local s="$1"
  done_step "$s" && return 0
  say "$s"
  # Not under an if: errexit would be off inside the step.
  set +e
  ( set -e; "step_$s" )
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] || { step_failed "$s"; exit 1; }
  mark "$s"
}

# --- the steps

step_park() {
  [ ! -f "$parked" ] || { echo "parked already"; return 0; }
  if [ -e "$unit" ]; then
    systemctl stop "worklane-$old.service" 2>/dev/null || true
    mv -f "$unit" "$parked"
    chmod 0600 "$parked"
  fi
  systemctl daemon-reload
  [ "$(systemctl show -p LoadState --value "worklane-$old.service")" = not-found ] || { echo "worklane-$old.service is still loaded"; return 1; }
  echo "parked $unit in $parked: nothing can start $old's coordinator now"
}

step_export() {
  local work stamp
  work="$(mktemp -d)"
  chown "wl-$old" "$work" && chmod 0700 "$work"
  run_as "wl-$old" '"$1" export --instance "$2" --out "$3"' "$ENGINE_CLI" "$old" "$work/export.bundle" || { rm -rf "$work"; return 1; }
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -o root -g root -m 0600 "$work/export.bundle" "$ARCHIVE/$old-$stamp.bundle"
  rm -rf "$work"
  printf 'bundle=%s\n' "$ARCHIVE/$old-$stamp.bundle" >> "$progress"
  echo "exported $old's history: $ARCHIVE/$old-$stamp.bundle (root's, 0600)"
}

step_users() {
  if user_exists "wl-$old-eval"; then bash "$here/instance.sh" "$new" --eval; else bash "$here/instance.sh" "$new"; fi
}

# A copy of <from> at <to>, the new user's own (its directories too, from the first one it makes).
copy_as() {
  local from="$1" to="$2" owner="$3"
  [ -e "$from" ] || return 0
  install -d -o "$owner" -g "$owner" -m 0700 "$(dirname "$to")"
  rm -rf "$to"
  cp -a "$from" "$to"
  chown -R -h "$owner:$owner" "$to"
}
step_home() {
  local nh oh oa na oe="" ne="" d from to owner
  ensure_instance_home "$new" "$repo"
  oh="$old_home" nh="$(home_of "wl-$new")" oa="$(home_of "wl-$old-agent")" na="$(home_of "wl-$new-agent")"
  if user_exists "wl-$old-eval"; then oe="$(home_of "wl-$old-eval")" ne="$(home_of "wl-$new-eval")"; fi
  # The coordinator's own config dirs: the App's key and secrets, the dashboard's secrets, gh, the chat bot, backups.
  for d in "$oh/.config/$old"-*; do
    [ -d "$d" ] || continue
    copy_as "$d" "$nh/.config/$new-${d##*/"$old"-}" "wl-$new"
    echo "carried $d -> $nh/.config/$new-${d##*/"$old"-}"
  done
  # The instance home's files, moved (all of them worked out first: a file that would still name the old instance
  # stops it here, nothing carried); then each file they name in the old users' homes.
  local named
  named="$(records carry "$old" "$new" "$(inst_dir "$old")" "$(inst_dir "$new")" "$oh" "$nh" "$oa" "$na" ${oe:+"$oe" "$ne"})" || return 1
  while IFS=$'\t' read -r from to; do
    [ -n "$from" ] || continue
    if [[ "$from" == "$oa"/* ]]; then owner="wl-$new-agent"
    elif [ -n "$oe" ] && [[ "$from" == "$oe"/* ]]; then owner="wl-$new-eval"
    else owner="wl-$new"; fi
    copy_as "$from" "$to" "$owner"
    echo "carried $from -> $to"
  done <<<"$named"
  find "$(inst_dir "$new")" -maxdepth 1 -type f -exec chown -h "wl-$new:wl-$new" {} +
  # The agents' Claude logins and account profiles (claude-account.sh's dirs), each the new user's own.
  copy_as "$oa/.claude/.credentials.json" "$na/.claude/.credentials.json" "wl-$new-agent"
  copy_as "$oa/.claude-profiles" "$na/.claude-profiles" "wl-$new-agent"
  if [ -n "$oe" ]; then copy_as "$oe/.claude/.credentials.json" "$ne/.claude/.credentials.json" "wl-$new-eval"; fi
}

step_checkout() {
  bash "$here/checkout.sh" "$new" "$repo"
  run_as "wl-$new" '"$1" instance show "$2" >/dev/null' "$ENGINE_CLI" "$new" || { echo "$new's instance doesn't load as wl-$new (above)"; return 1; }
}

step_import() {
  local bundle work force=()
  bundle="$(sed -n 's/^bundle=//p' "$progress" | tail -1)"
  [ -f "$bundle" ] || { echo "no export of $old's ($bundle)"; return 1; }
  work="$(mktemp -d)"
  install -o "wl-$new" -g "wl-$new" -m 0600 "$bundle" "$work/old.bundle"
  chown "wl-$new" "$work" && chmod 0700 "$work"
  # The new instance's state is this rename's alone (made by step users): an event log there is its first start's.
  [ ! -e "$(inst_dir "$new")/state/events.db" ] || force=(--force)
  run_as "wl-$new" '"$1" import "$2" --instance "$3" "${@:4}"' "$ENGINE_CLI" "$work/old.bundle" "$new" "${force[@]}" || { rm -rf "$work"; return 1; }
  rm -rf "$work"
  run_as "wl-$new" '"$1" instance renamed "$2" --from "$3"' "$ENGINE_CLI" "$new" "$old"
}

step_records() {
  records rekey "$old" "$new" "$ARCHIVE/$old-to-$new-$(date -u +%Y%m%dT%H%M%SZ).records.json"
  [ ! -f "/var/lib/worklane/init/$new.json" ] || chgrp "wl-$new" "/var/lib/worklane/init/$new.json"
}

# One limit from the old coordinator's unit, as service.sh wrote it.
old_limit() { sed -n "s/^$1=//p" "$parked" 2>/dev/null | head -1; }
step_services() {
  local devices args=() v names
  if user_exists "wl-test-$old" && ! user_exists "wl-test-$new"; then bash "$here/test-user.sh" install "$new"; fi
  devices="$(records plan "$old" | awk -F'\t' '$1 == "gpu" { print $3 }' | sed -n 's/.*"devices":\[\([0-9,]*\)\].*/\1/p')"
  if [ -n "$devices" ]; then
    # A grant is only ever made for an instance with a test user (testrun-gpu.sh enable); one whose test user has gone
    # since can't be moved, and goes.
    if user_exists "wl-test-$new"; then bash "$here/testrun-gpu.sh" enable "$new" --devices "$devices"; else echo "note: $old's GPU grant (GPU $devices) is not moved: $old has no test user, so its runs never had the GPU; enable it for $new once it has one (testrun-gpu.sh enable $new)"; fi
    bash "$here/testrun-gpu.sh" disable "$old"
  fi
  v="$(old_limit MemoryMax)"; [[ "$v" =~ ^[0-9]+[KMGT]?$|^[0-9]+%$ ]] && args+=(--memory-max "$v")
  v="$(old_limit MemoryHigh)"; [[ "$v" =~ ^[0-9]+[KMGT]?$|^[0-9]+%$|^infinity$ ]] && args+=(--memory-high "$v")
  v="$(old_limit CPUWeight)"; [[ "$v" =~ ^[0-9]+$ ]] && args+=(--cpu-weight "$v")
  v="$(old_limit TasksMax)"; [[ "$v" =~ ^[0-9]+$ ]] && args+=(--tasks-max "$v")
  bash "$here/service.sh" "$new" "${args[@]}"
  names="$({ helper_instances; echo "$new"; } | sort -u | while read -r n; do if user_exists "wl-$n"; then echo "$n"; fi; done | tr '\n' ' ')"
  # shellcheck disable=SC2086 # one word per instance name
  bash "$here/machine-helper.sh" $names
  if [ -f "$HUB_UNIT" ]; then
    mapfile -t args < <(hub_keep_args)
    names="$({ hub_instances; echo "$new"; } | sort -u | while read -r n; do if [ -d "$(inst_dir "$n" 2>/dev/null)/state" ]; then echo "$n"; fi; done | tr '\n' ' ')"
    # shellcheck disable=SC2086 # one word per instance name
    bash "$here/dashboards.sh" "${args[@]}" $names
  fi
}

step_remove() {
  # instance-remove.sh takes the same machine lock: let go of it for the removal, and take it back after.
  flock -u 9
  bash "$here/instance-remove.sh" "$old" --yes
  flock -n 9 || { echo "another add-project, instance-remove or instance-rename took the machine lock"; return 1; }
  rm -f "$parked"
}

for s in "${STEPS[@]}"; do run_step "$s"; done
printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress"
mark done
printf '{"at":%s,"by":%s,"what":"instance.renamed","from":%s,"to":%s}\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(json_str "${SUDO_USER:-root}")" "$(json_str "$old")" "$(json_str "$new")" >> "$MACHINE_CHANGES"
chmod 0644 "$MACHINE_CHANGES"
echo
echo "renamed $old to $new ($repo). $old's history: $(sed -n 's/^bundle=//p' "$progress" | tail -1)"
echo "Next:"
echo "  - Siri: every device token was revoked (each named $old): make new ones on $new's dashboard, Settings > Siri"
echo "  - GitHub: nothing changed. The App keeps its name ($old-worklane, unless GitHub's form changed it); to rename it, in the App's settings on GitHub (the engine reads its name from GitHub)"
echo "  - the gardener's log issue (gardener-log:$old) stays as it is; $new opens its own"
