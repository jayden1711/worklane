### Guardrail changes: what each one does

- **The benchmark (`scripts/bench/`, not installed) chooses its tasks by a pinned rule and seed, never by instance ids in the repo (#748).**
  - `scripts/bench/pins.json` pins the selection as a rule, a seed and the canonical sha256 of the rows it reads. The same pins always choose the same tasks: 50 for the baseline, the first 4 of them for the smoke.
  - `bench select` takes no argument. It writes the task manifest into the 0700 held-out store as a 0600 file, and never replaces a different one. It prints keys and the smoke run's plan, never an instance id, and the command's output withholds any word shaped like one.
  - The run takes its tasks and their image references from the store only. It refuses rows that aren't the pinned ones, a manifest that isn't what the pins select, and an image that isn't a pinned digest under its own task's name.
  - The rows aren't pinned yet, so `bench select` refuses and prints their digest for the owner to record.
