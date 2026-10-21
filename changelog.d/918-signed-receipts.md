### Upgrading (from v0.5.2)

- **Signed receipts for merge decisions, verifiable offline (#717, slice 1).** Nothing changes for an existing install
  until you run the new commands, and no merge waits on them.
  - `worklane receipts keygen` makes an ed25519 key pair.
  - `worklane receipts sign --log <events.db> --key <private> --out <file>` signs each merge decision and result in an
    instance's event log, chaining each receipt to the one before it.
  - `worklane receipts verify <file|dir> --key <pub>` checks the receipts with only the public key: no engine state and no
    network.
  - **Not yet root-signed:** `sign` signs as whoever runs it. Keep the private key away from the coordinator user.
    Every field is attested (the coordinator's claim as its log recorded it), and `verify` says so. The separate signer
    user that checks facts itself comes later.
    Until the merge record carries them, the policy commit, changed files, check run ids and review level are `null`
    in a receipt.
  - The auditor's guide is `docs/receipts.md`, and the design is in `docs/design.md` §5a.
