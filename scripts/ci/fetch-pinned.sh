#!/usr/bin/env bash
# Usage: fetch-pinned.sh <https url> <sha256> <out file>
# The one way CI downloads a pinned binary (#1201): over https only, retried on a transient failure (5 more tries, 5 s
# apart), a try that stalls (under 1 KB/s for 60 s, or 20 s to connect) ended, and no retry begun after 120 s; checked
# against its pinned sha256 (--strict) before it is put at <out file>. It downloads to a fresh, unpredictable file
# beside <out file> (mktemp: made new, never a planted link) and moves it into place only after the check. A
# mismatch, a failed download or a bad argument exits non-zero and leaves nothing at <out file>. curl's -q comes first,
# so no ~/.curlrc can add a URL, an output or `insecure`. Every tool is called by its absolute path, so neither a file
# put first on PATH nor a function a BASH_ENV or `export -f` defines stands in for curl or sha256sum (#1181 R1181l 2).
# test/ci-download-retry.test.ts and test/fetch-pinned.test.ts test this file's behaviour with a stub curl.
set -euo pipefail
if [ "$#" -ne 3 ]; then echo "usage: fetch-pinned.sh <https url> <sha256> <out file>" >&2; exit 2; fi
url="$1" sum="$2" out="$3"
case "$url" in https://*) ;; *) echo "fetch-pinned: only an https URL: $url" >&2; exit 2 ;; esac
if ! [[ "$sum" =~ ^[0-9a-f]{64}$ ]]; then echo "fetch-pinned: the sha256 must be 64 lowercase hex characters" >&2; exit 2; fi
if [ -z "$out" ]; then echo "fetch-pinned: an out file" >&2; exit 2; fi
/usr/bin/rm -f -- "$out"
part="$(/usr/bin/mktemp "$out.part.XXXXXX")"
trap '/usr/bin/rm -f -- "$part"' EXIT
/usr/bin/curl -q -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120 -o "$part" "$url"
echo "$sum  $part" | /usr/bin/sha256sum -c - --strict >/dev/null || { echo "fetch-pinned: sha256 mismatch for $url" >&2; exit 1; }
if [ -L "$part" ] || ! [ -f "$part" ]; then echo "fetch-pinned: $part is not the file it made" >&2; exit 1; fi
/usr/bin/mv -f -- "$part" "$out"
trap - EXIT
