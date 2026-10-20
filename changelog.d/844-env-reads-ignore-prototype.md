### Guardrail changes: what each one does

- **The engine's security reads of the environment ignore `Object.prototype` (#786).** A variable that isn't set reads as unset, even when code in the process has put a value under that name on `Object.prototype`. This covers:
  - the system root and the test-run marks;
  - the state dir and its test-run refusal, the slot dir and its config, and the instances, init and held-out dirs;
  - the tool prefix, PATH lookups, and the PATH handed to sudo, git, tar, npm and docker;
  - the Chrome and Git Bash binaries, and the backup dirs;
  - the agent users' homes and `SUDO_USER`;
  - the variables an agent user's run is given across the user switch (`TZ`, `LC_ALL`, `XDG_RUNTIME_DIR` and the rest of its pass-through list), the Claude login a run is serialized on, and the `NODE_OPTIONS` handed to the App check's node;
  - the `HOME` and instances dir written into an instance's service unit;
  - the Claude step's `claude auth status` (#738): the local unit's `PATH` and `HOME`, the pass-through list it shares with the runner (with `ANTHROPIC_API_KEY` for an `api_key` project), and the manager's `CLAUDE_CONFIG_DIR` in its login's cache key.

  Before, such a value was read as if it were set. These reads now go through one own-variable snapshot (`src/os/own-env.ts`). It joins the agents' tool guard's locked tree, since the guard's OS adapter imports it, which takes the tree to 58 modules. Nothing changes when the environment is clean. Not covered yet: a child process the engine spawns still inherits `Object.prototype`'s keys through Node's `child_process` (#846).
