### Guardrail changes: what each one does

- **The benchmark (`scripts/bench/`, not installed) pulls each task's image by its pinned digest only, and takes each task's base tree from that image, never from upstream (#748).**
  - `bench pull --tasks smoke|baseline` requires the flag and takes nothing else. Its tasks and image references come from the held-out store only. Each image is pulled as `<name>@sha256:<digest>`, never by tag, and its digest is read back. A changed `images.json` stops it before any tree is built.
  - Each task's base tree is copied out of its own image's `/testbed`, in a throwaway container with no network and no mount. HEAD must be the task's `base_commit`, and the host checks by hash that the tree is base_commit's. An image with no git metadata in `/testbed` is refused. The copy-out is capped in bytes as it arrives. Before git indexes the pack, every entry is charged against one budget: a fixed cost, the bytes its data inflates to (a delta's own data too), and each delta's target. One object is capped too. Host git runs on one thread. Past a cap the copy-out is refused and the container removed.
  - The agents' sandbox now also denies the system journal (`/var/log/journal`, `/run/log/journal`), where the bench user's Docker daemon may log the task images.
  - Each tree lands in the 0700 store as a bare remote with one commit (no upstream history) and a clone of it, never over anything. The agents' sandbox denies the store, so they never see the task set.
  - It prints keys and counts only, never docker's own error text (which names the image).
