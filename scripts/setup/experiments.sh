#!/usr/bin/env bash
# As root (review it first): experiment jobs for one instance (docs/experiments.md). Server mode only.
#
#   bash scripts/setup/experiments.sh install <name> [--memory-max 8G] [--cpu-weight 10]
#   bash scripts/setup/experiments.sh set <name> --devices 0 --max-minutes 20 --gpu-hours 8 --output-gb 50 [--env-network no]
#                                        [--tasks-max 1024] [--memory-gb 16] [--cpu-cores 4]
#   bash scripts/setup/experiments.sh data hash <path>                 the sha256 to approve (changes nothing; no root)
#   bash scripts/setup/experiments.sh data add <name> <id> --from <path> --sha256 <hex> --visibility job|scorer
#   bash scripts/setup/experiments.sh data remove <name> <id>
#   bash scripts/setup/experiments.sh check <name>
#   bash scripts/setup/experiments.sh status <name>
#   bash scripts/setup/experiments.sh remove <name>
#   bash scripts/setup/experiments.sh update-helper                     only the helper, from this checkout
#   bash scripts/setup/experiments.sh --print install <name>            (changes nothing)
# set and data add/remove show the file's change and ask before writing it (--yes skips the question).
#
# What install does:
#   - Two system users, no login, no home, no sudo, each in its own group only: wl-exp-<name> runs a job's build,
#     preflight, train and predict steps; wl-score-<name> runs its score step. Neither is ever in a GPU group: the
#     helper gives a granted unit the device group for that unit only.
#   - The helper /usr/local/libexec/worklane-exp (scripts/machine/worklane-exp.sh), root-owned, and a sudoers rule
#     letting wl-<name> run it for <name> only.
#   - worklane-exp.slice: a memory cap and a CPU weight below the instances'.
#   - /var/lib/worklane-exp/<name>: jobs (root's; the coordinator reads records, logs and outputs), evals (sealed eval
#     copies), data (approved sources; a job source is root:wl-exp-<name> 0750, a scorer source root:wl-score-<name>
#     0750), cache (environments, read-only once built).
#   - Root's file /etc/worklane/experiments/<name>.json with no GPU and no sources until `set` and `data add`.
# The approved data sources are copied here by root, checked against the sha256 you give (a mismatch installs
# nothing; the check is never skipped), and never fetched by a job: jobs have no network.
source "$(dirname "$0")/lib.sh"
all_args=("$@")
here="$(cd "$(dirname "$0")" && pwd)"
machine_dir="$here/../machine"

usage="usage: experiments.sh [--print] install <name> [options] | set <name> [options] | data hash <path> | data add <name> <id> --from <path> --sha256 <hex> --visibility job|scorer | data remove <name> <id> | check <name> | status <name> | remove <name> | update-helper"
print="" yes="" devices_set="" memory_max=8G cpu_weight=10 devices="" max_minutes="" gpu_hours="" output_gb="" env_network="" tasks_max="" memory_gb="" cpu_cores="" from="" want_sha="" visibility=""
pos=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print=1; shift ;;
    --yes) yes=1; shift ;;
    --memory-max) memory_max="${2:?}"; shift 2 ;;
    --cpu-weight) cpu_weight="${2:?}"; shift 2 ;;
    --devices) devices="${2?--devices needs GPU indices (or '' for none)}"; devices_set=1; shift 2 ;;
    --max-minutes) max_minutes="${2:?}"; shift 2 ;;
    --gpu-hours) gpu_hours="${2:?}"; shift 2 ;;
    --output-gb) output_gb="${2:?}"; shift 2 ;;
    --env-network) env_network="${2:?}"; shift 2 ;;
    --tasks-max) tasks_max="${2:?}"; shift 2 ;;
    --memory-gb) memory_gb="${2:?}"; shift 2 ;;
    --cpu-cores) cpu_cores="${2:?}"; shift 2 ;;
    --from) from="${2:?}"; shift 2 ;;
    --sha256) want_sha="${2:?}"; shift 2 ;;
    --visibility) visibility="${2:?}"; shift 2 ;;
    -*) echo "unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
cmd="${pos[0]:-}"
sub=""
case "$cmd" in
  install | set | check | status | remove) [ "${#pos[@]}" -eq 2 ] || { echo "$usage" >&2; exit 2; }; name="${pos[1]}" ;;
  update-helper) [ "${#pos[@]}" -eq 1 ] || { echo "$usage" >&2; exit 2; }; name=helper ;;
  data)
    sub="${pos[1]:-}"
    case "$sub" in
      hash) [ "${#pos[@]}" -eq 3 ] || { echo "$usage" >&2; exit 2; }; name=helper ;;
      add | remove) [ "${#pos[@]}" -eq 4 ] || { echo "$usage" >&2; exit 2; }; name="${pos[2]}"; sid="${pos[3]}"
        [[ "$sid" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || { echo "a data source id: lowercase letters, digits and dashes, at most 40" >&2; exit 2; } ;;
      *) echo "$usage" >&2; exit 2 ;;
    esac ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || { echo "the instance name: lowercase letters, digits and dashes, at most 21" >&2; exit 2; }
[[ "$memory_max" =~ ^[1-9][0-9]*[KMGT]$ ]] || { echo "--memory-max: a size such as 8G" >&2; exit 2; }
[[ "$cpu_weight" =~ ^[0-9]+$ ]] && [ "$cpu_weight" -ge 1 ] && [ "$cpu_weight" -le 10000 ] || { echo "--cpu-weight: 1 to 10000" >&2; exit 2; }

juser="wl-exp-$name"
suser="wl-score-$name"
coord="wl-$name"
base=/var/lib/worklane-exp
root="$base/$name"
etc_dir=/etc/worklane/experiments
rfile="$etc_dir/$name.json"
helper=/usr/local/libexec/worklane-exp

# A path's manifest: "<sha256>  <path>" per regular file (a file alone: its own name), sorted; refused when anything
# in it is a symlink or not a regular file or directory. Its sha256 is what root's file names.
manifest() {
  local p="$1"
  if [ -L "$p" ]; then echo "$p is a symlink" >&2; return 1; fi
  if [ -f "$p" ]; then printf '%s  %s\n' "$(sha256sum < "$p" | cut -d' ' -f1)" "$(basename "$p")"; return 0; fi
  [ -d "$p" ] || { echo "$p is not a file or a directory" >&2; return 1; }
  local bad
  bad="$(find "$p" -mindepth 1 \( ! -type f ! -type d \) -print -quit)"
  [ -z "$bad" ] || { echo "$bad is not a regular file or directory" >&2; return 1; }
  (cd "$p" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; done)
}

if [ "$cmd" = data ] && [ "$sub" = hash ]; then
  m="$(manifest "${pos[2]}")"
  echo "files: $(printf '%s\n' "$m" | grep -c .)"
  echo "sha256: $(printf '%s\n' "$m" | sha256sum | cut -d' ' -f1)"
  exit 0
fi

slice() {
  cat <<EOF
[Unit]
Description=worklane experiment jobs: a memory cap, weights below worklane.slice

[Slice]
CPUWeight=$cpu_weight
IOWeight=$cpu_weight
MemoryMax=$memory_max
MemorySwapMax=0
EOF
}

sudoers_rule() {
  printf '# %s runs its experiment jobs as %s and %s, through one validating helper, and nothing else.\n' "$coord" "$juser" "$suser"
  printf '%s ALL=(root) NOPASSWD: %s %s *\n' "$coord" "$helper" "$name"
}

if [ -n "$print" ]; then
  [ "$cmd" = install ] || { echo "--print goes with install" >&2; exit 2; }
  echo "# /etc/systemd/system/worklane-exp.slice"; slice; echo
  echo "# sudoers rule worklane-exp-$name"; sudoers_rule; echo
  echo "# $helper (scripts/machine/worklane-exp.sh)"; cat "$machine_dir/worklane-exp.sh"
  exit 0
fi
as_root "${all_args[@]}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ---- root's file -------------------------------------------------------------------------------------------------
# The current values (defaults when there is no file): F_DEVICES "0, 1", F_MAX, F_GPU_H, F_OUT, F_NET, F_SRC (lines).
# max_minutes starts at 20 (owner, 2026-10-15): raised per instance once its jobs are proven.
F_DEVICES="" F_MAX=20 F_GPU_H=8 F_OUT=50 F_NET=false F_TASKS=1024 F_MEM=16 F_CPUS=4
declare -A F_SHA=() F_VIS=()
read_file() {
  local l
  [ -f "$rfile" ] || return 0
  while IFS= read -r l; do
    if [[ "$l" =~ ^\ \ \"devices\":\ \[([0-9,\ ]*)\],$ ]]; then F_DEVICES="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"max_minutes\":\ ([0-9]+),$ ]]; then F_MAX="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"gpu_hours_per_day\":\ ([0-9]+),$ ]]; then F_GPU_H="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"output_gb\":\ ([0-9]+),$ ]]; then F_OUT="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"env_network\":\ (true|false),$ ]]; then F_NET="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"tasks_max\":\ ([0-9]+),$ ]]; then F_TASKS="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"memory_gb\":\ ([0-9]+),$ ]]; then F_MEM="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \"cpu_cores\":\ ([0-9]+),$ ]]; then F_CPUS="${BASH_REMATCH[1]}"
    elif [[ "$l" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,39})\":\ \{\ \"sha256\":\ \"([0-9a-f]{64})\",\ \"visibility\":\ \"(job|scorer)\"\ \},?$ ]]; then
      F_SHA[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"; F_VIS[${BASH_REMATCH[1]}]="${BASH_REMATCH[3]}"
    fi
  done < "$rfile"
}
# The file's text, exactly as the helper and src/experiments/root-file.ts read it.
file_text() {
  local ids=() i n
  printf '{\n  "version": 1,\n  "devices": [%s],\n  "max_minutes": %s,\n  "gpu_hours_per_day": %s,\n  "output_gb": %s,\n  "env_network": %s,\n  "tasks_max": %s,\n  "memory_gb": %s,\n  "cpu_cores": %s,\n' "$F_DEVICES" "$F_MAX" "$F_GPU_H" "$F_OUT" "$F_NET" "$F_TASKS" "$F_MEM" "$F_CPUS"
  while IFS= read -r i; do [ -n "$i" ] && ids+=("$i"); done < <(printf '%s\n' "${!F_SHA[@]}" | LC_ALL=C sort)
  if [ "${#ids[@]}" -eq 0 ]; then printf '  "sources": {}\n}\n'; return 0; fi
  printf '  "sources": {\n'
  n=0
  for i in "${ids[@]}"; do
    n=$((n + 1))
    printf '    "%s": { "sha256": "%s", "visibility": "%s" }%s\n' "$i" "${F_SHA[$i]}" "${F_VIS[$i]}" "$([ "$n" -lt "${#ids[@]}" ] && echo ,)"
  done
  printf '  }\n}\n'
}
# Show the change and write it (atomically, root:root 0644) after a yes.
write_file() {
  local tmp="$etc_dir/.$name.json.tmp"
  install -d -o root -g root -m 0755 /etc/worklane "$etc_dir"
  file_text > "$tmp"; chmod 0644 "$tmp"
  if cmp -s "$tmp" "$rfile"; then rm -f "$tmp"; echo "$rfile: no change"; return 0; fi
  echo "$rfile will change:"
  diff -u "$rfile" "$tmp" 2>/dev/null | tail -n +3 || diff -u /dev/null "$tmp" | tail -n +3 || true
  if [ -z "$yes" ]; then read -r -p "write it? [y/N] " a; [ "$a" = y ] || { rm -f "$tmp"; echo "nothing changed"; exit 1; }; fi
  mv -f "$tmp" "$rfile"
  echo "wrote $rfile"
}

install_helper() {
  local tmp
  tmp="$(dirname "$helper")/.worklane-exp.tmp"
  install -d -o root -g root -m 0755 "$(dirname "$helper")"
  install -o root -g root -m 0755 "$machine_dir/worklane-exp.sh" "$tmp"
  bash -n "$tmp" || { rm -f "$tmp"; echo "the helper doesn't parse; nothing installed" >&2; exit 1; }
  mv -f "$tmp" "$helper"
  echo "installed $helper (protocol $(sed -n 's/^PROTOCOL=\([0-9][0-9]*\)$/\1/p' "$helper"))"
}

need_instance() { id -u "$coord" >/dev/null 2>&1 || { echo "no $coord; set the instance up first" >&2; exit 1; }; }
need_installed() { id -u "$juser" >/dev/null 2>&1 && [ -d "$root" ] || { echo "experiments aren't installed for $name; run: sudo bash $0 install $name" >&2; exit 1; }; }

install_cmd() {
  local u
  need_instance
  command -v systemctl >/dev/null || { echo "this script is for Linux with systemd" >&2; exit 1; }
  say "users $juser and $suser: system users, no login, no home, each in its own group only"
  for u in "$juser" "$suser"; do
    if id -u "$u" >/dev/null 2>&1; then echo "user $u exists"; else useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$u"; echo "created $u"; fi
    [ "$(id -nG "$u")" = "$u" ] || { echo "$u is in other groups ($(id -nG "$u")): remove them first" >&2; exit 1; }
  done
  say "state in $root"
  install -d -o root -g root -m 0711 "$base"
  install -d -o root -g "$coord" -m 0750 "$root" "$root/jobs"
  install -d -o root -g root -m 0711 "$root/data" "$root/evals" "$root/cache"
  chown root:"$coord" "$root" "$root/jobs"; chmod 0750 "$root" "$root/jobs"
  say "worklane-exp.slice (MemoryMax $memory_max, CPU weight $cpu_weight)"
  slice > /etc/systemd/system/.worklane-exp.slice.tmp; chmod 0644 /etc/systemd/system/.worklane-exp.slice.tmp
  mv -f /etc/systemd/system/.worklane-exp.slice.tmp /etc/systemd/system/worklane-exp.slice
  systemctl daemon-reload
  say "the helper"
  install_helper
  say "root's file (no GPU, no data sources yet)"
  read_file; yes=1; write_file
  say "sudoers: $coord may run $helper $name ..., nothing else"
  install_sudoers "worklane-exp-$name" "$(sudoers_rule)"
  say "the egress rule: these users send nothing but loopback (the second layer under PrivateNetwork)"
  local flags=""
  grep -q '^# --with-test-users' /etc/worklane/egress.users 2>/dev/null && flags=--with-test-users
  if command -v nft >/dev/null 2>&1; then bash "$here/egress-firewall.sh" apply $flags || { echo "the egress rule didn't load; fix that, then run install again" >&2; exit 1; }
  else echo "no nft here: apt-get install -y nftables, then: sudo bash $here/egress-firewall.sh apply" >&2; exit 1; fi
  say "check"
  # As root, not as whoever ran sudo: the helper reads SUDO_USER as its caller, and refuses anyone but wl-<name>.
  env -u SUDO_USER "$helper" "$name" check || { echo "fix the FAIL lines, then run install again" >&2; exit 1; }
  echo
  echo "next: sudo bash $0 set $name --devices 0 --max-minutes 20 --gpu-hours 8 --output-gb 50"
  echo "      bash $0 data hash <path>; then sudo bash $0 data add $name <id> --from <path> --sha256 <hex> --visibility job|scorer"
}

set_cmd() {
  need_installed
  read_file
  if [ -n "$devices_set" ]; then
    [[ "$devices" =~ ^([0-9]{1,2}(,[0-9]{1,2}){0,15})?$ ]] || { echo "--devices: GPU indices such as 0 or 0,1 (none: --devices '')" >&2; exit 2; }
    F_DEVICES="$(printf '%s\n' "${devices//,/ }" | tr ' ' '\n' | grep . | sed 's/^0*\([0-9]\)/\1/' | sort -n -u | paste -sd, - | sed 's/,/, /g' || true)"
  fi
  if [ -n "$max_minutes" ]; then [[ "$max_minutes" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$max_minutes" -le 1440 ] || { echo "--max-minutes: 1 to 1440" >&2; exit 2; }; F_MAX="$max_minutes"; fi
  if [ -n "$gpu_hours" ]; then [[ "$gpu_hours" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--gpu-hours: 1 to 999" >&2; exit 2; }; F_GPU_H="$gpu_hours"; fi
  if [ -n "$output_gb" ]; then [[ "$output_gb" =~ ^[1-9][0-9]{0,4}$ ]] || { echo "--output-gb: 1 to 99999" >&2; exit 2; }; F_OUT="$output_gb"; fi
  case "$env_network" in "") ;; yes) F_NET=true ;; no) F_NET=false ;; *) echo "--env-network: yes or no" >&2; exit 2 ;; esac
  if [ -n "$tasks_max" ]; then [[ "$tasks_max" =~ ^[1-9][0-9]{1,5}$ ]] && [ "$tasks_max" -ge 16 ] && [ "$tasks_max" -le 100000 ] || { echo "--tasks-max: 16 to 100000" >&2; exit 2; }; F_TASKS="$tasks_max"; fi
  if [ -n "$memory_gb" ]; then [[ "$memory_gb" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "--memory-gb: 1 to 9999" >&2; exit 2; }; F_MEM="$memory_gb"; fi
  if [ -n "$cpu_cores" ]; then [[ "$cpu_cores" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--cpu-cores: 1 to 999" >&2; exit 2; }; F_CPUS="$cpu_cores"; fi
  write_file
}

data_add() {
  local grp m got tmp d="$root/data/$sid"
  need_installed
  [ -n "$from" ] && [[ "$want_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "data add needs --from <path> and --sha256 <64 hex> (from: bash $0 data hash <path>)" >&2; exit 2; }
  case "$visibility" in job) grp="$juser" ;; scorer) grp="$suser" ;; *) echo "--visibility: job or scorer" >&2; exit 2 ;; esac
  read_file
  [ -z "${F_SHA[$sid]:-}" ] || { echo "$sid is approved already; remove it first" >&2; exit 1; }
  tmp="$root/data/.$sid.new"
  rm -rf --one-file-system -- "$tmp"
  install -d -o root -g root -m 0700 "$tmp"
  say "copy $from, then check it against the sha256 you gave"
  if [ -f "$from" ] && [ ! -L "$from" ]; then cp -- "$from" "$tmp/"; else manifest "$from" > /dev/null || exit 1; cp -R -- "$from/." "$tmp/"; fi
  # WHY the copy, not the source: what is checked is exactly what jobs will read, and nobody but root can change it.
  m="$(manifest "$tmp")" || { rm -rf --one-file-system -- "$tmp"; exit 1; }
  got="$(printf '%s\n' "$m" | sha256sum | cut -d' ' -f1)"
  if [ "$got" != "$want_sha" ]; then rm -rf --one-file-system -- "$tmp"; echo "sha256 mismatch for $sid: got $got, expected $want_sha; nothing installed" >&2; exit 1; fi
  chown -R root:"$grp" "$tmp"; find "$tmp" -type d -exec chmod 0750 {} +; find "$tmp" -type f -exec chmod 0640 {} +
  F_SHA[$sid]="$want_sha"; F_VIS[$sid]="$visibility"
  write_file
  rm -rf --one-file-system -- "$d"
  mv "$tmp" "$d"
  printf '%s\n' "$m" > "$root/data/.$sid.manifest.tmp"; chmod 0644 "$root/data/.$sid.manifest.tmp"; mv -f "$root/data/.$sid.manifest.tmp" "$root/data/$sid.manifest"
  echo "approved $sid ($visibility-only, $(printf '%s\n' "$m" | grep -c .) files)"
}

data_remove() {
  need_installed
  read_file
  [ -n "${F_SHA[$sid]:-}" ] || { echo "$sid is not approved" >&2; exit 1; }
  unset "F_SHA[$sid]" "F_VIS[$sid]"
  write_file
  rm -rf --one-file-system -- "$root/data/$sid" "$root/data/$sid.manifest"
  echo "removed $sid"
}

remove_cmd() {
  local u
  say "the sudoers rule, the state, root's file and the users"
  remove_sudoers "worklane-exp-$name"
  rm -rf --one-file-system -- "$root"
  rm -f -- "$rfile"
  for u in "$juser" "$suser"; do if id -u "$u" >/dev/null 2>&1; then userdel "$u"; fi; done
  if [ -z "$(ls -A "$base" 2>/dev/null)" ]; then
    echo "no other instance's experiments here: removing the shared parts too"
    rm -f /etc/systemd/system/worklane-exp.slice "$helper"; rm -rf "$base"; rmdir "$etc_dir" 2>/dev/null || true
    systemctl daemon-reload
  fi
  echo "removed"
}

case "$cmd" in
  install) install_cmd ;;
  set) set_cmd ;;
  data) if [ "$sub" = add ]; then data_add; else data_remove; fi ;;
  check) need_installed; env -u SUDO_USER "$helper" "$name" check ;;
  status) need_installed; cat "$rfile"; ls -l "$root/data" ;;
  remove) remove_cmd ;;
  update-helper) if [ -f "$helper" ] && cmp -s "$helper" "$machine_dir/worklane-exp.sh"; then echo "$helper already matches"; else install_helper; fi ;;
esac
