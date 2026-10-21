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

**When a chain ends and a new one follows**, the new chain's first receipt (`chain.started`) names the chain it succeeds in `previous`: the keys that signed it, its head, and its last event. It receipts only events after that event, with a key that never signed the old chain. Check these:
- **`previous.head`** must be the head you kept for the old chain (your anchor). If it names an earlier head, the new chain started early and may sign events the old chain already signed.
- **`previous: null`** marks an instance's first chain only. A second such chain for the same instance is a fork.

**A receipt field can be cut.** A long text keeps its first 1,024 characters, and a long list its first 64 items. The receipt's `cut` lists each cut field with the SHA-256 and length of the whole, so whoever holds the full text can check it.

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
