# Signed receipts: checking them as an auditor

A signed receipt records one merge decision or merge result an instance made, signed with the instance's key and chained to the receipt before it. You can check a set of receipts offline, with only the receipts and the public key: no engine, no account and no network. The design, and what is built so far, is in [design.md §5a](design.md#5a-signed-receipts-717).

**Built so far (slice 1).** Receipts cover merge decisions and their results. They are signed by whoever runs `<cli> receipts sign` with the key file, so they're *not yet root-signed*: no installed signer keeps the key away from the coordinator yet. The policy commit, changed files, check run ids and review level are `null` until the merge record carries them.

## What you need

- **The receipts:** one `.jsonl` file, or a directory of them, which are read in name order as one chain.
- **The public key:** a PEM file you got from the customer directly, not from the receipts. The first receipt names its own key, but a key a file vouches for proves nothing.

## Check them

```
<cli> receipts verify receipts/ --key customer-receipts.pub
```

- **Exit 0:** every receipt verified. You see the counts by kind, the chain's keys in order (more than one after a rotation), and the **head**.
- **Exit 1:** `FAILED: receipt N of M: <why>`. One was changed, reordered, inserted or dropped, or a key you didn't give signed it.
- **Exit 2:** a usage error. Passing a private key as `--key` counts as one.

**Keep the head.** Next time, pass it with `--anchor <head>`. A chain that lost receipts at its end still looks whole on its own, and only the anchor shows they're gone.

**After a key rotation**, keep passing the chain's first key. The verifier follows each rotation, which the old key signed. You can pass several keys with `--key`.

## What a receipt proves, and what it never does

- **It proves:** the instance's log said this decision or result, in this order, and the key holder signed it.
- **It never proves:**
  - **That the inputs were true.** A compromised coordinator can log a false decision, and the receipt records it as logged.
  - **That the change was good.** A receipt holds ids, not the code.
  - **That nothing merged without a receipt.** Compare the repository's merges with the receipts.
  - **That the end of the chain is complete,** without your anchor.
