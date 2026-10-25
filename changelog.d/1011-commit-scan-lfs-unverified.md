### Upgrading (from v0.5.2)

- Under the standard git-lfs filter, an agent's commit is now refused when the `git-lfs` git would run isn't a program only root can change: one of the user's own (a user-level install, a Homebrew install owned by the user), one reached through a link or folder someone else can change, one git would look for through a path entry that depends on the folder (an empty or relative `PATH` entry), or none found. git's own exec path is checked first, as git looks there first. Install git-lfs where only root can change it, or have a person commit in that checkout. Native Windows can't check file owners, so there such commits are refused.
- A large file over 1024 bytes whose first 1024 bytes name a pointer version, and that isn't the exact pointer form, is refused too, as smaller ones already were. Stage it in an earlier call (git-lfs then stores the exact pointer), then commit.

### Guardrail changes: what each one does

- **The commit secret scan refuses the large-file cases it can't verify (#1011).** git-lfs reads a file of any size as a pointer from its first 1024 bytes and ignores the rest, so such a file could name an object the scan never read; and a `git-lfs` program the agent's user could replace could change what is stored after the scan has read it. Both now refuse the commit. The push gate still scans what leaves the machine.
