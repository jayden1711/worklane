# Signed receipts: checking them as an auditor

A signed receipt records one merge decision or merge result an instance made, signed with the instance's key and chained to the receipt before it. You can check a set of receipts offline, with only the receipts and the public key: no engine, no account and no network. The design, and what is built so far, is in [design.md §5a](design.md#5a-signed-receipts-717).

**Built so far (slice 1).** Receipts cover merge decisions and their results.
- **Not yet root-signed.** They are signed by whoever runs `worklane receipts sign` with the key file. The separate signer user, which keeps the key away from the coordinator, isn't installed yet.
- **Every field is attested; none is verified by the signer yet.** Each one is the coordinator's claim as its log recorded it.
- **Empty fields:** the policy commit, changed files, check run ids and review level are `null` until the merge record carries them.

## What you need

- **The receipts:** one `.jsonl` file, or a directory of them, which are read in name order as one chain.
- **The public key:** a PEM file you got from the customer directly, not from the receipts. The first receipt names its own key, but a key a file vouches for proves nothing.

## Check them

```
worklane receipts verify receipts/ --key customer-receipts.pub
```

- **Exit 0:** every receipt verified. You see:
  - the counts by kind;
  - the chain's keys in order (more than one after a rotation);
  - what the signer verified itself, against what it only attests;
  - the **head**.
- **Exit 1:** `FAILED: receipt N of M: <why>`. One was changed, reordered, inserted or dropped, or a key you didn't give signed it.
- **Exit 2:** a usage error. Passing a private key as `--key` counts as one, and so does an `--anchor` that isn't a receipt id (64 lowercase hex characters). An empty `--anchor` is refused rather than skipped, so a script with an unset variable fails loudly.
- **Exit 3:** every receipt is authentic, but the signer flagged a field. It found something different from what the coordinator claimed, and prints `FLAGGED: receipt N: <field>: the coordinator claimed X, the signer found Y`. A field the engine left `null` that the signer filled in is not a flag; `verify` prints it as `UNRECORDED: receipt N: <field>: ... the signer found Y`.

`verify` reads regular files only, at most 64 MiB of receipts in all: a link, FIFO or device fails. Each line must be exactly the canonical JSON the signer writes, so a line with a duplicate key fails. Text that comes from the receipts or file names is printed with control, format and invisible characters escaped as a backslash, `u` and the code point in hex (`\u001b` for ESC, and the same form for a zero-width space), so a receipts file can't rewrite what your terminal shows.

**Keep the head.** Next time, pass it with `--anchor <head>`. A chain that lost receipts at its end still looks whole on its own, and only the anchor shows they're gone.

**After a key rotation**, keep passing the chain's first key. The verifier follows each rotation, which the old key signed. You can pass several keys with `--key`.

**When a chain ends and a new one follows**, the new chain's first receipt (`chain.started`) names the chain it succeeds in `previous`: the keys that signed it, its head, its last event, and `from`, which says whether the signer read that from the old chain's own state or from a copy of its receipts. It receipts only events after that event (from a copy, after the log's last event when it started), with a key that never signed the old chain. `verify` checks both. Each of these is a fork:
- receipts in the old chain after the new chain's `previous.head`;
- two chains naming the same `previous.head`;
- a new chain whose `previous.head` isn't the latest head you hold for the old chain;
- a second chain with `previous: null` for the same instance. `previous: null` marks an instance's first chain only. The signer's own registry refuses a second one, but only within that registry: a signer started with a new registry isn't stopped, so this check is yours.

A chain started `from: "copy"` came from receipts that may have been cut short, so it can't show you everything the old chain signed. The signer starts one only when the old chain's own state can't be read. It starts after the log's last event at that time, so it signs no event that existed then, as long as the log's event ids never go back. The coordinator owns those ids, so this is its word: compare the merges between the old chain's head and the new chain's start with the repository's.

A receipt of kind `event.unsignable` stands for a merge event the signer couldn't read (not JSON, not the event's shape, or a payload past the 64 MiB the signer reads): it records the event's type and why, and nothing of its content as a decision. `at: "unrecorded"` means the log's time for that event was empty or too long (`cut.at` says which). `verify` prints one `UNSIGNABLE: receipt N: event E (type): why` line for each of the first, and one `UNRECORDED TIME: receipt N: event E: ...` line for each of the second. The `type` is the log's; the `why`, and the reading of the time, are the signing tool's own.

An `event` is the log's event id as a string of decimal digits (`"42"`), never a JSON number, so an id past 2^53 is exact. Compare them as integers, not as text. A merge event the log holds at an id of 0 or below can't be receipted; `sign` reports each as `SKIPPED`, so compare those with the repository's merges too. A `cut` entry with `of: "unread"`, `"null"` or `"not-utf8"` is a log field the signer never read as text (too long, NULL, or not UTF-8); its `length` is in bytes, and the receipt keeps `""`. `verify` prints an `UNREAD INSTANCE` line for each receipt whose `instance` is such a field.

Keep each chain's receipts in its own directory: `verify <dir>` reads one chain.

**A receipt field can be cut.** A long text keeps its first 1,024 characters (after redaction), and a long list its first 64 items. A text over 16,384 characters keeps nothing. The receipt's `cut` lists each cut field with its length and a SHA-256: with `of: "whole"`, of the whole redacted text, so whoever holds the text can redact it and check; with `of: "kept"`, only of what the receipt keeps. Each SHA-256 is over the value's canonical JSON, never the bare text: for a text, hash it quoted as a JSON string.

## Verified or attested

A receipt field is one of two kinds, and `verify` tells you which:
- **Verified:** the signer checked it itself, from git or GitHub with its own read-only access. Each receipt lists those checks.
- **Attested:** only the coordinator's claim, signed as the log recorded it.

Each verified field is reported in one of these ways:
- **Match:** the signer's value equals the coordinator's claim.
- **Mismatch:** the signer found something else. It is flagged, and `verify` exits 3.
- **Unrecorded:** the claim is `null`. The deciding engine didn't record that field, so the signer's value is the only one. This is not a flag.
- **Derived:** a fact the receipt has no field for, such as the merge commit's tree.

**A `verified` list is the key holder's word.** `verify` checks which key signed, not which program did the checking. Trust a `verified` list only as far as you trust that the key is held by the customer's separate signer user, and nothing else.

In slice 1 nothing is verified: `verify` prints `verified independently by the signer: none`. Any key holder can run `sign`, which can include the coordinator, so the chain fields themselves (`seq`, `prev`, `log.digest`) are only as independent as whoever ran it. The table in [design.md §5a](design.md#5a-signed-receipts-717) lists, field by field, what the installed signer will check and how.

## What a receipt proves, and what it never does

- **It proves:**
  - the key holder signed that the instance's log said this decision or result, in this order. A key holder can sign a statement no log holds, and in slice 1 the key holder can be the coordinator;
  - for a field listed as verified, the key holder states that the signer found that value itself (its word, see above).
- **It never proves:**
  - **That the log said it.** Only that the key holder signed that it did.
  - **That an attested field was true.** A compromised coordinator can log a false decision, and the receipt records it as logged.
  - **That the change was good.** A receipt holds ids, not the code.
  - **That nothing merged without a receipt.** Compare the repository's merges with the receipts.
  - **That the end of the chain is complete,** without your anchor.
  - **That this is the only chain.** Whoever holds the start key, or a key from before a rotation, can sign a different chain: a fresh one, or a fork of this one before the rotation. That chain verifies with the key you hold. Only an anchor from a later look (after the rotation, for a retired key) shows it isn't the chain you saw.
  - **That no secret slipped through.** Reasons and failure text are free text, passed through a pattern-based redactor. A secret no pattern matches would pass.
