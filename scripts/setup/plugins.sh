#!/usr/bin/env bash
# Plugins for an instance's agents, the root side (src/plugins/). Review it first.
#
#   bash scripts/setup/plugins.sh confirm <instance> <id> sha256:<digest>   an admin, at a root shell: approve a staged plugin
#   bash scripts/setup/plugins.sh remove <instance> <id>                    take an approved plugin away
#   bash scripts/setup/plugins.sh show <instance>                           what the instance's agents may load
#   bash scripts/setup/plugins.sh fetch <instance> <id> <https url> <sha> [<path>]
#                                                                           the machine helper's plugin-fetch, as its own unit
#
# confirm prints the whole approval record (source, commit, files hash, roles, components, notes) and asks for the
# plugin id to be typed back; anything else confirms nothing. A coordinator can never confirm: the machine helper has
# no confirm, and this refuses one (SUDO_USER=wl-*). confirm only applies an approval that was staged with exactly
# that digest from a preview whose files still hash as they did.
#
# fetch never runs anything it fetched. A throwaway user (systemd DynamicUser: no home, no access to any instance or
# to /etc or /usr for writing) fetches exactly that commit over https; root takes ownership of what it wrote without
# following any link, inspects it, and keeps a preview. At most 10 fetches an hour per instance.
source "$(dirname "$0")/lib.sh"
as_root "$@"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ENGINE/dist/src/cli.js"
NODE="$(command -v node)" || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
[ -f "$CLI" ] || { echo "no engine build at $CLI" >&2; exit 1; }
FETCH_STATE=worklane-plugin-fetch                 # StateDirectory: /var/lib/private/worklane-plugin-fetch
FETCH_DIR=/var/lib/private/$FETCH_STATE
STATUS_DIR=/var/lib/worklane/plugins/fetch-status   # one JSON file per instance: the last fetch's state, for the dashboard
PATH_ENV=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() { sed -n '4,8p' "$0" | sed 's/^#   //' >&2; exit 2; }
instance_ok() { [[ "$1" =~ ^[a-z][a-z0-9-]{0,20}$ ]] && [ "$1" != dash ]; }
id_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }

status() { # <instance> <id> <state> [<reason>]
  install -d -o root -g root -m 0755 /var/lib/worklane/plugins "$STATUS_DIR"
  local tmp="$STATUS_DIR/.$1.$$.tmp"
  printf '{"id":%s,"state":%s,"reason":%s,"at":%s}\n' "$(json_str "$2")" "$(json_str "$3")" "$(json_str "${4:-}")" "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" > "$tmp"
  chmod 0644 "$tmp" && mv -f "$tmp" "$STATUS_DIR/$1.json"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  confirm)
    [ "$#" -eq 3 ] || usage
    instance_ok "$1" && id_ok "$2" && [[ "$3" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
    [[ "${SUDO_USER:-}" != wl-* ]] || { echo "confirm is an admin's, at a root shell: a coordinator may only stage" >&2; exit 1; }
    [ -t 0 ] || { echo "confirm asks for the plugin id to be typed back: run it in a terminal" >&2; exit 1; }
    exec "$NODE" "$CLI" plugins confirm --instance "$1" --id "$2" --digest "$3"
    ;;
  remove)
    [ "$#" -eq 2 ] && instance_ok "$1" && id_ok "$2" || usage
    exec "$NODE" "$CLI" plugins remove --instance "$1" --id "$2"
    ;;
  show)
    [ "$#" -eq 1 ] && instance_ok "$1" || usage
    exec "$NODE" "$CLI" plugins show --instance "$1"
    ;;
  fetch)
    [ "$#" -eq 4 ] || [ "$#" -eq 5 ] || usage
    instance="$1" id="$2" url="$3" sha="$4" sub="${5:-}"
    instance_ok "$instance" && id_ok "$id" || usage
    [[ "$url" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9._~/-]+$ ]] || { echo "the source must be an https git URL" >&2; exit 2; }
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "the commit must be a full 40-character SHA" >&2; exit 2; }
    [ -z "$sub" ] || [[ "$sub" =~ ^([A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$ && ! "/$sub/" =~ /\.\.?/ ]] || { echo "the path must be a plain subdirectory" >&2; exit 2; }
    extra=(); [ -z "$sub" ] || extra=(--path "$sub")
    "$NODE" "$CLI" plugins fetch-slot --instance "$instance" || { status "$instance" "$id" failed "too many fetches this hour"; exit 1; }
    status "$instance" "$id" running
    run="$instance-$id-$$"
    out="$FETCH_DIR/$run"
    trap 'rm -rf "$out"' EXIT
    if ! systemd-run --wait --pipe --collect --quiet --unit "worklane-plugin-fetch-job-$run" --description "worklane plugin fetch (throwaway user)" \
      -p DynamicUser=yes -p StateDirectory="$FETCH_STATE" -p PrivateTmp=yes -p ProtectHome=yes -p ProtectSystem=strict -p PrivateDevices=yes \
      -p NoNewPrivileges=yes -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX" -p RuntimeMaxSec=300 -p MemoryMax=1G -p UMask=0022 \
      -p Environment="PATH=$PATH_ENV LANG=C.UTF-8" \
      "$NODE" "$CLI" plugins fetch-job --url "$url" --sha "$sha" "${extra[@]}" --out "/var/lib/$FETCH_STATE/$run"; then
      status "$instance" "$id" failed "the fetch failed (journalctl -u worklane-plugin-fetch-job-$run)"
      exit 1
    fi
    # Root's from here: ownership taken without following links (-h), which the inspection then refuses.
    chown -R -h root:root "$out"
    if "$NODE" "$CLI" plugins ingest --instance "$instance" --id "$id" --url "$url" --sha "$sha" "${extra[@]}" --from "$out"; then
      status "$instance" "$id" done
    else
      status "$instance" "$id" failed "the inspection could not run"
      exit 1
    fi
    ;;
  *) usage ;;
esac
