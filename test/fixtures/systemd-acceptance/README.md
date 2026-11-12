# systemd-acceptance fixtures

One JSON table per review round of #1169 (`r1169<round>.json`), consolidated from one folder per case (the owner, 2026-11-12). Each case:

- `exit`, `reason`, `listed`: what `scripts/ci/systemd-acceptance.mjs` must do with it (below).
- `files`: the case's files by path, each an array of its lines (joined with a newline), or `"@<id>"` for a shared base file in `bases.json`. A path ending in `.txt` is a test file, copied to `test/` and, as `.js`, to `dist/test/`; one ending in `.root` is copied to that path from the root.

`test/systemd-acceptance.test.ts` runs every case and holds their names in `FIXTURE_NAMES` (never-shrink). `scripts/ci/fixture-tables-check.mjs` compares the tables with the old folders, byte for byte.

From the old manifest:

Each folder is one attack on scripts/ci/systemd-acceptance.mjs (its files are *.test.ts.txt, copied to test/ and dist/test/, and *.root, copied to the root, so neither npm test nor the script's own scan reads them). Each is [exit, reason, listed?]: the script must exit with that code (2 refused statically, 1 refused at run time, 0 for a shape the VM runs or a stated limit) and its stderr match that pattern, so it's refused for its own reason; `listed`, when there, must match its stdout: the shape is among the tests it runs on the VM (R1169n). Kept as regression inputs (the owner's decision on #1169, 2026-11-08). r1169ah-block-*: each shape measured on V8's block coverage (R1169ag/ah, 2026-11-11): exit 0 is a named limit, 1 caught, 2 refused; F fails whenever it runs, so an exit 0 proves it never ran.
