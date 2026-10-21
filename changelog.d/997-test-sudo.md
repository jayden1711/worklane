### Guardrail changes: what each one does

- **A test process no longer lets the children it starts reach the machine's own host tools (#991).** The test preload (`test/isolate.ts`, which every test process runs) wraps Node's child_process and `process.execve`.
  - Every child finds a recording stand-in first on its PATH for each host tool that PATH would find on the machine. That covers sudo, systemctl, systemd-run, journalctl, useradd and the other user tools, visudo, nft, docker, gh, tailscale, claude and the like. A stand-in records the call and fails.
  - A test's own command is refused when it names a host tool by path, anywhere in its arguments or command line. So is `env -i`, `command -p` or a login shell whose command line has a host tool's name as a word.
  - When the engine's own code runs a host tool by path, it gets the stand-in instead.
  - Before, `test/add-project.test.ts` ran add-project with the real PATH, and since #904 every fresh run asked the machine's real `sudo -H -u <coordinator>`. On a developer machine, doctor's tests ran the real `claude --version`.
  - The exceptions hold only on CI, are keyed to the test process's own test file, and may only shrink:
    - the setup scripts' own CI-only acceptance test starts its children untouched;
    - five CI-only acceptance runs take the real sudo, visudo or systemctl through `machineTool`, found only on the PATH the process started with.

    Off CI, `machineTool` gives the stand-in, so a developer machine never runs the real tool.
  - A change to `test/isolate.ts` now runs the whole suite. `test/host-tools.ts` and `test/script-host-tools.test.ts` are engine-guards, as `test/isolate.ts` is.
  - Not covered:
    - a script that sets its own PATH, or an inline `PATH=` in a command line;
    - a login shell or `env -i` that reaches a tool only through a function it calls;
    - a tool named by path inside a script file;
    - a child Node process without the preload (it gets the stand-ins on its PATH, but none of the refusals);
    - code that runs before the preload, or patches the builtins after it;
    - a Worker, and `ChildProcess` used directly.
  - gitleaks is not stood in: it only reads, and the secret-scan tests run the real one.
  - Nothing changes for an install: only the tests and the CI selection changed.
