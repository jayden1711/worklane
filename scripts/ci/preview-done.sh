# shellcheck shell=bash
# CI only, sourced (ci-slow.yml's MCP broker step, scripts/ci/mcp-broker-kernel.sh): preview_done <instance> <id>,
# right after an MCP preview's wait (mcp-preview <id> ... && wait_status <id>). It returns 0 when the instance's fetch
# status says "<id> done". Otherwise it prints the fetch unit's journal tail and the status, and returns 1, so the step
# stops there with the preview's real reason.
# WHY: a failed preview's reason (say "plugin escape has no MCP server kernel") is only in the journal of the unit
# worklane-machine runs it in (worklane-plugin-fetch-<instance>). Without this a step went on to a jq or grep of a
# preview file that wasn't there, or to readPreview's "no preview of ... fetch it first" (#619's add-project; #631, #677).
# INVARIANT: no journal line holding the value of an MCP secret (the broker's, <home of wl-<instance>-mcp>/secrets/)
# is printed, whether or not the job masked it: such lines are left out and counted.
# FETCH_STATUS_DIR: the status files' directory (the tests' stand-in); plugins.sh writes them in the default.
preview_done() {
  local name="$1" id="$2" st home tail secrets dropped=0
  st="${FETCH_STATUS_DIR:-/var/lib/worklane/plugins/fetch-status}/$name.json"
  [ "$(sudo jq -r '.id + " " + .state' "$st" 2>/dev/null)" = "$id done" ] && return 0
  home="$(getent passwd "wl-$name-mcp" | cut -d: -f6)" || true
  tail="$(sudo journalctl -u "worklane-plugin-fetch-$name.service" --no-pager 2>&1 | tail -n 30)" || true
  # The secret files' non-empty lines are the values to leave out. Never an empty pattern: it matches every line.
  secrets="$([ -n "$home" ] && sudo find "$home/secrets" -type f -exec cat {} + 2>/dev/null | grep -v '^$')" || true
  if [ -n "$secrets" ]; then
    dropped="$(printf '%s\n' "$tail" | grep -cFf <(printf '%s\n' "$secrets"))" || true
    tail="$(printf '%s\n' "$tail" | grep -vFf <(printf '%s\n' "$secrets"))" || true
  fi
  [ -z "$tail" ] || printf '%s\n' "$tail" >&2
  [ "${dropped:-0}" -eq 0 ] || echo "($dropped journal lines holding an MCP secret left out)" >&2
  echo "the preview of $id didn't finish: $(sudo jq -c . "$st" 2>/dev/null || echo 'no status')" >&2
  return 1
}
