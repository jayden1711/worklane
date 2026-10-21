### Guardrail changes: what each one does

- **The benchmark (`scripts/bench/`, not installed) downloads only what `scripts/bench/pins.json` pins, verified before it is kept (#748).**
  - `bench download` fetches the dataset file at its pinned revision, over https from the pinned hosts only. It checks the sha256 in memory before it makes or writes anything. It writes a 0600 file into the 0700 held-out store through a temporary file that is read back before the rename.
  - It refuses a store that fails the preflight's held-out check, and never follows a link.
  - Task images are pulled by pinned digest only. The only docker calls are `pull <name>@sha256:…` and `image inspect`; a tag is refused.
  - No flag, argument or variable sets a pin. The pins file refuses anything shaped like an instance id, and any text but its canonical form, so a repeated key can't hide an unchecked copy. The dataset is unpinned for now, so `bench download` refuses until the owner records the pin.
