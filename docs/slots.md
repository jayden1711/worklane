# Machine-wide agent slots

Several agent harnesses can share one machine. To keep the total load bounded, they cooperate through a directory of lock files. Any harness can join this protocol with a few dozen lines of code.

## Where

- **Slot directory:** `$AGENT_SLOTS_DIR` if set. Otherwise `/var/lib/worklane/agent-slots` when it exists. Otherwise `/var/tmp/agent-slots` (macOS, Linux, WSL) or `%ProgramData%\agent-slots` (Windows).
- **Config:** `$AGENT_SLOTS_CONFIG` if set. Otherwise `/etc/worklane/slots.json` when the `/var/lib` directory is in use and that file exists. Otherwise `config.json` in the slot directory.

On a machine that runs agents for weeks, use the `/var/lib` and `/etc` locations. Tmp cleaners such as systemd-tmpfiles delete files in `/var/tmp` that haven't changed for about 30 days, which would reset the cap and drop its history. `/var/tmp` suits single-user and development machines.

## Files

| File | Meaning |
|---|---|
| config (`slots.json` or `config.json`) | `{"max_agents": N, "adaptive": {...}}`. The machine's configured cap on concurrent agents across **all** harnesses, set once per machine. Default 2. |
| `cap.json` | `{"cap": N, ...}`. The cap in force now, when an adaptive cap evaluator runs; it overrides `max_agents`. |
| `slots.lock` | Held for a moment while a harness counts running agents and takes a slot. |
| `agent-<i>.lock` | One running agent. The **number** of live files is capped, not the index: files may be numbered past the cap, so lowering it never strands an agent that is still running. |
| `full-run.lock` | A full test run is in progress. At most one per machine. |

Each lock file holds JSON: `{"pid": 1234, "owner": "free text: harness, project, task", "acquiredAt": "ISO-8601"}`.

## Rules

1. **Create a lock atomically:** write its JSON to a temp file in the same directory, then hard-link it to the lock's name (`link()` fails if the lock exists). A lock is never visible half-written. Exclusive create followed by a separate write is not enough: a competitor that reads the empty file in between takes it for stale.
2. **Stale:** a lock whose `pid` is not a live process on this machine is stale. To take it over, rename it aside (only one process can win that rename), check that what you moved is the lock you inspected (if not, link it back), delete it, and retry. Liveness decides staleness, not age, so a long full run is never stolen.
3. **Agents:** take `slots.lock`; count live `agent-*.lock` files; if fewer than the cap (`cap.json`, else `max_agents`), take the first free `agent-<i>.lock`; release `slots.lock`. If at the cap, wait. A lower cap never stops running agents; new ones wait until the count is below it.
4. **Full runs:** take `full-run.lock` before starting a full suite. Projects can also declare an `idle_probe` command for runs started outside any harness. For example, a script that exits 0 only when no full run is live.
5. **Release:** delete your own file, only if its `pid` and `acquiredAt` are yours.

`worklane slots` shows what's held. `worklane queue full-run` queues a full run behind both checks, in a detached runner that survives the session that queued it.
