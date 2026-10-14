#!/usr/bin/env bash
# CI only (.github/workflows/ci-slow.yml): the one-command install's end, checked on a real runner.
#   bash scripts/ci/wizard-url.sh <install log> <key file> <api path>
# WHY: scripts/bootstrap.sh must end with exactly one URL, the first-run wizard, with no key in it or in its output;
# that URL must answer 200 with the dashboard page, and the wizard's data must answer with the key sent as a header
# read from a 0600 file (never an argument, never the URL). <api path>: /api/first-run on a checkout's dashboard,
# /api/i/<instance>/first-run on a hub. Prints the URL on success.
set -euo pipefail
log="$1" key_file="$2" api="$3"
fail() { echo "wizard-url: $*" >&2; exit 1; }

url="$(tail -n 1 "$log")"
[[ "$url" =~ ^http://127\.0\.0\.1:[0-9]+/first-run$ ]] || fail "the install's last line isn't the wizard's URL: $url"
# The closing block: from the last "== " heading on.
closing="$(awk '/^== /{b=""} {b=b $0 "\n"} END{printf "%s", b}' "$log")"
[ "$(grep -c '://' <<< "$closing")" = 1 ] || fail "the closing block holds more than one URL:
$closing"
key="$(cat "$key_file")"
[ "${#key}" -ge 16 ] || fail "no key in $key_file"
if grep -qF -- "$key" "$log"; then fail "the key was printed"; fi
case "$url" in *"$key"* | *"?t="* | *"&t="*) fail "the URL carries a key: $url" ;; esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
code="$(curl -s -o "$work/page.html" -w '%{http_code}' "$url")"
[ "$code" = 200 ] || fail "GET $url: HTTP $code"
grep -q '<div id="root"></div>' "$work/page.html" || fail "GET $url: not the dashboard's page"
# The key as a header from a 0600 file: printf is a builtin, so the key is never in a process's arguments.
(umask 077; printf 'Authorization: Bearer %s\n' "$key" > "$work/auth")
origin="${url%/first-run}"
code="$(curl -s -o "$work/api.json" -w '%{http_code}' "$origin$api")"
[ "$code" = 401 ] || fail "GET $api with no key: HTTP $code, not 401"
code="$(curl -s -o "$work/api.json" -w '%{http_code}' -H @"$work/auth" "$origin$api")"
[ "$code" = 200 ] || fail "GET $api with the key: HTTP $code: $(head -c 300 "$work/api.json")"
grep -q '"steps":\[' "$work/api.json" || fail "GET $api: no checklist: $(head -c 300 "$work/api.json")"
echo "wizard-url: $url answers 200 with the dashboard; $api answers with the checklist, given the key in a header"
echo "$url"
