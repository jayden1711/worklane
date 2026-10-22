### Guardrail changes: what each one does

- **A test process no longer lets the children it starts reach the machine's own host tools (#991).** The test preload (`test/isolate.ts`, which every test process runs) wraps Node's child_process and `process.execve`.
  - Every child finds a recording stand-in first on its PATH for each name that PATH would find a machine host tool under: sudo, systemctl, systemd-run, journalctl, useradd and the other user tools, visudo, nft, docker, gh, tailscale, claude and the like, and symbolic links to any of them under another name (`sudoedit`, `reboot`). A stand-in records the call and fails.
  - A host tool named by path is refused as a word of a command line (a `-c` script, an exec line, an `env -S` string), whoever asks. As a whole argument (`env /usr/bin/sudo`), it is refused when a test file asked and replaced by its stand-in when the engine's own code did.
  - `env -i`, `command -p` or a login shell whose command line has a host tool's name as a word is refused, in argument form also behind `timeout`, `nice` or the like.
  - A literal `PATH=`, `PATH+=` (read as `PATH=$PATH…`) or `export PATH=` in a command line gets the stand-ins ahead of its first directory that has a machine host tool, so `PATH=/usr/bin sh script.sh` gives the script's `sudo` a stand-in. A value the guard can't read (a relative or empty entry, a variable other than `$PATH`) is refused. An `env -S` string is read inside a short-option cluster (`-vS`), and one with an escape (`\_`) or a `${VAR}` is refused. An `env` long option not spelled in full (`--split=`, `--ignore-env`, `--uns`) is refused.
  - The options a test passes are read once, accessors included, and the child gets what was checked.
  - Before, `test/add-project.test.ts` ran add-project with the real PATH, and since #904 every fresh run asked the machine's real `sudo -H -u <coordinator>`. On a developer machine, doctor's tests ran the real `claude --version`.
  - **The exceptions** may only shrink:
    - the setup scripts' own CI-only acceptance test starts its children untouched;
    - five CI-only acceptance runs take the real sudo, visudo or systemctl through `machineTool`, found only on the PATH the process started with.
  - **When the exceptions hold:**
    - only while the run's environment says `GITHUB_ACTIONS=true` (the gate main's acceptance runs use);
    - only for the process's own test file;
    - only when node ran no other code before it, loaded the preload by its path, and read no `--env-file`.

    Off CI, `GITHUB_ACTIONS` is deleted from what each child gets, emptied in `env`'s assignments, and refused in a command line or `env -S` string that spells it. An `--env-file` can't make a child on CI: a process that read one is off CI. On CI, a test can start a pinned test file, which then runs with its exceptions as it would on its own.
  - A change to `test/isolate.ts` now runs the whole suite. `test/host-tools.ts` and `test/script-host-tools.test.ts` are engine-guards, as `test/isolate.ts` is.
  - **Not covered, and a test can reach it by accident.** A script that sets its own PATH: a test that runs a machine helper without rewriting its `export PATH=` line gives the script's own `sudo` the machine's. No child_process preload can close it. By the owner's decision of 2026-10-21 it is a named limit; its structural fix is the approved move of agents and tests to an unprivileged user with no sudo. The same holds for a tool named by path inside a script file, and a login shell or `env -i` that reaches a tool only through a function.
  - **Not covered, and it needs test code written to get around the guard.** Since the owner's decision of 2026-10-21, these are named here rather than closed:
    - a PATH assignment whose name is built at run time (`V=PATH; eval "$V=/usr/bin"`);
    - an interpreter's inline program (`perl -e`, `awk`, `python3 -c`), or a script on stdin;
    - a command line or script that builds `GITHUB_ACTIONS` at run time;
    - a child Node process without the preload (it gets the stand-ins on its PATH, but none of the refusals);
    - code that runs before the preload, or patches the builtins after it;
    - a Worker, `ChildProcess` used directly, and a copy or hard link of a host tool under another name.
  - gitleaks is not stood in: it only reads, and the secret-scan tests run the real one.
  - Nothing changes for an install: only the tests and the CI selection changed.
