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
- **Exit 3:** every receipt is authentic, but the signer flagged a field. It found something different from what the coordinator claimed, and prints `FLAGGED: receipt N: <field>: the coordinator claimed X, the signer found Y`.

**Keep the head.** Next time, pass it with `--anchor <head>`. A chain that lost receipts at its end still looks whole on its own, and only the anchor shows they're gone.

**After a key rotation**, keep passing the chain's first key. The verifier follows each rotation, which the old key signed. You can pass several keys with `--key`.

## Verified or attested

A receipt field is one of two kinds, and `verify` tells you which:
- **Verified:** the signer checked it itself, from git or GitHub with its own read-only access. Each receipt lists those checks.
- **Attested:** only the coordinator's claim, signed as the log recorded it.

In slice 1 nothing is verified: `verify` prints `verified independently by the signer: none`. The table in [design.md §5a](design.md#5a-signed-receipts-717) lists, field by field, what the installed signer will check and how.

## What a receipt proves, and what it never does

- **It proves:**
  - the instance's log said this decision or result, in this order, and the key holder signed it;
  - for a field listed as verified, the signer found that value itself.
- **It never proves:**
  - **That an attested field was true.** A compromised coordinator can log a false decision, and the receipt records it as logged.
  - **That the change was good.** A receipt holds ids, not the code.
  - **That nothing merged without a receipt.** Compare the repository's merges with the receipts.
  - **That the end of the chain is complete,** without your anchor.
  - **That this is the only chain.** Whoever holds the start key, or a key from before a rotation, can sign a different chain: a fresh one, or a fork of this one before the rotation. That chain verifies with the key you hold. Only an anchor from a later look (after the rotation, for a retired key) shows it isn't the chain you saw.
  - **That no secret slipped through.** Reasons and failure text are free text, passed through a pattern-based redactor. A secret no pattern matches would pass.
