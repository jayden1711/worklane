# Machine-wide agent slots

Several agent harnesses can share one machine. To keep the total load bounded, they cooperate through a directory of lock files. Any harness can join this protocol with about 20 lines of code.

## Where

- `$AGENT_SLOTS_DIR` if set.
- Otherwise `/var/tmp/agent-slots` (macOS, Linux, WSL) or `%ProgramData%\agent-slots` (Windows).

## Files

| File | Meaning |
|---|---|
| `config.json` | `{"max_agents": N}`. The machine's cap on concurrent agents across **all** harnesses, set once per machine. Default 2. |
| `agent-<i>.lock` | One running agent. Valid only for `i < max_agents`. |
| `full-run.lock` | A full test run is in progress. At most one per machine. |

Each lock file holds JSON: `{"pid": 1234, "owner": "free text: harness, project, task", "acquiredAt": "ISO-8601"}`.

## Rules

1. **Acquire:** create the file with exclusive create (`O_CREAT|O_EXCL`, Node's `open(path, 'wx')`). If it already exists, the slot is taken.
2. **Stale:** a file whose `pid` is not a live process on this machine is stale. Delete it and retry the create once. Liveness decides staleness, not age, so a long full run is never stolen.
3. **Agents:** try `agent-0` … `agent-(max_agents-1)` in order. If none is free, wait.
4. **Full runs:** take `full-run.lock` before starting a full suite. Projects can also declare an `idle_probe` command for runs started outside any harness. For example, a script that exits 0 only when no full run is live.
5. **Release:** delete your own file, only if its `pid` is yours.

`worklane slots` shows what's held. `worklane queue full-run` queues a full run behind both checks, in a detached runner that survives the session that queued it.
