#!/usr/bin/env bash
# As root, per machine: which instances' test runs may use the GPU (docs/test-runs.md "GPU"). Off unless this is run.
#
#   bash scripts/setup/testrun-gpu.sh status
#   bash scripts/setup/testrun-gpu.sh enable <name> [--devices 0[,1...]] [--max-minutes 20]
#   bash scripts/setup/testrun-gpu.sh disable <name>
#
# Writes /etc/worklane/testrun-gpu.json, root:root 0644: the one place the sandbox helper
# (/usr/local/libexec/worklane-testrun) reads whether an instance's runs may have a GPU, which GPUs (their indices,
# /dev/nvidia<N>; 0 unless --devices says) and the longest a GPU command may run (--max-minutes, 1 to 120, default 20;
# one value for the machine). A tier still has to ask (tests.yaml test_run, `gpu: true`); the helper grants it only
# what this file lists. Nothing the coordinator, the dashboard or a repo can write changes it.
#
# Also writes /etc/tmpfiles.d/worklane-gpu.conf, so each listed GPU's lock file (/run/worklane/gpu/<N>.lock, root's
# 0644) is there from boot: one GPU test run per GPU at a time, and `worklane gpu hold -- <command>` takes the same
# lock for your own GPU jobs.
#
# WHY a separate file, never policy.yaml: the dashboard writes policy.yaml's settings, and this decides what a
# sandboxed run can touch. And WHY off by default: a GPU driver fault can hang the whole machine; turn it on for an
# instance only once you mean to.
source "$(dirname "$0")/lib.sh"

GPU_FILE=/etc/worklane/testrun-gpu.json
TMPFILES=/etc/tmpfiles.d/worklane-gpu.conf
LOCK_DIR=/run/worklane/gpu
usage="usage: testrun-gpu.sh status | enable <name> [--devices 0[,1...]] [--max-minutes 1-120] | disable <name>"

cmd="${1:-}"
[ -n "$cmd" ] || { echo "$usage" >&2; exit 2; }
shift
name="" devices="" max=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --devices) devices="${2:?--devices needs GPU indices, e.g. 0 or 0,1}"; shift 2 ;;
    --max-minutes) max="${2:?--max-minutes needs a number of minutes}"; shift 2 ;;
    -*) echo "unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "$usage" >&2; exit 2; }; name="$1"; shift ;;
  esac
done
case "$cmd" in
  status) [ -z "$name$devices$max" ] || { echo "$usage" >&2; exit 2; } ;;
  enable) instance_name_ok "$name" || { echo "not an instance name: ${name:-(none)}" >&2; exit 2; } ;;
  disable) instance_name_ok "$name" && [ -z "$devices$max" ] || { echo "$usage" >&2; exit 2; } ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [ -n "$devices" ]; then
  [[ "$devices" =~ ^[0-9]{1,2}(,[0-9]{1,2}){0,15}$ ]] || { echo "--devices: GPU indices 0 to 99, comma-separated (e.g. 0 or 0,1), got $devices" >&2; exit 2; }
fi
if [ -n "$max" ]; then
  [[ "$max" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$max" -le 120 ] || { echo "--max-minutes: 1 to 120, got $max" >&2; exit 2; }
fi
as_root "$cmd" ${name:+"$name"} ${devices:+--devices "$devices"} ${max:+--max-minutes "$max"}

# The file as it is: NAMES[i] lists DEVS[i] (", "-separated), MAX minutes. Exactly the form written below (the helper
# reads only that); anything else stops here, changing nothing.
NAMES=() DEVS=() MAX=20
read_file() {
  local lines=() l n i
  [ -e "$GPU_FILE" ] || return 0
  [ -f "$GPU_FILE" ] && [ ! -L "$GPU_FILE" ] || { echo "$GPU_FILE is not a regular file; remove it, then run this again" >&2; exit 1; }
  while IFS= read -r l || [ -n "$l" ]; do lines+=("$l"); done < "$GPU_FILE"
  n="${#lines[@]}"
  local bad="$GPU_FILE is not in the form this script writes; remove it (sudo rm $GPU_FILE), then run this again"
  [ "$n" -ge 5 ] && [ "${lines[0]}" = '{' ] && [ "${lines[1]}" = '  "version": 1,' ] && [ "${lines[$((n - 1))]}" = '}' ] || { echo "$bad" >&2; exit 1; }
  [[ "${lines[2]}" =~ ^\ \ \"max_minutes\":\ ([1-9][0-9]{0,2}),$ ]] || { echo "$bad" >&2; exit 1; }
  MAX="${BASH_REMATCH[1]}"
  if [ "$n" -eq 5 ]; then [ "${lines[3]}" = '  "instances": {}' ] || { echo "$bad" >&2; exit 1; }; return 0; fi
  [ "${lines[3]}" = '  "instances": {' ] && [ "${lines[$((n - 2))]}" = '  }' ] || { echo "$bad" >&2; exit 1; }
  for ((i = 4; i < n - 2; i++)); do
    [[ "${lines[$i]}" =~ ^\ \ \ \ \"([a-z][a-z0-9-]{0,20})\":\ \{\ \"devices\":\ \[([0-9]{1,2}(,\ [0-9]{1,2}){0,15})\]\ \}(,?)$ ]] || { echo "$bad" >&2; exit 1; }
    NAMES+=("${BASH_REMATCH[1]}"); DEVS+=("${BASH_REMATCH[2]}")
  done
}

# The file's text: one instance a line, sorted by name; the helper and src/testrun/gpu.ts read exactly this.
file_text() {
  local i n="${#NAMES[@]}" order
  printf '{\n  "version": 1,\n  "max_minutes": %s,\n' "$MAX"
  if [ "$n" -eq 0 ]; then printf '  "instances": {}\n}\n'; return 0; fi
  printf '  "instances": {\n'
  order="$(for i in "${!NAMES[@]}"; do printf '%s %s\n' "${NAMES[$i]}" "$i"; done | sort | cut -d' ' -f2)"
  local k=0
  for i in $order; do
    k=$((k + 1))
    printf '    "%s": { "devices": [%s] }%s\n' "${NAMES[$i]}" "${DEVS[$i]}" "$([ "$k" -lt "$n" ] && echo , || true)"
  done
  printf '  }\n}\n'
}

# Every GPU index any instance lists, once each, ascending.
all_indices() { for d in ${DEVS[@]+"${DEVS[@]}"}; do printf '%s\n' "${d//, /$'\n'}"; done | sed 's/^0*\([0-9]\)/\1/' | sort -n -u; }

show() {
  local i
  if [ ! -e "$GPU_FILE" ]; then echo "GPU test runs: off on this machine (no $GPU_FILE)"; return 0; fi
  if [ "${#NAMES[@]}" -eq 0 ]; then echo "GPU test runs: off for every instance (max $MAX min per GPU command)"; return 0; fi
  echo "GPU test runs: on for ${#NAMES[@]} instance(s); max $MAX min per GPU command"
  for i in "${!NAMES[@]}"; do echo "  ${NAMES[$i]}: GPU ${DEVS[$i]//, /,}"; done
  for i in $(all_indices); do
    if [ -c "/dev/nvidia$i" ]; then echo "  /dev/nvidia$i: present"; else echo "  /dev/nvidia$i: missing (no GPU run gets it until it exists)"; fi
  done
  for i in nvidiactl nvidia-uvm; do [ -c "/dev/$i" ] || echo "  /dev/$i: missing: the NVIDIA driver isn't loaded, so every GPU run runs without the GPU"; done
}

read_file
case "$cmd" in
  status) show; exit 0 ;;
  enable)
    id -u "wl-test-$name" >/dev/null 2>&1 || { echo "no test user wl-test-$name: set up $name's test runs first (scripts/setup/test-user.sh install $name)" >&2; exit 1; }
    want="$(printf '%s' "${devices:-0}" | tr ',' '\n' | sed 's/^0*\([0-9]\)/\1/' | sort -n -u | paste -sd, - | sed 's/,/, /g')"
    keep_n=() keep_d=()
    for i in "${!NAMES[@]}"; do [ "${NAMES[$i]}" = "$name" ] || { keep_n+=("${NAMES[$i]}"); keep_d+=("${DEVS[$i]}"); }; done
    NAMES=(${keep_n[@]+"${keep_n[@]}"} "$name"); DEVS=(${keep_d[@]+"${keep_d[@]}"} "$want")
    [ -z "$max" ] || MAX="$max"
    say "GPU test runs for $name: GPU ${want//, /,}, at most $MAX min per GPU command"
    echo "A GPU driver fault can hang the whole machine. Each GPU test run is capped at $MAX min and never retried by itself."
    ;;
  disable)
    keep_n=() keep_d=()
    for i in "${!NAMES[@]}"; do [ "${NAMES[$i]}" = "$name" ] || { keep_n+=("${NAMES[$i]}"); keep_d+=("${DEVS[$i]}"); }; done
    NAMES=(${keep_n[@]+"${keep_n[@]}"}); DEVS=(${keep_d[@]+"${keep_d[@]}"})
    say "GPU test runs off for $name"
    ;;
esac

# Made only when missing (scripts/setup/machine.sh makes it): an existing one keeps its mode and ACLs (test-user.sh
# denies each test user /etc/worklane by an ACL entry).
[ -d "$(dirname "$GPU_FILE")" ] || install -d -o root -g root -m 0755 "$(dirname "$GPU_FILE")"
file_text | put_file root root 0644 "$GPU_FILE"
echo "wrote $GPU_FILE"
# The locks from boot on: /run/worklane and its gpu directory root's 0755, one root 0644 file per listed GPU.
{
  echo "# Written by scripts/setup/testrun-gpu.sh: the GPU test runs' locks (one per GPU), root's, readable by all."
  echo "d $(dirname "$LOCK_DIR") 0755 root root -"
  echo "d $LOCK_DIR 0755 root root -"
  for i in $(all_indices); do echo "f $LOCK_DIR/$i.lock 0644 root root -"; done
} | put_file root root 0644 "$TMPFILES"
systemd-tmpfiles --create "$TMPFILES"
echo "wrote $TMPFILES"
show
