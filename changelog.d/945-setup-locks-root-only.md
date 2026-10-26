### Upgrading (from v0.5.2)

- The setup scripts' machine-wide locks moved out of `/run/lock` into `/run/worklane-machine/`, root's 0700 directory, beside the machine helper rule's lock (#945): add-project's (`add-project.lock`, which instance-remove and instance-rename share) and tailscale's (`tailscale.lock`). The first run that takes one makes the directory. Nothing to do on upgrade. The old `/run/lock/worklane-add-project.lock` and `/run/lock/worklane-tailscale.lock` are no longer used; `/run` is cleared at boot, so they go then.
- An older release's scripts still lock the old path, so a run of an older copy doesn't wait for a run of the new one, or the other way round. Don't run add-project, instance-remove, instance-rename or a tailscale step from two releases at once.
- add-project and the tailscale steps now refuse on a machine without `flock` (util-linux), as the machine helper's rule writer already did. Before, they ran unlocked.

### Guardrail changes: what each one does

- **No other user can hold or plant a setup lock (#945).** Any user could pre-create a file in `/run/lock` (1777), so root's open failed under `protected_regular`. They could also open the file read-only and hold a `flock` on it. Either way, add-project, instance-remove, instance-rename and the tailscale steps were blocked. Now every one of the setup scripts' machine locks is taken by one function, `machine_lock` in `scripts/setup/lib.sh`. It refuses, locking nothing, unless all of these hold:
  - `flock` is there;
  - the lock's directory is root's, 0700 and not a link;
  - that directory's parent is root's, and no one else can write it;
  - the lock file is absent or root's regular file, not a link.
- `test/setup-locks.test.ts` fails if a setup script opens one of these locks itself, or skips it when `flock` is missing.
