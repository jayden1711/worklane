#!/usr/bin/env bash
# Usage: fetch-pinned.sh <https url> <sha256> <out file>
# The one way CI downloads a pinned binary (#1201): over https only, retried on a transient failure (5 more tries,
# 5 s apart, at most 2 min in all), and checked against its pinned sha256 before it is put at <out file>. A mismatch,
# a failed download or a bad argument exits non-zero and leaves nothing at <out file>. The retry lives here, once, so
# no workflow can download with a weaker one, and the check can't be skipped: test/ci-download-retry.test.ts refuses a
# pinned download a workflow makes any other way.
set -euo pipefail
if [ "$#" -ne 3 ]; then echo "usage: fetch-pinned.sh <https url> <sha256> <out file>" >&2; exit 2; fi
url="$1" sum="$2" out="$3"
case "$url" in https://*) ;; *) echo "fetch-pinned: only an https URL: $url" >&2; exit 2 ;; esac
if ! [[ "$sum" =~ ^[0-9a-f]{64}$ ]]; then echo "fetch-pinned: the sha256 must be 64 lowercase hex characters" >&2; exit 2; fi
if [ -z "$out" ]; then echo "fetch-pinned: an out file" >&2; exit 2; fi
part="$out.part.$$"
trap 'rm -f "$part"' EXIT
rm -f "$out"
curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120 -o "$part" "$url"
echo "$sum  $part" | sha256sum -c - >/dev/null || { echo "fetch-pinned: sha256 mismatch for $url" >&2; exit 1; }
mv "$part" "$out"
trap - EXIT
