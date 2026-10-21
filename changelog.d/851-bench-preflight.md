### Guardrail changes: what each one does

- **The benchmark's own scripts (`scripts/bench/`, not installed) never run as root, and `bench preflight` checks the bench machine (#748, #851).** The bench user check now refuses uid 0 or the name root, even when `WORKLANE_BENCH_USER` names it; before, naming root made root the bench user. `bench preflight` runs the driver's model-free checks as the bench user only and prints one PASS, FAIL or SKIP line each, with no variable's value, token or account detail. It starts no container, makes no model call and downloads nothing.
