# shellcheck shell=bash
# CI only, sourced (ci-slow.yml's MCP broker step, scripts/ci/mcp-broker-kernel.sh): preview_done <instance> <id>,
# right after an MCP preview's wait (mcp-preview <id> ... && wait_status <id>). It returns 0 when the instance's fetch
# status says "<id> done". Otherwise it prints the fetch unit's journal tail and the status, and returns 1, so the step
# stops there with the preview's real reason.
# WHY: a failed preview's reason (say "plugin escape has no MCP server kernel") is only in the journal of the unit
# worklane-machine runs it in (worklane-plugin-fetch-<instance>). Without this a step went on to a jq or grep of a
# preview file that wasn't there, or to readPreview's "no preview of ... fetch it first" (#619's add-project; #631, #677).
# INVARIANT: no journal line holding the value of an MCP secret is printed, whether or not the job masked it. The
# secrets are the broker user's own (wl-<instance>-mcp, its 0700 <home>/secrets/). Lines holding one are left out and
# counted. When the values can't be known whole (the user's lookup or the read failed), no journal line is printed at
# all, and it says why: fail closed.
# FETCH_STATUS_DIR: the status files' directory (the tests' stand-in); plugins.sh writes them in the default.
preview_done() {
  local name="$1" id="$2" st
  st="${FETCH_STATUS_DIR:-/var/lib/worklane/plugins/fetch-status}/$name.json"
  [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$id done" ] && return 0
  fetch_journal "$name"
  echo "the preview of $id didn't finish: $(sudo jq -c . "$st" 2>/dev/null || echo 'no status')" >&2
  return 1
}

# snapshot_done <instance> <id> <preview file>, right after `mcp-snapshot <id>`: waits for that snapshot's own mark, the
# preview's snapshotWithSecrets (the broker sets it with a snapshot or with its error), and prints the status. On
# "<id> failed", or no mark after SNAPSHOT_WAIT_TRIES (90) waits of 2 s, it prints the fetch unit's journal (as
# preview_done does) and the status, and returns 1.
# WHY (#679): until the snapshot's unit writes "running", the status file still says "<id> done" from the preview, so a
# wait on the status alone could return at once and the next check read the preview's snapshotWithSecrets == false.
snapshot_done() {
  local name="$1" id="$2" p="$3" st i
  st="${FETCH_STATUS_DIR:-/var/lib/worklane/plugins/fetch-status}/$name.json"
  for ((i = 0; i < ${SNAPSHOT_WAIT_TRIES:-90}; i++)); do
    if sudo jq -e '.snapshotWithSecrets == true' "$p" > /dev/null 2>&1; then
      sudo jq -c . "$st" 2>/dev/null || true
      return 0
    fi
    [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$id failed" ] && break
    sleep 2
  done
  fetch_journal "$name"
  echo "the snapshot of $id didn't finish: $(sudo jq -c . "$st" 2>/dev/null || echo 'no status')" >&2
  return 1
}

# fetch_journal <instance>: the fetch unit's journal tail on stderr, without any line holding an MCP secret's value
# (the INVARIANT above).
fetch_journal() {
  local name="$1" ent rc home tail mark got secrets="" dropped=0
  tail="$(sudo journalctl -u "worklane-plugin-fetch-$name.service" --no-pager 2>&1 | tail -n 30)" || true
  # One read of every secret value, as root, ending in a mark only a whole read prints: "none-<mark>" when there is no
  # secrets dir (none set yet), the values then "<mark>" when every file was read. No broker user (getent's 2): no
  # secrets. Anything else (sudo, find or cat failed, getent's error) leaves `got` without its mark.
  mark="read-$RANDOM$RANDOM$RANDOM"
  ent="$(getent passwd "wl-$name-mcp")" && rc=0 || rc=$?
  if [ "$rc" = 2 ]; then
    got="none-$mark"
  elif [ "$rc" = 0 ] && home="$(printf '%s\n' "$ent" | cut -d: -f6)" && [ -n "$home" ]; then
    got="$(sudo sh -c 'd="$1/secrets"; [ -e "$d" ] || { echo "none-$2"; exit 0; }; find "$d" -type f -exec cat {} + && printf "\n%s\n" "$2"' preview-secrets "$home" "$mark" 2>/dev/null)" || got=""
  else
    got=""
  fi
  case "$got" in
    "none-$mark") ;;
    *$'\n'"$mark") secrets="$(printf '%s\n' "${got%$'\n'"$mark"}" | grep -v '^$')" || true ;;
    *) tail=""; echo "(the journal is left out: the MCP secrets of wl-$name-mcp couldn't be read, so its lines can't be checked for them)" >&2 ;;
  esac
  # The secret files' non-empty lines are the values to leave out. Never an empty pattern: it matches every line.
  if [ -n "$secrets" ]; then
    dropped="$(printf '%s\n' "$tail" | grep -cFf <(printf '%s\n' "$secrets"))" || true
    tail="$(printf '%s\n' "$tail" | grep -vFf <(printf '%s\n' "$secrets"))" || true
  fi
  [ -z "$tail" ] || printf '%s\n' "$tail" >&2
  [ "${dropped:-0}" -eq 0 ] || echo "($dropped journal lines holding an MCP secret left out)" >&2
  return 0
}
