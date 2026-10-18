# Machine-wide agent slots

Several agent harnesses can share one machine. To keep the total load bounded, they cooperate through a directory of lock files. Any harness can join this protocol with a few dozen lines of code.

## Where

- **Slot directory:** `$AGENT_SLOTS_DIR` if set. Otherwise `/var/lib/worklane/agent-slots` when it exists. Otherwise `/var/tmp/agent-slots` (macOS, Linux, WSL) or `%ProgramData%\agent-slots` (Windows).
- **Config:** `$AGENT_SLOTS_CONFIG` if set. Otherwise `/etc/worklane/slots.json` when the `/var/lib` directory is in use and that file exists. Otherwise `config.json` in the slot directory.

On a machine that runs agents for weeks, use the `/var/lib` and `/etc` locations. Tmp cleaners such as systemd-tmpfiles delete files in `/var/tmp` that haven't changed for about 30 days, which would reset the cap and drop its history. `/var/tmp` suits single-user and development machines.

## Files

| File | Meaning |
|---|---|
| config (`slots.json` or `config.json`) | `{"max_agents": N}`. The machine's configured cap on concurrent agents across **all** harnesses, set once per machine. Default 2. |
| `slots.lock` | Held for a moment while a harness counts running agents and takes a slot. |
| `agent-<i>.lock` | One running agent. The **number** of live files is capped, not the index: files may be numbered past the cap, so lowering it never strands an agent that is still running. |
| `full-run.lock` | A full test run is in progress. At most one per machine. |
| `test-<i>.lock` | One coordinator test run (docs/test-runs.md). Counted apart from agents and capped by the config's `max_test_runs` (default 2, 1..8), which only the machine helper changes (`set-test-slots`). |
| `STOP` | Emergency stop, `{"by", "at", "reason"}`. While it exists, every harness halts its running agents and takes no new slot. |
| `github-budget-<key>.json` | The GitHub API budget of one credential, shared by every process on the machine that uses it (src/github/budget.ts). `<key>` is the first 16 hex characters of the token's SHA-256, never the token. Per rate-limit resource (`core`, `graphql`): GitHub's last `X-RateLimit-Limit` / `-Remaining` / `-Reset`, less every call granted since, and the calls granted in the window by consumer; and `pausedUntil`, set by a secondary limit (403 or 429) for every caller on that token. A call takes one unit before it goes; at none left, or paused, it waits up to 10 s, then fails with GitHub's own kind of error (`rate_limited` or `secondary_rate_limited`, status 429) without reaching GitHub. Always replaced (a 0660 copy renamed over it), never written in place, so a coordinator of another user can update it. Bounded whoever wrote it: a pause counts only up to 15 min ahead (a longer Retry-After is cut to 15 min), a window only up to 1 h 5 min ahead; anything else (a reset too far or missing, a remaining that isn't a number of 0 or more) is "not known", and the call goes. Unreadable: starts afresh. A state it can't write, or a lock busy for 0.5 s, lets the call go. Keyed by token, so an App installation token's new token (about hourly) starts a new file: a pause in force is forgotten then, and the next limit GitHub meets sets it again. A file unchanged for 2 h is removed by the next process that takes from any budget (at most every 10 min per process). So far only the backlog's client (src/backlog/github.ts) takes from it. The dashboard's Health page shows it to owners and writers (src/github/budget-health.ts): read without the lock (the file is only ever replaced whole), as a regular file only, at most 64 KiB, the 8 most recently changed; credentials numbered there, never named by the key. |
| `github-budget-<key>.lock` | Held for a moment while one process reads, changes and replaces that state. Observing a response or pausing tries it once and never waits. One dated more than 5 s before or after now, or not dated, is stuck or planted and is broken, whatever its pid. |
| `update-drain.json` | The engine updater draining the machine for an install, `{"since", "until", "to"}`. While it stands (until its `until`), no new agent slot, test slot or full-run lock is taken; what holds one already keeps it until it ends. With the `/var/lib` slot directory it lives in root's `/var/lib/worklane/` (root-owned 0644), not in the slot directory, so only root writes or removes it. A flag past its `until`, unreadable, or more than 4 hours ahead is ignored. |

Each lock file holds JSON: `{"pid": 1234, "owner": "free text: harness, project, task", "acquiredAt": "ISO-8601"}`.

## Rules

1. **Create a lock atomically:** write its JSON to a temp file in the same directory, then hard-link it to the lock's name (`link()` fails if the lock exists). A lock is never visible half-written. Exclusive create followed by a separate write is not enough: a competitor that reads the empty file in between takes it for stale.
2. **Stale:** a lock whose `pid` is not a live process on this machine is stale. To take it over, rename it aside (only one process can win that rename), check that what you moved is the lock you inspected (if not, link it back), delete it, and retry. Liveness decides staleness, not age, so a long full run is never stolen.
3. **Agents:** take `slots.lock`; count live `agent-*.lock` files; if fewer than `max_agents`, take the first free `agent-<i>.lock`; release `slots.lock`. If at the cap, wait. A lower cap never stops running agents; new ones wait until the count is below it.
4. **Full runs:** take `full-run.lock` before starting a full suite. Projects can also declare an `idle_probe` command for runs started outside any harness. For example, a script that exits 0 only when no full run is live.
5. **Release:** delete your own file, only if its `pid` and `acquiredAt` are yours.

**Emergency stop:** `worklane stop-all [reason]` writes `STOP`; every Worklane coordinator on the machine aborts its agents within about 5 seconds (their tasks requeue) and starts none until `worklane resume-all` removes it. Writing it needs write access to the slot directory: run it as a coordinator user, or as root.

`worklane slots` shows what's held, and any stop in force. `worklane queue full-run` queues a full run behind both checks, in a detached runner that survives the session that queued it.
