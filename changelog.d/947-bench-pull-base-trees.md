### Guardrail changes: what each one does

- **The benchmark (`scripts/bench/`, not installed) pulls each task's image by its pinned digest only, and takes each task's base tree from that image, never from upstream (#748).**
  - `bench pull --tasks smoke|baseline` requires the flag and takes nothing else. Its tasks and image references come from the held-out store only. Each image is pulled as `<name>@sha256:<digest>`, never by tag, and its digest is read back. A changed `images.json` stops it before any tree is built.
  - Each task's base tree is copied out of its own image's `/testbed`, in a throwaway container with no network and no mount. With git metadata, HEAD must be the task's `base_commit`, and the host checks by hash that the tree is base_commit's. Without it, the content hash is recorded and the output says HEAD wasn't checked.
  - Each tree lands in the 0700 store as a bare remote with one commit (no upstream history) and a clone of it, never over anything. The agents' sandbox denies the store, so they never see the task set.
  - It prints keys and counts only, never docker's own error text (which names the image).
