#!/usr/bin/env bash
# Off-machine backups for one instance (docs/backups.md): copies of the event log, encrypted with age
# and stored in a Backblaze B2 bucket through rclone. Creating the bucket and its key is up to you.
#
#   bash scripts/setup/offsite-backup.sh <name> b2 <bucket> [<prefix>]
#       For wl-<name>, and nobody else:
#       - an age key pair in ~/.config/<name>-backup/ (the private key 0400, the directory 0700),
#         made once and kept on later runs;
#       - the bucket key, pasted (not shown), in an rclone config of its own (0600);
#       - offsite-backup.yaml in the instance home (0600).
#       Then it checks one copy end to end as wl-<name>: encrypt, upload, download, decrypt, compare.
#       <prefix> defaults to <name>; each instance gets its own.
#   bash scripts/setup/offsite-backup.sh --print-config <name> <bucket> <prefix> <age-recipient> <dir>
#       Prints the offsite-backup.yaml that would be written, changing nothing (for review and tests).
#
# age and rclone must already be installed (installs are yours: apt-get install age rclone).
source "$(dirname "$0")/lib.sh"

usage='usage: offsite-backup.sh <name> b2 <bucket> [<prefix>]  |  offsite-backup.sh --print-config <name> <bucket> <prefix> <age-recipient> <dir>'

# The config: every path comes from the engine's variables, never the command line; only decrypt names the key.
config_yaml() {
  local name="$1" bucket="$2" prefix="$3" recipient="$4" dir="$5"
  local remote="$name-offsite:$bucket/$prefix" rc="--config $dir/rclone.conf"
  cat <<YAML
version: 1
destination: Backblaze B2 $bucket/$prefix
every_hours: 6
encrypt: 'age -r $recipient -o "\$WORKLANE_BACKUP_OUT" "\$WORKLANE_BACKUP_IN"'
put: 'rclone $rc copyto "\$WORKLANE_BACKUP_IN" "$remote/\$WORKLANE_BACKUP_NAME"'
get: 'rclone $rc copyto "$remote/\$WORKLANE_BACKUP_NAME" "\$WORKLANE_BACKUP_OUT"'
decrypt: 'age -d -i $dir/age.key -o "\$WORKLANE_BACKUP_OUT" "\$WORKLANE_BACKUP_IN"'
YAML
}

# Names that end up inside the config's commands: nothing a shell would read as more than a word.
check_word() { [[ "$2" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "$1 must be letters, digits, '.', '_' or '-': $2" >&2; exit 1; }; }

if [ "${1:-}" = --print-config ]; then
  [ "$#" -eq 6 ] || { echo "$usage" >&2; exit 2; }
  check_word name "$2"; check_word bucket "$3"; check_word prefix "$4"
  [[ "$5" =~ ^age1[a-z0-9]{50,}$ ]] || { echo "not an age recipient: $5" >&2; exit 1; }
  config_yaml "$2" "$3" "$4" "$5" "$6"
  exit 0
fi

as_root "$@"
name="${1:?$usage}"
kind="${2:?$usage}"
bucket="${3:?$usage}"
prefix="${4:-$1}"
[ "$kind" = b2 ] || { echo "only b2 is supported: $usage" >&2; exit 2; }
check_word name "$name"; check_word bucket "$bucket"; check_word prefix "$prefix"
coord="wl-$name"
id -u "$coord" >/dev/null 2>&1 || { echo "no user $coord; run instance.sh $name first" >&2; exit 1; }
for tool in age age-keygen rclone; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed (apt-get install age rclone), so nothing was changed" >&2; exit 1; }
done
home="$(getent passwd "$coord" | cut -d: -f6)"
inst="$home/.local/state/worklane/instances/$name"
[ -d "$inst" ] || { echo "no instance home at $inst; run engine.sh $name first" >&2; exit 1; }
dir="$home/.config/$name-backup"

say "the age key pair for $coord ($dir/age.key, 0400)"
run_as "$coord" 'umask 077; mkdir -p "$1"; chmod 0700 "$1"
  if [ -f "$1/age.key" ]; then echo "kept the existing key"; else age-keygen -o "$1/age.key" 2>/dev/null; chmod 0400 "$1/age.key"; echo "made a new key"; fi' "$dir"
recipient="$(run_as "$coord" 'age-keygen -y "$1/age.key"' "$dir")"
echo "public key (safe to share): $recipient"
echo "Keep a copy of the private key off this machine (your password manager): without it no copy can be read."
read -rp "Show the private key once now, to copy it? [y/N] " yn
if [ "$yn" = y ]; then run_as "$coord" 'cat "$1/age.key"' "$dir"; fi

say "the bucket key for $coord, in $dir/rclone.conf (0600)"
read -rp "B2 keyID: " key_id
check_word keyID "$key_id"
read -rsp "B2 applicationKey (it is not shown): " app_key; echo
[[ "$app_key" =~ ^[A-Za-z0-9/+=_-]{20,}$ ]] || { echo "that doesn't look like a B2 application key; nothing installed" >&2; exit 1; }
printf '[%s]\ntype = b2\naccount = %s\nkey = %s\nhard_delete = false\n' "$name-offsite" "$key_id" "$app_key" \
  | run_as "$coord" 'umask 077; rm -f "$1/rclone.conf"; cat > "$1/rclone.conf"; chmod 0600 "$1/rclone.conf"' "$dir"
unset app_key

say "the config ($inst/offsite-backup.yaml, 0600)"
config_yaml "$name" "$bucket" "$prefix" "$recipient" "$dir" \
  | run_as "$coord" 'umask 077; cat > "$1.tmp"; chmod 0600 "$1.tmp"; mv -f "$1.tmp" "$1"' "$inst/offsite-backup.yaml"
echo "wrote it"

say "one copy end to end as $coord: encrypt, upload, download, decrypt, compare"
# The bucket key may not delete, so the check copy stays in the bucket under setup-check-*.
run_as "$coord" 'set -euo pipefail
  t="$(mktemp -d)"; trap "rm -rf \"\$t\"" EXIT
  head -c 4096 /dev/urandom > "$t/plain"
  n="setup-check-$(date -u +%Y%m%dT%H%M%SZ)"
  age -r "$2" -o "$t/enc" "$t/plain"
  if cmp -s "$t/plain" "$t/enc"; then echo "encryption left the file unchanged" >&2; exit 1; fi
  rclone --config "$1/rclone.conf" copyto "$t/enc" "$3/$n"
  rclone --config "$1/rclone.conf" copyto "$3/$n" "$t/back"
  age -d -i "$1/age.key" -o "$t/plain2" "$t/back"
  cmp -s "$t/plain" "$t/plain2" || { echo "the copy read back differs" >&2; exit 1; }
  echo "verified: $3/$n read back, decrypted and matched"' "$dir" "$recipient" "$name-offsite:$bucket/$prefix"
echo
echo "Done. The coordinator makes its first copy within the hour and every 6 hours after; the health panel shows when the last one was verified."
