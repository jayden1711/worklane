# Backups

Every hour the coordinator snapshots its event log (`VACUUM INTO`) into the instance's `state/backups/`. It reports success only after reading the copy back: the checksum and the latest event id must match.

## Off the machine

Off-machine copies are off until the owner turns them on. To turn them on, put `offsite-backup.yaml` in the instance home, beside `policy.yaml`. For a plain checkout, set `WORKLANE_OFFSITE_BACKUP` to the file's path.

The file names four commands. Worklane runs them as the coordinator user. Each gets its paths in environment variables, never on the command line:

| Command | Reads | Writes |
|---|---|---|
| `encrypt` | `$WORKLANE_BACKUP_IN` (the snapshot) | `$WORKLANE_BACKUP_OUT` (its encrypted form) |
| `put` | `$WORKLANE_BACKUP_IN` (the encrypted copy) | the destination, as `$WORKLANE_BACKUP_NAME` |
| `get` | `$WORKLANE_BACKUP_NAME` at the destination | `$WORKLANE_BACKUP_OUT` |
| `decrypt` | `$WORKLANE_BACKUP_IN` (the fetched copy) | `$WORKLANE_BACKUP_OUT` (the snapshot again) |

A copy counts as made only once Worklane has fetched the remote copy, decrypted it, and matched its checksum and latest event id against the snapshot. An exit code is never proof.

- **Encryption is checked.** If the encrypt command leaves the snapshot readable, nothing is sent and the attempt is recorded as failed.
- **The key is yours.** Worklane never holds or copies it. Only your `decrypt` command names it, so keep it readable only by the coordinator user.
- **The file runs commands.** It must belong to the coordinator user (or root) and be writable only by its owner (`chmod 600`), or it is refused. Keep it out of the repo, which agents can change.
- **Outcomes are recorded.** Each attempt is a `backup.offsite` event. Every report shows when the last verified copy was made. If that copy is over a day old, or none was ever verified, the report and the health panel say it's stale, with the latest error.
- **Old copies are kept.** Worklane doesn't prune the destination.

Example with [age](https://github.com/FiloSottile/age) and [rclone](https://rclone.org). Both are installed by you, and the remote is already configured for the coordinator user:

```yaml
version: 1
destination: rclone remote, backups bucket
every_hours: 6            # default 6; a failed attempt is retried within the hour
encrypt: 'age -r age1yourpublickey... -o "$WORKLANE_BACKUP_OUT" "$WORKLANE_BACKUP_IN"'
put: 'rclone copyto "$WORKLANE_BACKUP_IN" "remote:backups/$WORKLANE_BACKUP_NAME"'
get: 'rclone copyto "remote:backups/$WORKLANE_BACKUP_NAME" "$WORKLANE_BACKUP_OUT"'
decrypt: 'age -d -i /home/<coordinator user>/.config/backup/age.key -o "$WORKLANE_BACKUP_OUT" "$WORKLANE_BACKUP_IN"'
```

With openssl and a mounted drive instead:

```yaml
version: 1
destination: external drive
encrypt: 'openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:/home/<coordinator user>/.config/backup/key -in "$WORKLANE_BACKUP_IN" -out "$WORKLANE_BACKUP_OUT"'
put: 'cp "$WORKLANE_BACKUP_IN" "/mnt/backup/$WORKLANE_BACKUP_NAME"'
get: 'cp "/mnt/backup/$WORKLANE_BACKUP_NAME" "$WORKLANE_BACKUP_OUT"'
decrypt: 'openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/home/<coordinator user>/.config/backup/key -in "$WORKLANE_BACKUP_IN" -out "$WORKLANE_BACKUP_OUT"'
```

The commands run in bash with `pipefail`, the same shell as every project command (Git for Windows' bash on Windows), so `"$WORKLANE_BACKUP_IN"` works everywhere.
