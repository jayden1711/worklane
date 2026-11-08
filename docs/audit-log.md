# The audit log and its hash chain

Every action the engine records is one event in the instance's event log. That includes an agent run, a merge
decision and its result, a decision answered, a guardrail block, and every write a person makes on the dashboard.
The **audit chain** makes changes to that record visible. It is a SHA-256 hash chain over every stored event, with
the chain's head checkpointed to a file beside the log. `worklane audit verify` recomputes the chain and shows where
it was changed. Code: `src/audit-chain.ts`, `src/audit-chain-cli.ts`. Tests: `test/audit-chain.test.ts`.

## What is logged

Everything in the event log, with nothing filtered out (the event types are in `src/events/types.ts`). The ones an
audit usually needs:

- **Agent actions:** `run.started`, `run.heartbeat`, `run.finished`, `run.stuck`, `run.cost`, and `guardrail.decision` (what a guardrail blocked or asked).
- **Merges:** `merge.decided`, `merge.attempted`, `merge.done`, `merge.failed`, `merge.stopped`, `merge.resumed`.
- **People:** `dashboard.audit`, one per dashboard write, with login, role, how they came in, the instance and the
  action (`src/decide.ts` `auditWrite`), and `decision.answered`.

Payloads are redacted before they're written (`src/events/redact.ts`), so the chain covers the redacted text, never a
secret.

## How the chain works

- **Each event links to the one before it.** `link(prev, row)` is the SHA-256 of `prev`, a newline, then the row as
  SQLite stores it, as one JSON array: `[id, ts, type, actor, source, payload]`. The payload is the exact stored text,
  never re-serialized. The first event links to 64 zeros.
- **The coordinator writes a checkpoint at most every 10 minutes** (its `audit chain` step) to `audit-chain.jsonl`.
  Each line is `{"v":1,"event":<last id covered>,"head":"<hex>","at":"<time>","prev":"<sha256 of the line before>"}`,
  so the file is a chain of its own.
- **`verify` recomputes the whole chain** from the first event and checks every checkpoint: that the line chains to
  the line before it, that its event is in the log, and that its head is the chain's head at that event.

## Where it lives, and retention

- **The checkpoint file sits beside the events database**: `<state dir>/audit-chain.jsonl`. It has the database's
  permissions (owner and group only). An instance export (`src/instance-move.ts`) takes the whole state directory, so
  the file moves with the log.
- **Events are never deleted.** The log is append-only: its triggers refuse `UPDATE` and `DELETE`
  (`src/events/log.ts`). The checkpoint file is only ever appended to. One line every 10 minutes comes to about
  8 MB a year.
- **Backups verify too.** A backup made with `VACUUM INTO` holds the same stored text, so it verifies against the
  same checkpoint file.

## Check it

```
worklane audit verify --log <state dir>/events.db [--anchor <head>]
```

- **Exit 0:** `verified: N checkpoint(s), through event E`. Then the head to keep, and how many events come after the
  last checkpoint and aren't covered yet.
- **Exit 1:** `FAILED: <why>`. For example, `checkpoint 3 of 5 (event 812): the log's head there is …, the checkpoint
  says …: an event was changed, removed or inserted after event 640, up to event 812`. The range is the one between
  the last checkpoint that matched and the first that didn't.
- **Exit 2:** a usage error.

`worklane audit checkpoint --log <events.db>` writes a checkpoint now. `--chain <file>` reads another checkpoint
file, for example a copy you kept.

**Keep the head somewhere else.** Next time, pass it as `--anchor`. Without an anchor, a checkpoint file with its
last lines cut off still looks whole.

## What it shows, and what it can never show

It shows:

- an event whose payload, type, actor, source or time was changed;
- an event removed, or put back with other content;
- a checkpoint line changed, removed or inserted in the middle of the file;
- with `--anchor`: a checkpoint file cut short, or rewritten to match an edited log.

It can never show:

- **A consistent rewrite of both files, without an anchor.** Whoever can write the events database and the checkpoint
  file (the coordinator's user, or root) can rewrite both to agree. Only a head kept out of their reach shows that.
  This is the same limit signed receipts have ([receipts.md](receipts.md)). Receipts add a signature, but cover
  merges only.
- **Changes after the last checkpoint.** Events written since the last checkpoint aren't covered until the next one,
  10 minutes at most. `verify` counts them.
- **That an event was true.** The chain proves the record wasn't changed, not that the coordinator recorded the
  truth.
- **Events lost while the disk was full.** Events kept in memory and later written are covered once written. Events
  the full buffer dropped were never stored, so the chain has nothing to cover (`src/disk-guard.ts`).
