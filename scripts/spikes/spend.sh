# The spend gate for spikes (#673, as #612 for the node commands). Sourced first, before lib.sh's as_root, so a run
# without --spend stops before sudo and before any paid `claude` call.
#   spend_gate <calls> "$@"
# --spend <usd> is the most the spike may spend in all; each of its <calls> claude calls gets an equal share as its
# --max-budget-usd (SPIKE_CALL_BUDGET). SPIKE_ARGS holds the other arguments. Exits 2 without a positive --spend.
spend_gate() {
  local calls="$1" spend="" rest=()
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --spend) spend="${2-}"; shift; [ "$#" -gt 0 ] && shift ;;
      --spend=*) spend="${1#--spend=}"; shift ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  if ! printf '%s' "$spend" | grep -Eq '^([0-9]+(\.[0-9]*)?|\.[0-9]+)$' || ! awk -v s="$spend" 'BEGIN { exit !(s + 0 > 0) }'; then
    echo "not run: this spike makes $calls paid claude call(s). Run it with --spend <usd>, the most it may spend in all (each call gets an equal share as its --max-budget-usd)." >&2
    exit 2
  fi
  SPIKE_ARGS=("${rest[@]+"${rest[@]}"}")
  SPIKE_CALL_BUDGET="$(awk -v s="$spend" -v n="$calls" 'BEGIN { printf "%.4f", s / n }')"
}
