### Guardrail changes: what each one does

- **The benchmark (`scripts/bench/`, not installed) writes each task's image reference from the held-out store, never from a command line (#748).**
  - `bench images` takes no argument. It reads the selected tasks from the store's manifest, only when it is exactly what the pins select now, and names each task's image under SWE-bench's naming.
  - Each digest is the sha256 of the manifest Docker Hub's registry serves for that name (fixed addresses, an anonymous token, manifests only, no redirect, capped answers). It is taken only when `scripts/bench/pins.json` pins it and no other task has it.
  - It writes `images.json` once, as a 0600 file in the 0700 store, through a verified temporary file, and never replaces a different one. Any doubt refuses the whole file and writes nothing.
  - It prints keys, counts and digests, never an instance id or an image name. No image digest is pinned yet, so it refuses.
