### Upgrading (from v0.5.2)

- In a checkout under the standard git-lfs filter where any file (tracked or untracked, by the working tree's attributes or the index's) carries `filter=lfs`, an agent's commit is now refused when the `git-lfs` git would run isn't a program only root can change:
  - one of the user's own, for example a user-level install or a Homebrew, linuxbrew or conda one owned by the user;
  - one reached through a link or folder someone else can change;
  - one git would look for through a path entry that depends on the folder (an empty or relative `PATH` entry);
  - none found.

  git's own exec path is checked first, as git looks there first. On native Windows, which has no file owners to check, such commits are refused. Checkouts with no file under the filter are unchanged, even where `git lfs install` set the filter up in the global config. Install git-lfs where only root can change it, or have a person commit in those checkouts.
- In such a checkout, a file the commit records that is over 1024 bytes, names a pointer version in its first 1024 bytes and isn't the exact pointer form is refused, as smaller ones already were. Stage it in an earlier call (git-lfs then stores the exact pointer), then commit. What the file held before the commit is not refused on this ground.

### Guardrail changes: what each one does

- **The commit secret scan refuses the large-file cases it can't verify (#1011).** git-lfs reads a file of any size as a pointer from its first 1024 bytes and ignores the rest, so such a file could name an object the scan never read. A `git-lfs` program the agent's user could replace could change what is stored after the scan has read it, so it is checked wherever git would run it. Both now refuse the commit. The push gate still scans what leaves the machine.
